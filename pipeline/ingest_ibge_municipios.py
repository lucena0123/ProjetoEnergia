#!/usr/bin/env python3
"""
ingest_ibge_municipios.py — GridRisk pipeline: IBGE municipality boundaries

Downloads municipality boundaries from the public IBGE API and inserts them
into the ibge_municipios table.  The operation is idempotent: existing rows
for a given UF are deleted before re-inserting.

Data sources (both public and free):
  Geometry: https://servicodados.ibge.gov.br/api/v3/malhas/estados/{code}?intrarregiao=municipio
  Names:    https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios

Usage:
    python ingest_ibge_municipios.py --uf AL
    python ingest_ibge_municipios.py --uf ALL   # all 27 states
    python ingest_ibge_municipios.py --uf SP --db-url postgresql://user:pass@host/db
"""

import os
import sys
import time
import logging
import unicodedata
from datetime import datetime
from typing import Optional

import click
import requests
import geopandas as gpd
from shapely.geometry import shape, MultiPolygon, Polygon
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# IBGE state code mapping (2-letter abbreviation → IBGE numeric code)
# ---------------------------------------------------------------------------
UF_CODES: dict[str, int] = {
    "AC": 12, "AL": 27, "AP": 16, "AM": 13, "BA": 29, "CE": 23,
    "DF": 53, "ES": 32, "GO": 52, "MA": 21, "MT": 51, "MS": 50,
    "MG": 31, "PA": 15, "PB": 25, "PR": 41, "PE": 26, "PI": 22,
    "RJ": 33, "RN": 24, "RS": 43, "RO": 11, "RR": 14, "SC": 42,
    "SP": 35, "SE": 28, "TO": 17,
}

IBGE_MALHAS_URL = (
    "https://servicodados.ibge.gov.br/api/v3/malhas/estados"
    "/{code}?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=intermediaria"
)
IBGE_NOMES_URL = (
    "https://servicodados.ibge.gov.br/api/v1/localidades/estados"
    "/{uf}/municipios"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalize(text: str) -> str:
    """Lowercase + strip accents (matches the unaccent(lower()) DB expression)."""
    nfkd = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def fetch_json(url: str, retries: int = 3, backoff: float = 2.0) -> object:
    """GET JSON with simple retry logic."""
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


def to_multipolygon(geom) -> MultiPolygon:
    """Ensure geometry is MultiPolygon (IBGE returns both Polygon and MultiPolygon)."""
    if isinstance(geom, Polygon):
        return MultiPolygon([geom])
    if isinstance(geom, MultiPolygon):
        return geom
    raise ValueError(f"Unexpected geometry type: {type(geom)}")


# ---------------------------------------------------------------------------
# Core ingestion per UF
# ---------------------------------------------------------------------------

def ingest_uf(uf: str, engine) -> int:
    """Download and insert IBGE boundaries for a single UF. Returns row count."""
    uf = uf.upper()
    if uf not in UF_CODES:
        raise click.BadParameter(f"UF '{uf}' not recognised. Valid values: {', '.join(sorted(UF_CODES))}")

    code = UF_CODES[uf]
    log.info("[%s] Fetching municipality names from IBGE localidades API...", uf)
    nomes_data = fetch_json(IBGE_NOMES_URL.format(uf=uf))
    # Build dict: "7-digit code str" → "municipality name"
    nomes: dict[str, str] = {str(m["id"]): m["nome"] for m in nomes_data}
    log.info("[%s] %d municipality names loaded.", uf, len(nomes))

    log.info("[%s] Fetching municipality geometry from IBGE malhas API (intrarregiao=municipio)...", uf)
    geojson = fetch_json(IBGE_MALHAS_URL.format(code=code))

    features = geojson.get("features", [])
    if not features:
        log.warning("[%s] No features returned from malhas API.", uf)
        return 0

    rows = []
    missing_names = 0
    for feat in features:
        codigo = str(feat["properties"].get("codarea", "")).strip()
        if not codigo:
            continue
        nome = nomes.get(codigo)
        if nome is None:
            missing_names += 1
            nome = f"Município {codigo}"  # fallback — won't match mapa_risco
        geom = to_multipolygon(shape(feat["geometry"]))
        rows.append({
            "codigo_ibge": codigo,
            "nome": nome,
            "nome_norm": normalize(nome),
            "uf": uf,
            "geom": geom,
        })

    if missing_names:
        log.warning("[%s] %d features had no name match — used fallback.", uf, missing_names)

    gdf = gpd.GeoDataFrame(rows, geometry="geom", crs="EPSG:4674")

    with engine.begin() as conn:
        deleted = conn.execute(
            text("DELETE FROM ibge_municipios WHERE uf = :uf"), {"uf": uf}
        ).rowcount
        if deleted:
            log.info("[%s] Deleted %d existing rows before re-insert.", uf, deleted)

    gdf.to_postgis(
        "ibge_municipios",
        engine,
        if_exists="append",
        index=False,
        chunksize=500,
    )
    log.info("[%s] Inserted %d municipality boundaries.", uf, len(gdf))
    return len(gdf)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option(
    "--uf",
    required=True,
    type=str,
    help=(
        "2-letter state abbreviation (e.g. AL, SP) or 'ALL' to import all 27 states."
    ),
)
@click.option(
    "--db-url",
    "db_url",
    default=None,
    envvar="DATABASE_URL",
    show_envvar=True,
    help="SQLAlchemy database URL. Falls back to DATABASE_URL env variable.",
)
def main(uf: str, db_url: Optional[str]) -> None:
    """Download IBGE municipality boundaries and load into ibge_municipios table."""
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL is not set. Pass --db-url or set the environment variable.")
        sys.exit(1)

    engine = create_engine(db_url, pool_pre_ping=True)

    started = datetime.now()

    if uf.upper() == "ALL":
        target_ufs = sorted(UF_CODES.keys())
        log.info("Importing all %d states...", len(target_ufs))
    else:
        target_ufs = [uf.upper()]

    total = 0
    errors = []
    for state in target_ufs:
        try:
            count = ingest_uf(state, engine)
            total += count
        except Exception as exc:
            log.error("[%s] Failed: %s", state, exc)
            errors.append(state)

    elapsed = (datetime.now() - started).total_seconds()
    log.info(
        "Done. %d boundaries inserted across %d state(s) in %.1fs.",
        total, len(target_ufs) - len(errors), elapsed,
    )
    if errors:
        log.warning("Failed states: %s", ", ".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
