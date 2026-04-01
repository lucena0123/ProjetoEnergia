#!/usr/bin/env python3
"""
ingest_bdgd.py — GridRisk pipeline step 1

Ingests layers from a BDGD GeoPackage file (.gpkg) into the PostgreSQL/PostGIS
database, normalising column names and reprojecting to EPSG:4674 (SIRGAS 2000).

Usage:
    python ingest_bdgd.py \
        --arquivo /path/to/bdgd.gpkg \
        --distribuidora "CEMIG-D" \
        --uf MG \
        [--db-url postgresql://user:pass@host/db]
"""

import os
import sys
import logging
from datetime import datetime

import click
import geopandas as gpd
from dotenv import load_dotenv
from sqlalchemy import create_engine

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
# Layer configuration
# ---------------------------------------------------------------------------
# Maps BDGD layer name  →  (target table, {target_col: source_col, ...})
# 'geom' always maps to the GeoDataFrame geometry column
LAYER_MAP: dict[str, tuple[str, dict[str, str]]] = {
    "SSDMT": (
        "rede_mt",
        {
            "cod_id": "COD_ID",
            "tensao_nom": "TEN_NOM",
            "condutor": "TIP_CND",
            "comprimento": "COMP_TREC",
            "data_implant": "DAT_INS",
            "geom": "geometry",
        },
    ),
    "SSDBT": (
        "rede_bt",
        {
            "cod_id": "COD_ID",
            "condutor": "TIP_CND",
            "comprimento": "COMP_TREC",
            "data_implant": "DAT_INS",
            "geom": "geometry",
        },
    ),
    "UNSDAT": (
        "transformadores",
        {
            "cod_id": "COD_ID",
            "potencia_nom": "POT_NOM",
            "fabricante": "FAB",
            "data_implant": "DAT_INS",
            "geom": "geometry",
        },
    ),
    "EQRE": (
        "religadores",
        {
            "cod_id": "COD_ID",
            "data_implant": "DAT_INS",
            "geom": "geometry",
        },
    ),
    "EQSE": (
        "subestacoes",
        {
            "cod_id": "COD_ID",
            "tensao_nom": "TEN_NOM",
            "data_implant": "DAT_INS",
            "geom": "geometry",
        },
    ),
}

