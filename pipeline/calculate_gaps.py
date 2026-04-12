#!/usr/bin/env python3
"""
calculate_gaps.py — GridRisk pipeline: topological public gap analysis

Constrói segmentos topológicos de MT por alimentador e recalcula gaps com base
na distância a equipamentos de proteção/religamento automático e pontos de
manobra ao longo da rede, sem usar buffer euclidiano.

Metodologia:
- segmentos topológicos persistidos em segmentos_mt_topologicos
- gaps persistidos em gaps_protecao
- disjuntores reais da BDGD próximos à subestação entram como proteção de cabeceira
- BAY de alimentador entra como evidência estrutural quando não houver disjuntor explícito
- chaves normalmente abertas entram como candidatas de transferência, não como proteção
- score_vulnerabilidade = min((dist_equipamento_auto_km / 10) * 100, 100)
- dist_religador_km permanece como alias legado de dist_equipamento_auto_km
- dist_chave_km permanece como alias legado de dist_manobra_km
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from typing import Optional

import click
from dotenv import load_dotenv
from psycopg2.extras import execute_batch
from sqlalchemy import create_engine, text

from topology_public import FeederScope, build_topology_for_feeder


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)


SEGMENT_COLUMNS = [
    "distribuidora",
    "municipio",
    "uf",
    "alimentador_id",
    "subestacao_id",
    "rede_mt_cod_id",
    "source_segment_key",
    "node_start_id",
    "node_end_id",
    "comprimento_km",
    "dist_religador_km",
    "dist_chave_km",
    "dist_equipamento_auto_km",
    "dist_manobra_km",
    "dist_transferencia_km",
    "score_vulnerabilidade",
    "score_recomposicao",
    "gap_religamento_auto",
    "gap_recomposicao",
    "gap_transferencia",
    "equipamentos_auto_considerados",
    "equipamentos_manobra_considerados",
    "equipamentos_transferencia_considerados",
    "clientes_bt_total",
    "clientes_mt_total",
    "clientes_total",
    "demanda_mt_total",
    "metodologia",
    "lacunas",
    "geom_wkb_hex",
]

SEGMENT_TARGET_COLUMNS = [
    "distribuidora",
    "municipio",
    "uf",
    "alimentador_id",
    "subestacao_id",
    "rede_mt_cod_id",
    "source_segment_key",
    "node_start_id",
    "node_end_id",
    "comprimento_km",
    "dist_religador_km",
    "dist_chave_km",
    "dist_equipamento_auto_km",
    "dist_manobra_km",
    "dist_transferencia_km",
    "score_vulnerabilidade",
    "score_recomposicao",
    "gap_religamento_auto",
    "gap_recomposicao",
    "gap_transferencia",
    "equipamentos_auto_considerados",
    "equipamentos_manobra_considerados",
    "equipamentos_transferencia_considerados",
    "clientes_bt_total",
    "clientes_mt_total",
    "clientes_total",
    "demanda_mt_total",
    "metodologia",
    "lacunas",
    "geom",
]

GAP_COLUMNS = [
    "distribuidora",
    "municipio",
    "uf",
    "alimentador_id",
    "comprimento_km",
    "score_vulnerabilidade",
    "dist_religador_km",
    "dist_chave_km",
    "dist_equipamento_auto_km",
    "dist_manobra_km",
    "dist_transferencia_km",
    "score_recomposicao",
    "gap_religamento_auto",
    "gap_recomposicao",
    "gap_transferencia",
    "equipamentos_auto_considerados",
    "equipamentos_manobra_considerados",
    "equipamentos_transferencia_considerados",
    "clientes_bt_total",
    "clientes_mt_total",
    "clientes_total",
    "demanda_mt_total",
    "metodologia",
    "geom_wkb_hex",
]

GAP_TARGET_COLUMNS = [
    "distribuidora",
    "municipio",
    "uf",
    "alimentador_id",
    "comprimento_km",
    "score_vulnerabilidade",
    "dist_religador_km",
    "dist_chave_km",
    "dist_equipamento_auto_km",
    "dist_manobra_km",
    "dist_transferencia_km",
    "score_recomposicao",
    "gap_religamento_auto",
    "gap_recomposicao",
    "gap_transferencia",
    "equipamentos_auto_considerados",
    "equipamentos_manobra_considerados",
    "equipamentos_transferencia_considerados",
    "clientes_bt_total",
    "clientes_mt_total",
    "clientes_total",
    "demanda_mt_total",
    "metodologia",
    "geom",
]

TEMP_SEGMENTS_TABLE = "tmp_segmentos_mt_topologicos"
TEMP_GAPS_TABLE = "tmp_gaps_protecao"


def _build_filters(distribuidora: Optional[str], uf: Optional[str]) -> tuple[str, dict[str, str]]:
    conditions: list[str] = []
    params: dict[str, str] = {}

    if distribuidora:
        conditions.append("distribuidora = :dist")
        params["dist"] = distribuidora
    if uf:
        conditions.append("uf = :uf")
        params["uf"] = uf.upper()

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    return where_clause, params


def _delete_scope(conn, *, distribuidora: Optional[str], uf: Optional[str]) -> None:
    where_clause, params = _build_filters(distribuidora, uf)
    conn.execute(text(f"DELETE FROM gaps_protecao {where_clause}"), params)
    conn.execute(text(f"DELETE FROM segmentos_mt_topologicos {where_clause}"), params)


def _create_staging_tables(conn) -> None:
    conn.execute(text(f"DROP TABLE IF EXISTS {TEMP_SEGMENTS_TABLE}"))
    conn.execute(text(f"DROP TABLE IF EXISTS {TEMP_GAPS_TABLE}"))
    conn.execute(
        text(
            f"""
            CREATE TEMP TABLE {TEMP_SEGMENTS_TABLE}
            ON COMMIT DROP
            AS
            SELECT
              distribuidora,
              municipio,
              uf,
              alimentador_id,
              subestacao_id,
              rede_mt_cod_id,
              source_segment_key,
              node_start_id,
              node_end_id,
              comprimento_km,
              dist_religador_km,
              dist_chave_km,
              dist_equipamento_auto_km,
              dist_manobra_km,
              dist_transferencia_km,
              score_vulnerabilidade,
              score_recomposicao,
              gap_religamento_auto,
              gap_recomposicao,
              gap_transferencia,
              equipamentos_auto_considerados,
              equipamentos_manobra_considerados,
              equipamentos_transferencia_considerados,
              clientes_bt_total,
              clientes_mt_total,
              clientes_total,
              demanda_mt_total,
              metodologia,
              lacunas,
              geom
            FROM segmentos_mt_topologicos
            WHERE false
            """
        )
    )
    conn.execute(
        text(
            f"""
            CREATE TEMP TABLE {TEMP_GAPS_TABLE}
            ON COMMIT DROP
            AS
            SELECT
              distribuidora,
              municipio,
              uf,
              alimentador_id,
              comprimento_km,
              score_vulnerabilidade,
              dist_religador_km,
              dist_chave_km,
              dist_equipamento_auto_km,
              dist_manobra_km,
              dist_transferencia_km,
              score_recomposicao,
              gap_religamento_auto,
              gap_recomposicao,
              gap_transferencia,
              equipamentos_auto_considerados,
              equipamentos_manobra_considerados,
              equipamentos_transferencia_considerados,
              clientes_bt_total,
              clientes_mt_total,
              clientes_total,
              demanda_mt_total,
              metodologia,
              geom
            FROM gaps_protecao
            WHERE false
            """
        )
    )


def _load_feeders(engine, *, distribuidora: Optional[str], uf: Optional[str]) -> list[FeederScope]:
    where_clause, params = _build_filters(distribuidora, uf)
    sql = f"""
      SELECT cod_id, distribuidora, uf, subestacao_id
      FROM alimentadores
      {where_clause}
      ORDER BY uf ASC, distribuidora ASC, cod_id ASC
    """
    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    return [
        FeederScope(
            cod_id=str(row["cod_id"]),
            distribuidora=str(row["distribuidora"]),
            uf=str(row["uf"]),
            subestacao_id=str(row["subestacao_id"]) if row["subestacao_id"] else None,
        )
        for row in rows
        if row["cod_id"] and row["distribuidora"] and row["uf"]
    ]


def _insert_segments(conn, records: list[dict], *, table_name: str) -> None:
    if not records:
        return

    values = [
        tuple(record.get(column) for column in SEGMENT_COLUMNS)
        for record in records
    ]
    placeholders = ", ".join(
        ["%s"] * (len(SEGMENT_COLUMNS) - 1)
        + ["ST_Multi(ST_CollectionExtract(ST_SetSRID(ST_GeomFromWKB(decode(%s, 'hex')), 4674), 2))"]
    )
    sql = """
      INSERT INTO {table_name} (
        {columns}
      )
      VALUES ({placeholders})
    """
    sql = sql.format(
        table_name=table_name,
        columns=", ".join(SEGMENT_TARGET_COLUMNS),
        placeholders=placeholders,
    )
    with conn.connection.cursor() as cursor:
        execute_batch(cursor, sql, values, page_size=1000)


def _insert_gaps(conn, records: list[dict], *, table_name: str) -> None:
    if not records:
        return

    values = [
        tuple(record.get(column) for column in GAP_COLUMNS)
        for record in records
    ]
    placeholders = ", ".join(
        ["%s"] * (len(GAP_COLUMNS) - 1)
        + ["ST_Multi(ST_CollectionExtract(ST_SetSRID(ST_GeomFromWKB(decode(%s, 'hex')), 4674), 2))"]
    )
    sql = """
      INSERT INTO {table_name} (
        {columns}
      )
      VALUES ({placeholders})
    """
    sql = sql.format(
        table_name=table_name,
        columns=", ".join(GAP_TARGET_COLUMNS),
        placeholders=placeholders,
    )
    with conn.connection.cursor() as cursor:
        execute_batch(cursor, sql, values, page_size=1000)


def _publish_staged(conn, *, distribuidora: Optional[str], uf: Optional[str]) -> None:
    _delete_scope(conn, distribuidora=distribuidora, uf=uf)
    conn.execute(
        text(
            f"""
            INSERT INTO segmentos_mt_topologicos (
              {", ".join(SEGMENT_TARGET_COLUMNS)}
            )
            SELECT
              {", ".join(SEGMENT_TARGET_COLUMNS)}
            FROM {TEMP_SEGMENTS_TABLE}
            """
        )
    )
    conn.execute(
        text(
            f"""
            INSERT INTO gaps_protecao (
              {", ".join(GAP_TARGET_COLUMNS)}
            )
            SELECT
              {", ".join(GAP_TARGET_COLUMNS)}
            FROM {TEMP_GAPS_TABLE}
            """
        )
    )


def calculate_gaps(distribuidora: Optional[str], uf: Optional[str], engine) -> int:
    feeders = _load_feeders(engine, distribuidora=distribuidora, uf=uf)
    if not feeders:
        log.warning("Nenhum alimentador encontrado para o escopo informado.")
        with engine.begin() as conn:
            _delete_scope(conn, distribuidora=distribuidora, uf=uf)
        return 0

    log.info("Recalculando gaps topológicos para %d alimentador(es)...", len(feeders))

    total_segments = 0
    total_gaps = 0
    total_gap_km = 0.0

    with engine.begin() as conn:
        _create_staging_tables(conn)

        for feeder in feeders:
            result = build_topology_for_feeder(conn, feeder)
            _insert_segments(conn, result.segment_records, table_name=TEMP_SEGMENTS_TABLE)
            _insert_gaps(conn, result.gap_records, table_name=TEMP_GAPS_TABLE)

            total_segments += result.summary["total_segments"]
            total_gaps += result.summary["total_gaps"]
            total_gap_km += result.summary["gap_km"]
            log.info(
                "[%s/%s/%s] segmentos=%d gaps=%d gap_km=%.1f exposição=%s cobertura_trafo=%.2f cobertura_ucmt=%.2f",
                feeder.uf,
                feeder.distribuidora,
                feeder.cod_id,
                result.summary["total_segments"],
                result.summary["total_gaps"],
                result.summary["gap_km"],
                "ok" if result.summary["exposure_available"] else "indisponível",
                result.summary["transformador_coverage"],
                result.summary["ucmt_coverage"],
            )

        _publish_staged(conn, distribuidora=distribuidora, uf=uf)

    log.info(
        "Gaps topológicos calculados: %d segmentos topológicos, %d gaps, %.1f km expostos.",
        total_segments,
        total_gaps,
        total_gap_km,
    )
    return total_gaps


@click.command()
@click.option("--distribuidora", default=None, help="Filtro por distribuidora.")
@click.option("--uf", default=None, help="Filtro por estado (2 letras).")
@click.option("--db-url", "db_url", default=None, envvar="DATABASE_URL", help="SQLAlchemy database URL.")
def main(distribuidora: Optional[str], uf: Optional[str], db_url: Optional[str]) -> None:
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL não definida.")
        sys.exit(1)

    engine = create_engine(db_url, pool_pre_ping=True, future=True)
    started = datetime.now()

    if not distribuidora and not uf:
        log.warning("Nenhum filtro informado — todos os alimentadores com dados reais serão processados.")

    count = calculate_gaps(distribuidora, uf, engine)
    elapsed = (datetime.now() - started).total_seconds()
    log.info("Done. %d gaps topológicos encontrados em %.1fs.", count, elapsed)


if __name__ == "__main__":
    main()
