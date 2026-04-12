#!/usr/bin/env python3
"""
calculate_alimentador_metricas.py — feeder-first operational metrics

Materializa métricas por alimentador usando apenas dados reais já carregados no
banco (BDGD + gaps derivados). O resultado persistido abastece ranking,
detalhe operacional e KPIs feeder-first.
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from typing import Optional

import click
from dotenv import load_dotenv
from sqlalchemy import create_engine, text


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)


def _build_scope(alias: str, distribuidora: Optional[str], uf: Optional[str], params: dict[str, str]) -> str:
    conditions: list[str] = []
    if distribuidora:
        conditions.append(f"{alias}.distribuidora = :distribuidora")
        params["distribuidora"] = distribuidora
    if uf:
        conditions.append(f"{alias}.uf = :uf")
        params["uf"] = uf.upper()
    return f"WHERE {' AND '.join(conditions)}" if conditions else ""


def calculate_metricas(engine, *, distribuidora: Optional[str], uf: Optional[str], limpar: bool) -> int:
    params: dict[str, str] = {}
    base_where = _build_scope("a", distribuidora, uf, params)
    mt_where = _build_scope("r", distribuidora, uf, params)
    bt_where = _build_scope("r", distribuidora, uf, params)
    trafo_where = _build_scope("t", distribuidora, uf, params)
    rel_where = _build_scope("r", distribuidora, uf, params)
    chv_where = _build_scope("c", distribuidora, uf, params)
    gap_where = _build_scope("g", distribuidora, uf, params)
    ucbt_where = _build_scope("u", distribuidora, uf, params)
    ucmt_where = _build_scope("u", distribuidora, uf, params)

    delete_sql = "DELETE FROM alimentador_metricas"
    if distribuidora or uf:
        delete_conditions: list[str] = []
        if distribuidora:
            delete_conditions.append("distribuidora = :distribuidora")
        if uf:
            delete_conditions.append("uf = :uf")
        delete_sql += " WHERE " + " AND ".join(delete_conditions)

    insert_sql = f"""
    INSERT INTO alimentador_metricas (
      cod_id,
      distribuidora,
      uf,
      subestacao_id,
      tensao_nom,
      municipios_atendidos,
      km_mt,
      km_bt,
      n_transformadores,
      n_religadores,
      n_chaves,
      km_gap_severo,
      n_gaps_severos,
      densidade_religadores_km,
      densidade_chaves_km,
      n_ucbt,
      n_ucmt,
      clientes_bt_total,
      clientes_mt_total,
      clientes_total,
      demanda_mt_total,
      clientes_expostos_gap_severo,
      km_gap_religamento_auto,
      n_segmentos_gap_religamento_auto,
      km_gap_recomposicao,
      n_segmentos_gap_recomposicao,
      km_gap_transferencia,
      n_segmentos_gap_transferencia,
      km_gap_severo_topologico,
      n_segmentos_gap_severo,
      clientes_gap_severo_bt,
      clientes_gap_severo_mt,
      clientes_gap_severo_total,
      demanda_gap_severo_total,
      max_dist_religador_km,
      max_dist_equipamento_auto_km,
      max_dist_manobra_km,
      max_dist_transferencia_km,
      metodologia_gap,
      lacunas,
      atualizado_em
    )
    WITH base AS (
      SELECT
        a.cod_id,
        a.distribuidora,
        a.uf,
        a.subestacao_id,
        a.tensao_nom,
        a.comprimento_km AS comprimento_oficial_km,
        a.municipio
      FROM alimentadores a
      {base_where}
    ),
    mt AS (
      SELECT
        r.alimentador_id AS cod_id,
        r.distribuidora,
        r.uf,
        ROUND(COALESCE(SUM(r.comprimento), 0)::numeric / 1000.0, 3) AS km_mt
      FROM rede_mt r
      WHERE r.alimentador_id IS NOT NULL
      {"AND " + mt_where[6:] if mt_where else ""}
      GROUP BY r.alimentador_id, r.distribuidora, r.uf
    ),
    bt AS (
      SELECT
        r.alimentador_id AS cod_id,
        r.distribuidora,
        r.uf,
        ROUND(COALESCE(SUM(r.comprimento), 0)::numeric / 1000.0, 3) AS km_bt
      FROM rede_bt r
      WHERE r.alimentador_id IS NOT NULL
      {"AND " + bt_where[6:] if bt_where else ""}
      GROUP BY r.alimentador_id, r.distribuidora, r.uf
    ),
    trafos AS (
      SELECT
        t.alimentador_id AS cod_id,
        t.distribuidora,
        t.uf,
        COUNT(*)::int AS n_transformadores
      FROM transformadores t
      WHERE t.alimentador_id IS NOT NULL
      {"AND " + trafo_where[6:] if trafo_where else ""}
      GROUP BY t.alimentador_id, t.distribuidora, t.uf
    ),
    relig AS (
      SELECT
        r.alimentador_id AS cod_id,
        r.distribuidora,
        r.uf,
        COUNT(*)::int AS n_religadores
      FROM religadores r
      WHERE r.alimentador_id IS NOT NULL
      {"AND " + rel_where[6:] if rel_where else ""}
      GROUP BY r.alimentador_id, r.distribuidora, r.uf
    ),
    chv AS (
      SELECT
        c.alimentador_id AS cod_id,
        c.distribuidora,
        c.uf,
        COUNT(*)::int AS n_chaves
      FROM chaves c
      WHERE c.alimentador_id IS NOT NULL
      {"AND " + chv_where[6:] if chv_where else ""}
      GROUP BY c.alimentador_id, c.distribuidora, c.uf
    ),
    gaps AS (
      SELECT
        g.alimentador_id AS cod_id,
        g.distribuidora,
        g.uf,
        ROUND(COALESCE(SUM(g.comprimento_km) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)), 0)::numeric, 3) AS km_gap_severo,
        COUNT(*) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20))::int AS n_gaps_severos
        ,
        ROUND(COALESCE(SUM(g.comprimento_km) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)), 0)::numeric, 3) AS km_gap_religamento_auto,
        COUNT(*) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20))::int AS n_segmentos_gap_religamento_auto,
        ROUND(COALESCE(SUM(g.comprimento_km) FILTER (WHERE COALESCE(g.gap_recomposicao, FALSE)), 0)::numeric, 3) AS km_gap_recomposicao,
        COUNT(*) FILTER (WHERE COALESCE(g.gap_recomposicao, FALSE))::int AS n_segmentos_gap_recomposicao,
        ROUND(COALESCE(SUM(g.comprimento_km) FILTER (WHERE COALESCE(g.gap_transferencia, FALSE)), 0)::numeric, 3) AS km_gap_transferencia,
        COUNT(*) FILTER (WHERE COALESCE(g.gap_transferencia, FALSE))::int AS n_segmentos_gap_transferencia,
        ROUND(COALESCE(SUM(g.comprimento_km) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)), 0)::numeric, 3) AS km_gap_severo_topologico,
        COUNT(*) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20))::int AS n_segmentos_gap_severo,
        SUM(g.clientes_bt_total) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)) ::int AS clientes_gap_severo_bt,
        SUM(g.clientes_mt_total) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)) ::int AS clientes_gap_severo_mt,
        SUM(g.clientes_total) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)) ::int AS clientes_gap_severo_total,
        ROUND(COALESCE(SUM(g.demanda_mt_total) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)), 0)::numeric, 3) AS demanda_gap_severo_total,
        ROUND(MAX(g.dist_religador_km)::numeric, 3) AS max_dist_religador_km,
        ROUND(MAX(COALESCE(g.dist_equipamento_auto_km, g.dist_religador_km))::numeric, 3) AS max_dist_equipamento_auto_km,
        ROUND(MAX(COALESCE(g.dist_manobra_km, g.dist_chave_km))::numeric, 3) AS max_dist_manobra_km,
        ROUND(MAX(g.dist_transferencia_km)::numeric, 3) AS max_dist_transferencia_km,
        MAX(g.metodologia) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)) AS metodologia_gap,
        BOOL_OR(g.clientes_total IS NOT NULL) FILTER (WHERE COALESCE(g.gap_religamento_auto, g.score_vulnerabilidade >= 20)) AS exposicao_disponivel
      FROM gaps_protecao g
      WHERE g.alimentador_id IS NOT NULL
      {"AND " + gap_where[6:] if gap_where else ""}
      GROUP BY g.alimentador_id, g.distribuidora, g.uf
    ),
    bt_clientes AS (
      SELECT
        u.alimentador_id AS cod_id,
        u.distribuidora,
        u.uf,
        COUNT(*)::int AS n_ucbt
      FROM ucbt u
      WHERE u.alimentador_id IS NOT NULL
      {"AND " + ucbt_where[6:] if ucbt_where else ""}
      GROUP BY u.alimentador_id, u.distribuidora, u.uf
    ),
    mt_clientes AS (
      SELECT
        u.alimentador_id AS cod_id,
        u.distribuidora,
        u.uf,
        COUNT(*)::int AS n_ucmt,
        ROUND(COALESCE(SUM(u.demanda_contratada), 0)::numeric, 3) AS demanda_mt_total
      FROM ucmt u
      WHERE u.alimentador_id IS NOT NULL
      {"AND " + ucmt_where[6:] if ucmt_where else ""}
      GROUP BY u.alimentador_id, u.distribuidora, u.uf
    ),
    idade_mt AS (
      SELECT
        r.alimentador_id AS cod_id,
        r.distribuidora,
        r.uf,
        AVG(EXTRACT(YEAR FROM AGE(NOW(), r.data_implant))) AS idade_media_anos
      FROM rede_mt r
      WHERE r.alimentador_id IS NOT NULL
        AND r.data_implant IS NOT NULL
      {"AND " + mt_where[6:] if mt_where else ""}
      GROUP BY r.alimentador_id, r.distribuidora, r.uf
    ),
    municipios AS (
      SELECT
        m.cod_id,
        m.distribuidora,
        m.uf,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.municipio ORDER BY m.municipio), NULL) AS municipios_atendidos
      FROM (
        SELECT cod_id, distribuidora, uf, municipio FROM base
        UNION ALL
        SELECT r.alimentador_id AS cod_id, r.distribuidora, r.uf, r.municipio
        FROM rede_mt r
        WHERE r.alimentador_id IS NOT NULL
        {"AND " + mt_where[6:] if mt_where else ""}
        UNION ALL
        SELECT r.alimentador_id AS cod_id, r.distribuidora, r.uf, r.municipio
        FROM rede_bt r
        WHERE r.alimentador_id IS NOT NULL
        {"AND " + bt_where[6:] if bt_where else ""}
        UNION ALL
        SELECT t.alimentador_id AS cod_id, t.distribuidora, t.uf, t.municipio
        FROM transformadores t
        WHERE t.alimentador_id IS NOT NULL
        {"AND " + trafo_where[6:] if trafo_where else ""}
        UNION ALL
        SELECT u.alimentador_id AS cod_id, u.distribuidora, u.uf, u.municipio
        FROM ucbt u
        WHERE u.alimentador_id IS NOT NULL
        {"AND " + ucbt_where[6:] if ucbt_where else ""}
        UNION ALL
        SELECT u.alimentador_id AS cod_id, u.distribuidora, u.uf, u.municipio
        FROM ucmt u
        WHERE u.alimentador_id IS NOT NULL
        {"AND " + ucmt_where[6:] if ucmt_where else ""}
      ) m
      GROUP BY m.cod_id, m.distribuidora, m.uf
    )
    SELECT
      b.cod_id,
      b.distribuidora,
      b.uf,
      b.subestacao_id,
      b.tensao_nom,
      COALESCE(municipios.municipios_atendidos, ARRAY_REMOVE(ARRAY[b.municipio], NULL)) AS municipios_atendidos,
      COALESCE(mt.km_mt, b.comprimento_oficial_km, 0) AS km_mt,
      COALESCE(bt.km_bt, 0) AS km_bt,
      COALESCE(trafos.n_transformadores, 0) AS n_transformadores,
      COALESCE(relig.n_religadores, 0) AS n_religadores,
      COALESCE(chv.n_chaves, 0) AS n_chaves,
      COALESCE(gaps.km_gap_severo, 0) AS km_gap_severo,
      COALESCE(gaps.n_gaps_severos, 0) AS n_gaps_severos,
      CASE
        WHEN COALESCE(mt.km_mt, b.comprimento_oficial_km, 0) > 0
        THEN ROUND((COALESCE(relig.n_religadores, 0)::numeric / COALESCE(mt.km_mt, b.comprimento_oficial_km, 0)::numeric), 4)
        ELSE NULL
      END AS densidade_religadores_km,
      CASE
        WHEN COALESCE(mt.km_mt, b.comprimento_oficial_km, 0) > 0
        THEN ROUND((COALESCE(chv.n_chaves, 0)::numeric / COALESCE(mt.km_mt, b.comprimento_oficial_km, 0)::numeric), 4)
        ELSE NULL
      END AS densidade_chaves_km,
      bt_clientes.n_ucbt,
      mt_clientes.n_ucmt,
      bt_clientes.n_ucbt AS clientes_bt_total,
      mt_clientes.n_ucmt AS clientes_mt_total,
      COALESCE(bt_clientes.n_ucbt, 0) + COALESCE(mt_clientes.n_ucmt, 0) AS clientes_total,
      mt_clientes.demanda_mt_total,
      gaps.clientes_gap_severo_total AS clientes_expostos_gap_severo,
      COALESCE(gaps.km_gap_religamento_auto, 0) AS km_gap_religamento_auto,
      COALESCE(gaps.n_segmentos_gap_religamento_auto, 0) AS n_segmentos_gap_religamento_auto,
      COALESCE(gaps.km_gap_recomposicao, 0) AS km_gap_recomposicao,
      COALESCE(gaps.n_segmentos_gap_recomposicao, 0) AS n_segmentos_gap_recomposicao,
      COALESCE(gaps.km_gap_transferencia, 0) AS km_gap_transferencia,
      COALESCE(gaps.n_segmentos_gap_transferencia, 0) AS n_segmentos_gap_transferencia,
      COALESCE(gaps.km_gap_severo_topologico, 0) AS km_gap_severo_topologico,
      COALESCE(gaps.n_segmentos_gap_severo, 0) AS n_segmentos_gap_severo,
      gaps.clientes_gap_severo_bt,
      gaps.clientes_gap_severo_mt,
      gaps.clientes_gap_severo_total,
      gaps.demanda_gap_severo_total,
      gaps.max_dist_religador_km,
      gaps.max_dist_equipamento_auto_km,
      gaps.max_dist_manobra_km,
      gaps.max_dist_transferencia_km,
      gaps.metodologia_gap,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN COALESCE(mt.km_mt, b.comprimento_oficial_km, 0) <= 0 THEN 'rede_mt_indisponivel' END,
        CASE WHEN idade_mt.idade_media_anos IS NULL THEN 'idade_rede_mt_indisponivel' END,
        CASE WHEN bt_clientes.n_ucbt IS NULL THEN 'clientes_bt_indisponiveis' END,
        CASE WHEN mt_clientes.n_ucmt IS NULL THEN 'clientes_mt_indisponiveis' END,
        CASE
          WHEN COALESCE(bt_clientes.n_ucbt, 0) + COALESCE(mt_clientes.n_ucmt, 0) > 0
           AND NOT COALESCE(gaps.exposicao_disponivel, FALSE)
          THEN 'exposicao_clientes_gap_indisponivel'
        END
      ], NULL) AS lacunas,
      NOW() AS atualizado_em
    FROM base b
    LEFT JOIN municipios
      ON municipios.cod_id = b.cod_id
     AND municipios.distribuidora = b.distribuidora
     AND municipios.uf = b.uf
    LEFT JOIN mt
      ON mt.cod_id = b.cod_id
     AND mt.distribuidora = b.distribuidora
     AND mt.uf = b.uf
    LEFT JOIN bt
      ON bt.cod_id = b.cod_id
     AND bt.distribuidora = b.distribuidora
     AND bt.uf = b.uf
    LEFT JOIN trafos
      ON trafos.cod_id = b.cod_id
     AND trafos.distribuidora = b.distribuidora
     AND trafos.uf = b.uf
    LEFT JOIN relig
      ON relig.cod_id = b.cod_id
     AND relig.distribuidora = b.distribuidora
     AND relig.uf = b.uf
    LEFT JOIN chv
      ON chv.cod_id = b.cod_id
     AND chv.distribuidora = b.distribuidora
     AND chv.uf = b.uf
    LEFT JOIN gaps
      ON gaps.cod_id = b.cod_id
     AND gaps.distribuidora = b.distribuidora
     AND gaps.uf = b.uf
    LEFT JOIN bt_clientes
      ON bt_clientes.cod_id = b.cod_id
     AND bt_clientes.distribuidora = b.distribuidora
     AND bt_clientes.uf = b.uf
    LEFT JOIN mt_clientes
      ON mt_clientes.cod_id = b.cod_id
     AND mt_clientes.distribuidora = b.distribuidora
     AND mt_clientes.uf = b.uf
    LEFT JOIN idade_mt
      ON idade_mt.cod_id = b.cod_id
     AND idade_mt.distribuidora = b.distribuidora
     AND idade_mt.uf = b.uf
    ON CONFLICT (cod_id, distribuidora, uf) DO UPDATE SET
      subestacao_id = EXCLUDED.subestacao_id,
      tensao_nom = EXCLUDED.tensao_nom,
      municipios_atendidos = EXCLUDED.municipios_atendidos,
      km_mt = EXCLUDED.km_mt,
      km_bt = EXCLUDED.km_bt,
      n_transformadores = EXCLUDED.n_transformadores,
      n_religadores = EXCLUDED.n_religadores,
      n_chaves = EXCLUDED.n_chaves,
      km_gap_severo = EXCLUDED.km_gap_severo,
      n_gaps_severos = EXCLUDED.n_gaps_severos,
      densidade_religadores_km = EXCLUDED.densidade_religadores_km,
      densidade_chaves_km = EXCLUDED.densidade_chaves_km,
      n_ucbt = EXCLUDED.n_ucbt,
      n_ucmt = EXCLUDED.n_ucmt,
      clientes_bt_total = EXCLUDED.clientes_bt_total,
      clientes_mt_total = EXCLUDED.clientes_mt_total,
      clientes_total = EXCLUDED.clientes_total,
      demanda_mt_total = EXCLUDED.demanda_mt_total,
      clientes_expostos_gap_severo = EXCLUDED.clientes_expostos_gap_severo,
      km_gap_religamento_auto = EXCLUDED.km_gap_religamento_auto,
      n_segmentos_gap_religamento_auto = EXCLUDED.n_segmentos_gap_religamento_auto,
      km_gap_recomposicao = EXCLUDED.km_gap_recomposicao,
      n_segmentos_gap_recomposicao = EXCLUDED.n_segmentos_gap_recomposicao,
      km_gap_transferencia = EXCLUDED.km_gap_transferencia,
      n_segmentos_gap_transferencia = EXCLUDED.n_segmentos_gap_transferencia,
      km_gap_severo_topologico = EXCLUDED.km_gap_severo_topologico,
      n_segmentos_gap_severo = EXCLUDED.n_segmentos_gap_severo,
      clientes_gap_severo_bt = EXCLUDED.clientes_gap_severo_bt,
      clientes_gap_severo_mt = EXCLUDED.clientes_gap_severo_mt,
      clientes_gap_severo_total = EXCLUDED.clientes_gap_severo_total,
      demanda_gap_severo_total = EXCLUDED.demanda_gap_severo_total,
      max_dist_religador_km = EXCLUDED.max_dist_religador_km,
      max_dist_equipamento_auto_km = EXCLUDED.max_dist_equipamento_auto_km,
      max_dist_manobra_km = EXCLUDED.max_dist_manobra_km,
      max_dist_transferencia_km = EXCLUDED.max_dist_transferencia_km,
      metodologia_gap = EXCLUDED.metodologia_gap,
      lacunas = EXCLUDED.lacunas,
      atualizado_em = EXCLUDED.atualizado_em
    """

    count_sql = "SELECT COUNT(*) FROM alimentador_metricas"
    if distribuidora or uf:
        conditions: list[str] = []
        if distribuidora:
            conditions.append("distribuidora = :distribuidora")
        if uf:
            conditions.append("uf = :uf")
        count_sql += " WHERE " + " AND ".join(conditions)

    with engine.begin() as conn:
        if limpar:
            deleted = int(conn.execute(text(delete_sql), params).rowcount or 0)
            log.info("Deleted %d alimentador_metricas rows before rebuild.", deleted)
        conn.execute(text(insert_sql), params)
        total = int(conn.execute(text(count_sql), params).scalar() or 0)

    return total


@click.command()
@click.option("--distribuidora", default=None, type=str, help="Restringe o rebuild a uma distribuidora.")
@click.option("--uf", default=None, type=str, help="Restringe o rebuild a uma UF.")
@click.option("--limpar/--sem-limpar", default=True, show_default=True, help="Limpa o escopo antes de recalcular.")
@click.option("--db-url", "db_url", default=None, envvar="DATABASE_URL", help="SQLAlchemy database URL.")
def main(distribuidora: Optional[str], uf: Optional[str], limpar: bool, db_url: Optional[str]) -> None:
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL não definida.")
        sys.exit(1)

    engine = create_engine(db_url, pool_pre_ping=True)
    started = datetime.now()
    count = calculate_metricas(
        engine,
        distribuidora=distribuidora,
        uf=uf,
        limpar=limpar,
    )
    elapsed = (datetime.now() - started).total_seconds()
    log.info("Feeder metrics rebuilt: %d alimentadores em %.1fs.", count, elapsed)


if __name__ == "__main__":
    main()
