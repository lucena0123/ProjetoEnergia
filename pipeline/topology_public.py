#!/usr/bin/env python3
"""
topology_public.py — utilitários para exposição topológica pública por alimentador.

Constrói segmentos topológicos de MT apenas com dados públicos da BDGD:
- rede_mt como malha base
- religadores / chaves qualificadas como proteção automática e manobra
- transformadores para propagar UCBT
- UCMT para exposição direta por segmento

O objetivo é produzir uma leitura mais fiel da rede, sem usar buffer euclidiano
e sem tratar chave fusível comum como capacidade de recomposição.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import math
from typing import Any, Iterable

import geopandas as gpd
import networkx as nx
import pandas as pd
from pyproj import CRS
from shapely import wkb as shapely_wkb
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import substring
from sqlalchemy import text


SEGMENT_MIN_LENGTH_M = 1.0
TOPOLOGY_METHOD = "topologica_publica_v5"
GAP_COVERAGE_THRESHOLD_KM = 0.5
GAP_SEVERE_THRESHOLD_KM = 2.0
HEADEND_BREAKER_SUBSTATION_BUFFER_M = 100.0
NORMALLY_OPEN_OPERATION_VALUES = ("A",)
NORMALLY_CLOSED_OPERATION_VALUES = ("F",)

# Tipos de chaves que entram na leitura pública de proteção/religamento
# automático. Religadores da tabela própria entram sempre nessa família.
AUTOMATIC_PROTECTION_SWITCH_TYPES = (
    "Tripsaver",
    "Fusesaver",
    "Chave Fusível Religadora",
    "Disjuntor",
    "Seccionalizador",
)

# Tipos de chaves que entram na leitura pública de manobra/recomposição.
# Chave Fusível comum fica fora para não transformar fusíveis de ramal em
# capacidade real de recomposição do alimentador.
MANEUVER_SWITCH_TYPES = (
    "Chave Telecomandada",
    "Chave Seccionadora",
    "Chave Seccionadora Monopolar",
    "Chave Seccionadora Tripolar",
    "Chave Lâmina",
    "Disjuntor",
    "Seccionalizador",
    "Chave Fusível Religadora",
    "Tripsaver",
    "Fusesaver",
)

TRANSFER_CANDIDATE_SWITCH_TYPES = (
    "Chave Telecomandada",
    "Chave Seccionadora",
    "Chave Seccionadora Monopolar",
    "Chave Seccionadora Tripolar",
    "Chave Lâmina",
)


def _normalize_operation(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip().upper()


def _is_normally_open(value: Any) -> bool:
    return _normalize_operation(value) in NORMALLY_OPEN_OPERATION_VALUES


def _is_normally_closed_or_unknown(value: Any) -> bool:
    operation = _normalize_operation(value)
    return operation == "" or operation in NORMALLY_CLOSED_OPERATION_VALUES


def _maneuver_label(tipo_chave: Any, operacao: Any) -> str:
    tipo = str(tipo_chave or "Chave").strip() or "Chave"
    operation = _normalize_operation(operacao)
    if operation in NORMALLY_OPEN_OPERATION_VALUES:
        return f"{tipo} NA (candidata a transferência)"
    if operation in NORMALLY_CLOSED_OPERATION_VALUES:
        if tipo == "Chave Telecomandada":
            return f"{tipo} NF (seccionamento remoto)"
        return f"{tipo} NF (seccionamento)"
    return f"{tipo} (estado operacional indisponível)"


def _automatic_protection_label(tipo_chave: Any, operacao: Any) -> str:
    tipo = str(tipo_chave or "Equipamento automático").strip() or "Equipamento automático"
    operation = _normalize_operation(operacao)
    if operation in NORMALLY_CLOSED_OPERATION_VALUES:
        return f"{tipo} NF (proteção automática em serviço)"
    if operation in NORMALLY_OPEN_OPERATION_VALUES:
        return f"{tipo} NA (fora da trajetória energizada)"
    return f"{tipo} (estado operacional indisponível)"


@dataclass(frozen=True)
class FeederScope:
    cod_id: str
    distribuidora: str
    uf: str
    subestacao_id: str | None


@dataclass(frozen=True)
class FeederBuildResult:
    segment_records: list[dict[str, Any]]
    gap_records: list[dict[str, Any]]
    summary: dict[str, Any]


def _geom_from_wkb(value: Any):
    if value is None:
        return None
    if isinstance(value, memoryview):
        value = value.tobytes()
    return shapely_wkb.loads(value)


def read_geodataframe(conn, sql: str, params: dict[str, Any], geom_col: str = "geom") -> gpd.GeoDataFrame:
    df = pd.read_sql_query(text(sql), conn, params=params)
    if df.empty:
        empty = df.drop(columns=[geom_col], errors="ignore").copy()
        empty["geometry"] = pd.Series(dtype="object")
        return gpd.GeoDataFrame(empty, geometry="geometry", crs="EPSG:4674")

    geometry = df[geom_col].apply(_geom_from_wkb)
    df = df.drop(columns=[geom_col])
    return gpd.GeoDataFrame(df, geometry=geometry, crs="EPSG:4674")


def read_dataframe(conn, sql: str, params: dict[str, Any]) -> pd.DataFrame:
    return pd.read_sql_query(text(sql), conn, params=params)


def _metric_crs_from_geometries(geometries: Iterable[Any]) -> CRS:
    geo = gpd.GeoSeries([geom for geom in geometries if geom is not None and not geom.is_empty], crs="EPSG:4674")
    centroid = geo.unary_union.centroid
    return CRS.from_proj4(
        f"+proj=aeqd +lat_0={centroid.y} +lon_0={centroid.x} +datum=WGS84 +units=m +no_defs"
    )


def _iter_lines(geom: Any) -> Iterable[LineString]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return [line for line in geom.geoms if isinstance(line, LineString) and not line.is_empty]
    return []


def _endpoint_node_id(point: Point, tolerance_m: float) -> str:
    x = round(point.x / tolerance_m) * tolerance_m
    y = round(point.y / tolerance_m) * tolerance_m
    return f"ep:{x:.1f}:{y:.1f}"


def _midpoint_node_id(point: Point) -> str:
    return f"pt:{round(point.x, 3):.3f}:{round(point.y, 3):.3f}"


def _normalise_projection(value: float, length_m: float) -> float:
    return max(0.0, min(float(value), float(length_m)))


def _collapse_distances(values: Iterable[float], *, tolerance_m: float) -> list[float]:
    sorted_values = sorted(float(value) for value in values)
    if not sorted_values:
        return []

    collapsed = [sorted_values[0]]
    for value in sorted_values[1:]:
        if abs(value - collapsed[-1]) <= tolerance_m:
            collapsed[-1] = (collapsed[-1] + value) / 2.0
        else:
            collapsed.append(value)
    return collapsed


def _finite_distance(value: float | None) -> float | None:
    if value is None:
        return None
    numeric = float(value)
    if not math.isfinite(numeric):
        return None
    return numeric


def _sanitize_record(record: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in record.items():
        if isinstance(value, list):
            cleaned[key] = value
        elif pd.isna(value):
            cleaned[key] = None
        else:
            cleaned[key] = value
    return cleaned


def _safe_cardinality(total: int, matched: int) -> float:
    if total <= 0:
        return 1.0
    return matched / total


def _snap_points_to_lines(
    points_gdf: gpd.GeoDataFrame,
    line_gdf: gpd.GeoDataFrame,
    *,
    tolerance_m: float,
) -> pd.DataFrame:
    if points_gdf.empty or line_gdf.empty:
        return pd.DataFrame()

    joined = gpd.sjoin_nearest(
        points_gdf,
        line_gdf[["line_idx", "geometry"]],
        how="left",
        max_distance=tolerance_m,
        distance_col="snap_distance_m",
    )
    joined = joined.loc[joined["line_idx"].notna()].copy()
    if joined.empty:
        return pd.DataFrame()

    joined = (
        joined.reset_index()
        .sort_values(["index", "snap_distance_m", "line_idx"])
        .drop_duplicates(subset="index", keep="first")
        .drop(columns=["index"])
    )
    line_lookup = line_gdf.set_index("line_idx")
    joined["line_idx"] = joined["line_idx"].astype(int)
    joined["projection_m"] = joined.apply(
        lambda row: _normalise_projection(
            line_lookup.at[row["line_idx"], "geometry"].project(row.geometry),
            line_lookup.at[row["line_idx"], "geometry"].length,
        ),
        axis=1,
    )
    return pd.DataFrame(joined.drop(columns=["index_right"]))


def _line_interval_lookup(intervals: list[dict[str, Any]], projection_m: float) -> str | None:
    if not intervals:
        return None

    for interval in intervals:
        if interval["start_m"] - 0.01 <= projection_m <= interval["end_m"] + 0.01:
            return interval["segment_key"]

    return min(
        intervals,
        key=lambda item: abs(((item["start_m"] + item["end_m"]) / 2.0) - projection_m),
    )["segment_key"]


def _multiline_wkb_hex(geometries: list[Any]) -> list[str]:
    if not geometries:
        return []
    gdf = gpd.GeoDataFrame({"geometry": geometries}, geometry="geometry", crs="EPSG:4674")
    return [
        shapely_wkb.dumps(
            geom if isinstance(geom, MultiLineString) else MultiLineString([geom]),
            hex=True,
        )
        for geom in gdf.geometry
    ]


def build_topology_for_feeder(conn, scope: FeederScope) -> FeederBuildResult:
    params = {
        "cod_id": scope.cod_id,
        "dist": scope.distribuidora,
        "uf": scope.uf,
        "subestacao_id": scope.subestacao_id,
    }

    mt = read_geodataframe(
        conn,
        """
        SELECT id, cod_id, municipio, alimentador_id, ST_AsEWKB(geom) AS geom
        FROM rede_mt
        WHERE alimentador_id = :cod_id
          AND distribuidora = :dist
          AND uf = :uf
          AND geom IS NOT NULL
        ORDER BY cod_id ASC
        """,
        params,
    )
    if mt.empty:
        return FeederBuildResult(
            segment_records=[],
            gap_records=[],
            summary={
                "total_segments": 0,
                "total_gaps": 0,
                "gap_km": 0.0,
                "transformador_coverage": 1.0,
                "ucmt_coverage": 1.0,
                "exposure_available": False,
                "max_dist_religador_km": None,
            },
        )

    religadores = read_geodataframe(
        conn,
        """
        SELECT cod_id, municipio, ST_AsEWKB(geom) AS geom
        FROM religadores
        WHERE alimentador_id = :cod_id
          AND distribuidora = :dist
          AND uf = :uf
          AND geom IS NOT NULL
        ORDER BY cod_id ASC
        """,
        params,
    )
    _auto_types_literal = ", ".join(f"'{t}'" for t in AUTOMATIC_PROTECTION_SWITCH_TYPES)
    _maneuver_types_literal = ", ".join(f"'{t}'" for t in MANEUVER_SWITCH_TYPES)
    chaves_manobra = read_geodataframe(
        conn,
        f"""
        SELECT cod_id, municipio, tipo_chave, operacao, ST_AsEWKB(geom) AS geom
        FROM chaves
        WHERE alimentador_id = :cod_id
          AND distribuidora = :dist
          AND uf = :uf
          AND geom IS NOT NULL
          AND tipo_chave IN ({_maneuver_types_literal})
        ORDER BY cod_id ASC
        """,
        params,
    )
    chaves_auto = read_geodataframe(
        conn,
        f"""
        SELECT cod_id, municipio, tipo_chave, operacao, ST_AsEWKB(geom) AS geom
        FROM chaves
        WHERE alimentador_id = :cod_id
          AND distribuidora = :dist
          AND uf = :uf
          AND geom IS NOT NULL
          AND tipo_chave IN ({_auto_types_literal})
          AND (operacao IS NULL OR btrim(operacao) = '' OR upper(btrim(operacao)) = 'F')
        ORDER BY cod_id ASC
        """,
        params,
    )
    transformadores = read_geodataframe(
        conn,
        """
        SELECT cod_id, municipio, ST_AsEWKB(geom) AS geom
        FROM transformadores
        WHERE alimentador_id = :cod_id
          AND distribuidora = :dist
          AND uf = :uf
          AND geom IS NOT NULL
        ORDER BY cod_id ASC
        """,
        params,
    )
    ucmt = read_geodataframe(
        conn,
        """
        SELECT cod_id, municipio, demanda_contratada, ST_AsEWKB(geom) AS geom
        FROM ucmt
        WHERE alimentador_id = :cod_id
          AND distribuidora = :dist
          AND uf = :uf
          AND geom IS NOT NULL
        ORDER BY cod_id ASC
        """,
        params,
    )

    ucbt_counts = read_dataframe(
        conn,
        """
        SELECT transformador_id, COUNT(*)::int AS clientes_bt_total
        FROM ucbt
        WHERE alimentador_id = :cod_id
          AND distribuidora = :dist
          AND uf = :uf
          AND transformador_id IS NOT NULL
        GROUP BY transformador_id
        """,
        params,
    )
    subestacoes = (
        read_geodataframe(
            conn,
            """
            SELECT cod_id, municipio, ST_AsEWKB(geom) AS geom
            FROM subestacoes
            WHERE cod_id = :subestacao_id
              AND distribuidora = :dist
              AND uf = :uf
              AND geom IS NOT NULL
            ORDER BY cod_id ASC
            LIMIT 1
            """,
            params,
        )
        if scope.subestacao_id
        else gpd.GeoDataFrame({"geometry": pd.Series(dtype="object")}, geometry="geometry", crs="EPSG:4674")
    )
    headend_breakers = (
        read_geodataframe(
            conn,
            """
            SELECT c.cod_id, c.municipio, c.alimentador_id, c.tipo_chave, c.operacao, ST_AsEWKB(c.geom) AS geom
            FROM chaves c
            JOIN subestacoes s
              ON s.cod_id = :subestacao_id
             AND s.distribuidora = c.distribuidora
             AND s.uf = c.uf
             AND s.geom IS NOT NULL
            WHERE c.distribuidora = :dist
              AND c.uf = :uf
              AND c.geom IS NOT NULL
              AND c.tipo_chave = 'Disjuntor'
              AND (c.operacao IS NULL OR btrim(c.operacao) = '' OR upper(btrim(c.operacao)) = 'F')
              AND (
                c.alimentador_id = :cod_id
                OR c.alimentador_id IS NULL
                OR btrim(c.alimentador_id) = ''
              )
              AND ST_DWithin(c.geom::geography, s.geom::geography, :headend_buffer_m)
            ORDER BY
              CASE WHEN c.alimentador_id = :cod_id THEN 0 ELSE 1 END,
              c.cod_id ASC
            """,
            {**params, "headend_buffer_m": HEADEND_BREAKER_SUBSTATION_BUFFER_M},
        )
        if scope.subestacao_id
        else gpd.GeoDataFrame({"geometry": pd.Series(dtype="object")}, geometry="geometry", crs="EPSG:4674")
    )
    headend_feeder_bays = (
        read_dataframe(
            conn,
            """
            SELECT cod_id, subestacao_id, descricao
            FROM subestacao_componentes
            WHERE distribuidora = :dist
              AND uf = :uf
              AND subestacao_id = :subestacao_id
              AND component_type = 'BAY'
              AND descricao ILIKE '%ALIMENTADOR%'
            ORDER BY cod_id ASC
            """,
            params,
        )
        if scope.subestacao_id
        else pd.DataFrame()
    )

    metric_crs = _metric_crs_from_geometries(mt.geometry)
    mt = mt.to_crs(metric_crs)
    religadores = religadores.to_crs(metric_crs) if not religadores.empty else religadores
    chaves_manobra = chaves_manobra.to_crs(metric_crs) if not chaves_manobra.empty else chaves_manobra
    chaves_auto = chaves_auto.to_crs(metric_crs) if not chaves_auto.empty else chaves_auto
    transformadores = transformadores.to_crs(metric_crs) if not transformadores.empty else transformadores
    ucmt = ucmt.to_crs(metric_crs) if not ucmt.empty else ucmt
    subestacoes = subestacoes.to_crs(metric_crs) if not subestacoes.empty else subestacoes
    headend_breakers = headend_breakers.to_crs(metric_crs) if not headend_breakers.empty else headend_breakers

    line_records: list[dict[str, Any]] = []
    for row in mt.itertuples(index=False):
        for part_idx, line in enumerate(_iter_lines(row.geometry)):
            if line.length < SEGMENT_MIN_LENGTH_M:
                continue
            line_records.append(
                {
                    "line_idx": len(line_records),
                    "rede_mt_cod_id": row.cod_id,
                    "municipio": row.municipio,
                    "alimentador_id": row.alimentador_id,
                    "line_part_idx": part_idx,
                    "geometry": line,
                    "length_m": float(line.length),
                }
            )

    if not line_records:
        return FeederBuildResult(
            segment_records=[],
            gap_records=[],
            summary={
                "total_segments": 0,
                "total_gaps": 0,
                "gap_km": 0.0,
                "transformador_coverage": 1.0,
                "ucmt_coverage": 1.0,
                "exposure_available": False,
                "max_dist_religador_km": None,
            },
        )

    line_gdf = gpd.GeoDataFrame(line_records, geometry="geometry", crs=metric_crs)

    relig_snap = _snap_points_to_lines(religadores, line_gdf, tolerance_m=20.0)
    chaves_auto_snap = _snap_points_to_lines(chaves_auto, line_gdf, tolerance_m=20.0)
    chaves_manobra_snap = _snap_points_to_lines(chaves_manobra, line_gdf, tolerance_m=20.0)
    trafos_snap = _snap_points_to_lines(transformadores, line_gdf, tolerance_m=30.0)
    ucmt_snap = _snap_points_to_lines(ucmt, line_gdf, tolerance_m=50.0)
    subest_snap = _snap_points_to_lines(subestacoes, line_gdf, tolerance_m=80.0)

    relig_proj = defaultdict(list)
    chave_auto_proj = defaultdict(list)
    chave_manobra_proj = defaultdict(list)
    trafo_proj = defaultdict(list)
    ucmt_proj = defaultdict(list)

    for row in relig_snap.itertuples(index=False):
        relig_proj[int(row.line_idx)].append({"cod_id": row.cod_id, "projection_m": float(row.projection_m)})
    for row in chaves_auto_snap.itertuples(index=False):
        chave_auto_proj[int(row.line_idx)].append(
            {
                "cod_id": row.cod_id,
                "tipo_chave": row.tipo_chave,
                "operacao": row.operacao,
                "projection_m": float(row.projection_m),
            }
        )
    for row in chaves_manobra_snap.itertuples(index=False):
        chave_manobra_proj[int(row.line_idx)].append(
            {
                "cod_id": row.cod_id,
                "tipo_chave": row.tipo_chave,
                "operacao": row.operacao,
                "projection_m": float(row.projection_m),
            }
        )
    for row in trafos_snap.itertuples(index=False):
        trafo_proj[int(row.line_idx)].append({"cod_id": row.cod_id, "projection_m": float(row.projection_m)})
    for row in ucmt_snap.itertuples(index=False):
        ucmt_proj[int(row.line_idx)].append(
            {
                "cod_id": row.cod_id,
                "projection_m": float(row.projection_m),
                "demanda_contratada": float(row.demanda_contratada or 0.0),
            }
        )

    ucbt_by_transformador = {
        str(row.transformador_id): int(row.clientes_bt_total)
        for row in ucbt_counts.itertuples(index=False)
        if row.transformador_id is not None
    }

    graph = nx.MultiGraph()
    segment_records_local: list[dict[str, Any]] = []
    line_intervals: dict[int, list[dict[str, Any]]] = {}
    node_map_by_line_dist: dict[int, dict[float, str]] = defaultdict(dict)
    recloser_nodes: set[str] = set()
    switching_nodes: set[str] = set()
    transfer_nodes: set[str] = set()

    feeder_lacunas: set[str] = set()
    equipamentos_auto_considerados_set = {
        *(["Religador"] if not religadores.empty else []),
        *[
            _automatic_protection_label(row.tipo_chave, row.operacao)
            for row in chaves_auto.itertuples(index=False)
            if str(row.tipo_chave or "").strip()
        ],
    }
    equipamentos_manobra_considerados_set: set[str] = {
        *(["Religador"] if not religadores.empty else []),
    }
    equipamentos_transferencia_considerados_set: set[str] = set()

    if not chaves_auto.empty and chaves_auto["operacao"].fillna("").astype(str).str.strip().eq("").any():
        feeder_lacunas.add("estado_operacional_protecao_indisponivel")
    if not chaves_manobra.empty and chaves_manobra["operacao"].fillna("").astype(str).str.strip().eq("").any():
        feeder_lacunas.add("estado_operacional_chave_indisponivel")

    for line in line_gdf.itertuples(index=False):
        base_breaks = [0.0, float(line.length_m)]
        base_breaks.extend(event["projection_m"] for event in relig_proj[line.line_idx])
        base_breaks.extend(event["projection_m"] for event in chave_auto_proj[line.line_idx])
        base_breaks.extend(event["projection_m"] for event in chave_manobra_proj[line.line_idx])
        base_breaks.extend(event["projection_m"] for event in trafo_proj[line.line_idx])
        base_breaks.extend(event["projection_m"] for event in ucmt_proj[line.line_idx])
        breakpoints = _collapse_distances(base_breaks, tolerance_m=0.25)

        breakpoint_nodes: dict[float, str] = {}
        for distance_m in breakpoints:
            point = line.geometry.interpolate(distance_m)
            is_endpoint = abs(distance_m - 0.0) <= 0.25 or abs(distance_m - float(line.length_m)) <= 0.25
            breakpoint_nodes[distance_m] = (
                _endpoint_node_id(point, 15.0) if is_endpoint else _midpoint_node_id(point)
            )

        line_intervals[line.line_idx] = []
        line_key_prefix = f"{scope.cod_id}:{line.rede_mt_cod_id}:{line.line_part_idx}"
        interval_index = 0
        for start_m, end_m in zip(breakpoints[:-1], breakpoints[1:]):
            if (end_m - start_m) < SEGMENT_MIN_LENGTH_M:
                continue

            segment_line = substring(line.geometry, start_m, end_m)
            if segment_line.is_empty or not isinstance(segment_line, LineString) or segment_line.length < SEGMENT_MIN_LENGTH_M:
                continue

            segment_key = f"{line_key_prefix}:{interval_index}"
            interval_index += 1
            start_node_id = breakpoint_nodes[start_m]
            end_node_id = breakpoint_nodes[end_m]
            length_m = float(segment_line.length)

            graph.add_edge(
                start_node_id,
                end_node_id,
                key=segment_key,
                weight=length_m,
                segment_key=segment_key,
            )
            line_intervals[line.line_idx].append(
                {
                    "segment_key": segment_key,
                    "start_m": start_m,
                    "end_m": end_m,
                }
            )
            node_map_by_line_dist[line.line_idx][start_m] = start_node_id
            node_map_by_line_dist[line.line_idx][end_m] = end_node_id

            segment_records_local.append(
                {
                    "segment_key": segment_key,
                    "distribuidora": scope.distribuidora,
                    "municipio": line.municipio,
                    "uf": scope.uf,
                    "alimentador_id": scope.cod_id,
                    "subestacao_id": scope.subestacao_id,
                    "rede_mt_cod_id": line.rede_mt_cod_id,
                    "node_start_id": start_node_id,
                    "node_end_id": end_node_id,
                    "comprimento_km": round(length_m / 1000.0, 6),
                    "geometry_local": segment_line,
                    "lacunas": [],
                }
            )

    def resolve_node(line_idx: int, projection_m: float) -> str | None:
        candidates = node_map_by_line_dist.get(line_idx)
        if not candidates:
            return None
        nearest_distance = min(candidates.keys(), key=lambda item: abs(item - projection_m))
        return candidates[nearest_distance]

    def resolve_segment(line_idx: int, projection_m: float) -> str | None:
        return _line_interval_lookup(line_intervals.get(line_idx, []), projection_m)

    trafo_to_segment: dict[str, str] = {}
    ucmt_to_segment: dict[str, str] = {}
    segment_bt_totals = defaultdict(int)
    segment_mt_totals = defaultdict(int)
    segment_demand_totals = defaultdict(float)

    for row in relig_snap.itertuples(index=False):
        node_id = resolve_node(int(row.line_idx), float(row.projection_m))
        if node_id:
            recloser_nodes.add(node_id)
            switching_nodes.add(node_id)

    for row in chaves_auto_snap.itertuples(index=False):
        node_id = resolve_node(int(row.line_idx), float(row.projection_m))
        if node_id:
            recloser_nodes.add(node_id)
            switching_nodes.add(node_id)

    for row in chaves_manobra_snap.itertuples(index=False):
        node_id = resolve_node(int(row.line_idx), float(row.projection_m))
        if not node_id:
            continue

        tipo_chave = str(row.tipo_chave or "").strip()
        if _is_normally_open(row.operacao) and tipo_chave in TRANSFER_CANDIDATE_SWITCH_TYPES:
            transfer_nodes.add(node_id)
            equipamentos_transferencia_considerados_set.add(_maneuver_label(row.tipo_chave, row.operacao))
            continue

        if _is_normally_closed_or_unknown(row.operacao):
            switching_nodes.add(node_id)
            equipamentos_manobra_considerados_set.add(_maneuver_label(row.tipo_chave, row.operacao))
        elif tipo_chave:
            feeder_lacunas.add("estado_operacional_chave_nao_classificado")

    matched_transformadores = 0
    for row in trafos_snap.itertuples(index=False):
        segment_key = resolve_segment(int(row.line_idx), float(row.projection_m))
        if not segment_key:
            continue
        trafo_to_segment[str(row.cod_id)] = segment_key
        matched_transformadores += 1
        segment_bt_totals[segment_key] += ucbt_by_transformador.get(str(row.cod_id), 0)

    matched_ucmt = 0
    for row in ucmt_snap.itertuples(index=False):
        segment_key = resolve_segment(int(row.line_idx), float(row.projection_m))
        if not segment_key:
            continue
        ucmt_to_segment[str(row.cod_id)] = segment_key
        matched_ucmt += 1
        segment_mt_totals[segment_key] += 1
        segment_demand_totals[segment_key] += float(row.demanda_contratada or 0.0)

    transformador_coverage = _safe_cardinality(len(transformadores), matched_transformadores)
    ucmt_coverage = _safe_cardinality(len(ucmt), matched_ucmt)
    exposure_available = transformador_coverage >= 0.95 and ucmt_coverage >= 0.90
    if not exposure_available:
        feeder_lacunas.add("exposicao_clientes_gap_indisponivel")

    if graph.number_of_nodes() > 0 and graph.number_of_edges() > 0:
        components = list(nx.connected_components(graph))
        largest_component = max(components, key=len)
    else:
        largest_component = set()

    root_node_id: str | None = None
    if not subest_snap.empty:
        for row in subest_snap.itertuples(index=False):
            node_id = resolve_node(int(row.line_idx), float(row.projection_m))
            if node_id and node_id in largest_component:
                root_node_id = node_id
                break
    if root_node_id is None:
        feeder_lacunas.add("subestacao_nao_associada")

    explicit_headend_breakers = 0
    if not headend_breakers.empty and "alimentador_id" in headend_breakers:
        explicit_headend_breakers = int(
            (headend_breakers["alimentador_id"].fillna("").astype(str).str.strip() == scope.cod_id).sum()
        )

    feeder_bay_matched = False
    if not headend_feeder_bays.empty and scope.subestacao_id:
        bay_code_candidates = {scope.cod_id}
        if scope.cod_id.startswith(scope.subestacao_id):
            feeder_suffix = scope.cod_id[len(scope.subestacao_id):]
            if feeder_suffix:
                bay_code_candidates.add(f"{scope.subestacao_id}01{feeder_suffix}")
                bay_code_candidates.add(f"{scope.subestacao_id}{feeder_suffix}")

        feeder_bay_matched = bool(
            headend_feeder_bays["cod_id"].fillna("").astype(str).str.strip().isin(bay_code_candidates).any()
        )

    if root_node_id is not None and not headend_breakers.empty:
        recloser_nodes.add(root_node_id)
        switching_nodes.add(root_node_id)
        if explicit_headend_breakers > 0:
            headend_label = "Disjuntor de cabeceira (BDGD, vínculo alimentador)"
        else:
            headend_label = "Disjuntor de cabeceira (BDGD, associado por subestação)"
            feeder_lacunas.add("protecao_cabecalho_sem_vinculo_alimentador_explicito")

        equipamentos_auto_considerados_set.add(headend_label)
        equipamentos_manobra_considerados_set.add(headend_label)
    elif root_node_id is not None and feeder_bay_matched:
        recloser_nodes.add(root_node_id)
        switching_nodes.add(root_node_id)
        headend_label = "BAY de alimentador (BDGD, proteção de cabeceira estrutural)"
        equipamentos_auto_considerados_set.add(headend_label)
        equipamentos_manobra_considerados_set.add(headend_label)
        feeder_lacunas.add("protecao_cabecalho_por_bay_sem_disjuntor_explicito")
    elif root_node_id is not None:
        feeder_lacunas.add("protecao_cabecalho_bdgd_nao_observada")

    if not recloser_nodes:
        feeder_lacunas.add("equipamento_auto_protecao_nao_associado")
    if not switching_nodes:
        feeder_lacunas.add("equipamento_manobra_nao_associado")

    equipamentos_auto_considerados = sorted(equipamentos_auto_considerados_set)
    equipamentos_manobra_considerados = sorted(equipamentos_manobra_considerados_set)
    equipamentos_transferencia_considerados = sorted(equipamentos_transferencia_considerados_set)

    dist_to_recloser = (
        nx.multi_source_dijkstra_path_length(graph, list(recloser_nodes), weight="weight")
        if recloser_nodes
        else {}
    )
    dist_to_switch = (
        nx.multi_source_dijkstra_path_length(graph, list(switching_nodes), weight="weight")
        if switching_nodes
        else {}
    )
    dist_to_transfer = (
        nx.multi_source_dijkstra_path_length(graph, list(transfer_nodes), weight="weight")
        if transfer_nodes
        else {}
    )

    segment_rows = []
    gap_rows = []
    for segment in segment_records_local:
        start_node_id = segment["node_start_id"]
        end_node_id = segment["node_end_id"]
        dist_religador_m_candidates = [
            _finite_distance(dist_to_recloser.get(start_node_id)),
            _finite_distance(dist_to_recloser.get(end_node_id)),
        ]
        dist_switch_m_candidates = [
            _finite_distance(dist_to_switch.get(start_node_id)),
            _finite_distance(dist_to_switch.get(end_node_id)),
        ]
        dist_transfer_m_candidates = [
            _finite_distance(dist_to_transfer.get(start_node_id)),
            _finite_distance(dist_to_transfer.get(end_node_id)),
        ]
        dist_religador_m = min(
            (value for value in dist_religador_m_candidates if value is not None),
            default=None,
        )
        dist_switch_m = min(
            (value for value in dist_switch_m_candidates if value is not None),
            default=None,
        )
        dist_transfer_m = min(
            (value for value in dist_transfer_m_candidates if value is not None),
            default=None,
        )

        if dist_religador_m is None:
            score_vulnerabilidade = 100.0
        else:
            score_vulnerabilidade = min((dist_religador_m / 1000.0 / 10.0) * 100.0, 100.0)

        if dist_switch_m is None:
            score_recomposicao = 100.0
        else:
            score_recomposicao = min((dist_switch_m / 1000.0 / 10.0) * 100.0, 100.0)

        gap_religamento_auto = dist_religador_m is None or ((dist_religador_m / 1000.0) >= GAP_SEVERE_THRESHOLD_KM)
        gap_recomposicao = dist_switch_m is None or ((dist_switch_m / 1000.0) >= GAP_SEVERE_THRESHOLD_KM)
        gap_transferencia = (
            bool(transfer_nodes)
            and (dist_transfer_m is None or ((dist_transfer_m / 1000.0) >= GAP_SEVERE_THRESHOLD_KM))
        )

        bt_total = segment_bt_totals.get(segment["segment_key"], 0)
        mt_total = segment_mt_totals.get(segment["segment_key"], 0)
        demanda_total = segment_demand_totals.get(segment["segment_key"], 0.0)
        lacunas = list(feeder_lacunas)

        row = {
            "distribuidora": scope.distribuidora,
            "municipio": segment["municipio"],
            "uf": scope.uf,
            "alimentador_id": scope.cod_id,
            "subestacao_id": scope.subestacao_id,
            "rede_mt_cod_id": segment["rede_mt_cod_id"],
            "source_segment_key": segment["segment_key"],
            "node_start_id": segment["node_start_id"],
            "node_end_id": segment["node_end_id"],
            "comprimento_km": segment["comprimento_km"],
            "dist_religador_km": round(dist_religador_m / 1000.0, 6) if dist_religador_m is not None else None,
            "dist_chave_km": round(dist_switch_m / 1000.0, 6) if dist_switch_m is not None else None,
            "dist_equipamento_auto_km": round(dist_religador_m / 1000.0, 6) if dist_religador_m is not None else None,
            "dist_manobra_km": round(dist_switch_m / 1000.0, 6) if dist_switch_m is not None else None,
            "dist_transferencia_km": round(dist_transfer_m / 1000.0, 6) if dist_transfer_m is not None else None,
            "score_vulnerabilidade": round(score_vulnerabilidade, 3),
            "score_recomposicao": round(score_recomposicao, 3),
            "gap_religamento_auto": gap_religamento_auto,
            "gap_recomposicao": gap_recomposicao,
            "gap_transferencia": gap_transferencia,
            "equipamentos_auto_considerados": equipamentos_auto_considerados,
            "equipamentos_manobra_considerados": equipamentos_manobra_considerados,
            "equipamentos_transferencia_considerados": equipamentos_transferencia_considerados,
            "clientes_bt_total": bt_total if exposure_available else None,
            "clientes_mt_total": mt_total if exposure_available else None,
            "clientes_total": (bt_total + mt_total) if exposure_available else None,
            "demanda_mt_total": round(demanda_total, 3) if exposure_available else None,
            "metodologia": TOPOLOGY_METHOD,
            "lacunas": lacunas,
            "geometry_local": segment["geometry_local"],
        }
        segment_rows.append(row)

        is_gap_auto = dist_religador_m is None or ((dist_religador_m / 1000.0) > GAP_COVERAGE_THRESHOLD_KM)
        is_gap_maneuver = dist_switch_m is None or ((dist_switch_m / 1000.0) > GAP_COVERAGE_THRESHOLD_KM)
        is_gap_transfer = bool(transfer_nodes) and (
            dist_transfer_m is None or ((dist_transfer_m / 1000.0) > GAP_COVERAGE_THRESHOLD_KM)
        )
        is_gap = is_gap_auto or is_gap_maneuver or is_gap_transfer
        if is_gap:
            gap_rows.append(row.copy())

    segment_geoms = gpd.GeoDataFrame(segment_rows, geometry="geometry_local", crs=metric_crs)
    segment_geoms = segment_geoms.rename(columns={"geometry_local": "geometry"}).set_geometry("geometry").to_crs("EPSG:4674")
    if gap_rows:
        gap_geoms = gpd.GeoDataFrame(gap_rows, geometry="geometry_local", crs=metric_crs)
        gap_geoms = gap_geoms.rename(columns={"geometry_local": "geometry"}).set_geometry("geometry").to_crs("EPSG:4674")
    else:
        gap_geoms = gpd.GeoDataFrame({"geometry": pd.Series(dtype="object")}, geometry="geometry", crs="EPSG:4674")

    segment_wkbs = _multiline_wkb_hex(list(segment_geoms.geometry))
    gap_wkbs = _multiline_wkb_hex(list(gap_geoms.geometry))

    segment_records = []
    for raw_row, geom_wkb_hex in zip(segment_geoms.drop(columns=["geometry"]).to_dict(orient="records"), segment_wkbs):
        row = _sanitize_record(raw_row)
        row["geom_wkb_hex"] = geom_wkb_hex
        segment_records.append(row)

    gap_records = []
    for raw_row, geom_wkb_hex in zip(gap_geoms.drop(columns=["geometry"]).to_dict(orient="records"), gap_wkbs):
        row = _sanitize_record(raw_row)
        row["geom_wkb_hex"] = geom_wkb_hex
        gap_records.append(row)

    max_dist_religador_km = max(
        (
            float(record["dist_religador_km"])
            for record in segment_records
            if record["dist_religador_km"] is not None and math.isfinite(float(record["dist_religador_km"]))
        ),
        default=None,
    )
    max_dist_manobra_km = max(
        (
            float(record["dist_manobra_km"])
            for record in segment_records
            if record["dist_manobra_km"] is not None and math.isfinite(float(record["dist_manobra_km"]))
        ),
        default=None,
    )

    summary = {
        "total_segments": len(segment_records),
        "total_gaps": len(gap_records),
        "gap_km": round(sum(float(record["comprimento_km"]) for record in gap_records), 3),
        "transformador_coverage": round(transformador_coverage, 4),
        "ucmt_coverage": round(ucmt_coverage, 4),
        "exposure_available": exposure_available,
        "max_dist_religador_km": max_dist_religador_km,
        "max_dist_manobra_km": max_dist_manobra_km,
    }

    return FeederBuildResult(
        segment_records=segment_records,
        gap_records=gap_records,
        summary=summary,
    )
