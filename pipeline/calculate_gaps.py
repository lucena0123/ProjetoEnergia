#!/usr/bin/env python3
"""
calculate_gaps.py — GridRisk pipeline: protection gap analysis

Identifies segments of medium-voltage network (rede_mt) that are NOT covered
by a recloser (religador) within a given radius. These "gaps" represent zones
of vulnerability where a fault would require manual restoration.

Usage:
    python calculate_gaps.py --distribuidora "Equatorial Alagoas" --uf AL
    python calculate_gaps.py --uf AL --raio_m 500
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


def calculate_gaps(distribuidora: Optional[str], uf: Optional[str], raio_m: int, engine) -> int:
    """Calculate protection gaps and insert into gaps_protecao table."""

    # Build filter conditions
    conditions = []
    params: dict = {"raio_m": raio_m}

    if distribuidora:
        conditions.append("r.distribuidora = :distribuidora")
        params["distribuidora"] = distribuidora
    if uf:
        conditions.append("r.uf = :uf")
        params["uf"] = uf.upper()

    where_clause = "WHERE " + " AND ".join(conditions) if conditions else ""

    # Delete existing gaps for this scope
    delete_conditions = []
    if distribuidora:
        delete_conditions.append("distribuidora = :distribuidora")
    if uf:
        delete_conditions.append("uf = :uf")
    delete_where = "WHERE " + " AND ".join(delete_conditions) if delete_conditions else ""

    log.info("Clearing existing gaps (dist=%s, uf=%s)...", distribuidora or "*", uf or "*")

    # The gaps SQL uses PostGIS geography operations for accurate distance calculations
    # We use a CTE to compute the buffer union per rede_mt segment, then subtract
    gaps_sql = f"""
    DELETE FROM gaps_protecao {delete_where};

    INSERT INTO gaps_protecao (distribuidora, municipio, uf, comprimento_km, score_vulnerabilidade, geom)
    WITH religadores_buf AS (
      SELECT
        r_mt.id AS rede_id,
        ST_Union(ST_Buffer(rel.geom::geography, :raio_m)::geometry) AS buf
      FROM rede_mt r_mt
      LEFT JOIN religadores rel
        ON r_mt.distribuidora = rel.distribuidora
        AND ST_DWithin(r_mt.geom::geography, rel.geom::geography, :raio_m)
      GROUP BY r_mt.id
    ),
    gaps_raw AS (
      SELECT
        r.id,
        r.distribuidora,
        r.municipio,
        r.uf,
        CASE
          WHEN rb.buf IS NOT NULL
          THEN ST_Difference(r.geom, rb.buf)
          ELSE r.geom
        END AS gap_geom
      FROM rede_mt r
      LEFT JOIN religadores_buf rb ON r.id = rb.rede_id
      {where_clause.replace("r.", "r.")}
    ),
    gaps_filtered AS (
      SELECT
        id, distribuidora, municipio, uf, gap_geom,
        ST_Length(ST_Transform(gap_geom, 31983)) AS len_m
      FROM gaps_raw
      WHERE gap_geom IS NOT NULL
        AND NOT ST_IsEmpty(gap_geom)
        AND ST_Length(ST_Transform(gap_geom, 31983)) > 100
    )
    SELECT
      distribuidora,
      municipio,
      uf,
      ROUND((len_m / 1000.0)::numeric, 3) AS comprimento_km,
      LEAST(ROUND((len_m / 1000.0 / 10.0 * 100)::numeric, 1), 100.0) AS score_vulnerabilidade,
      gap_geom::geometry(LineString, 4674) AS geom
    FROM gaps_filtered
    ORDER BY len_m DESC
    """

    try:
        with engine.begin() as conn:
            for stmt in gaps_sql.strip().split(";"):
                stmt = stmt.strip()
                if stmt:
                    conn.execute(text(stmt), params)

        # Query results
        with engine.connect() as conn:
            count_row = conn.execute(text(
                f"SELECT COUNT(*), COALESCE(SUM(comprimento_km), 0) FROM gaps_protecao {delete_where}"
            ), params).fetchone()
            total_gaps = count_row[0] if count_row else 0
            total_km = float(count_row[1]) if count_row else 0.0

            # Worst municipality
            worst = conn.execute(text(
                f"""SELECT municipio, SUM(comprimento_km) AS km_total
                    FROM gaps_protecao {delete_where}
                    GROUP BY municipio ORDER BY km_total DESC LIMIT 1"""
            ), params).fetchone()

        log.info("Gaps calculated: %d segments, %.1f km total exposed.", total_gaps, total_km)
        if worst:
            log.info("Worst municipality: %s (%.1f km exposed)", worst[0], float(worst[1]))

        return total_gaps

    except Exception as exc:
        log.error("Error calculating gaps: %s", exc, exc_info=True)
        raise


@click.command()
@click.option("--distribuidora", default=None, help="Filter by distributor name.")
@click.option("--uf", default=None, help="Filter by state (2-letter code).")
@click.option("--raio_m", default=500, show_default=True, type=int,
              help="Recloser coverage radius in meters.")
@click.option("--db-url", "db_url", default=None, envvar="DATABASE_URL",
              help="SQLAlchemy database URL.")
def main(distribuidora: Optional[str], uf: Optional[str], raio_m: int, db_url: Optional[str]) -> None:
    """Calculate protection gaps in MT network and store in gaps_protecao table."""
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL is not set.")
        sys.exit(1)

    engine = create_engine(db_url, pool_pre_ping=True)
    started = datetime.now()

    if not distribuidora and not uf:
        log.warning("No filters specified — processing ALL data. This may take a while.")

    count = calculate_gaps(distribuidora, uf, raio_m, engine)
    elapsed = (datetime.now() - started).total_seconds()
    log.info("Done. %d gap segments found in %.1fs.", count, elapsed)


if __name__ == "__main__":
    main()
