#!/usr/bin/env python3
"""
seed_demo.py — GridRisk: dados de demonstração automáticos

Popula o banco com dados realistas para uma UF brasileira sem precisar baixar
arquivos BDGD manualmente. Execução completa em ~4 minutos.

O que este script faz:
  1. Carrega polígonos municipais da UF via API pública do IBGE
  2. Gera segmentos de rede MT sintéticos dentro de cada município
  3. Gera transformadores sintéticos
  4. Tenta ingerir indicadores DEC/FEC reais da ANEEL; faz fallback sintético
  5. Calcula scores de risco
  6. Gera religadores e chaves sintéticos
  7. Calcula gaps de proteção
  8. Ingere dados populacionais do IBGE
  9. Cria snapshot de histórico de scores
"""

import os
import sys
import math
import random
import logging
from collections import Counter
from datetime import datetime, date, timedelta
from typing import Optional

import click
import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, Point, MultiPolygon
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(__file__))
from ingest_ibge_municipios import ingest_uf as ingest_ibge


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

random.seed(42)


CONDUTORES = ["XLPE 95mm²", "XLPE 70mm²", "AAC 95mm²", "ACSR 4/0", "NU 2AWG"]
FABRICANTES = ["ABB", "Trafo", "WEG", "Siemens", "Romagnole"]
TENSAO_MT = 13.8

MT_SEGS_PEQUENO = 8
MT_SEGS_MEDIO = 20
MT_SEGS_GRANDE = 50

DISTRIBUIDORA_BY_UF = {
    "AL": "Equatorial Alagoas",
    "CE": "Enel Ceará",
}

DATA_INICIO = date(2022, 1, 1)
MESES = 24


def random_point_in_polygon(poly) -> Point:
    if isinstance(poly, MultiPolygon):
        poly = max(poly.geoms, key=lambda g: g.area)
    minx, miny, maxx, maxy = poly.bounds
    for _ in range(200):
        point = Point(random.uniform(minx, maxx), random.uniform(miny, maxy))
        if poly.contains(point):
            return point
    return poly.centroid


def random_line_in_polygon(poly, max_len_deg: float = 0.02) -> LineString:
    point_a = random_point_in_polygon(poly)
    angle = random.uniform(0, 2 * math.pi)
    length = random.uniform(0.003, max_len_deg)
    point_b = Point(
        point_a.x + length * math.cos(angle),
        point_a.y + length * math.sin(angle),
    )
    if not poly.contains(point_b):
        point_b = poly.centroid
    return LineString([point_a, point_b])


def seg_length_m(line: LineString) -> float:
    dx = (line.coords[1][0] - line.coords[0][0]) * 111320 * math.cos(
        math.radians((line.coords[0][1] + line.coords[1][1]) / 2)
    )
    dy = (line.coords[1][1] - line.coords[0][1]) * 110540
    return math.sqrt(dx**2 + dy**2)


def random_date_past(max_years: int = 35) -> date:
    days = random.randint(365, max_years * 365)
    return (datetime.now() - timedelta(days=days)).date()


def random_date_past_range(min_years: int, max_years: int) -> date:
    min_days = min_years * 365
    max_days = max_years * 365
    days = random.randint(min_days, max_days)
    return (datetime.now() - timedelta(days=days)).date()


def resolve_distribuidora(uf: str) -> str:
    return DISTRIBUIDORA_BY_UF.get(uf.upper(), f"Distribuidora Demo {uf.upper()}")


def select_large_municipios(municipios_gdf: gpd.GeoDataFrame) -> set[str]:
    if municipios_gdf.empty:
        return set()

    projected = municipios_gdf.to_crs(3857)
    ranked = (
        municipios_gdf[["nome", "geom"]]
        .assign(area=projected.geometry.area)
        .sort_values("area", ascending=False)
    )
    top_n = min(max(5, math.ceil(len(ranked) * 0.1)), len(ranked))
    return set(ranked.head(top_n)["nome"].tolist())


