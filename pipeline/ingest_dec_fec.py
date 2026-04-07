#!/usr/bin/env python3
"""
ingest_dec_fec.py — GridRisk pipeline step 2

Supports two import modes:

1. Legacy municipal CSV
   Expects a single CSV that already contains municipality-level DEC/FEC data.

2. Official ANEEL continuity datasets
   Expects:
     - apurado CSV (`indicadores-continuidade-coletivos-2020-2029.csv`)
     - limite CSV (`indicadores-continuidade-coletivos-limite.csv`)
     - IndQual linkage CSV (`indqual-municipio.csv`)

   The script expands conjuntos to municipalities via IndQual and aggregates
   DEC/FEC to municipality-month using `NumCon` as weight.

Examples:
    python ingest_dec_fec.py --arquivo /data/indicadores_dec_fec.csv

    python ingest_dec_fec.py \
        --arquivo /data/indicadores_continuidade_2020_2029.csv \
        --arquivo-limite /data/indicadores_continuidade_limite.csv \
        --arquivo-indqual /data/indqual_municipio.csv \
        --uf CE \
        --distribuidora "Enel Ceará" \
        --limpar
"""

from __future__ import annotations

import os
import sys
import logging
import unicodedata
from datetime import datetime
from typing import Optional

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
OFFICIAL_CHUNK_SIZE = 500_000

FLOAT_COLUMNS = ["dec_apurado", "dec_limite", "fec_apurado", "fec_limite"]
LEGACY_KEY_COLUMNS = ["distribuidora", "municipio", "ano", "mes"]

APURADO_USECOLS = [
    "SigAgente",
    "IdeConjUndConsumidoras",
    "SigIndicador",
    "AnoIndice",
    "NumPeriodoIndice",
    "VlrIndiceEnviado",
]
LIMITE_USECOLS = [
    "SigAgente",
    "IdeConjUndConsumidoras",
    "SigIndicador",
    "AnoLimiteQualidade",
    "VlrLimite",
]
INDQUAL_USECOLS = [
    "IdeConjUnidConsumidoras",
    "CodMunicipio",
    "NomMunicipio",
    "SigUF",
]


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _strip_accents(text_value: str) -> str:
    normalised = unicodedata.normalize("NFKD", text_value)
    return "".join(c for c in normalised if not unicodedata.combining(c))


def _normalise_col_name(name: str) -> str:
    name = _strip_accents(str(name)).lower().strip()
    cleaned: list[str] = []
    for ch in name:
        cleaned.append(ch if ch.isalnum() or ch == "_" else "_")
    result = "".join(cleaned)
    while "__" in result:
        result = result.replace("__", "_")
    return result.strip("_")


def _to_float(series: pd.Series) -> pd.Series:
    return (
        series.astype(str)
        .str.strip()
        .str.replace(r"(?<=\d)\.(?=\d{3}(?:\D|$))", "", regex=True)
        .str.replace(",", ".", regex=False)
        .replace({"": None, "nan": None, "None": None})
        .pipe(pd.to_numeric, errors="coerce")
    )


def _safe_upper(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned.upper() if cleaned else None


def _load_ibge_names(engine, uf: Optional[str] = None) -> dict[str, tuple[str, str]]:
    sql = "SELECT codigo_ibge, nome, uf FROM ibge_municipios"
    params: dict[str, str] = {}
    if uf:
      sql += " WHERE uf = :uf"
      params["uf"] = uf

    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).fetchall()

    return {str(row[0]): (str(row[1]), str(row[2])) for row in rows}


def _delete_existing_rows(
    engine,
    *,
    distribuidora: Optional[str],
    uf: Optional[str],
) -> int:
    conditions: list[str] = []
    params: dict[str, str] = {}

    if distribuidora:
        conditions.append("distribuidora = :distribuidora")
        params["distribuidora"] = distribuidora

    if uf:
        conditions.append("uf = :uf")
        params["uf"] = uf

    sql = f"DELETE FROM {TARGET_TABLE}"
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)

    with engine.begin() as conn:
        result = conn.execute(text(sql), params)
    return result.rowcount or 0


