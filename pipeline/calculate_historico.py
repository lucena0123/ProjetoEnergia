#!/usr/bin/env python3
"""
calculate_historico.py — GridRisk pipeline: monthly score snapshot

Takes a snapshot of the current mapa_risco table into historico_score
for the current month. Should be run monthly (via cron or scheduler).

Usage:
    python calculate_historico.py
    python calculate_historico.py --db-url postgresql://user:pass@host/db
"""

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


@click.command()
@click.option("--ano", default=None, type=int,
              help="Year to snapshot (default: current year).")
@click.option("--mes", default=None, type=int,
              help="Month to snapshot (default: current month).")
@click.option("--db-url", "db_url", default=None, envvar="DATABASE_URL",
              help="SQLAlchemy database URL.")
def main(ano: Optional[int], mes: Optional[int], db_url: Optional[str]) -> None:
    """Snapshot current risk scores into historico_score table."""
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL is not set.")
        sys.exit(1)

    engine = create_engine(db_url, pool_pre_ping=True)
    started = datetime.now()
    count = snapshot_scores(engine, ano, mes)
    elapsed = (datetime.now() - started).total_seconds()
    log.info("Done. %d records in %.1fs.", count, elapsed)


if __name__ == "__main__":
    main()