def assign_profiles(nomes: list[str]) -> dict[str, str]:
    """
    Distribui municípios em 4 perfis de risco:
      - critico: 30% — score esperado 75-95
      - alto:    25% — score esperado 55-74
      - medio:   25% — score esperado 35-54
      - bom:     20% — score esperado 10-34
    """
    nomes = list(nomes)
    random.shuffle(nomes)
    total = len(nomes)

    n_critico = int(total * 0.30)
    n_alto = int(total * 0.25)
    n_medio = int(total * 0.25)

    profiles: dict[str, str] = {}
    for index, nome in enumerate(nomes):
        if index < n_critico:
            profiles[nome] = "critico"
        elif index < n_critico + n_alto:
            profiles[nome] = "alto"
        elif index < n_critico + n_alto + n_medio:
            profiles[nome] = "medio"
        else:
            profiles[nome] = "bom"

    counts = Counter(profiles.values())
    log.info(
        "  Perfis: Crítico=%d (%.0f%%), Alto=%d (%.0f%%), Médio=%d (%.0f%%), Bom=%d (%.0f%%)",
        counts["critico"], counts["critico"] / total * 100,
        counts["alto"], counts["alto"] / total * 100,
        counts["medio"], counts["medio"] / total * 100,
        counts["bom"], counts["bom"] / total * 100,
    )
    return profiles


def generate_rede_mt(
    municipios_gdf: gpd.GeoDataFrame,
    distribuidora: str,
    profiles: dict[str, str],
    large_municipios: set[str],
) -> gpd.GeoDataFrame:
    log.info("Gerando segmentos de rede MT...")
    rows = []
    for _, row in municipios_gdf.iterrows():
        nome = row["nome"]
        perfil = profiles.get(nome, "medio")
        n_segs = (
            MT_SEGS_GRANDE if nome in large_municipios
            else MT_SEGS_MEDIO if random.random() < 0.15
            else MT_SEGS_PEQUENO
        )
        for index in range(n_segs):
            line = random_line_in_polygon(row["geom"])
            if perfil == "critico":
                data_implant = random_date_past_range(25, 40)
            elif perfil == "alto":
                data_implant = random_date_past_range(15, 30)
            elif perfil == "medio":
                data_implant = random_date_past_range(8, 25)
            else:
                data_implant = random_date_past_range(2, 15)
            rows.append({
                "cod_id": f"MT-DEMO-{row['codigo_ibge']}-{index:03d}",
                "distribuidora": distribuidora,
                "municipio": nome,
                "uf": row["uf"],
                "tensao_nom": TENSAO_MT,
                "condutor": random.choice(CONDUTORES),
                "comprimento": round(seg_length_m(line), 1),
                "data_implant": data_implant,
                "geom": line,
            })
    gdf = gpd.GeoDataFrame(rows, geometry="geom", crs="EPSG:4674")
    log.info("  %d segmentos MT gerados para %d municípios.", len(gdf), len(municipios_gdf))
    return gdf


def generate_transformadores(
    municipios_gdf: gpd.GeoDataFrame,
    distribuidora: str,
    profiles: dict[str, str],
    large_municipios: set[str],
) -> gpd.GeoDataFrame:
    log.info("Gerando transformadores...")
    rows = []
    potencias = [15.0, 30.0, 45.0, 75.0, 112.5, 150.0, 225.0, 300.0]
    for _, row in municipios_gdf.iterrows():
        nome = row["nome"]
        perfil = profiles.get(nome, "medio")
        n_trans = max(2, int((MT_SEGS_GRANDE if nome in large_municipios else MT_SEGS_MEDIO) / 2))
        for index in range(n_trans):
            point = random_point_in_polygon(row["geom"])
            if perfil == "critico":
                data_implant = random_date_past_range(20, 35)
            elif perfil == "bom":
                data_implant = random_date_past_range(2, 15)
            else:
                data_implant = random_date_past(30)
            rows.append({
                "cod_id": f"TR-DEMO-{row['codigo_ibge']}-{index:03d}",
                "distribuidora": distribuidora,
                "municipio": nome,
                "potencia_nom": random.choice(potencias),
                "fabricante": random.choice(FABRICANTES),
                "data_implant": data_implant,
                "geom": point,
            })
    gdf = gpd.GeoDataFrame(rows, geometry="geom", crs="EPSG:4674")
    log.info("  %d transformadores gerados.", len(gdf))
    return gdf