# ---------------------------------------------------------------------------
# Legacy CSV path
# ---------------------------------------------------------------------------

def _find_column(columns: list[str], *keywords: str) -> str | None:
    for col in columns:
        col_lower = col.lower()
        if all(kw.lower() in col_lower for kw in keywords):
            return col
    return None


def _find_column_any(columns: list[str], *keyword_groups: tuple[str, ...]) -> str | None:
    for keywords in keyword_groups:
        result = _find_column(columns, *keywords)
        if result is not None:
            return result
    return None


def _map_legacy_columns(df: pd.DataFrame) -> pd.DataFrame:
    cols = list(df.columns)
    mapping: dict[str, str] = {}

    src = _find_column_any(cols, ("distribuidora",), ("agente",))
    if src:
        mapping["distribuidora"] = src

    src = _find_column_any(cols, ("municipio",), ("nome_municipio",))
    if src:
        mapping["municipio"] = src

    src = _find_column_any(cols, ("sig_uf",), ("uf",))
    if src:
        mapping["uf"] = src

    src = _find_column(cols, "ano")
    if src:
        mapping["ano"] = src

    src = _find_column(cols, "mes")
    if src:
        mapping["mes"] = src

    src = _find_column(cols, "dec", "apurado")
    if src:
        mapping["dec_apurado"] = src

    src = _find_column(cols, "dec", "limite")
    if src:
        mapping["dec_limite"] = src

    src = _find_column(cols, "fec", "apurado")
    if src:
        mapping["fec_apurado"] = src

    src = _find_column(cols, "fec", "limite")
    if src:
        mapping["fec_limite"] = src

    result = pd.DataFrame()
    target_cols = [
        "distribuidora", "municipio", "uf",
        "ano", "mes",
        "dec_apurado", "dec_limite",
        "fec_apurado", "fec_limite",
    ]
    for target in target_cols:
        result[target] = df[mapping[target]] if target in mapping else None

    if "ano" not in mapping or "mes" not in mapping:
        date_col = _find_column_any(
            cols, ("data",), ("competencia",), ("periodo",), ("referencia",)
        )
        if date_col:
            parsed = pd.to_datetime(df[date_col], errors="coerce", dayfirst=True)
            if "ano" not in mapping:
                result["ano"] = parsed.dt.year
            if "mes" not in mapping:
                result["mes"] = parsed.dt.month

    return result


def _fetch_existing_combos(engine) -> set[tuple]:
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
        log.warning("Could not query existing rows (table may not exist yet): %s", exc)
        return set()


def _anti_join(df: pd.DataFrame, existing: set[tuple]) -> pd.DataFrame:
    if not existing:
        return df

    def _is_new(row: pd.Series) -> bool:
        return (row["distribuidora"], row["municipio"], row["ano"], row["mes"]) not in existing

    return df[df.apply(_is_new, axis=1)]


