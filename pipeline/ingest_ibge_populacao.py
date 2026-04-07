#!/usr/bin/env python3
"""
ingest_ibge_populacao.py — GridRisk pipeline: IBGE population data

Downloads municipality population estimates from the IBGE SIDRA API and inserts
them into the ibge_populacao table. The operation is idempotent.

Usage:
    python ingest_ibge_populacao.py --uf AL
    python ingest_ibge_populacao.py --uf ALL
"""

import os
import sys
import time
import logging
from datetime import datetime
from typing import Optional

import click
import requests
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

UF_CODES: dict[str, int] = {
    "AC": 12, "AL": 27, "AP": 16, "AM": 13, "BA": 29, "CE": 23,
    "DF": 53, "ES": 32, "GO": 52, "MA": 21, "MT": 51, "MS": 50,
    "MG": 31, "PA": 15, "PB": 25, "PR": 41, "PE": 26, "PI": 22,
    "RJ": 33, "RN": 24, "RS": 43, "RO": 11, "RR": 14, "SC": 42,
    "SP": 35, "SE": 28, "TO": 17,
}

IBGE_MUNICIPIOS_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios"
SIDRA_POP_YEAR = "2025"
IBGE_POP_URL = (
    f"https://apisidra.ibge.gov.br/values/t/6579/n6/all/v/9324/p/{SIDRA_POP_YEAR}?formato=json"
)


def fetch_json(url: str, retries: int = 3, backoff: float = 2.0) -> object:
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, timeout=60)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            if attempt == retries:
                raise
            log.warning("Request failed (attempt %d/%d): %s", attempt, retries, exc)
            time.sleep(backoff ** attempt)
    raise RuntimeError("unreachable")


def build_population_map(pop_rows: list[dict]) -> dict[str, int]:
    pop_map: dict[str, int] = {}
    for item in pop_rows:
        codigo = str(item.get("D1C", "")).strip()
        valor = str(item.get("V", "")).strip()
        if not codigo or not valor or valor == "...":
            continue
        try:
            pop_map[codigo] = int(float(valor))
        except (ValueError, TypeError):
            continue
    return pop_map


def ingest_uf(uf: str, engine, population_rows: Optional[list[dict]] = None) -> int:
    uf = uf.upper()
    if uf not in UF_CODES:
        raise click.BadParameter(f"UF '{uf}' not recognised.")

    log.info("[%s] Fetching municipality list...", uf)
    municipios = fetch_json(IBGE_MUNICIPIOS_URL.format(uf=uf))
    # Build dict: code -> name
    mun_map: dict[str, str] = {str(m["id"]): m["nome"] for m in municipios}
    log.info("[%s] %d municipalities found.", uf, len(mun_map))

    if population_rows is None:
        log.info("[%s] Fetching population estimates (%s SIDRA)...", uf, SIDRA_POP_YEAR)
        population_rows = fetch_json(IBGE_POP_URL)

    pop_map = build_population_map(population_rows[1:] if isinstance(population_rows, list) else [])

    # Get area from ibge_municipios if available
    area_map: dict[str, float] = {}
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT codigo_ibge, ST_Area(ST_Transform(geom, 31983)) / 1e6 AS area_km2 "
                "FROM ibge_municipios WHERE uf = :uf"
            ), {"uf": uf}).fetchall()
            area_map = {r[0]: float(r[1]) for r in rows}
    except Exception as exc:
        log.warning("Could not fetch area from ibge_municipios: %s", exc)

    rows_to_insert = []
    for codigo, nome in mun_map.items():
        populacao = pop_map.get(codigo, 0)
        area_km2 = area_map.get(codigo)
        domicilios = int(populacao * 0.35) if populacao else 0
        rows_to_insert.append({
            "codigo_ibge": codigo,
            "municipio": nome,
            "uf": uf,
            "populacao": populacao,
            "domicilios": domicilios,
            "pib_per_capita": None,
            "area_km2": area_km2,
        })

    if not rows_to_insert:
        log.warning("[%s] No population data to insert.", uf)
        return 0

    with engine.begin() as conn:
        for row in rows_to_insert:
            conn.execute(text("""
                INSERT INTO ibge_populacao
                  (codigo_ibge, municipio, uf, populacao, domicilios, pib_per_capita, area_km2, atualizado_em)
                VALUES
                  (:codigo_ibge, :municipio, :uf, :populacao, :domicilios, :pib_per_capita, :area_km2, NOW())
                ON CONFLICT (codigo_ibge) DO UPDATE SET
                  populacao     = EXCLUDED.populacao,
                  domicilios    = EXCLUDED.domicilios,
                  area_km2      = COALESCE(EXCLUDED.area_km2, ibge_populacao.area_km2),
                  atualizado_em = NOW()
            """), row)

    log.info("[%s] %d population records upserted.", uf, len(rows_to_insert))
    return len(rows_to_insert)


@click.command()
@click.option("--uf", required=True, type=str,
              help="2-letter state code (e.g. AL) or ALL for all states.")
@click.option("--db-url", "db_url", default=None, envvar="DATABASE_URL",
              help="SQLAlchemy database URL.")
def main(uf: str, db_url: Optional[str]) -> None:
    """Download IBGE population data and load into ibge_populacao table."""
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL is not set.")
        sys.exit(1)

    engine = create_engine(db_url, pool_pre_ping=True)
    started = datetime.now()

    if uf.upper() == "ALL":
        target_ufs = sorted(UF_CODES.keys())
        log.info("Importing population for all %d states...", len(target_ufs))
    else:
        target_ufs = [uf.upper()]

    population_rows = fetch_json(IBGE_POP_URL)
    total = 0
    errors = []
    for state in target_ufs:
        try:
            count = ingest_uf(state, engine, population_rows)
            total += count
        except Exception as exc:
            log.error("[%s] Failed: %s", state, exc)
            errors.append(state)

    elapsed = (datetime.now() - started).total_seconds()
    log.info("Done. %d records inserted in %.1fs.", total, elapsed)
    if errors:
        log.warning("Failed states: %s", ", ".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
