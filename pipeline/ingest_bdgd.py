#!/usr/bin/env python3
"""
ingest_bdgd.py — GridRisk pipeline step 1

Ingests layers from official ANEEL BDGD datasets into PostgreSQL/PostGIS,
normalising column names and reprojecting to EPSG:4674 (SIRGAS 2000).

Supported input formats:
  - GeoPackage (.gpkg)
  - File Geodatabase directory (.gdb)
  - Zipped File Geodatabase (.gdb.zip / .zip containing a .gdb directory)

Usage:
    python ingest_bdgd.py \
        --arquivo /path/to/bdgd.gdb.zip \
        --distribuidora "CEMIG-D" \
        --uf MG \
        [--db-url postgresql://user:pass@host/db]
"""

import logging
import os
import re
import sys
import tempfile
import zipfile
import json
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import click
import geopandas as gpd
import pandas as pd
from dotenv import load_dotenv
from geoalchemy2 import Geometry
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import create_engine, text
from shapely.geometry import LineString, MultiLineString, Point

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

UNSEMT_TIPO_UNID_LABELS: dict[str, str] = {
    "16": "Chave Telecomandada",
    "17": "SUB",
    "19": "Chave Seccionadora",
    "22": "Chave Fusível",
    "27": "Chave Fusível Religadora",
    "29": "Disjuntor",
    "31": "Chave Lâmina",
    "32": "Religador",
    "33": "Chave Seccionadora Tripolar",
    "34": "Chave Seccionadora Monopolar",
    "35": "Seccionalizador",
    "36": "Chave Seccionadora Monopolar",
    "49": "Chave Seccionadora Monopolar",
    "57": "Chave Telecomandada",
}

_CODE_LIKE_PATTERN = re.compile(r"^[0-9A-Z_:/.\-]+$")

