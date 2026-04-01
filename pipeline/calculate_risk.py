#!/usr/bin/env python3
"""
calculate_risk.py — GridRisk pipeline step 3

Calculates the composite risk score for each (municipio, distribuidora) pair
and writes the results to the mapa_risco table.  The operation is idempotent:
existing rows are deleted before re-inserting so re-runs always produce a
fresh, consistent result.

The score is composed of three weighted components (total = 100 pts):
  * 40 % — DEC ratio  (apurado / limite, capped at 3x)
  * 30 % — Violation frequency  (months out of last 12 where DEC was exceeded)
  * 30 % — Average network age  (rede_mt, capped at 40 years)

Usage:
    python calculate_risk.py \
        [--distribuidora "CEMIG-D"] \
        [--db-url postgresql://user:pass@host/db]
"""

import os
import sys
import logging
from datetime import datetime

import click
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
# SQL
# ---------------------------------------------------------------------------

# The core INSERT statement.  The optional distribuidora filter is injected
# at runtime via string substitution into the WHERE clause placeholder below.
_SQL_INSERT = """\
INSERT INTO mapa_risco (
    municipio,
    distribuidora,
    uf,
    score_risco,
    dec_medio_12m,
    ratio_dec,
    meses_violacao,
    idade_media_anos,
    atualizado_em
)
WITH ic_12m AS (
    SELECT
        municipio,
        distribuidora,
        uf,
        AVG(dec_apurado)  AS dec_medio_12m,
        AVG(dec_limite)   AS dec_limite_medio,
        CASE WHEN AVG(dec_limite) > 0
             THEN LEAST(AVG(dec_apurado) / AVG(dec_limite), 3.0)
             ELSE 0
        END AS ratio_dec,
        COUNT(*) FILTER (WHERE violacao_dec = TRUE) AS meses_violacao
    FROM indicadores_continuidade
    WHERE (ano * 12 + mes) >= (
        SELECT MAX(ano * 12 + mes) - 11
        FROM indicadores_continuidade
    )
    {distribuidora_filter}
    GROUP BY municipio, distribuidora, uf
),
idade_rede AS (
    SELECT
        municipio,
        distribuidora,
        AVG(EXTRACT(YEAR FROM AGE(NOW(), data_implant))) AS idade_media_anos
    FROM rede_mt
    WHERE data_implant IS NOT NULL
    GROUP BY municipio, distribuidora
),
scoring AS (
    SELECT
        ic.municipio,
        ic.distribuidora,
        ic.uf,
        ic.dec_medio_12m,
        ic.ratio_dec,
        ic.meses_violacao,
        COALESCE(ir.idade_media_anos, 20) AS idade_media_anos,
        -- Score components (0-100 each)
        LEAST(ic.ratio_dec / 3.0, 1.0) * 40                          AS score_dec,    -- 40 %
        LEAST(ic.meses_violacao::float / 12.0, 1.0) * 30             AS score_freq,   -- 30 %
        LEAST(COALESCE(ir.idade_media_anos, 20) / 40.0, 1.0) * 30    AS score_idade   -- 30 %
    FROM ic_12m ic
    LEFT JOIN idade_rede ir
        ON ic.municipio    = ir.municipio
       AND ic.distribuidora = ir.distribuidora
)
SELECT
    municipio,
    distribuidora,
    uf,
    ROUND((score_dec + score_freq + score_idade)::numeric, 2) AS score_risco,
    ROUND(dec_medio_12m::numeric, 2)                          AS dec_medio_12m,
    ROUND(ratio_dec::numeric, 4)                              AS ratio_dec,
    meses_violacao,
    ROUND(idade_media_anos::numeric, 1)                       AS idade_media_anos,
    NOW()                                                     AS atualizado_em
FROM scoring
ORDER BY score_risco DESC
"""

_SQL_DELETE_ALL = "DELETE FROM mapa_risco"
_SQL_DELETE_DIST = "DELETE FROM mapa_risco WHERE distribuidora = :distribuidora"

_SQL_TOP5 = """\
SELECT municipio, distribuidora, score_risco
FROM mapa_risco
{distribuidora_filter}
ORDER BY score_risco DESC
LIMIT 5
"""