def generate_religadores(
    municipios_gdf: gpd.GeoDataFrame,
    distribuidora: str,
    profiles: dict[str, str],
) -> gpd.GeoDataFrame:
    log.info("Gerando religadores...")
    rows = []
    for _, row in municipios_gdf.iterrows():
        nome = row["nome"]
        perfil = profiles.get(nome, "medio")
        if perfil == "critico":
            n_rel = random.randint(0, 1)
        elif perfil == "alto":
            n_rel = random.randint(1, 2)
        elif perfil == "medio":
            n_rel = random.randint(2, 3)
        else:
            n_rel = random.randint(2, 4)

        for index in range(n_rel):
            point = random_point_in_polygon(row["geom"])
            rows.append({
                "cod_id": f"RE-DEMO-{row['codigo_ibge']}-{index:03d}",
                "distribuidora": distribuidora,
                "municipio": nome,
                "data_implant": random_date_past_range(5, 20),
                "geom": point,
            })
    gdf = gpd.GeoDataFrame(rows, geometry="geom", crs="EPSG:4674")
    log.info("  %d religadores gerados.", len(gdf))
    return gdf


def generate_chaves(
    municipios_gdf: gpd.GeoDataFrame,
    distribuidora: str,
    n_rel_per_mun: dict[str, int],
) -> gpd.GeoDataFrame:
    log.info("Gerando chaves seccionadoras...")
    rows = []
    for _, row in municipios_gdf.iterrows():
        nome = row["nome"]
        n_rel = n_rel_per_mun.get(nome, 1)
        n_chaves = max(1, n_rel // 2)
        for index in range(n_chaves):
            point = random_point_in_polygon(row["geom"])
            rows.append({
                "cod_id": f"CH-DEMO-{row['codigo_ibge']}-{index:03d}",
                "distribuidora": distribuidora,
                "municipio": nome,
                "uf": row["uf"],
                "tipo_chave": "SECCIONADORA",
                "operacao": "MANUAL",
                "data_implant": random_date_past_range(5, 25),
                "geom": point,
            })
    gdf = gpd.GeoDataFrame(rows, geometry="geom", crs="EPSG:4674")
    log.info("  %d chaves geradas.", len(gdf))
    return gdf


def generate_dec_fec(
    municipios_gdf: gpd.GeoDataFrame,
    distribuidora: str,
    profiles: dict[str, str],
) -> pd.DataFrame:
    log.info("Gerando indicadores DEC/FEC (2022-2023)...")
    rows = []

    for _, mun in municipios_gdf.iterrows():
        nome = mun["nome"]
        uf = mun["uf"]
        perfil = profiles.get(nome, "bom")

        if perfil == "critico":
            dec_base, dec_lim, fec_base, fec_lim = 28.0, 12.0, 18.0, 8.0
            jitter_d, jitter_f = 4.0, 3.0
        elif perfil == "alto":
            dec_base, dec_lim, fec_base, fec_lim = 18.0, 12.0, 11.0, 8.0
            jitter_d, jitter_f = 3.0, 2.5
        elif perfil == "medio":
            dec_base, dec_lim, fec_base, fec_lim = 13.0, 12.0, 8.0, 8.0
            jitter_d, jitter_f = 2.5, 2.0
        else:
            dec_base, dec_lim, fec_base, fec_lim = 6.0, 12.0, 4.0, 8.0
            jitter_d, jitter_f = 2.0, 1.5

        for offset in range(MESES):
            mes_date = DATA_INICIO + timedelta(days=30 * offset)
            season = 1.0 + 0.3 * math.sin(2 * math.pi * (mes_date.month - 1) / 12)
            rows.append({
                "distribuidora": distribuidora,
                "municipio": nome,
                "uf": uf,
                "ano": mes_date.year,
                "mes": mes_date.month,
                "dec_apurado": round(max(0.5, dec_base * season + random.gauss(0, jitter_d)), 2),
                "dec_limite": dec_lim,
                "fec_apurado": round(max(0.1, fec_base * season + random.gauss(0, jitter_f)), 2),
                "fec_limite": fec_lim,
            })

    df = pd.DataFrame(rows)
    log.info("  %d registros DEC/FEC gerados (%d meses × %d municípios).", len(df), MESES, len(municipios_gdf))
    return df


def clear_existing(engine, uf: str, distribuidora: str) -> None:
    log.info("Removendo dados existentes para UF=%s...", uf)
    deletions = [
        ("mapa_risco", text("DELETE FROM mapa_risco WHERE uf = :uf"), {"uf": uf}),
        ("historico_score", text("DELETE FROM historico_score WHERE uf = :uf"), {"uf": uf}),
        ("gaps_protecao", text("DELETE FROM gaps_protecao WHERE uf = :uf"), {"uf": uf}),
        ("indicadores_continuidade", text("DELETE FROM indicadores_continuidade WHERE uf = :uf"), {"uf": uf}),
        ("chaves", text("DELETE FROM chaves WHERE uf = :uf"), {"uf": uf}),
        (
            "religadores",
            text(
                """
                DELETE FROM religadores
                WHERE distribuidora = :dist
                  AND municipio IN (
                    SELECT nome FROM ibge_municipios WHERE uf = :uf
                  )
                """
            ),
            {"dist": distribuidora, "uf": uf},
        ),
        ("rede_mt", text("DELETE FROM rede_mt WHERE uf = :uf"), {"uf": uf}),
        (
            "transformadores",
            text(
                """
                DELETE FROM transformadores
                WHERE distribuidora = :dist
                  AND municipio IN (
                    SELECT nome FROM ibge_municipios WHERE uf = :uf
                  )
                """
            ),
            {"dist": distribuidora, "uf": uf},
        ),
    ]

    with engine.begin() as conn:
        for table, statement, params in deletions:
            deleted = conn.execute(statement, params).rowcount
            if deleted:
                log.info("  %s: %d linhas removidas.", table, deleted)


def insert_rede_mt(gdf: gpd.GeoDataFrame, engine) -> None:
    log.info("Inserindo rede MT no banco...")
    with engine.begin() as conn:
      for cod in gdf["cod_id"].tolist():
        conn.execute(text("DELETE FROM rede_mt WHERE cod_id = :c"), {"c": cod})
    gdf.to_postgis("rede_mt", engine, if_exists="append", index=False, chunksize=1000)
    log.info("  %d segmentos inseridos.", len(gdf))


def insert_transformadores(gdf: gpd.GeoDataFrame, engine) -> None:
    log.info("Inserindo transformadores no banco...")
    with engine.begin() as conn:
        for cod in gdf["cod_id"].tolist():
            conn.execute(text("DELETE FROM transformadores WHERE cod_id = :c"), {"c": cod})
    gdf.to_postgis("transformadores", engine, if_exists="append", index=False, chunksize=1000)
    log.info("  %d transformadores inseridos.", len(gdf))


def insert_religadores(gdf: gpd.GeoDataFrame, engine) -> None:
    log.info("Inserindo religadores no banco...")
    with engine.begin() as conn:
        for cod in gdf["cod_id"].tolist():
            conn.execute(text("DELETE FROM religadores WHERE cod_id = :c"), {"c": cod})
    if len(gdf) > 0:
        gdf.to_postgis("religadores", engine, if_exists="append", index=False, chunksize=500)
    log.info("  %d religadores inseridos.", len(gdf))


def insert_chaves(gdf: gpd.GeoDataFrame, engine) -> None:
    log.info("Inserindo chaves no banco...")
    with engine.begin() as conn:
        for cod in gdf["cod_id"].tolist():
            conn.execute(text("DELETE FROM chaves WHERE cod_id = :c"), {"c": cod})
    if len(gdf) > 0:
        gdf.to_postgis("chaves", engine, if_exists="append", index=False, chunksize=500)
    log.info("  %d chaves inseridas.", len(gdf))


def insert_dec_fec(df: pd.DataFrame, engine, distribuidora: str) -> None:
    log.info("Inserindo indicadores DEC/FEC no banco...")
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM indicadores_continuidade WHERE distribuidora = :d"),
            {"d": distribuidora},
        )
    df.to_sql("indicadores_continuidade", engine, if_exists="append", index=False, chunksize=2000)
    log.info("  %d registros inseridos.", len(df))


