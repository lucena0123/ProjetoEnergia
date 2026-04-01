#!/usr/bin/env python3
"""
ingest_dec_fec.py — GridRisk pipeline step 2

Ingests DEC/FEC continuity indicator data from a CSV file (ANEEL format)
into the indicadores_continuidade table, implementing idempotent import so
that re-running the script with the same file never creates duplicate rows.

Usage:
    python ingest_dec_fec.py \
        --arquivo /path/to/indicadores.csv \
        [--db-url postgresql://user:pass@host/db]
"""

import os
import sys
import logging
import unicodedata
from datetime import datetime

import click
import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
TARGET_TABLE = "indicadores_continuidade"
CHUNK_SIZE = 5_000

# Columns that should be treated as floats (commas replaced with dots)
FLOAT_COLUMNS = ["dec_apurado", "dec_limite", "fec_apurado", "fec_limite"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts() -> str:
    """Return current timestamp as a readable string."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _strip_accents(text_value: str) -> str:
    """Remove diacritic marks from a Unicode string."""
    normalised = unicodedata.normalize("NFKD", text_value)
    return "".join(c for c in normalised if not unicodedata.combining(c))


def _normalise_col_name(name: str) -> str:
    """
    Lowercase, strip accents, replace any run of non-alphanumeric characters
    with a single underscore, and strip leading/trailing underscores.
    """
    name = _strip_accents(str(name)).lower().strip()
    # Replace spaces, hyphens, slashes, parentheses, dots, etc.
    cleaned: list[str] = []
    for ch in name:
        if ch.isalnum() or ch == "_":
            cleaned.append(ch)
        else:
            cleaned.append("_")
    result = "".join(cleaned)
    # Collapse runs of underscores
    while "__" in result:
        result = result.replace("__", "_")
    return result.strip("_")


def _find_column(columns: list[str], *keywords: str) -> str | None:
    """
    Return the first column name that contains ALL of the given keywords
    (case-insensitive substring match on the already-normalised column name).
    """
    for col in columns:
        col_lower = col.lower()
        if all(kw.lower() in col_lower for kw in keywords):
            return col
    return None


def _find_column_any(columns: list[str], *keyword_groups: tuple[str, ...]) -> str | None:
    """
    Try each keyword group in order; return the first column that matches any group.
    Each group is a tuple of keywords that must ALL be present.
    """
    for keywords in keyword_groups:
        result = _find_column(columns, *keywords)
        if result is not None:
            return result
    return None


def _to_float(series: pd.Series) -> pd.Series:
    """Convert a string series to float, handling comma decimal separators."""
    return (
        series.astype(str)
        .str.strip()
        .str.replace(",", ".", regex=False)
        .pipe(pd.to_numeric, errors="coerce")
    )


def _map_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    Map raw (normalised) dataframe columns to the target schema.
    Returns a dataframe with the canonical column names.
    """
    cols = list(df.columns)
    log.debug("Normalised columns: %s", cols)

    mapping: dict[str, str] = {}  # target → source

    # distribuidora
    src = _find_column_any(cols, ("distribuidora",), ("agente",))
    if src:
        mapping["distribuidora"] = src
    else:
        log.warning("Could not find 'distribuidora'/'agente' column; will be None.")

    # municipio
    src = _find_column_any(cols, ("municipio",), ("nome_municipio",))
    if src:
        mapping["municipio"] = src
    else:
        log.warning("Could not find 'municipio'/'nome_municipio' column; will be None.")

    # uf
    src = _find_column_any(cols, ("sig_uf",), ("uf",))
    if src:
        mapping["uf"] = src
    else:
        log.warning("Could not find 'uf'/'sig_uf' column; will be None.")

    # ano
    src = _find_column(cols, "ano")
    if src:
        mapping["ano"] = src

    # mes
    src = _find_column(cols, "mes")
    if src:
        mapping["mes"] = src

    # dec_apurado
    src = _find_column(cols, "dec", "apurado")
    if src:
        mapping["dec_apurado"] = src
    else:
        log.warning("Could not find DEC apurado column.")

    # dec_limite
    src = _find_column(cols, "dec", "limite")
    if src:
        mapping["dec_limite"] = src
    else:
        log.warning("Could not find DEC limite column.")

    # fec_apurado
    src = _find_column(cols, "fec", "apurado")
    if src:
        mapping["fec_apurado"] = src
    else:
        log.warning("Could not find FEC apurado column.")

    # fec_limite
    src = _find_column(cols, "fec", "limite")
    if src:
        mapping["fec_limite"] = src
    else:
        log.warning("Could not find FEC limite column.")

    # Build result dataframe with target column names
    result = pd.DataFrame()
    target_cols = [
        "distribuidora", "municipio", "uf",
        "ano", "mes",
        "dec_apurado", "dec_limite",
        "fec_apurado", "fec_limite",
    ]
    for target in target_cols:
        if target in mapping:
            result[target] = df[mapping[target]]
        else:
            result[target] = None

    # --- Handle ano/mes extraction from a date column if direct columns absent ---
    if "ano" not in mapping or "mes" not in mapping:
        # Look for a column that might be a date
        date_col = _find_column_any(
            cols, ("data",), ("competencia",), ("periodo",), ("referencia",)
        )
        if date_col:
            log.info(
                "Extracting ano/mes from date column '%s'.", date_col
            )
            parsed = pd.to_datetime(df[date_col], errors="coerce", dayfirst=True)
            if "ano" not in mapping:
                result["ano"] = parsed.dt.year
            if "mes" not in mapping:
                result["mes"] = parsed.dt.month

    return result


def _fetch_existing_combos(engine) -> set[tuple]:
    """
    Retrieve the set of (distribuidora, municipio, ano, mes) tuples already
    present in the target table.  Returns an empty set if the table does not
    exist yet.
    """
    query = text(
        f"""
        SELECT distribuidora, municipio, ano, mes
        FROM {TARGET_TABLE}
        """
    )
    try:
        with engine.connect() as conn:
            rows = conn.execute(query).fetchall()
        existing = {(r[0], r[1], r[2], r[3]) for r in rows}
        log.info("Existing combos in DB: %d", len(existing))
        return existing
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "Could not query existing rows (table may not exist yet): %s", exc
        )
        return set()