# ---------------------------------------------------------------------------
# Layer configuration
# ---------------------------------------------------------------------------
# Maps BDGD layer name  → runtime import specification.
# The official AL/CE BDGD datasets expose the operational assets we need via:
#   SSDMT   → rede_mt
#   SSDBT   → rede_bt
#   CTMT    → alimentadores
#   UNTRMT  → transformadores
#   UNREMT  → religadores
#   UNSEMT  → chaves / dispositivos de manobra MT
#   SUB     → subestacoes
# 'geom' always maps to the GeoDataFrame geometry column.
LAYER_MAP: dict[str, dict[str, object]] = {
    "SSDMT": {
        "source_layers": ["SSDMT"],
        "table": "rede_mt",
        "col_map": {
            "cod_id": "COD_ID",
            "alimentador_id": "CTMT",
            "condutor": "TIP_CND",
            "comprimento": "COMP",
            "tensao_nom": "TEN_NOM",
            "data_implant": None,
            "geom": "geometry",
        },
        "municipio_strategy": "spatial",
        "geometry_mode": "multiline",
    },
    "SSDBT": {
        "source_layers": ["SSDBT"],
        "table": "rede_bt",
        "col_map": {
            "cod_id": "COD_ID",
            "alimentador_id": "CTMT",
            "condutor": "TIP_CND",
            "comprimento": "COMP",
            "data_implant": None,
            "geom": "geometry",
        },
        "municipio_strategy": "spatial",
        "geometry_mode": "multiline",
    },
    "CTMT": {
        "source_layers": ["CTMT"],
        "table": "alimentadores",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": "SUB",
            "n_consumidores": None,
            "comprimento_km": None,
            "tensao_nom": "TEN_NOM",
            "data_implant": None,
            "geom": "geometry",
        },
        "municipio_strategy": "spatial",
        "geometry_mode": "multiline",
        "derive_length_km": True,
        "aggregate_geometry_from": {
            "layer": "SSDMT",
            "source_column": "CTMT",
            "target_column": "COD_ID",
        },
    },
    "UNTRMT": {
        "source_layers": ["UNTRMT"],
        "table": "transformadores",
        "col_map": {
            "cod_id": "COD_ID",
            "alimentador_id": "CTMT",
            "potencia_nom": "POT_NOM",
            "fabricante": None,
            "data_implant": "DAT_CON",
            "geom": "geometry",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
    },
    "UNREMT": {
        "source_layers": ["UNREMT"],
        "table": "religadores",
        "col_map": {
            "cod_id": "COD_ID",
            "alimentador_id": "CTMT",
            "data_implant": "DAT_CON",
            "geom": "geometry",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
    },
    "UNSEMT": {
        "source_layers": ["UNSEMT"],
        "table": "chaves",
        "col_map": {
            "cod_id": "COD_ID",
            "alimentador_id": "CTMT",
            "tipo_chave": "DESCR",
            "operacao": "P_N_OPE",
            "data_implant": "DAT_CON",
            "geom": "geometry",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
    },
    "SUB": {
        "source_layers": ["SUB", "SUBESTACOES", "SUBESTACAO"],
        "table": "subestacoes",
        "col_map": {
            "cod_id": "COD_ID",
            "tensao_nom": None,
            "data_implant": None,
            "geom": "geometry",
        },
        "municipio_strategy": "spatial",
        "geometry_mode": "point",
    },
    "CTAT": {
        "source_layers": ["CTAT"],
        "table": "alimentadores_at",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": None,
            "nome": "NOME",
            "descricao": "DESCR",
            "pac_ini": "PAC_INI",
            "tensao_nom": "TEN_NOM",
            "comprimento_km": None,
            "geom": "geometry",
        },
        "municipio_strategy": "spatial",
        "geometry_mode": "multiline",
        "derive_length_km": True,
        "attach_nearest_substation": True,
        "aggregate_geometry_from": {
            "layer": "SSDAT",
            "source_column": "CTAT",
            "target_column": "COD_ID",
        },
        "write_raw_also": True,
    },
    "SSDAT": {
        "source_layers": ["SSDAT"],
        "table": "rede_at",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": None,
            "alimentador_at_id": "CTAT",
            "condutor": "TIP_CND",
            "comprimento": "COMP",
            "descricao": "DESCR",
            "tip_inst": "TIP_INST",
            "geom": "geometry",
        },
        "municipio_strategy": "spatial",
        "geometry_mode": "multiline",
        "attach_nearest_substation": True,
        "write_raw_also": True,
    },
    "UNTRAT": {
        "source_layers": ["UNTRAT"],
        "table": "transformadores_at",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": "SUB",
            "potencia_nom": "POT_NOM",
            "tipo_trafo": "TIP_TRAFO",
            "data_implant": "DAT_CON",
            "descricao": "DESCR",
            "geom": "geometry",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "write_raw_also": True,
    },
    "UNREAT": {
        "source_layers": ["UNREAT"],
        "table": "religadores_at",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": "SUB",
            "tipo_regu": "TIP_REGU",
            "data_implant": "DAT_CON",
            "descricao": "DESCR",
            "geom": "geometry",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "write_raw_also": True,
    },
    "UNSEAT": {
        "source_layers": ["UNSEAT"],
        "table": "chaves_at",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": "SUB",
            "tipo_chave": "DESCR",
            "operacao": "P_N_OPE",
            "data_implant": "DAT_CON",
            "descricao": "DESCR",
            "geom": "geometry",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "write_raw_also": True,
    },
    "BAR": {
        "source_layers": ["BAR"],
        "table": "subestacao_componentes",
        "col_map": {},
        "component_type": "BAR",
        "write_raw_also": True,
        "shared_target_scope_key": "component_type",
    },
    "BASE": {
        "source_layers": ["BASE"],
        "table": "subestacao_componentes",
        "col_map": {},
        "component_type": "BASE",
        "write_raw_also": True,
        "shared_target_scope_key": "component_type",
    },
    "BAY": {
        "source_layers": ["BAY"],
        "table": "subestacao_componentes",
        "col_map": {},
        "component_type": "BAY",
        "write_raw_also": True,
        "shared_target_scope_key": "component_type",
    },
    "BE": {
        "source_layers": ["BE"],
        "table": "subestacao_componentes",
        "col_map": {},
        "component_type": "BE",
        "write_raw_also": True,
        "shared_target_scope_key": "component_type",
    },
    "UCBT_tab": {
        "source_layers": ["UCBT_tab", "UCBT"],
        "table": "ucbt",
        "col_map": {
            "cod_id": "COD_ID",
            "alimentador_id": "CTMT",
            "transformador_id": "UNI_TR_MT",
            "classe_consumo": "CLAS_SUB",
            "data_ligacao": "DAT_CON",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "tabular": True,
    },
    "UCMT_tab": {
        "source_layers": ["UCMT_tab", "UCMT"],
        "table": "ucmt",
        "col_map": {
            "cod_id": "COD_ID",
            "alimentador_id": "CTMT",
            "classe_consumo": "CLAS_SUB",
            "demanda_contratada": "DEM_CONT",
            "data_ligacao": "DAT_CON",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "tabular": True,
    },
    "UCAT_tab": {
        "source_layers": ["UCAT_tab", "UCAT"],
        "table": "ucat",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": "SUB",
            "circuito_at_id": "CTAT",
            "classe_consumo": "CLAS_SUB",
            "demanda_contratada": "DEM_CONT",
            "descricao": "DESCR",
            "data_ligacao": "DAT_CON",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "tabular": True,
        "write_raw_also": True,
    },
    "UGAT_tab": {
        "source_layers": ["UGAT_tab", "UGAT"],
        "table": "ug_at",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": "SUB",
            "circuito_at_id": "CTAT",
            "classe_consumo": "CLAS_SUB",
            "demanda_contratada": "DEM_CONT",
            "descricao": "DESCR",
            "ceg_gd": "CEG_GD",
            "data_ligacao": "DAT_CON",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "tabular": True,
        "write_raw_also": True,
    },
    "UGMT_tab": {
        "source_layers": ["UGMT_tab", "UGMT"],
        "table": "ug_mt",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": "SUB",
            "alimentador_id": "CTMT",
            "classe_consumo": "CLAS_SUB",
            "demanda_contratada": "DEM_CONT",
            "descricao": "DESCR",
            "ceg_gd": "CEG_GD",
            "data_ligacao": "DAT_CON",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "tabular": True,
        "write_raw_also": True,
    },
    "UGBT_tab": {
        "source_layers": ["UGBT_tab", "UGBT"],
        "table": "ug_bt",
        "col_map": {
            "cod_id": "COD_ID",
            "subestacao_id": "SUB",
            "alimentador_id": "CTMT",
            "classe_consumo": "CLAS_SUB",
            "demanda_contratada": "DEM_CONT",
            "descricao": "DESCR",
            "ceg_gd": "CEG_GD",
            "data_ligacao": "DAT_CON",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "tabular": True,
        "write_raw_also": True,
    },
    "UNSEBT": {
        "source_layers": ["UNSEBT"],
        "table": "chaves_bt",
        "col_map": {
            "cod_id": "COD_ID",
            "alimentador_id": "CTMT",
            "tipo_chave": "DESCR",
            "operacao": "P_N_OPE",
            "data_implant": "DAT_CON",
            "descricao": "DESCR",
            "geom": "geometry",
        },
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "geometry_mode": "point",
        "write_raw_also": True,
    },
    "UNCRAT": {
        "source_layers": ["UNCRAT"],
        "table": "regulacao_reativos",
        "col_map": {},
        "nivel_tensao": "AT",
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "geometry_mode": "point",
        "write_raw_also": True,
        "shared_target_scope_key": "nivel_tensao",
    },
    "UNCRBT": {
        "source_layers": ["UNCRBT"],
        "table": "regulacao_reativos",
        "col_map": {},
        "nivel_tensao": "BT",
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "geometry_mode": "point",
        "write_raw_also": True,
        "shared_target_scope_key": "nivel_tensao",
    },
    "UNCRMT": {
        "source_layers": ["UNCRMT"],
        "table": "regulacao_reativos",
        "col_map": {},
        "nivel_tensao": "MT",
        "municipio_strategy": "codigo_ibge",
        "municipio_code_source": "MUN",
        "active_only": True,
        "geometry_mode": "point",
        "write_raw_also": True,
        "shared_target_scope_key": "nivel_tensao",
    },
    "EQCR": {
        "source_layers": ["EQCR"],
        "table": "equipamentos_tecnicos",
        "col_map": {},
        "family": "EQCR",
        "tabular": True,
        "write_raw_also": True,
        "shared_target_scope_key": "family",
    },
    "EQRE": {
        "source_layers": ["EQRE"],
        "table": "equipamentos_tecnicos",
        "col_map": {},
        "family": "EQRE",
        "tabular": True,
        "write_raw_also": True,
        "shared_target_scope_key": "family",
    },
    "EQSE": {
        "source_layers": ["EQSE"],
        "table": "equipamentos_tecnicos",
        "col_map": {},
        "family": "EQSE",
        "tabular": True,
        "write_raw_also": True,
        "shared_target_scope_key": "family",
    },
    "EQTRAT": {
        "source_layers": ["EQTRAT"],
        "table": "equipamentos_tecnicos",
        "col_map": {},
        "family": "EQTRAT",
        "tabular": True,
        "write_raw_also": True,
        "shared_target_scope_key": "family",
    },
    "EQTRM": {
        "source_layers": ["EQTRM"],
        "table": "equipamentos_tecnicos",
        "col_map": {},
        "family": "EQTRM",
        "tabular": True,
        "write_raw_also": True,
        "shared_target_scope_key": "family",
    },
    "EQTRMT": {
        "source_layers": ["EQTRMT"],
        "table": "equipamentos_tecnicos",
        "col_map": {},
        "family": "EQTRMT",
        "tabular": True,
        "write_raw_also": True,
        "shared_target_scope_key": "family",
    },
}

TARGET_CRS = "EPSG:4674"
CHUNK_SIZE = 5_000
RAW_LAYER_TABLE = "bdgd_raw_features"
CATALOG_TABLE = "bdgd_layer_catalog"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts() -> str:
    """Return current timestamp as a readable string."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _find_extracted_dataset(root: Path) -> Path | None:
    """Return the first supported spatial dataset found inside an extracted archive."""
    gdb_dirs = sorted(p for p in root.rglob("*.gdb") if p.is_dir())
    if gdb_dirs:
        return gdb_dirs[0]

    gpkg_files = sorted(p for p in root.rglob("*.gpkg") if p.is_file())
    if gpkg_files:
        return gpkg_files[0]

    return None


@contextmanager
def _prepare_dataset(arquivo: str):
    """
    Resolve the source dataset into a path readable by Fiona/GeoPandas.

    The official ANEEL BDGD download is a zipped File Geodatabase, so this
    helper transparently extracts `.zip` archives into a temporary directory.
    """
    source = Path(arquivo)
    suffixes = [suffix.lower() for suffix in source.suffixes]

    if source.is_dir():
        if source.suffix.lower() != ".gdb":
            raise RuntimeError(
                f"Unsupported directory input '{arquivo}'. Expected a .gdb directory."
            )
        yield str(source)
        return

    if source.suffix.lower() == ".gpkg":
        yield str(source)
        return

    if source.suffix.lower() == ".zip":
        with tempfile.TemporaryDirectory(prefix="bdgd_extract_") as temp_dir:
            with zipfile.ZipFile(source) as archive:
                archive.extractall(temp_dir)

            dataset = _find_extracted_dataset(Path(temp_dir))
            if dataset is None:
                raise RuntimeError(
                    f"No supported BDGD dataset found inside '{arquivo}'. "
                    "Expected a .gdb directory or .gpkg file."
                )

            log.info("Archive extracted to %s; resolved dataset: %s", temp_dir, dataset)
            yield str(dataset)
        return

    raise RuntimeError(
        f"Unsupported BDGD input '{arquivo}'. "
        "Supported formats: .gpkg, .gdb, .gdb.zip"
    )


def _list_layers(dataset_path: str) -> list[str]:
    """Return all layer names present in the source dataset."""
    import fiona  # fiona is a geopandas dependency

    try:
        return fiona.listlayers(dataset_path)
    except Exception as exc:  # noqa: BLE001
        log.error("Could not list layers in %s: %s", dataset_path, exc)
        return []


def _inspect_layer(dataset_path: str, layer: str) -> dict[str, object]:
    """Return lightweight metadata for a BDGD layer without fully loading it."""
    import fiona  # fiona is a geopandas dependency

    with fiona.open(dataset_path, layer=layer) as src:
        schema = src.schema or {}
        property_names = list((schema.get("properties") or {}).keys())
        geometry_type = schema.get("geometry")
        feature_count = len(src)

    has_geometry = geometry_type not in (None, "", "None", "Unknown")
    return {
        "column_names": property_names,
        "geometry_type": geometry_type if has_geometry else None,
        "has_geometry": has_geometry,
        "feature_count": feature_count,
    }


def _read_layer(
    dataset_path: str,
    layer: str,
    source_columns: list[str] | None = None,
) -> gpd.GeoDataFrame | None:
    """Read a single layer from the source dataset. Returns None on failure."""
    try:
        log.info("[%s] Reading layer '%s' …", _ts(), layer)
        read_kwargs = {"layer": layer, "engine": "pyogrio"}
        if source_columns:
            read_kwargs["columns"] = sorted(set(source_columns))
        gdf = gpd.read_file(dataset_path, **read_kwargs)
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


def _is_textual_unsemt_description(value: object) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    if text.upper() == "SUB":
        return True
    return not _CODE_LIKE_PATTERN.fullmatch(text)


def _derive_unsemt_tipo_chave(row: pd.Series) -> str | None:
    tip_unid = str(row.get("TIP_UNID") or "").strip()
    cod_id = str(row.get("COD_ID") or "").strip().upper()
    descr = str(row.get("DESCR") or "").strip()

    if "CSTP" in cod_id:
        return "Chave Seccionadora Tripolar"
    if "CSMP" in cod_id:
        return "Chave Seccionadora Monopolar"

    mapped = UNSEMT_TIPO_UNID_LABELS.get(tip_unid)
    if mapped:
        return mapped

    if _is_textual_unsemt_description(descr):
        return descr

    return f"TIP_UNID {tip_unid}" if tip_unid else None


def _filter_layer_rows(gdf: gpd.GeoDataFrame, layer: str) -> gpd.GeoDataFrame:
    """Apply lightweight, layer-specific cleanup before normalization."""
    working = gdf.copy()

    if "SIT_ATIV" in working.columns:
        active_mask = working["SIT_ATIV"].astype(str).str.strip().eq("AT")
        removed = int((~active_mask).sum())
        if removed:
            log.info(
                "[%s] Layer '%s': filtered %d inactive rows.",
                _ts(),
                layer,
                removed,
            )
        working = working.loc[active_mask].copy()

    if layer in {"UNSEMT", "UNSEAT", "UNSEBT"}:
        working["DESCR"] = working.apply(_derive_unsemt_tipo_chave, axis=1)
        descricao = working["DESCR"].fillna("").astype(str).str.strip().str.casefold()
        excluded = {"sub", "religador"}
        keep_mask = ~descricao.isin(excluded)
        removed = int((~keep_mask).sum())
        if removed:
            log.info(
                "[%s] Layer '%s': filtered %d switchgear rows already covered by "
                "substations/reclosers.",
                _ts(),
                layer,
                removed,
            )
        working = working.loc[keep_mask].copy()

    return working


def _load_subestacao_lookup(engine, distribuidora: str, uf: str) -> gpd.GeoDataFrame:
    """Load the current substation lookup for the target scope."""
    lookup = gpd.read_postgis(
        """
        SELECT cod_id, municipio, uf, geom
        FROM subestacoes
        WHERE distribuidora = %(distribuidora)s
          AND uf = %(uf)s
        """,
        engine,
        params={"distribuidora": distribuidora, "uf": uf.upper()},
        geom_col="geom",
    )

    if lookup.empty:
        raise RuntimeError(
            f"No substations available for distribuidora='{distribuidora}' uf='{uf}'. "
            "Import SUB before the dependent AT layers."
        )

    if lookup.crs is None:
        lookup = lookup.set_crs(TARGET_CRS)
    elif lookup.crs.to_string() != TARGET_CRS:
        lookup = lookup.to_crs(TARGET_CRS)

    if lookup.geometry.name != "geometry":
        lookup = lookup.rename_geometry("geometry")

    return lookup.rename(columns={"cod_id": "subestacao_id", "municipio": "subestacao_municipio"})


def _attach_substation_context(
    frame: pd.DataFrame | gpd.GeoDataFrame,
    engine,
    distribuidora: str,
    uf: str,
    layer: str,
    source_col: str = "SUB",
    attach_geometry: bool = False,
) -> pd.DataFrame | gpd.GeoDataFrame:
    """Attach substation id, municipality and optional geometry from the SUB layer."""
    if source_col not in frame.columns:
        log.warning(
            "Layer '%s': substation source column '%s' not found.",
            layer,
            source_col,
        )
        return frame

    lookup = _load_subestacao_lookup(engine, distribuidora, uf)
    working = frame.copy()
    working["subestacao_id"] = working[source_col].astype(str).str.strip()
    merged = working.merge(
        lookup[["subestacao_id", "subestacao_municipio", "geometry"]],
        on="subestacao_id",
        how="left",
        suffixes=("", "_sub"),
    )

    if "municipio" not in merged.columns:
        merged["municipio"] = None

    merged["municipio"] = merged["municipio"].where(
        merged["municipio"].notna() & merged["municipio"].astype(str).str.strip().ne(""),
        merged["subestacao_municipio"],
    )

    if attach_geometry:
        result = gpd.GeoDataFrame(merged, geometry="geometry", crs=TARGET_CRS)
        missing = int(result.geometry.isna().sum())
        if missing:
            log.warning(
                "Layer '%s': %d row(s) could not inherit substation geometry.",
                layer,
                missing,
            )
        return result

    return merged.drop(columns=["geometry"], errors="ignore")


def _line_endpoints(geom) -> list[Point]:
    if geom is None or geom.is_empty:
        return []

    parts: list[LineString] = []
    if isinstance(geom, LineString):
        parts = [geom]
    elif isinstance(geom, MultiLineString):
        parts = list(geom.geoms)
    elif geom.geom_type == "GeometryCollection":
        parts = [part for part in geom.geoms if isinstance(part, LineString)]

    endpoints: list[Point] = []
    for part in parts:
        coords = list(part.coords)
        if not coords:
            continue
        endpoints.append(Point(coords[0]))
        endpoints.append(Point(coords[-1]))

    return endpoints


def _attach_nearest_substation_to_lines(
    gdf: gpd.GeoDataFrame,
    engine,
    distribuidora: str,
    uf: str,
    layer: str,
    max_distance_m: float = 2500,
) -> gpd.GeoDataFrame:
    """Infer the origin substation of AT lines/feeders from the nearest line endpoint."""
    lookup = _load_subestacao_lookup(engine, distribuidora, uf)
    working = gdf.copy()
    row_id_col = "__row_id"
    working[row_id_col] = working.index

    endpoint_records: list[dict[str, object]] = []
    for row_index, geom in working.geometry.items():
        for endpoint in _line_endpoints(geom):
            endpoint_records.append({row_id_col: row_index, "geometry": endpoint})

    if not endpoint_records:
        working["subestacao_id"] = None
        return working.drop(columns=[row_id_col])

    endpoints = gpd.GeoDataFrame(endpoint_records, geometry="geometry", crs=TARGET_CRS)
    endpoints_metric = endpoints.to_crs(3857)
    lookup_metric = lookup.to_crs(3857)

    nearest = gpd.sjoin_nearest(
        endpoints_metric,
        lookup_metric[["subestacao_id", "subestacao_municipio", "geometry"]],
        how="left",
        max_distance=max_distance_m,
        distance_col="dist_m",
    )

    nearest = nearest.sort_values(by=["dist_m"], na_position="last")
    nearest = nearest.drop_duplicates(subset=[row_id_col], keep="first")
    nearest = nearest.set_index(row_id_col)

    working["subestacao_id"] = nearest["subestacao_id"].reindex(working.index)
    missing = int(working["subestacao_id"].isna().sum())
    if missing:
        log.warning(
            "Layer '%s': %d row(s) without inferred AT origin substation.",
            layer,
            missing,
        )

    return working.drop(columns=[row_id_col])


def _resolve_source_layer(spec_key: str, spec: dict[str, object], available_layers: list[str]) -> str | None:
    """Resolve the actual layer name present in the dataset for a runtime spec."""
    candidates = [str(item) for item in spec.get("source_layers", [spec_key])]
    for candidate in candidates:
        if candidate in available_layers:
            return candidate
    return None


def _ensure_multiline_geometries(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Normalize line geometries to MultiLineString for PostGIS compatibility."""

    def to_multiline(geom):
        if geom is None or geom.is_empty:
            return None
        if isinstance(geom, MultiLineString):
            return geom
        if isinstance(geom, LineString):
            return MultiLineString([geom])
        if geom.geom_type == "GeometryCollection":
            lines = []
            for part in geom.geoms:
                if isinstance(part, LineString):
                    lines.append(part)
                elif isinstance(part, MultiLineString):
                    lines.extend(list(part.geoms))
            return MultiLineString(lines) if lines else None
        return geom

    working = gdf.copy()
    working.geometry = working.geometry.apply(to_multiline)
    return working


def _ensure_point_geometries(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Normalize polygonal or mixed geometries into representative points."""
    working = gdf.copy()
    working.geometry = working.geometry.apply(
        lambda geom: None if geom is None or geom.is_empty else geom.representative_point()
    )
    return working


def _normalise_columns(
    gdf: pd.DataFrame,
    col_map: dict[str, str | None],
    distribuidora: str,
    uf: str,
) -> pd.DataFrame:
    """
    Rename source columns to target names, add metadata columns, and select
    only the final target columns.  Missing source columns are added as None.
    """
    # Geometry column name may vary; normalise it to 'geometry' first so the
    # col_map entry {"geom": "geometry"} always works.
    is_geo = isinstance(gdf, gpd.GeoDataFrame)

    if is_geo and gdf.geometry.name != "geometry":
        gdf = gdf.rename_geometry("geometry")

    # Build a rename dict for columns that actually exist in the GDF
    rename: dict[str, str] = {}
    for target, source in col_map.items():
        if target == "geom":
            # geometry is handled separately via rename_geometry above
            continue
        if not source:
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
    if "municipio" not in gdf.columns:
        gdf["municipio"] = None
    gdf["uf"] = uf

    numeric_cols = ("tensao_nom", "comprimento", "potencia_nom", "comprimento_km", "n_consumidores", "demanda_contratada")
    for column in numeric_cols:
        if column in gdf.columns:
            gdf[column] = pd.to_numeric(gdf[column], errors="coerce")

    for date_column in ("data_implant", "data_ligacao"):
        if date_column in gdf.columns:
            gdf[date_column] = pd.to_datetime(
                gdf[date_column],
                format="%d/%m/%Y",
                errors="coerce",
            ).dt.date

    # Build the final ordered column list
    # non-geometry target columns + metadata + geometry
    non_geom_targets = [t for t in col_map if t != "geom"]
    final_cols = non_geom_targets + ["distribuidora", "municipio", "uf"]
    if is_geo:
        final_cols.append("geometry")

    # Keep only columns that are actually present
    final_cols = [c for c in final_cols if c in gdf.columns or c == "geometry"]

    result = gdf[final_cols]
    if is_geo and result.geometry.name != "geom":
        result = result.rename_geometry("geom")
    return result


def _fill_missing_length_km(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Fill missing feeder lengths from geometry when no source metric exists."""
    if "comprimento_km" not in gdf.columns:
        return gdf

    working = gdf.copy()
    missing_mask = working["comprimento_km"].isna()
    if not missing_mask.any():
        return working

    metric_lengths = working.loc[missing_mask].to_crs(3857).geometry.length / 1000.0
    working.loc[missing_mask, "comprimento_km"] = metric_lengths.values
    return working


def _attach_geometry_from_layer(
    dataset_path: str,
    base_df: pd.DataFrame,
    spec: dict[str, object],
) -> gpd.GeoDataFrame:
    """Attach aggregated feeder geometry from a geospatial source layer."""
    aggregate_spec = spec.get("aggregate_geometry_from")
    if not isinstance(aggregate_spec, dict):
        raise RuntimeError("aggregate_geometry_from specification is invalid.")

    layer_name = str(aggregate_spec["layer"])
    source_column = str(aggregate_spec["source_column"])
    target_column = str(aggregate_spec["target_column"])

    geometry_gdf = _read_layer(dataset_path, layer_name, source_columns=[source_column])
    if geometry_gdf is None or geometry_gdf.empty:
        raise RuntimeError(
            f"Geometry source layer '{layer_name}' is empty or unavailable for aggregation."
        )
    if not isinstance(geometry_gdf, gpd.GeoDataFrame):
        raise RuntimeError(
            f"Geometry source layer '{layer_name}' is not geospatial."
        )

    geometry_gdf = _reproject(geometry_gdf, layer_name)
    geometry_gdf = _ensure_multiline_geometries(geometry_gdf)
    geometry_gdf = geometry_gdf.loc[
        geometry_gdf[source_column].notna()
    ][[source_column, geometry_gdf.geometry.name]].copy()
    geometry_gdf[source_column] = geometry_gdf[source_column].astype(str).str.strip()

    aggregated = geometry_gdf.dissolve(by=source_column, as_index=False)
    aggregated = _ensure_multiline_geometries(aggregated)

    working = base_df.copy()
    working[target_column] = working[target_column].astype(str).str.strip()
    merged = working.merge(
        aggregated,
        left_on=target_column,
        right_on=source_column,
        how="left",
    )

    result = gpd.GeoDataFrame(merged, geometry="geometry", crs=TARGET_CRS)
    missing = int(result.geometry.isna().sum())
    if missing:
        log.warning(
            "Aggregated geometry from '%s' missing for %d row(s) in '%s'.",
            layer_name,
            missing,
            target_column,
        )

    if source_column in result.columns and source_column != target_column:
        result = result.drop(columns=[source_column])

    return result


def _assign_municipios_from_code(
    gdf: pd.DataFrame,
    municipios_gdf: gpd.GeoDataFrame,
    layer: str,
    source_col: str,
) -> pd.DataFrame:
    """Assign municipality names from a source IBGE code column, with spatial fallback."""
    if source_col not in gdf.columns:
        log.warning(
            "Layer '%s': municipality code source '%s' not found. Falling back to spatial join.",
            layer,
            source_col,
        )
        return gdf

    working = gdf.copy()
    municipio_map = (
        municipios_gdf[["codigo_ibge", "nome"]]
        .drop_duplicates(subset=["codigo_ibge"])
        .set_index("codigo_ibge")["nome"]
    )
    codigo_ibge = (
        working[source_col]
        .astype(str)
        .str.extract(r"(\d{7})", expand=False)
    )
    working["municipio"] = codigo_ibge.map(municipio_map)

    unmatched_mask = working["municipio"].isna() | (working["municipio"].astype(str).str.strip() == "")
    unmatched = int(unmatched_mask.sum())
    if unmatched and isinstance(working, gpd.GeoDataFrame):
        fallback = _assign_municipios(
            gpd.GeoDataFrame(working.loc[unmatched_mask].copy(), geometry=working.geometry.name, crs=working.crs),
            municipios_gdf,
            f"{layer} (fallback)",
        )
        working.loc[fallback.index, "municipio"] = fallback["municipio"]

    matched = len(working) - int(
        (working["municipio"].isna() | (working["municipio"].astype(str).str.strip() == "")).sum()
    )
    log.info(
        "[%s] Layer '%s': %d/%d features linked to IBGE municipalities by code.",
        _ts(),
        layer,
        matched,
        len(working),
    )

    return working


def _load_ibge_municipios(engine, uf: str) -> gpd.GeoDataFrame:
    """Load municipality boundaries for the target UF from PostGIS."""
    municipios = gpd.read_postgis(
        "SELECT codigo_ibge, nome, uf, geom FROM ibge_municipios WHERE uf = %(uf)s",
        engine,
        params={"uf": uf},
        geom_col="geom",
    )
    if municipios.empty:
        raise RuntimeError(
            f"No IBGE municipality boundaries found for UF={uf}. "
            "Run ingest_ibge_municipios.py first."
        )

    if municipios.crs is None:
        municipios = municipios.set_crs(TARGET_CRS)
    elif municipios.crs.to_string() != TARGET_CRS:
        municipios = municipios.to_crs(TARGET_CRS)

    if municipios.geometry.name != "geometry":
        municipios = municipios.rename_geometry("geometry")

    return municipios[["codigo_ibge", "nome", "uf", "geometry"]]


def _assign_municipios(
    gdf: gpd.GeoDataFrame,
    municipios_gdf: gpd.GeoDataFrame,
    layer: str,
) -> gpd.GeoDataFrame:
    """
    Assign each BDGD feature to a municipality using a representative point.

    Using representative points avoids duplicating line features that cross
    municipal boundaries while still keeping a deterministic municipality key.
    """
    if gdf.empty:
        return gdf

    if gdf.crs is None:
        raise RuntimeError(f"Layer '{layer}' has no CRS; cannot spatially assign municipalities.")

    working = gdf.copy()
    row_id_col = "__row_id"
    working[row_id_col] = working.index

    rep_points_metric = gpd.GeoDataFrame(
        working[[row_id_col]].copy(),
        geometry=working.to_crs(3857).geometry.representative_point(),
        crs="EPSG:3857",
    ).to_crs(TARGET_CRS)

    joined = gpd.sjoin(
        rep_points_metric,
        municipios_gdf,
        how="left",
        predicate="intersects",
    )

    if joined.index.has_duplicates:
        joined = joined[~joined.index.duplicated(keep="first")]

    working["municipio"] = joined["nome"].reindex(working.index)

    unmatched_mask = working["municipio"].isna() | (working["municipio"].astype(str).str.strip() == "")
    unmatched = int(unmatched_mask.sum())
    matched = len(working) - unmatched

    log.info(
        "[%s] Layer '%s': %d/%d features linked to IBGE municipalities.",
        _ts(),
        layer,
        matched,
        len(working),
    )
    if unmatched:
        sample_ids = working.loc[unmatched_mask, "cod_id"].dropna().astype(str).head(5).tolist()
        log.warning(
            "Layer '%s': %d features could not be linked to a municipality. Sample cod_id: %s",
            layer,
            unmatched,
            sample_ids if sample_ids else "n/a",
        )

    return working.drop(columns=[row_id_col])


def _prepare_subestacao_component_frame(
    frame: pd.DataFrame | gpd.GeoDataFrame,
    spec: dict[str, object],
    engine,
    distribuidora: str,
    uf: str,
) -> pd.DataFrame | gpd.GeoDataFrame:
    """Normalize BAR / BASE / BAY / BE into the shared subestacao_componentes table."""
    component_type = str(spec["component_type"])
    working = frame.copy()

    if component_type in {"BAR", "BAY"}:
        source_col = "SUB"
        working = _attach_substation_context(
            working,
            engine,
            distribuidora,
            uf,
            component_type,
            source_col=source_col,
            attach_geometry=True,
        )
    else:
        working = working.copy()
        working["subestacao_id"] = None
        working["municipio"] = None
        working["geometry"] = None

    attributes = [
        {column: _serialize_json_value(row[column]) for column in working.columns if column != "geometry"}
        for _, row in working.iterrows()
    ]

    payload = pd.DataFrame(
        {
            "cod_id": working["COD_ID"] if "COD_ID" in working.columns else None,
            "distribuidora": distribuidora,
            "municipio": working["municipio"] if "municipio" in working.columns else None,
            "uf": uf.upper(),
            "subestacao_id": working["subestacao_id"] if "subestacao_id" in working.columns else None,
            "component_type": component_type,
            "sub_grupo": working["SUB_GRP"] if "SUB_GRP" in working.columns else None,
            "descricao": working["DESCR"] if "DESCR" in working.columns else None,
            "tensao_nom": pd.to_numeric(working["TEN_NOM"], errors="coerce") if "TEN_NOM" in working.columns else None,
            "data_inicio": pd.to_datetime(
                working["DAT_INC"] if "DAT_INC" in working.columns else working["DAT_IMO"] if "DAT_IMO" in working.columns else None,
                format="%d/%m/%Y",
                errors="coerce",
            ).dt.date if ("DAT_INC" in working.columns or "DAT_IMO" in working.columns) else None,
            "data_fim": pd.to_datetime(
                working["DAT_FNL"] if "DAT_FNL" in working.columns else working["DAT_EXT"] if "DAT_EXT" in working.columns else None,
                format="%d/%m/%Y",
                errors="coerce",
            ).dt.date if ("DAT_FNL" in working.columns or "DAT_EXT" in working.columns) else None,
            "attributes": [json.dumps(item, ensure_ascii=False) for item in attributes],
        }
    )

    geometry = working["geometry"] if "geometry" in working.columns else None
    if geometry is not None and pd.Series(geometry).notna().any():
        return gpd.GeoDataFrame(payload, geometry=geometry, crs=TARGET_CRS).rename_geometry("geom")

    payload["geom"] = None
    return payload


def _prepare_regulacao_reativos_frame(
    frame: pd.DataFrame | gpd.GeoDataFrame,
    spec: dict[str, object],
    distribuidora: str,
    uf: str,
) -> pd.DataFrame | gpd.GeoDataFrame:
    """Normalize UNCRAT / UNCRBT / UNCRMT into the shared regulacao_reativos table."""
    nivel_tensao = str(spec["nivel_tensao"])
    working = frame.copy()
    attributes = [
        {column: _serialize_json_value(row[column]) for column in working.columns if column != "geometry"}
        for _, row in working.iterrows()
    ]

    payload = pd.DataFrame(
        {
            "cod_id": working["COD_ID"] if "COD_ID" in working.columns else None,
            "distribuidora": distribuidora,
            "municipio": working["municipio"] if "municipio" in working.columns else None,
            "uf": uf.upper(),
            "nivel_tensao": nivel_tensao,
            "subestacao_id": working["SUB"] if "SUB" in working.columns else None,
            "alimentador_id": working["CTMT"] if "CTMT" in working.columns else None,
            "tipo_unidade": working["TIP_UNID"] if "TIP_UNID" in working.columns else None,
            "banco": pd.to_numeric(working["BANC"], errors="coerce") if "BANC" in working.columns else None,
            "posicao": working["POS"] if "POS" in working.columns else None,
            "potencia_nom": pd.to_numeric(working["POT_NOM"], errors="coerce") if "POT_NOM" in working.columns else None,
            "descricao": working["DESCR"] if "DESCR" in working.columns else None,
            "data_implant": pd.to_datetime(
                working["DAT_CON"] if "DAT_CON" in working.columns else None,
                format="%d/%m/%Y",
                errors="coerce",
            ).dt.date if "DAT_CON" in working.columns else None,
            "attributes": [json.dumps(item, ensure_ascii=False) for item in attributes],
        }
    )

    geometry = working["geometry"] if "geometry" in working.columns else None
    if geometry is not None and pd.Series(geometry).notna().any():
        return gpd.GeoDataFrame(payload, geometry=geometry, crs=TARGET_CRS).rename_geometry("geom")

    payload["geom"] = None
    return payload


EQ_RELATED_SOURCE: dict[str, str] = {
    "EQCR": "UN_CR",
    "EQRE": "UN_RE",
    "EQSE": "UN_SE",
    "EQTRAT": "UNI_TR_AT",
    "EQTRM": "COD_ID",
    "EQTRMT": "UNI_TR_MT",
}


def _prepare_equipamentos_tecnicos_frame(
    frame: pd.DataFrame,
    spec: dict[str, object],
    distribuidora: str,
    uf: str,
) -> pd.DataFrame:
    """Normalize EQ* layers into a single technical dictionary table."""
    family = str(spec["family"])
    working = frame.copy()
    related_source = EQ_RELATED_SOURCE.get(family, "COD_ID")
    attributes = [
        {column: _serialize_json_value(row[column]) for column in working.columns}
        for _, row in working.iterrows()
    ]

    return pd.DataFrame(
        {
            "family": family,
            "cod_id": working["COD_ID"] if "COD_ID" in working.columns else None,
            "distribuidora": distribuidora,
            "uf": uf.upper(),
            "related_asset_id": working[related_source] if related_source in working.columns else None,
            "subestacao_id": working["SUB"] if "SUB" in working.columns else None,
            "alimentador_id": working["CTMT"] if "CTMT" in working.columns else None,
            "nivel_tensao": working["GRU_TEN"] if "GRU_TEN" in working.columns else working["CLAS_TEN"] if "CLAS_TEN" in working.columns else None,
            "descricao": working["DESCR"] if "DESCR" in working.columns else None,
            "tipo_inst": working["TIP_INST"] if "TIP_INST" in working.columns else None,
            "data_imobilizado": pd.to_datetime(
                working["DAT_IMO"] if "DAT_IMO" in working.columns else None,
                format="%d/%m/%Y",
                errors="coerce",
            ).dt.date if "DAT_IMO" in working.columns else None,
            "attributes": [json.dumps(item, ensure_ascii=False) for item in attributes],
        }
    )


def _write_layer(
    gdf: pd.DataFrame,
    table: str,
    engine,
    layer: str,
) -> int:
    """Write normalized rows to the target table. Returns row count."""
    count = len(gdf)
    log.info(
        "[%s] Writing %d rows to table '%s' (chunksize=%d) …",
        _ts(),
        count,
        table,
        CHUNK_SIZE,
    )
    if isinstance(gdf, gpd.GeoDataFrame):
        gdf.to_postgis(
            name=table,
            con=engine,
            if_exists="append",
            index=False,
            chunksize=CHUNK_SIZE,
        )
    else:
        dtype = {}
        if "attributes" in gdf.columns:
            dtype["attributes"] = JSONB
        gdf.to_sql(
            name=table,
            con=engine,
            if_exists="append",
            index=False,
            chunksize=CHUNK_SIZE,
            method="multi",
            dtype=dtype or None,
        )
    log.info("[%s] Layer '%s' → table '%s': %d rows written.", _ts(), layer, table, count)
    return count


def _delete_target_scope(table: str, engine, distribuidora: str, uf: str) -> int:
    return _delete_target_scope_filtered(table, engine, distribuidora, uf)


def _delete_target_scope_filtered(
    table: str,
    engine,
    distribuidora: str,
    uf: str,
    extra_filters: dict[str, object] | None = None,
) -> int:
    with engine.begin() as conn:
        where_sql = "distribuidora = :distribuidora AND uf = :uf"
        params: dict[str, object] = {"distribuidora": distribuidora, "uf": uf.upper()}
        for key, value in (extra_filters or {}).items():
            where_sql += f" AND {key} = :{key}"
            params[key] = value
        result = conn.execute(
            text(f"DELETE FROM {table} WHERE {where_sql}"),
            params,
        )
    deleted = int(result.rowcount or 0)
    log.info(
        "[%s] Cleared %d existing rows from '%s' for distribuidora='%s' uf='%s'.",
        _ts(),
        deleted,
        table,
        distribuidora,
        uf.upper(),
    )
    return deleted


def _collect_source_columns(spec: dict[str, object]) -> list[str]:
    """Return the minimal source column set needed for a layer import."""
    source_columns: list[str] = []
    col_map = spec["col_map"]
    assert isinstance(col_map, dict)

    for target, source in col_map.items():
        if target == "geom" or not source:
            continue
        source_columns.append(str(source))

    municipio_strategy = spec.get("municipio_strategy")
    if municipio_strategy == "codigo_ibge":
        source_col = spec.get("municipio_code_source")
        if source_col:
            source_columns.append(str(source_col))

    if spec.get("active_only"):
        source_columns.append("SIT_ATIV")

    if "UNSEMT" in str(spec.get("table", "")) or spec.get("table") == "chaves":
        source_columns.append("DESCR")
        source_columns.append("TIP_UNID")

    if spec.get("table") == "subestacao_componentes":
        component_type = spec.get("component_type")
        if component_type in {"BAR", "BAY"}:
            source_columns.append("SUB")
        for extra in ("COD_ID", "SUB_GRP", "DESCR", "TEN_NOM", "DAT_INC", "DAT_FNL", "DAT_EXT", "DAT_IMO"):
            source_columns.append(extra)

    if spec.get("table") == "regulacao_reativos":
        source_columns.extend([
            "COD_ID", "SUB", "CTMT", "TIP_UNID", "BANC", "POS", "POT_NOM", "DESCR", "DAT_CON",
        ])

    if spec.get("table") == "equipamentos_tecnicos":
        source_columns.extend([
            "COD_ID", "SUB", "CTMT", "DESCR", "TIP_INST", "DAT_IMO", "GRU_TEN", "CLAS_TEN",
            "UN_CR", "UN_RE", "UN_SE", "UNI_TR_AT", "UNI_TR_MT", "PAC",
        ])

    return sorted(set(source_columns))


def _serialize_json_value(value: object) -> object:
    """Convert pandas / numpy values into JSON-safe Python primitives."""
    if value is None:
        return None
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.isoformat()
    if hasattr(value, "isoformat") and callable(value.isoformat):
        try:
            return value.isoformat()
        except TypeError:
            pass
    if pd.isna(value):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "item") and callable(value.item):
        try:
            item = value.item()
            if isinstance(item, (str, int, float, bool)):
                return item
        except Exception:  # noqa: BLE001
            pass
    return str(value)


def _pick_feature_key(frame: pd.DataFrame) -> pd.Series:
    """Choose a human-readable feature key when the source layer exposes one."""
    for candidate in ("COD_ID", "cod_id", "ID", "OBJECTID", "OBJECTID_1", "FID"):
        if candidate in frame.columns:
            values = frame[candidate].astype(str).str.strip()
            return values.where(values.ne(""), None)
    return pd.Series([None] * len(frame), index=frame.index, dtype="object")


def _prepare_raw_layer_frame(
    frame: pd.DataFrame,
    layer_name: str,
    distribuidora: str,
    uf: str,
) -> pd.DataFrame | gpd.GeoDataFrame:
    """Convert any BDGD layer into the generic raw storage contract."""
    working: pd.DataFrame | gpd.GeoDataFrame = frame.copy()
    is_geo = isinstance(working, gpd.GeoDataFrame)

    geometry_type = None
    if is_geo:
        working = _reproject(working, layer_name)
        if working.geometry.name != "geometry":
            working = working.rename_geometry("geometry")

        geometry_types = (
            working.geometry.geom_type.dropna().astype(str).str.strip().replace("", pd.NA).dropna().unique().tolist()
        )
        geometry_type = geometry_types[0] if len(geometry_types) == 1 else "Mixed"
    else:
        working = working.copy()

    working = working.reset_index(drop=True)
    source_row_id = pd.Series(range(len(working)), index=working.index, dtype="int64")
    feature_key = _pick_feature_key(working)

    property_columns = [column for column in working.columns if not (is_geo and column == "geometry")]
    properties = [
        json.dumps(
            {column: _serialize_json_value(row[column]) for column in property_columns},
            ensure_ascii=False,
        )
        for _, row in working[property_columns].iterrows()
    ]

    payload = pd.DataFrame(
        {
            "distribuidora": distribuidora,
            "uf": uf.upper(),
            "layer_name": layer_name,
            "source_row_id": source_row_id,
            "feature_key": feature_key,
            "geometry_type": geometry_type,
            "properties": properties,
            "imported_at": datetime.now(),
        }
    )

    if is_geo:
        raw_gdf = gpd.GeoDataFrame(payload, geometry=working["geometry"], crs=TARGET_CRS)
        return raw_gdf.rename_geometry("geom")

    payload["geom"] = None
    return payload


def _delete_raw_layer_scope(engine, distribuidora: str, uf: str, layer_name: str) -> int:
    """Delete generic BDGD raw rows for a specific source layer scope."""
    with engine.begin() as conn:
        result = conn.execute(
            text(
                f"""
                DELETE FROM {RAW_LAYER_TABLE}
                WHERE distribuidora = :distribuidora
                  AND uf = :uf
                  AND layer_name = :layer_name
                """
            ),
            {
                "distribuidora": distribuidora,
                "uf": uf.upper(),
                "layer_name": layer_name,
            },
        )

    deleted = int(result.rowcount or 0)
    log.info(
        "[%s] Cleared %d existing raw BDGD rows from layer '%s' for distribuidora='%s' uf='%s'.",
        _ts(),
        deleted,
        layer_name,
        distribuidora,
        uf.upper(),
    )
    return deleted


def _write_raw_layer(
    frame: pd.DataFrame | gpd.GeoDataFrame,
    engine,
    layer_name: str,
) -> int:
    """Persist an unmapped BDGD layer into the generic raw storage table."""
    count = len(frame)
    if count == 0:
        return 0

    log.info(
        "[%s] Writing %d raw rows for layer '%s' to '%s' …",
        _ts(),
        count,
        layer_name,
        RAW_LAYER_TABLE,
    )

    if isinstance(frame, gpd.GeoDataFrame):
        frame.to_postgis(
            name=RAW_LAYER_TABLE,
            con=engine,
            if_exists="append",
            index=False,
            chunksize=CHUNK_SIZE,
            dtype={
                "properties": JSONB,
                "geom": Geometry("GEOMETRY", srid=4674),
            },
        )
    else:
        frame.to_sql(
            name=RAW_LAYER_TABLE,
            con=engine,
            if_exists="append",
            index=False,
            chunksize=CHUNK_SIZE,
            method="multi",
            dtype={"properties": JSONB},
        )

    log.info(
        "[%s] Raw BDGD layer '%s' → table '%s': %d rows written.",
        _ts(),
        layer_name,
        RAW_LAYER_TABLE,
        count,
    )
    return count


def _upsert_layer_catalog(
    engine,
    distribuidora: str,
    uf: str,
    layer_name: str,
    surfaced_mode: str,
    target_table: str | None,
    has_geometry: bool,
    geometry_type: str | None,
    feature_count: int,
    column_names: list[str],
) -> None:
    """Store the imported BDGD layer inventory for the current scope."""
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                INSERT INTO {CATALOG_TABLE} (
                  distribuidora,
                  uf,
                  layer_name,
                  surfaced_mode,
                  target_table,
                  has_geometry,
                  geometry_type,
                  feature_count,
                  column_names,
                  imported_at
                )
                VALUES (
                  :distribuidora,
                  :uf,
                  :layer_name,
                  :surfaced_mode,
                  :target_table,
                  :has_geometry,
                  :geometry_type,
                  :feature_count,
                  :column_names,
                  NOW()
                )
                ON CONFLICT (distribuidora, uf, layer_name) DO UPDATE
                SET surfaced_mode = EXCLUDED.surfaced_mode,
                    target_table = EXCLUDED.target_table,
                    has_geometry = EXCLUDED.has_geometry,
                    geometry_type = EXCLUDED.geometry_type,
                    feature_count = EXCLUDED.feature_count,
                    column_names = EXCLUDED.column_names,
                    imported_at = NOW()
                """
            ),
            {
                "distribuidora": distribuidora,
                "uf": uf.upper(),
                "layer_name": layer_name,
                "surfaced_mode": surfaced_mode,
                "target_table": target_table,
                "has_geometry": has_geometry,
                "geometry_type": geometry_type,
                "feature_count": feature_count,
                "column_names": column_names,
            },
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option(
    "--arquivo",
    required=True,
    type=click.Path(exists=True, readable=True),
    help="Path to the BDGD dataset (.gpkg, .gdb, or .gdb.zip).",
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
@click.option(
    "--only-layer",
    "only_layer",
    default=None,
    type=str,
    help="Processa apenas uma layer BDGD específica (ex.: UNSEMT).",
)
@click.option(
    "--replace-scope/--append-scope",
    default=False,
    show_default=True,
    help="Apaga previamente o escopo distribuidora+UF da tabela de destino antes da importação.",
)
def main(
    arquivo: str,
    distribuidora: str,
    uf: str,
    db_url: str | None,
    only_layer: str | None,
    replace_scope: bool,
) -> None:
    """Ingest BDGD layers into the GridRisk PostGIS database."""

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

    if only_layer is not None:
        only_layer = only_layer.strip()

    log.info("=== BDGD Ingest started at %s ===", _ts())
    log.info("File         : %s", arquivo)
    log.info("Distribuidora: %s", distribuidora)
    log.info("UF           : %s", uf)
    if only_layer:
        log.info("Only layer   : %s", only_layer)
    log.info("Replace scope: %s", "yes" if replace_scope else "no")

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

    try:
        municipios_gdf = _load_ibge_municipios(engine, uf)
        log.info("Loaded %d IBGE municipality polygons for UF=%s.", len(municipios_gdf), uf)
    except Exception as exc:  # noqa: BLE001
        log.error("Cannot load IBGE municipalities for UF=%s: %s", uf, exc)
        sys.exit(1)

    totals: dict[str, int] = {}

    try:
        with _prepare_dataset(arquivo) as dataset_path:
            log.info("Resolved BDGD dataset: %s", dataset_path)

            available_layers = _list_layers(dataset_path)
            if not available_layers:
                log.error("No layers found in '%s'.  Aborting.", dataset_path)
                sys.exit(1)

            log.info("Layers found in dataset: %s", available_layers)
            resolved_curated_specs: dict[str, tuple[str, dict[str, object]]] = {}
            resolved_curated_layers: list[str] = []
            for spec_key, spec in LAYER_MAP.items():
                source_layer = _resolve_source_layer(spec_key, spec, available_layers)
                if source_layer is None:
                    continue
                resolved_curated_specs[source_layer] = (spec_key, spec)
                resolved_curated_layers.append(source_layer)

            if only_layer:
                if only_layer in available_layers:
                    layers_to_process = [only_layer]
                elif only_layer in LAYER_MAP:
                    resolved = _resolve_source_layer(only_layer, LAYER_MAP[only_layer], available_layers)
                    if resolved is None:
                        log.error("Layer '%s' não está presente no dataset.", only_layer)
                        sys.exit(1)
                    layers_to_process = [resolved]
                else:
                    log.error(
                        "--only-layer '%s' não foi encontrado. Esperado uma layer BDGD presente no arquivo ou uma das layers modeladas: %s",
                        only_layer,
                        ", ".join(sorted(LAYER_MAP.keys())),
                    )
                    sys.exit(1)
            else:
                remaining_layers = [layer for layer in available_layers if layer not in resolved_curated_specs]
                layers_to_process = resolved_curated_layers + remaining_layers

            for source_layer in layers_to_process:
                try:
                    metadata = _inspect_layer(dataset_path, source_layer)
                    column_names = list(metadata["column_names"])
                    geometry_type = metadata["geometry_type"]
                    has_geometry = bool(metadata["has_geometry"])
                    source_feature_count = int(metadata["feature_count"])

                    if source_layer in resolved_curated_specs:
                        spec_key, spec = resolved_curated_specs[source_layer]
                        table = str(spec["table"])
                        col_map = spec["col_map"]
                        assert isinstance(col_map, dict)
                        log.info(
                            "--- Processing curated layer '%s' (source '%s') → table '%s' ---",
                            spec_key,
                            source_layer,
                            table,
                        )

                        gdf = _read_layer(
                            dataset_path,
                            source_layer,
                            source_columns=_collect_source_columns(spec),
                        )
                        if gdf is None or gdf.empty:
                            log.warning("Layer '%s' is empty — skipping curated import.", spec_key)
                            totals[spec_key] = 0
                            _upsert_layer_catalog(
                                engine,
                                distribuidora,
                                uf,
                                source_layer,
                                "curated",
                                table,
                                has_geometry,
                                str(geometry_type) if geometry_type else None,
                                0,
                                column_names,
                            )
                            continue

                        gdf = _filter_layer_rows(gdf, source_layer)
                        if spec.get("aggregate_geometry_from"):
                            gdf = _attach_geometry_from_layer(dataset_path, gdf, spec)

                        is_geo = isinstance(gdf, gpd.GeoDataFrame)
                        if is_geo:
                            gdf = _reproject(gdf, source_layer)

                            if spec.get("geometry_mode") == "multiline":
                                gdf = _ensure_multiline_geometries(gdf)
                            elif spec.get("geometry_mode") == "point":
                                gdf = _ensure_point_geometries(gdf)
                        elif not spec.get("tabular") and table != "subestacao_componentes":
                            raise RuntimeError(
                                f"Layer '{spec_key}' is not geospatial in this dataset."
                            )

                        if spec.get("attach_nearest_substation"):
                            if not isinstance(gdf, gpd.GeoDataFrame):
                                raise RuntimeError(
                                    f"Layer '{spec_key}' requires geospatial nearest-substation inference."
                                )
                            gdf = _attach_nearest_substation_to_lines(
                                gdf,
                                engine,
                                distribuidora,
                                uf,
                                spec_key,
                            )

                        if spec.get("municipio_strategy") == "codigo_ibge":
                            source_col = str(spec.get("municipio_code_source", "MUN"))
                            gdf = _assign_municipios_from_code(gdf, municipios_gdf, spec_key, source_col)

                        if table == "subestacao_componentes":
                            gdf = _prepare_subestacao_component_frame(
                                gdf,
                                spec,
                                engine,
                                distribuidora,
                                uf,
                            )
                        elif table == "regulacao_reativos":
                            gdf = _prepare_regulacao_reativos_frame(
                                gdf,
                                spec,
                                distribuidora,
                                uf,
                            )
                        elif table == "equipamentos_tecnicos":
                            gdf = _prepare_equipamentos_tecnicos_frame(
                                gdf,
                                spec,
                                distribuidora,
                                uf,
                            )
                        else:
                            gdf = _normalise_columns(gdf, col_map, distribuidora, uf)
                            if spec.get("derive_length_km"):
                                gdf = _fill_missing_length_km(gdf)

                        if spec.get("municipio_strategy") != "codigo_ibge" and table not in {"subestacao_componentes", "equipamentos_tecnicos"}:
                            if not isinstance(gdf, gpd.GeoDataFrame):
                                raise RuntimeError(
                                    f"Layer '{spec_key}' requires spatial municipality assignment but has no geometry."
                                )
                            gdf = _assign_municipios(gdf, municipios_gdf, spec_key)

                        log.info(
                            "[%s] Layer '%s': %d curated features ready for import.",
                            _ts(),
                            spec_key,
                            len(gdf),
                        )

                        if replace_scope:
                            extra_filters = None
                            if spec.get("shared_target_scope_key") and spec.get("component_type"):
                                extra_filters = {
                                    str(spec["shared_target_scope_key"]): str(spec["component_type"])
                                }
                            _delete_target_scope_filtered(table, engine, distribuidora, uf, extra_filters)
                        inserted = _write_layer(gdf, table, engine, spec_key)
                        totals[spec_key] = inserted
                        _upsert_layer_catalog(
                            engine,
                            distribuidora,
                            uf,
                            source_layer,
                            "curated",
                            table,
                            has_geometry,
                            str(geometry_type) if geometry_type else None,
                            source_feature_count,
                            column_names,
                        )

                        if spec.get("write_raw_also"):
                            raw_source = _read_layer(dataset_path, source_layer)
                            if raw_source is not None:
                                raw_frame = _prepare_raw_layer_frame(raw_source, source_layer, distribuidora, uf)
                                _delete_raw_layer_scope(engine, distribuidora, uf, source_layer)
                                _write_raw_layer(raw_frame, engine, source_layer)
                        continue

                    log.info(
                        "--- Processing additional BDGD layer '%s' → generic raw storage ---",
                        source_layer,
                    )
                    layer_frame = _read_layer(dataset_path, source_layer)
                    if layer_frame is None:
                        totals[source_layer] = -1
                        continue

                    raw_frame = _prepare_raw_layer_frame(layer_frame, source_layer, distribuidora, uf)
                    _delete_raw_layer_scope(engine, distribuidora, uf, source_layer)
                    inserted = _write_raw_layer(raw_frame, engine, source_layer)
                    totals[source_layer] = inserted
                    _upsert_layer_catalog(
                        engine,
                        distribuidora,
                        uf,
                        source_layer,
                        "raw",
                        RAW_LAYER_TABLE,
                        has_geometry,
                        str(geometry_type) if geometry_type else None,
                        inserted,
                        column_names,
                    )

                except Exception as exc:  # noqa: BLE001
                    log.error(
                        "Unhandled error processing source layer '%s': %s — layer skipped.",
                        source_layer,
                        exc,
                        exc_info=True,
                    )
                    totals[source_layer] = -1
    except Exception as exc:  # noqa: BLE001
        log.error("Cannot prepare BDGD dataset from '%s': %s", arquivo, exc)
        sys.exit(1)

    # Summary
    log.info("=== Ingest summary ===")
    for layer, count in totals.items():
        status = f"{count} rows" if count >= 0 else "FAILED"
        log.info("  %-12s : %s", layer, status)
    log.info("=== BDGD Ingest finished at %s ===", _ts())

    failed_layers = [layer for layer, count in totals.items() if count < 0]
    if failed_layers:
        log.error(
            "BDGD ingest finished with failures in layer(s): %s",
            ", ".join(failed_layers),
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