def run_calculate_risk(engine, distribuidora: Optional[str] = None) -> None:
    """
    Executa o SQL de scoring diretamente (sem chamar o script externo).

    Se distribuidora=None, recalcula para todas as distribuidoras presentes em
    indicadores_continuidade (útil quando dados reais da ANEEL são usados e o
    nome do agente pode diferir de DISTRIBUIDORA).
    """
    log.info("Calculando scores de risco...")

    # Determine which distribuidoras to process
    if distribuidora is not None:
        distribuidoras = [distribuidora]
    else:
        with engine.connect() as conn:
            rows = conn.execute(
                text("SELECT DISTINCT distribuidora FROM indicadores_continuidade")
            ).fetchall()
        distribuidoras = [r[0] for r in rows if r[0]]
        if not distribuidoras:
            log.warning("  Nenhuma distribuidora encontrada em indicadores_continuidade.")
            return
        log.info("  Calculando scores para %d distribuidora(s): %s", len(distribuidoras), distribuidoras)

    sql_delete = "DELETE FROM mapa_risco WHERE distribuidora = :dist"
    sql_insert = """
    INSERT INTO mapa_risco
      (municipio, distribuidora, uf, score_risco, dec_medio_12m,
       ratio_dec, meses_violacao, idade_media_anos, atualizado_em)
    WITH ic_12m AS (
      SELECT
        municipio, distribuidora, uf,
        AVG(dec_apurado)  AS dec_medio_12m,
        AVG(dec_limite)   AS dec_limite_medio,
        CASE WHEN AVG(dec_limite) > 0
             THEN LEAST(AVG(dec_apurado) / AVG(dec_limite), 3.0)
             ELSE 0 END   AS ratio_dec,
        COUNT(*) FILTER (WHERE violacao_dec) AS meses_violacao
      FROM indicadores_continuidade
      WHERE distribuidora = :dist
        AND (ano * 12 + mes) >= (
          SELECT MAX(ano * 12 + mes) - 11 FROM indicadores_continuidade
        )
      GROUP BY municipio, distribuidora, uf
    ),
    idade_rede AS (
      SELECT municipio, distribuidora,
        AVG(EXTRACT(YEAR FROM AGE(NOW(), data_implant))) AS idade_media_anos
      FROM rede_mt
      WHERE data_implant IS NOT NULL AND distribuidora = :dist
      GROUP BY municipio, distribuidora
    ),
    scoring AS (
      SELECT
        ic.municipio, ic.distribuidora, ic.uf,
        ic.dec_medio_12m, ic.ratio_dec, ic.meses_violacao,
        COALESCE(ir.idade_media_anos, 20) AS idade_media_anos,
        LEAST(ic.ratio_dec / 3.0, 1.0) * 40               AS score_dec,
        LEAST(ic.meses_violacao::float / 12.0, 1.0) * 30  AS score_freq,
        LEAST(COALESCE(ir.idade_media_anos, 20) / 40.0, 1.0) * 30 AS score_idade
      FROM ic_12m ic
      LEFT JOIN idade_rede ir
        ON ic.municipio = ir.municipio AND ic.distribuidora = ir.distribuidora
    )
    SELECT
      municipio, distribuidora, uf,
      ROUND((score_dec + score_freq + score_idade)::numeric, 2) AS score_risco,
      ROUND(dec_medio_12m::numeric, 2),
      ROUND(ratio_dec::numeric, 4),
      meses_violacao,
      ROUND(idade_media_anos::numeric, 1),
      NOW()
    FROM scoring
    ORDER BY (score_dec + score_freq + score_idade) DESC
    """
    for dist in distribuidoras:
        with engine.begin() as conn:
            conn.execute(text(sql_delete), {"dist": dist})
            conn.execute(text(sql_insert), {"dist": dist})

    with engine.connect() as conn:
        total = conn.execute(
            text("SELECT COUNT(*) FROM mapa_risco WHERE distribuidora = ANY(:dists)"),
            {"dists": distribuidoras},
        ).scalar()
        top5 = conn.execute(
            text("""
                SELECT municipio, distribuidora, score_risco
                FROM mapa_risco WHERE distribuidora = ANY(:dists)
                ORDER BY score_risco DESC LIMIT 5
            """),
            {"dists": distribuidoras},
        ).fetchall()

    log.info("  %d municípios com score calculado.", total)
    log.info("  Top 5 municípios críticos:")
    for i, row in enumerate(top5, 1):
        mun, dist, score = row[0], row[1], row[2]
        log.info("    %d. %-30s (%s)  score %.1f", i, mun, dist, score)