def _anti_join(df: pd.DataFrame, existing: set[tuple]) -> pd.DataFrame:
    """Return only rows whose (distribuidora, municipio, ano, mes) are not in existing."""
    if not existing:
        return df

    key_cols = ["distribuidora", "municipio", "ano", "mes"]

    def _is_new(row: pd.Series) -> bool:
        key = (row["distribuidora"], row["municipio"], row["ano"], row["mes"])
        return key not in existing

    mask = df.apply(_is_new, axis=1)
    return df[mask]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option(
    "--arquivo",
    required=True,
    type=click.Path(exists=True, readable=True),
    help="Path to the DEC/FEC CSV file (semicolon-separated, Latin-1 encoding).",
)
@click.option(
    "--db-url",
    "db_url",
    default=None,
    envvar="DATABASE_URL",
    show_envvar=True,
    help="SQLAlchemy database URL.  Falls back to DATABASE_URL env variable.",
)
def main(arquivo: str, db_url: str | None) -> None:
    """Ingest DEC/FEC continuity indicators into the GridRisk database (idempotent)."""

    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")

    if not db_url:
        log.error(
            "No database URL supplied.  "
            "Set --db-url or the DATABASE_URL environment variable."
        )
        sys.exit(1)

    log.info("=== DEC/FEC Ingest started at %s ===", _ts())
    log.info("File: %s", arquivo)

    # -----------------------------------------------------------------------
    # 1. Read CSV
    # -----------------------------------------------------------------------
    try:
        raw_df = pd.read_csv(arquivo, sep=";", encoding="latin-1", dtype=str)
    except Exception as exc:  # noqa: BLE001
        log.error("Failed to read CSV '%s': %s", arquivo, exc)
        sys.exit(1)

    total_rows = len(raw_df)
    log.info("Rows read from file: %d", total_rows)

    if total_rows == 0:
        log.warning("CSV file is empty — nothing to import.")
        sys.exit(0)

    # -----------------------------------------------------------------------
    # 2. Normalise column names
    # -----------------------------------------------------------------------
    raw_df.columns = [_normalise_col_name(c) for c in raw_df.columns]

    # -----------------------------------------------------------------------
    # 3. Map columns to target schema
    # -----------------------------------------------------------------------
    df = _map_columns(raw_df)

    # -----------------------------------------------------------------------
    # 4. Convert numeric columns
    # -----------------------------------------------------------------------
    for col in FLOAT_COLUMNS:
        if col in df.columns:
            df[col] = _to_float(df[col])

    # Convert ano / mes to nullable integer
    for col in ("ano", "mes"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

    # -----------------------------------------------------------------------
    # 5. Drop rows with null key fields
    # -----------------------------------------------------------------------
    required_keys = ["distribuidora", "municipio", "ano", "mes"]
    before_drop = len(df)
    df = df.dropna(subset=[c for c in required_keys if c in df.columns])
    dropped = before_drop - len(df)
    if dropped:
        log.warning(
            "%d rows dropped due to null values in key columns (%s).",
            dropped,
            required_keys,
        )

    # -----------------------------------------------------------------------
    # 6. Connect to DB
    # -----------------------------------------------------------------------
    try:
        engine = create_engine(db_url, future=True)
        with engine.connect():
            pass
        log.info("Database connection OK.")
    except Exception as exc:  # noqa: BLE001
        log.error("Cannot connect to database: %s", exc)
        sys.exit(1)

    # -----------------------------------------------------------------------
    # 7. Idempotent check — anti-join against existing rows
    # -----------------------------------------------------------------------
    existing = _fetch_existing_combos(engine)
    df_new = _anti_join(df, existing)

    already_existing = total_rows - len(df_new) - dropped
    log.info("Rows already in DB (skipped): %d", max(already_existing, 0))
    log.info("New rows to insert         : %d", len(df_new))

    if df_new.empty:
        log.info("No new rows to insert — import is up to date.")
        log.info("=== DEC/FEC Ingest finished at %s ===", _ts())
        return

    # -----------------------------------------------------------------------
    # 8. Insert new rows
    # -----------------------------------------------------------------------
    try:
        df_new.to_sql(
            name=TARGET_TABLE,
            con=engine,
            if_exists="append",
            index=False,
            chunksize=CHUNK_SIZE,
            method="multi",
        )
        log.info(
            "[%s] Successfully inserted %d new rows into '%s'.",
            _ts(),
            len(df_new),
            TARGET_TABLE,
        )
    except Exception as exc:  # noqa: BLE001
        log.error("Failed to insert rows: %s", exc, exc_info=True)
        sys.exit(1)

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    log.info("=== Summary ===")
    log.info("  Total rows in file : %d", total_rows)
    log.info("  Already in DB      : %d", max(already_existing, 0))
    log.info("  Newly inserted     : %d", len(df_new))
    log.info("=== DEC/FEC Ingest finished at %s ===", _ts())


if __name__ == "__main__":
    main()