_SQL_COUNT_ROWS = "SELECT COUNT(*) FROM mapa_risco {distribuidora_filter}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts() -> str:
    """Return the current timestamp as a human-readable string."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _check_source_data(conn, distribuidora: str | None) -> int:
    """
    Return the number of rows in indicadores_continuidade (optionally
    filtered by distribuidora).  Used as a quick sanity check before running
    the full scoring query.
    """
    if distribuidora:
        sql = text(
            "SELECT COUNT(*) FROM indicadores_continuidade "
            "WHERE distribuidora = :distribuidora"
        )
        row = conn.execute(sql, {"distribuidora": distribuidora}).fetchone()
    else:
        sql = text("SELECT COUNT(*) FROM indicadores_continuidade")
        row = conn.execute(sql).fetchone()
    return row[0] if row else 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option(
    "--db-url",
    "db_url",
    default=None,
    envvar="DATABASE_URL",
    show_envvar=True,
    help="SQLAlchemy database URL.  Falls back to DATABASE_URL env variable.",
)
@click.option(
    "--distribuidora",
    default=None,
    type=str,
    help=(
        "Restrict scoring to a single distribution company.  "
        "When omitted, all companies are processed."
    ),
)
def main(db_url: str | None, distribuidora: str | None) -> None:
    """Calculate GridRisk scores and populate the mapa_risco table (idempotent)."""

    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")

    if not db_url:
        log.error(
            "No database URL supplied.  "
            "Set --db-url or the DATABASE_URL environment variable."
        )
        sys.exit(1)

    log.info("=== Risk Calculation started at %s ===", _ts())
    if distribuidora:
        log.info("Scope: distribuidora = '%s'", distribuidora)
    else:
        log.info("Scope: all distribuidoras")

    # -----------------------------------------------------------------------
    # Connect
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
    # Sanity-check: verify source data exists
    # -----------------------------------------------------------------------
    try:
        with engine.connect() as conn:
            source_count = _check_source_data(conn, distribuidora)
    except Exception as exc:  # noqa: BLE001
        log.error("Failed to query source table: %s", exc)
        sys.exit(1)

    if source_count == 0:
        scope_msg = (
            f"distribuidora='{distribuidora}'"
            if distribuidora
            else "all distribuidoras"
        )
        log.warning(
            "No rows found in indicadores_continuidade for %s — nothing to calculate.",
            scope_msg,
        )
        log.info("=== Risk Calculation finished (no-op) at %s ===", _ts())
        sys.exit(0)

    log.info(
        "Source rows available in indicadores_continuidade: %d", source_count
    )

    # -----------------------------------------------------------------------
    # Build SQL fragments for the optional distribuidora filter
    # -----------------------------------------------------------------------
    # For the INSERT/CTE the filter sits inside the ic_12m CTE after the WHERE
    # clause that already exists, so we use AND.
    if distribuidora:
        insert_filter = "AND distribuidora = :distribuidora"
        top5_filter = "WHERE distribuidora = :distribuidora"
        count_filter = "WHERE distribuidora = :distribuidora"
        bind_params: dict = {"distribuidora": distribuidora}
    else:
        insert_filter = ""
        top5_filter = ""
        count_filter = ""
        bind_params = {}

    sql_insert = _SQL_INSERT.format(distribuidora_filter=insert_filter)
    sql_top5 = _SQL_TOP5.format(distribuidora_filter=top5_filter)
    sql_count = _SQL_COUNT_ROWS.format(distribuidora_filter=count_filter)

    # -----------------------------------------------------------------------
    # Execute DELETE + INSERT in a single transaction
    # -----------------------------------------------------------------------
    rows_deleted = 0
    rows_inserted = 0

    try:
        with engine.begin() as conn:
            # --- DELETE ---
            if distribuidora:
                result = conn.execute(
                    text(_SQL_DELETE_DIST), {"distribuidora": distribuidora}
                )
            else:
                result = conn.execute(text(_SQL_DELETE_ALL))

            rows_deleted = result.rowcount
            log.info("[%s] Deleted %d existing rows from mapa_risco.", _ts(), rows_deleted)

            # --- INSERT ---
            log.info("[%s] Running scoring query …", _ts())
            conn.execute(text(sql_insert), bind_params)

            # Count newly inserted rows within the same transaction
            count_row = conn.execute(text(sql_count), bind_params).fetchone()
            rows_inserted = count_row[0] if count_row else 0

            log.info(
                "[%s] Inserted %d rows into mapa_risco.", _ts(), rows_inserted
            )

            # --- Top 5 preview ---
            top5_rows = conn.execute(text(sql_top5), bind_params).fetchall()

    except Exception as exc:  # noqa: BLE001
        log.error(
            "Risk calculation failed (transaction rolled back): %s",
            exc,
            exc_info=True,
        )
        sys.exit(1)

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    log.info("=== Summary ===")
    log.info("  Rows deleted  : %d", rows_deleted)
    log.info("  Rows inserted : %d", rows_inserted)

    if top5_rows:
        log.info("  Top 5 municipalities by risk score:")
        for rank, row in enumerate(top5_rows, start=1):
            municipio, dist, score = row[0], row[1], row[2]
            log.info("    %d. %-40s %-20s score=%.2f", rank, municipio, dist, score)
    else:
        log.warning("  No scored rows found — top-5 list is empty.")

    log.info("=== Risk Calculation finished at %s ===", _ts())


if __name__ == "__main__":
    main()