@click.command()
@click.option("--uf", default="AL", show_default=True, help="Estado para gerar dados (ex: AL, PE, BA).")
@click.option("--limpar", is_flag=True, default=False, help="Remove dados existentes do estado antes de inserir.")
@click.option("--db-url", "db_url", default=None, envvar="DATABASE_URL", show_envvar=True, help="SQLAlchemy database URL.")
def main(uf: str, limpar: bool, db_url: Optional[str]) -> None:
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL não definida. Use --db-url ou defina a variável de ambiente.")
        sys.exit(1)

    uf = uf.upper()
    distribuidora = resolve_distribuidora(uf)
    engine = create_engine(db_url, pool_pre_ping=True)
    started = datetime.now()

    log.info("=" * 60)
    log.info("GridRisk — Seed de demonstração para UF=%s", uf)
    log.info("Distribuidora da demo: %s", distribuidora)
    log.info("=" * 60)

    log.info("[1/9] Carregando polígonos municipais do IBGE...")
    ingest_ibge(uf, engine)

    municipios_gdf = gpd.read_postgis(
        f"SELECT codigo_ibge, nome, uf, geom FROM ibge_municipios WHERE uf = '{uf}'",
        engine,
        geom_col="geom",
    )
    log.info("  %d municípios carregados.", len(municipios_gdf))
    large_municipios = select_large_municipios(municipios_gdf)

    log.info("  Distribuindo perfis de risco...")
    profiles = assign_profiles(municipios_gdf["nome"].tolist())

    if limpar:
        clear_existing(engine, uf, distribuidora)

    log.info("[2/9] Gerando rede MT sintética...")
    rede_gdf = generate_rede_mt(municipios_gdf, distribuidora, profiles, large_municipios)
    insert_rede_mt(rede_gdf, engine)

    log.info("[3/9] Gerando transformadores sintéticos...")
    trans_gdf = generate_transformadores(municipios_gdf, distribuidora, profiles, large_municipios)
    insert_transformadores(trans_gdf, engine)

    log.info("[4/9] Carregando indicadores DEC/FEC...")
    aneel_ok = False
    if uf in {"AL", "CE"}:
        try:
            from ingest_aneel_continuidade import ingest_for_seed as ingest_aneel_real

            ingest_aneel_real(
                uf,
                engine,
                ano_inicio=2022,
                ano_fim=2023,
                distribuidora_override=distribuidora,
            )
            log.info("  Usando dados reais da ANEEL para DEC/FEC.")
            aneel_ok = True
        except Exception as exc:
            log.warning("  Falha ao usar dados reais da ANEEL: %s", exc)

    if not aneel_ok:
        log.info("  Usando DEC/FEC sintético para a demo.")
        dec_df = generate_dec_fec(municipios_gdf, distribuidora, profiles)
        insert_dec_fec(dec_df, engine, distribuidora)

    log.info("[5/9] Calculando scores de risco...")
    run_calculate_risk(engine, distribuidora)

    log.info("[6/9] Gerando religadores e chaves sintéticos...")
    rel_gdf = generate_religadores(municipios_gdf, distribuidora, profiles)
    insert_religadores(rel_gdf, engine)

    n_rel_per_mun = {nome: 0 for nome in municipios_gdf["nome"].tolist()}
    for _, row in rel_gdf.iterrows():
        n_rel_per_mun[row["municipio"]] = n_rel_per_mun.get(row["municipio"], 0) + 1

    chaves_gdf = generate_chaves(municipios_gdf, distribuidora, n_rel_per_mun)
    insert_chaves(chaves_gdf, engine)

    log.info("[7/9] Calculando gaps de proteção...")
    try:
        from calculate_gaps import calculate_gaps
        n_gaps = calculate_gaps(distribuidora, uf, 500, engine)
        log.info("  %d gaps de proteção encontrados.", n_gaps)
    except Exception as exc:
        log.warning("  Falha ao calcular gaps: %s", exc)

    log.info("[8/9] Ingerindo dados populacionais do IBGE...")
    try:
        from ingest_ibge_populacao import ingest_uf as ingest_pop
        n_pop = ingest_pop(uf, engine)
        log.info("  %d municípios com dados populacionais.", n_pop)
    except Exception as exc:
        log.warning("  Falha ao ingerir população IBGE: %s", exc)

    log.info("[9/9] Criando snapshot de histórico...")
    try:
        from calculate_historico import snapshot_scores
        n_hist = snapshot_scores(engine)
        log.info("  %d registros de histórico criados.", n_hist)
    except Exception as exc:
        log.warning("  Falha ao criar snapshot de histórico: %s", exc)

    elapsed = (datetime.now() - started).total_seconds()
    log.info("=" * 60)
    log.info("Seed concluído em %.1fs.", elapsed)
    log.info("Acesse: http://localhost:3000")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