def _load_legacy_dataframe(arquivo: str) -> pd.DataFrame:
    raw_df = pd.read_csv(arquivo, sep=";", encoding="latin-1", dtype=str)
    raw_df.columns = [_normalise_col_name(c) for c in raw_df.columns]
    df = _map_legacy_columns(raw_df)

    for col in FLOAT_COLUMNS:
        if col in df.columns:
            df[col] = _to_float(df[col])

    for col in ("ano", "mes"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

    before_drop = len(df)
    df = df.dropna(subset=[c for c in LEGACY_KEY_COLUMNS if c in df.columns])
    dropped = before_drop - len(df)
    if dropped:
        log.warning("%d legacy rows dropped due to null keys.", dropped)

    return df


# ---------------------------------------------------------------------------
# Official ANEEL path
# ---------------------------------------------------------------------------

def _load_indqual_dataframe(
    arquivo_indqual: str,
    engine,
    uf_filter: Optional[str],
) -> pd.DataFrame:
    log.info("Loading IndQual linkage CSV: %s", arquivo_indqual)
    indqual = pd.read_csv(arquivo_indqual, sep=";", encoding="latin-1", usecols=INDQUAL_USECOLS, dtype=str)
    indqual = indqual.rename(
        columns={
            "IdeConjUnidConsumidoras": "ide_conj",
            "CodMunicipio": "codigo_ibge",
            "NomMunicipio": "municipio_raw",
            "SigUF": "uf",
        }
    )

    indqual["uf"] = indqual["uf"].astype(str).str.upper().str.strip()
    if uf_filter:
        indqual = indqual[indqual["uf"] == uf_filter].copy()

    ibge_names = _load_ibge_names(engine, uf_filter)
    indqual["codigo_ibge"] = indqual["codigo_ibge"].astype(str).str.strip()
    indqual["municipio"] = indqual["codigo_ibge"].map(
        lambda code: ibge_names.get(code, (None, None))[0]
    )
    indqual["uf_canon"] = indqual["codigo_ibge"].map(
        lambda code: ibge_names.get(code, (None, None))[1]
    )
    indqual["municipio"] = indqual["municipio"].fillna(indqual["municipio_raw"])
    indqual["uf"] = indqual["uf_canon"].fillna(indqual["uf"])

    indqual = indqual.dropna(subset=["ide_conj", "municipio", "uf"]).copy()
    indqual["ide_conj"] = indqual["ide_conj"].astype(str).str.strip()

    result = indqual[["ide_conj", "codigo_ibge", "municipio", "uf"]].drop_duplicates()
    log.info(
        "IndQual loaded: %d municipality-conjunto links, %d conjuntos, %d municipios.",
        len(result),
        result["ide_conj"].nunique(),
        result["municipio"].nunique(),
    )
    return result


def _load_limite_dataframe(
    arquivo_limite: str,
    relevant_conjuntos: Optional[set[str]],
) -> pd.DataFrame:
    log.info("Loading official continuity limits CSV: %s", arquivo_limite)
    limite = pd.read_csv(arquivo_limite, sep=";", encoding="latin-1", usecols=LIMITE_USECOLS, dtype=str)
    limite = limite.rename(
        columns={
            "SigAgente": "sig_agente",
            "IdeConjUndConsumidoras": "ide_conj",
            "SigIndicador": "sig_indicador",
            "AnoLimiteQualidade": "ano",
            "VlrLimite": "valor_limite",
        }
    )

    limite["ide_conj"] = limite["ide_conj"].astype(str).str.strip()
    limite = limite[limite["sig_indicador"].isin(["DEC", "FEC"])].copy()
    if relevant_conjuntos:
        limite = limite[limite["ide_conj"].isin(relevant_conjuntos)].copy()

    limite["ano"] = pd.to_numeric(limite["ano"], errors="coerce").astype("Int64")
    limite["valor_limite"] = _to_float(limite["valor_limite"])
    limite["sig_agente"] = limite["sig_agente"].astype(str).str.strip()

    limite_pivot = (
        limite.pivot_table(
            index=["ide_conj", "ano"],
            columns="sig_indicador",
            values="valor_limite",
            aggfunc="first",
        )
        .reset_index()
        .rename(columns={"DEC": "dec_limite", "FEC": "fec_limite"})
    )

    agente_lookup = (
        limite.dropna(subset=["sig_agente"])
        .groupby(["ide_conj", "ano"], as_index=False)["sig_agente"]
        .first()
    )
    limite_pivot = limite_pivot.merge(agente_lookup, on=["ide_conj", "ano"], how="left")

    log.info("Limits prepared: %d conjunto-year rows.", len(limite_pivot))
    return limite_pivot


def _group_official_chunk(chunk: pd.DataFrame) -> pd.DataFrame:
    for value_col in ("dec_apurado", "fec_apurado", "num_consumidores", "dec_limite", "fec_limite"):
        if value_col not in chunk.columns:
            chunk[value_col] = pd.NA
        chunk[value_col] = pd.to_numeric(chunk[value_col], errors="coerce")

    chunk["weight"] = chunk["num_consumidores"].where(chunk["num_consumidores"] > 0, 1.0).fillna(1.0)
    chunk["dec_num"] = chunk["dec_apurado"] * chunk["weight"]
    chunk["dec_den"] = chunk["weight"].where(chunk["dec_apurado"].notna(), 0.0)
    chunk["fec_num"] = chunk["fec_apurado"] * chunk["weight"]
    chunk["fec_den"] = chunk["weight"].where(chunk["fec_apurado"].notna(), 0.0)
    chunk["dec_lim_num"] = chunk["dec_limite"] * chunk["weight"]
    chunk["dec_lim_den"] = chunk["weight"].where(chunk["dec_limite"].notna(), 0.0)
    chunk["fec_lim_num"] = chunk["fec_limite"] * chunk["weight"]
    chunk["fec_lim_den"] = chunk["weight"].where(chunk["fec_limite"].notna(), 0.0)

    grouped = (
        chunk.groupby(["distribuidora", "municipio", "uf", "ano", "mes"], as_index=False)[
            ["dec_num", "dec_den", "fec_num", "fec_den", "dec_lim_num", "dec_lim_den", "fec_lim_num", "fec_lim_den"]
        ]
        .sum()
    )
    return grouped


def _load_official_dataframe(
    arquivo: str,
    arquivo_limite: str,
    arquivo_indqual: str,
    engine,
    uf_filter: Optional[str],
    distribuidora_final: Optional[str],
) -> pd.DataFrame:
    indqual = _load_indqual_dataframe(arquivo_indqual, engine, uf_filter)
    relevant_conjuntos = set(indqual["ide_conj"].astype(str).tolist())
    limite = _load_limite_dataframe(arquivo_limite, relevant_conjuntos)

    grouped_chunks: list[pd.DataFrame] = []
    total_rows = 0
    matched_rows = 0

    log.info("Reading official continuity CSV in chunks: %s", arquivo)
    for chunk in pd.read_csv(
        arquivo,
        sep=";",
        encoding="latin-1",
        usecols=APURADO_USECOLS,
        dtype=str,
        chunksize=OFFICIAL_CHUNK_SIZE,
    ):
        total_rows += len(chunk)
        chunk = chunk.rename(
            columns={
                "SigAgente": "sig_agente_apurado",
                "IdeConjUndConsumidoras": "ide_conj",
                "SigIndicador": "sig_indicador",
                "AnoIndice": "ano",
                "NumPeriodoIndice": "mes",
                "VlrIndiceEnviado": "valor",
            }
        )

        chunk["ide_conj"] = chunk["ide_conj"].astype(str).str.strip()
        chunk = chunk[chunk["sig_indicador"].isin(["DEC", "FEC", "NumCon"])].copy()
        if relevant_conjuntos:
            chunk = chunk[chunk["ide_conj"].isin(relevant_conjuntos)].copy()
        if chunk.empty:
            continue

        matched_rows += len(chunk)

        chunk["ano"] = pd.to_numeric(chunk["ano"], errors="coerce").astype("Int64")
        chunk["mes"] = pd.to_numeric(chunk["mes"], errors="coerce").astype("Int64")
        chunk["valor"] = _to_float(chunk["valor"])
        chunk["sig_agente_apurado"] = chunk["sig_agente_apurado"].astype(str).str.strip()

        pivot = (
            chunk.pivot_table(
                index=["ide_conj", "ano", "mes"],
                columns="sig_indicador",
                values="valor",
                aggfunc="first",
            )
            .reset_index()
            .rename(
                columns={
                    "DEC": "dec_apurado",
                    "FEC": "fec_apurado",
                    "NumCon": "num_consumidores",
                }
            )
        )
        for missing_col in ("dec_apurado", "fec_apurado", "num_consumidores"):
            if missing_col not in pivot.columns:
                pivot[missing_col] = pd.NA

        agente_lookup = (
            chunk.dropna(subset=["sig_agente_apurado"])
            .groupby(["ide_conj", "ano", "mes"], as_index=False)["sig_agente_apurado"]
            .first()
        )

        merged = pivot.merge(agente_lookup, on=["ide_conj", "ano", "mes"], how="left")
        merged = merged.merge(limite, on=["ide_conj", "ano"], how="left")
        merged = merged.merge(indqual, on="ide_conj", how="inner")
        if merged.empty:
            continue

        merged["distribuidora"] = (
            distribuidora_final
            if distribuidora_final
            else merged["sig_agente"].fillna(merged["sig_agente_apurado"]).fillna("ANEEL")
        )

        grouped_chunks.append(_group_official_chunk(merged))

    log.info("Official continuity rows scanned: %d", total_rows)
    log.info("Rows matching target conjuntos  : %d", matched_rows)

    if not grouped_chunks:
        raise click.ClickException("No official continuity rows matched the selected scope.")

    aggregated = pd.concat(grouped_chunks, ignore_index=True)
    aggregated = aggregated.groupby(
        ["distribuidora", "municipio", "uf", "ano", "mes"],
        as_index=False,
    ).sum()

    aggregated["dec_apurado"] = aggregated["dec_num"] / aggregated["dec_den"].where(aggregated["dec_den"] > 0)
    aggregated["fec_apurado"] = aggregated["fec_num"] / aggregated["fec_den"].where(aggregated["fec_den"] > 0)
    aggregated["dec_limite"] = aggregated["dec_lim_num"] / aggregated["dec_lim_den"].where(aggregated["dec_lim_den"] > 0)
    aggregated["fec_limite"] = aggregated["fec_lim_num"] / aggregated["fec_lim_den"].where(aggregated["fec_lim_den"] > 0)

    result = aggregated[
        ["distribuidora", "municipio", "uf", "ano", "mes", "dec_apurado", "dec_limite", "fec_apurado", "fec_limite"]
    ].copy()

    result["ano"] = result["ano"].astype("Int64")
    result["mes"] = result["mes"].astype("Int64")
    result = result.dropna(subset=["distribuidora", "municipio", "uf", "ano", "mes"])
    result = result.sort_values(["distribuidora", "municipio", "ano", "mes"]).reset_index(drop=True)

    log.info(
        "Official continuity prepared: %d municipality-month rows, %d municipios, %d distribuidoras.",
        len(result),
        result["municipio"].nunique(),
        result["distribuidora"].nunique(),
    )

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option(
    "--arquivo",
    required=True,
    type=click.Path(exists=True, readable=True),
    help="Path to the continuity CSV (legacy municipal CSV or official ANEEL apurado CSV).",
)
@click.option(
    "--arquivo-limite",
    default=None,
    type=click.Path(exists=True, readable=True),
    help="Path to the official ANEEL continuity limit CSV.",
)
@click.option(
    "--arquivo-indqual",
    default=None,
    type=click.Path(exists=True, readable=True),
    help="Path to the official ANEEL IndQual Município linkage CSV.",
)
@click.option(
    "--uf",
    default=None,
    type=str,
    callback=lambda _ctx, _param, v: _safe_upper(v),
    help="Restrict the official ANEEL import to a single UF.",
)
@click.option(
    "--distribuidora",
    default=None,
    type=str,
    help="Final distribuidora name to persist in the database.",
)
@click.option(
    "--limpar",
    is_flag=True,
    help="Delete existing rows in the selected scope before inserting.",
)
@click.option(
    "--db-url",
    "db_url",
    default=None,
    envvar="DATABASE_URL",
    show_envvar=True,
    help="SQLAlchemy database URL. Falls back to DATABASE_URL env variable.",
)
def main(
    arquivo: str,
    arquivo_limite: Optional[str],
    arquivo_indqual: Optional[str],
    uf: Optional[str],
    distribuidora: Optional[str],
    limpar: bool,
    db_url: Optional[str],
) -> None:
    """Ingest DEC/FEC continuity indicators into the GridRisk database."""
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")

    if not db_url:
        log.error("No database URL supplied. Set --db-url or DATABASE_URL.")
        sys.exit(1)

    official_mode = bool(arquivo_limite or arquivo_indqual)
    if official_mode and not (arquivo_limite and arquivo_indqual):
        log.error("Official ANEEL mode requires both --arquivo-limite and --arquivo-indqual.")
        sys.exit(1)

    log.info("=== DEC/FEC Ingest started at %s ===", _ts())
    log.info("File: %s", arquivo)
    if official_mode:
        log.info("Mode: official_aneel")
        log.info("Limits: %s", arquivo_limite)
        log.info("IndQual: %s", arquivo_indqual)
        if uf:
            log.info("UF filter: %s", uf)
        if distribuidora:
            log.info("Distribuidora final: %s", distribuidora)
    else:
        log.info("Mode: legacy_municipal_csv")

    try:
        engine = create_engine(db_url, future=True)
        with engine.connect():
            pass
        log.info("Database connection OK.")
    except Exception as exc:  # noqa: BLE001
        log.error("Cannot connect to database: %s", exc)
        sys.exit(1)

    try:
        if official_mode:
            df = _load_official_dataframe(
                arquivo,
                arquivo_limite=arquivo_limite,
                arquivo_indqual=arquivo_indqual,
                engine=engine,
                uf_filter=uf,
                distribuidora_final=distribuidora,
            )
        else:
            df = _load_legacy_dataframe(arquivo)
    except Exception as exc:  # noqa: BLE001
        log.error("Failed to prepare continuity dataframe: %s", exc, exc_info=True)
        sys.exit(1)

    if df.empty:
        log.warning("Prepared dataframe is empty — nothing to insert.")
        sys.exit(0)

    if limpar:
        try:
            deleted = _delete_existing_rows(engine, distribuidora=distribuidora, uf=uf)
            log.info("Deleted %d existing rows from %s.", deleted, TARGET_TABLE)
        except Exception as exc:  # noqa: BLE001
            log.error("Failed to clear scope before import: %s", exc, exc_info=True)
            sys.exit(1)

    if not official_mode and not limpar:
        existing = _fetch_existing_combos(engine)
        before = len(df)
        df = _anti_join(df, existing)
        log.info("Rows already in DB (skipped): %d", before - len(df))

    if df.empty:
        log.info("No new rows to insert — import is up to date.")
        log.info("=== DEC/FEC Ingest finished at %s ===", _ts())
        return

    try:
        df.to_sql(
            name=TARGET_TABLE,
            con=engine,
            if_exists="append",
            index=False,
            chunksize=CHUNK_SIZE,
            method="multi",
        )
        log.info("[%s] Successfully inserted %d rows into '%s'.", _ts(), len(df), TARGET_TABLE)
    except Exception as exc:  # noqa: BLE001
        log.error("Failed to insert rows: %s", exc, exc_info=True)
        sys.exit(1)

    log.info("=== Summary ===")
    log.info("  Rows inserted : %d", len(df))
    if official_mode:
        log.info("  Scope UF      : %s", uf or "ALL")
        log.info("  Distribuidora : %s", distribuidora or "from official dataset")
    log.info("=== DEC/FEC Ingest finished at %s ===", _ts())


if __name__ == "__main__":
    main()