TARGET_CRS = "EPSG:4674"
CHUNK_SIZE = 5_000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts() -> str:
    """Return current timestamp as a readable string."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _list_layers(arquivo: str) -> list[str]:
    """Return all layer names present in the GeoPackage."""
    import fiona  # fiona is a geopandas dependency

    try:
        return fiona.listlayers(arquivo)
    except Exception as exc:  # noqa: BLE001
        log.error("Could not list layers in %s: %s", arquivo, exc)
        return []


def _read_layer(arquivo: str, layer: str) -> gpd.GeoDataFrame | None:
    """Read a single layer from the GeoPackage. Returns None on failure."""
    try:
        log.info("[%s] Reading layer '%s' …", _ts(), layer)
        gdf = gpd.read_file(arquivo, layer=layer, engine="pyogrio")
        log.info("[%s] Layer '%s' loaded: %d features", _ts(), layer, len(gdf))
        return gdf
    except Exception as exc:  # noqa: BLE001
        log.error("Failed to read layer '%s': %s", layer, exc)
        return None


def _reproject(gdf: gpd.GeoDataFrame, layer: str) -> gpd.GeoDataFrame:
    """Reproject to TARGET_CRS if necessary."""
    if gdf.crs is None:
        log.warning("Layer '%s' has no CRS defined; assuming %s.", layer, TARGET_CRS)
        gdf = gdf.set_crs(TARGET_CRS)
    elif gdf.crs.to_epsg() != 4674:
        log.info(
            "Layer '%s': reprojecting %s → %s",
            layer,
            gdf.crs.to_string(),
            TARGET_CRS,
        )
        gdf = gdf.to_crs(TARGET_CRS)
    return gdf


def _normalise_columns(
    gdf: gpd.GeoDataFrame,
    col_map: dict[str, str],
    distribuidora: str,
    uf: str,
) -> gpd.GeoDataFrame:
    """
    Rename source columns to target names, add metadata columns, and select
    only the final target columns.  Missing source columns are added as None.
    """
    # Geometry column name may vary; normalise it to 'geometry' first so the
    # col_map entry {"geom": "geometry"} always works.
    if gdf.geometry.name != "geometry":
        gdf = gdf.rename_geometry("geometry")

    # Build a rename dict for columns that actually exist in the GDF
    rename: dict[str, str] = {}
    for target, source in col_map.items():
        if target == "geom":
            # geometry is handled separately via rename_geometry above
            continue
        if source in gdf.columns:
            rename[source] = target
        else:
            log.debug("Source column '%s' not found; will be set to None.", source)

    gdf = gdf.rename(columns=rename)

    # Add any target columns that were not mapped (source missing)
    for target, source in col_map.items():
        if target == "geom":
            continue
        if target not in gdf.columns:
            gdf[target] = None

    # Add metadata columns
    gdf["distribuidora"] = distribuidora
    gdf["municipio"] = ""
    gdf["uf"] = uf

    # Build the final ordered column list
    # non-geometry target columns + metadata + geometry
    non_geom_targets = [t for t in col_map if t != "geom"]
    final_cols = non_geom_targets + ["distribuidora", "municipio", "uf", "geometry"]

    # Keep only columns that are actually present
    final_cols = [c for c in final_cols if c in gdf.columns or c == "geometry"]

    return gdf[final_cols]


def _write_layer(
    gdf: gpd.GeoDataFrame,
    table: str,
    engine,
    layer: str,
) -> int:
    """Write GeoDataFrame to PostGIS table. Returns number of rows inserted."""
    count = len(gdf)
    log.info(
        "[%s] Writing %d rows to table '%s' (chunksize=%d) …",
        _ts(),
        count,
        table,
        CHUNK_SIZE,
    )
    gdf.to_postgis(
        name=table,
        con=engine,
        if_exists="append",
        index=False,
        chunksize=CHUNK_SIZE,
    )
    log.info("[%s] Layer '%s' → table '%s': %d rows written.", _ts(), layer, table, count)
    return count


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option(
    "--arquivo",
    required=True,
    type=click.Path(exists=True, readable=True),
    help="Path to the BDGD GeoPackage (.gpkg) file.",
)
@click.option(
    "--distribuidora",
    required=True,
    type=str,
    help="Distribution company identifier (e.g. 'CEMIG-D').",
)
@click.option(
    "--uf",
    required=True,
    type=str,
    callback=lambda _ctx, _param, v: v.upper(),
    help="Two-letter state code (e.g. 'MG').",
)
@click.option(
    "--db-url",
    "db_url",
    default=None,
    envvar="DATABASE_URL",
    show_envvar=True,
    help="SQLAlchemy database URL.  Falls back to DATABASE_URL env variable.",
)
def main(arquivo: str, distribuidora: str, uf: str, db_url: str | None) -> None:
    """Ingest BDGD layers from a GeoPackage into the GridRisk PostGIS database."""

    # Load .env for DATABASE_URL if not explicitly provided
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")

    if not db_url:
        log.error(
            "No database URL supplied.  "
            "Set --db-url or the DATABASE_URL environment variable."
        )
        sys.exit(1)

    if len(uf) != 2:
        log.error("--uf must be exactly 2 characters (got '%s').", uf)
        sys.exit(1)

    log.info("=== BDGD Ingest started at %s ===", _ts())
    log.info("File         : %s", arquivo)
    log.info("Distribuidora: %s", distribuidora)
    log.info("UF           : %s", uf)

    # Create SQLAlchemy engine
    try:
        engine = create_engine(db_url, future=True)
        # Smoke-test the connection
        with engine.connect():
            pass
        log.info("Database connection OK.")
    except Exception as exc:  # noqa: BLE001
        log.error("Cannot connect to database: %s", exc)
        sys.exit(1)

    # List layers in the file
    available_layers = _list_layers(arquivo)
    if not available_layers:
        log.error("No layers found in '%s'.  Aborting.", arquivo)
        sys.exit(1)

    log.info("Layers found in file: %s", available_layers)

    totals: dict[str, int] = {}

    for bdgd_layer, (table, col_map) in LAYER_MAP.items():
        if bdgd_layer not in available_layers:
            log.warning("Layer '%s' not present in file — skipping.", bdgd_layer)
            continue

        log.info("--- Processing layer '%s' → table '%s' ---", bdgd_layer, table)

        try:
            # 1. Read
            gdf = _read_layer(arquivo, bdgd_layer)
            if gdf is None or gdf.empty:
                log.warning("Layer '%s' is empty — skipping.", bdgd_layer)
                continue

            raw_count = len(gdf)

            # 2. Reproject
            gdf = _reproject(gdf, bdgd_layer)

            # 3. Normalise columns
            gdf = _normalise_columns(gdf, col_map, distribuidora, uf)

            log.info(
                "[%s] Layer '%s': %d features ready for import.",
                _ts(),
                bdgd_layer,
                raw_count,
            )

            # 4. Write to PostGIS
            inserted = _write_layer(gdf, table, engine, bdgd_layer)
            totals[bdgd_layer] = inserted

        except Exception as exc:  # noqa: BLE001
            log.error(
                "Unhandled error processing layer '%s': %s — layer skipped.",
                bdgd_layer,
                exc,
                exc_info=True,
            )
            totals[bdgd_layer] = -1  # -1 signals failure

    # Summary
    log.info("=== Ingest summary ===")
    for layer, count in totals.items():
        status = f"{count} rows" if count >= 0 else "FAILED"
        log.info("  %-12s : %s", layer, status)
    log.info("=== BDGD Ingest finished at %s ===", _ts())


if __name__ == "__main__":
    main()
