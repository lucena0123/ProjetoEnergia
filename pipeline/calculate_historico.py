#!/usr/bin/env python3
"""
calculate_historico.py — GridRisk pipeline: historico_score maintenance

Supports two modes:

1. Snapshot mode (default)
   Takes a snapshot of the current mapa_risco table for a target month.

2. Rebuild mode
   Rebuilds historico_score from indicadores_continuidade using the same
   rolling 12-month logic used by the municipality detail API.

Examples:
    python calculate_historico.py
    python calculate_historico.py --rebuild --distribuidora "Enel Ceará"
    python calculate_historico.py --rebuild --uf CE --limpar
"""

from __future__ import annotations

import os
import sys
import logging
from datetime import datetime
from typing import Optional

import click
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)


def snapshot_scores(engine, ano: Optional[int] = None, mes: Optional[int] = None) -> int:
    """Snapshot current mapa_risco into historico_score. Returns row count."""
    now = datetime.now()
    target_ano = ano or now.year
    target_mes = mes or now.month

    log.info("Snapshotting scores for %04d-%02d...", target_ano, target_mes)

    sql = """
    INSERT INTO historico_score
      (municipio, distribuidora, uf, ano, mes, score_risco, dec_medio, calculado_em)
    SELECT
      municipio,
      distribuidora,
      uf,
      :ano,
      :mes,
      score_risco,
      dec_medio_12m,
      NOW()
    FROM mapa_risco
    ON CONFLICT (municipio, distribuidora, ano, mes) DO UPDATE SET
      score_risco  = EXCLUDED.score_risco,
      dec_medio    = EXCLUDED.dec_medio,
      calculado_em = NOW()
    """

    with engine.begin() as conn:
        result = conn.execute(text(sql), {"ano": target_ano, "mes": target_mes})
        count = result.rowcount

    log.info("Snapshotted %d municipality scores for %04d-%02d.", count, target_ano, target_mes)
    return count


def rebuild_historico(
    engine,
    *,
    distribuidora: Optional[str],
    uf: Optional[str],
    limpar: bool,
) -> int:
    """Rebuild historico_score from indicadores_continuidade."""
    conditions: list[str] = []
    params: dict[str, str] = {}

    if distribuidora:
        conditions.append("distribuidora = :distribuidora")
        params["distribuidora"] = distribuidora

    if uf:
        conditions.append("uf = :uf")
        params["uf"] = uf.upper()

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    delete_sql = "DELETE FROM historico_score"
    if conditions:
        delete_sql += " WHERE " + " AND ".join(conditions)

    rebuild_sql = f"""
    INSERT INTO historico_score
      (municipio, distribuidora, uf, ano, mes, score_risco, dec_medio, calculado_em)
    WITH monthly AS (
      SELECT
        municipio,
        distribuidora,
        uf,
        ano,
        mes,
        dec_apurado,
        dec_limite,
        CASE WHEN violacao_dec THEN 1 ELSE 0 END AS violacao_dec
      FROM indicadores_continuidade
      {where_clause}
    ),
    rolling AS (
      SELECT
        municipio,
        distribuidora,
        uf,
        ano,
        mes,
        COUNT(*) OVER w AS pontos_janela,
        AVG(dec_apurado) OVER w AS dec_medio_12m,
        AVG(dec_limite) OVER w AS dec_limite_12m,
        SUM(violacao_dec) OVER w AS meses_violacao_12m
      FROM monthly
      WINDOW w AS (
        PARTITION BY municipio, distribuidora
        ORDER BY ano, mes
        ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
      )
    ),
    idade_rede AS (
      SELECT
        municipio,
        distribuidora,
        AVG(EXTRACT(YEAR FROM AGE(NOW(), data_implant))) AS idade_media_anos
      FROM rede_mt
      WHERE data_implant IS NOT NULL
      GROUP BY municipio, distribuidora
    )
    SELECT
      r.municipio,
      r.distribuidora,
      r.uf,
      r.ano,
      r.mes,
      ROUND((
        LEAST(
          CASE
            WHEN COALESCE(r.dec_limite_12m, 0) > 0
            THEN LEAST(r.dec_medio_12m / r.dec_limite_12m, 3.0) / 3.0
            ELSE 0
          END,
          1.0
        ) * 40
        + LEAST(COALESCE(r.meses_violacao_12m, 0)::float / 12.0, 1.0) * 30
        + LEAST(COALESCE(ir.idade_media_anos, 20) / 40.0, 1.0) * 30
      )::numeric, 2) AS score_risco,
      ROUND(r.dec_medio_12m::numeric, 2) AS dec_medio,
      NOW()
    FROM rolling r
    LEFT JOIN idade_rede ir
      ON r.municipio = ir.municipio
     AND r.distribuidora = ir.distribuidora
    WHERE r.pontos_janela >= 3
    ON CONFLICT (municipio, distribuidora, ano, mes) DO UPDATE SET
      score_risco = EXCLUDED.score_risco,
      dec_medio = EXCLUDED.dec_medio,
      calculado_em = NOW()
    """

    with engine.begin() as conn:
        if limpar:
            deleted = conn.execute(text(delete_sql), params).rowcount or 0
            log.info("Deleted %d historico_score rows before rebuild.", deleted)

        conn.execute(text(rebuild_sql), params)
        count_sql = "SELECT COUNT(*) FROM historico_score"
        if conditions:
            count_sql += " WHERE " + " AND ".join(conditions)
        count = conn.execute(text(count_sql), params).scalar() or 0

    log.info("Rebuilt %d historico_score rows.", int(count))
    return int(count)


@click.command()
@click.option("--ano", default=None, type=int, help="Year to snapshot (default: current year).")
@click.option("--mes", default=None, type=int, help="Month to snapshot (default: current month).")
@click.option("--rebuild", is_flag=True, help="Rebuild historico_score from indicadores_continuidade.")
@click.option("--distribuidora", default=None, type=str, help="Restrict rebuild to a distribuidora.")
@click.option("--uf", default=None, type=str, help="Restrict rebuild to a UF.")
@click.option("--limpar", is_flag=True, help="Delete historico_score rows in scope before rebuilding.")
@click.option("--db-url", "db_url", default=None, envvar="DATABASE_URL", help="SQLAlchemy database URL.")
def main(
    ano: Optional[int],
    mes: Optional[int],
    rebuild: bool,
    distribuidora: Optional[str],
    uf: Optional[str],
    limpar: bool,
    db_url: Optional[str],
) -> None:
    """Maintain historico_score using either snapshot or rebuild mode."""
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL is not set.")
        sys.exit(1)

    engine = create_engine(db_url, pool_pre_ping=True)
    started = datetime.now()

    if rebuild:
        count = rebuild_historico(
            engine,
            distribuidora=distribuidora,
            uf=uf,
            limpar=limpar,
        )
    else:
        count = snapshot_scores(engine, ano, mes)

    elapsed = (datetime.now() - started).total_seconds()
    log.info("Done. %d records in %.1fs.", count, elapsed)


if __name__ == "__main__":
    main()
