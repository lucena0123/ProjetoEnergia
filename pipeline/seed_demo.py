#!/usr/bin/env python3
"""
seed_demo.py — GridRisk: dados de demonstração automáticos

Popula o banco com dados realistas para uma UF brasileira sem precisar baixar
arquivos BDGD manualmente. Execução completa em ~3 minutos.

O que este script faz:
  1. Carrega polígonos municipais da UF via API pública do IBGE
  2. Gera segmentos de rede MT sintéticos dentro de cada município
  3. Gera transformadores sintéticos
  4. Gera indicadores DEC/FEC com distribuição realista (2022-2023)
  5. Calcula scores de risco

Os dados de rede (rede_mt, transformadores) são sintéticos mas geograficamente
corretos (dentro dos polígonos reais do IBGE). Os dados DEC/FEC refletem
distribuições típicas do setor elétrico brasileiro.

Usage:
    python seed_demo.py
    python seed_demo.py --uf AL          # padrão
    python seed_demo.py --uf PE          # outro estado
    python seed_demo.py --limpar         # apaga dados existentes antes
"""

import os
import sys
import math
import random
import logging
from datetime import datetime, date, timedelta
from typing import Optional

import click
import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, Point, MultiPolygon, Polygon
from shapely.ops import unary_union
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

# Importa o script de ingestão IBGE do mesmo diretório
sys.path.insert(0, os.path.dirname(__file__))
from ingest_ibge_municipios import ingest_uf as ingest_ibge

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

random.seed(42)  # reprodutível

# ---------------------------------------------------------------------------
# Parâmetros de geração
# ---------------------------------------------------------------------------
CONDUTORES = ["XLPE 95mm²", "XLPE 70mm²", "AAC 95mm²", "ACSR 4/0", "NU 2AWG"]
FABRICANTES = ["ABB", "Trafo", "WEG", "Siemens", "Romagnole"]
TENSAO_MT = 13.8   # kV — valor padrão para a demo

# Segmentos MT por município (proporcional à população estimada)
MT_SEGS_PEQUENO   = 8    # < 20k hab
MT_SEGS_MEDIO     = 20   # 20k–100k hab
MT_SEGS_GRANDE    = 50   # > 100k hab (Maceió, Arapiraca, etc.)

# Distribuidoras usadas na demo por UF. Quando a UF não estiver mapeada,
# usamos um nome neutro para evitar rótulos incorretos.
DISTRIBUIDORA_BY_UF = {
    "AL": "Equatorial Alagoas",
    "CE": "Enel Ceará",
}

# Meses de dados DEC/FEC: jan/2022 – dez/2023
DATA_INICIO = date(2022, 1, 1)
MESES = 24


# ---------------------------------------------------------------------------
# Helpers de geometria
# ---------------------------------------------------------------------------

def random_point_in_polygon(poly) -> Point:
    """Gera um ponto aleatório dentro de um polígono (com bounding box rejection)."""
    if isinstance(poly, MultiPolygon):
        poly = max(poly.geoms, key=lambda g: g.area)
    minx, miny, maxx, maxy = poly.bounds
    for _ in range(200):
        p = Point(random.uniform(minx, maxx), random.uniform(miny, maxy))
        if poly.contains(p):
            return p
    return poly.centroid


def random_line_in_polygon(poly, max_len_deg: float = 0.02) -> LineString:
    """Gera um segmento de linha aleatório dentro de um polígono."""
    p1 = random_point_in_polygon(poly)
    angle = random.uniform(0, 2 * math.pi)
    length = random.uniform(0.003, max_len_deg)
    p2 = Point(
        p1.x + length * math.cos(angle),
        p1.y + length * math.sin(angle),
    )
    # Se o ponto final sair do polígono, usa o centroide como ponto final
    if not poly.contains(p2):
        p2 = poly.centroid
    return LineString([p1, p2])


def seg_length_m(line: LineString) -> float:
    """Comprimento aproximado em metros (conversão graus → metros para BR)."""
    dx = (line.coords[1][0] - line.coords[0][0]) * 111320 * math.cos(
        math.radians((line.coords[0][1] + line.coords[1][1]) / 2)
    )
    dy = (line.coords[1][1] - line.coords[0][1]) * 110540
    return math.sqrt(dx**2 + dy**2)


def random_date_past(max_years: int = 35) -> date:
    """Data aleatória no passado (máximo max_years atrás)."""
    days = random.randint(365, max_years * 365)
    return (datetime.now() - timedelta(days=days)).date()


def resolve_distribuidora(uf: str) -> str:
    return DISTRIBUIDORA_BY_UF.get(uf.upper(), f"Distribuidora Demo {uf.upper()}")


def select_large_municipios(municipios_gdf: gpd.GeoDataFrame) -> set[str]:
    """Seleciona municípios maiores por área para densificar a rede sintética."""
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


# ---------------------------------------------------------------------------
# Geração de rede MT
# ---------------------------------------------------------------------------

def generate_rede_mt(
    municipios_gdf: gpd.GeoDataFrame,
    distribuidora: str,
    large_municipios: set[str],
) -> gpd.GeoDataFrame:
    """Gera segmentos de rede MT sintéticos para cada município."""
    log.info("Gerando segmentos de rede MT...")
    rows = []
    for _, row in municipios_gdf.iterrows():
        nome = row["nome"]
        n_segs = (
            MT_SEGS_GRANDE if nome in large_municipios
            else MT_SEGS_MEDIO if random.random() < 0.15
            else MT_SEGS_PEQUENO
        )
        for i in range(n_segs):
            line = random_line_in_polygon(row["geom"])
            rows.append({
                "cod_id": f"MT-DEMO-{row['codigo_ibge']}-{i:03d}",
                "distribuidora": distribuidora,
                "municipio": nome,
                "uf": row["uf"],
                "tensao_nom": TENSAO_MT,
                "condutor": random.choice(CONDUTORES),
                "comprimento": round(seg_length_m(line), 1),
                "data_implant": random_date_past(35),
                "geom": line,
            })
    gdf = gpd.GeoDataFrame(rows, geometry="geom", crs="EPSG:4674")
    log.info("  %d segmentos MT gerados para %d municípios.",
             len(gdf), len(municipios_gdf))
    return gdf


# ---------------------------------------------------------------------------
# Geração de transformadores
# ---------------------------------------------------------------------------

def generate_transformadores(
    municipios_gdf: gpd.GeoDataFrame,
    distribuidora: str,
    large_municipios: set[str],
) -> gpd.GeoDataFrame:
    """Gera transformadores sintéticos (1 por ~2 segmentos MT)."""
    log.info("Gerando transformadores...")
    rows = []
    potencias = [15.0, 30.0, 45.0, 75.0, 112.5, 150.0, 225.0, 300.0]
    for _, row in municipios_gdf.iterrows():
        n_trans = max(2, int(
            (MT_SEGS_GRANDE if row["nome"] in large_municipios else MT_SEGS_MEDIO) / 2
        ))
        for i in range(n_trans):
            pt = random_point_in_polygon(row["geom"])
            rows.append({
                "cod_id": f"TR-DEMO-{row['codigo_ibge']}-{i:03d}",
                "distribuidora": distribuidora,
                "municipio": row["nome"],
                "potencia_nom": random.choice(potencias),
                "fabricante": random.choice(FABRICANTES),
                "data_implant": random_date_past(30),
                "geom": pt,
            })
    gdf = gpd.GeoDataFrame(rows, geometry="geom", crs="EPSG:4674")
    log.info("  %d transformadores gerados.", len(gdf))
    return gdf


# ---------------------------------------------------------------------------
# Geração de indicadores DEC/FEC
# ---------------------------------------------------------------------------

def generate_dec_fec(municipios_gdf: gpd.GeoDataFrame, distribuidora: str) -> pd.DataFrame:
    """
    Gera indicadores DEC/FEC mensais com distribuição realista.

    Municípios "críticos" (25% da amostra) têm DEC sistematicamente acima
    do limite, criando scores de risco altos e dando vida ao mapa.
    """
    log.info("Gerando indicadores DEC/FEC (2022-2023)...")

    # Distribui municípios em 3 perfis de risco
    nomes = municipios_gdf["nome"].tolist()
    random.shuffle(nomes)
    n = len(nomes)
    criticos  = set(nomes[:int(n * 0.25)])   # 25% — score alto
    medianos  = set(nomes[int(n*0.25):int(n*0.60)])  # 35% — score médio
    # demais são "bons"

    rows = []
    for _, mun in municipios_gdf.iterrows():
        nome = mun["nome"]
        uf = mun["uf"]

        if nome in criticos:
            dec_base, dec_lim, fec_base, fec_lim = 18.0, 12.0, 12.0, 8.0
            jitter_d, jitter_f = 6.0, 4.0
        elif nome in medianos:
            dec_base, dec_lim, fec_base, fec_lim = 10.0, 12.0, 7.0, 8.0
            jitter_d, jitter_f = 4.0, 3.0
        else:
            dec_base, dec_lim, fec_base, fec_lim = 6.0, 12.0, 4.0, 8.0
            jitter_d, jitter_f = 3.0, 2.0

        for m in range(MESES):
            mes_date = DATA_INICIO + timedelta(days=30 * m)
            # Sazonalidade: pior no verão (dez-mar) por chuvas
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
    log.info("  %d registros DEC/FEC gerados (%d meses × %d municípios).",
             len(df), MESES, len(municipios_gdf))
    return df


# ---------------------------------------------------------------------------
# Inserção no banco
# ---------------------------------------------------------------------------

def clear_existing(engine, uf: str, distribuidora: str) -> None:
    log.info("Removendo dados existentes para UF=%s...", uf)
    with engine.begin() as conn:
        deletions = [
            ("mapa_risco", text("DELETE FROM mapa_risco WHERE uf = :uf"), {"uf": uf}),
            (
                "indicadores_continuidade",
                text("DELETE FROM indicadores_continuidade WHERE uf = :uf"),
                {"uf": uf},
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

        for table, statement, params in deletions:
            deleted = conn.execute(statement, params).rowcount
            if deleted:
                log.info("  %s: %d linhas removidas.", table, deleted)


def insert_rede_mt(gdf: gpd.GeoDataFrame, engine) -> None:
    log.info("Inserindo rede MT no banco...")
    # Remove duplicatas de cod_id que possam existir
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


def insert_dec_fec(df: pd.DataFrame, engine, distribuidora: str) -> None:
    log.info("Inserindo indicadores DEC/FEC no banco...")
    # Remove duplicatas
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM indicadores_continuidade WHERE distribuidora = :d"),
            {"d": distribuidora},
        )
    df.to_sql("indicadores_continuidade", engine, if_exists="append", index=False, chunksize=2000)
    log.info("  %d registros inseridos.", len(df))


def run_calculate_risk(engine, distribuidora: str) -> None:
    """Executa o SQL de scoring diretamente (sem chamar o script externo)."""
    log.info("Calculando scores de risco...")
    sql = """
    DELETE FROM mapa_risco WHERE distribuidora = :dist;

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
    ORDER BY (score_dec + score_freq + score_idade) DESC;
    """
    with engine.begin() as conn:
        for statement in sql.strip().split(";"):
            stmt = statement.strip()
            if stmt:
                conn.execute(text(stmt), {"dist": distribuidora})

    with engine.connect() as conn:
        total = conn.execute(
            text("SELECT COUNT(*) FROM mapa_risco WHERE distribuidora = :d"),
            {"d": distribuidora},
        ).scalar()
        top5 = conn.execute(
            text("""
                SELECT municipio, score_risco
                FROM mapa_risco WHERE distribuidora = :d
                ORDER BY score_risco DESC LIMIT 5
            """),
            {"d": distribuidora},
        ).fetchall()

    log.info("  %d municípios com score calculado.", total)
    log.info("  Top 5 municípios críticos:")
    for i, (mun, score) in enumerate(top5, 1):
        log.info("    %d. %-30s  score %.1f", i, mun, score)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option("--uf", default="AL", show_default=True,
              help="Estado para gerar dados (ex: AL, PE, BA).")
@click.option("--limpar", is_flag=True, default=False,
              help="Remove dados existentes do estado antes de inserir.")
@click.option("--db-url", "db_url", default=None, envvar="DATABASE_URL",
              show_envvar=True, help="SQLAlchemy database URL.")
def main(uf: str, limpar: bool, db_url: Optional[str]) -> None:
    """Popula o banco com dados de demonstração para um estado brasileiro."""
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

    # ── 1. IBGE boundaries ────────────────────────────────────────────────────
    log.info("[1/5] Carregando polígonos municipais do IBGE...")
    ingest_ibge(uf, engine)

    # Lê os municípios do banco (já carregados)
    municipios_gdf = gpd.read_postgis(
        f"SELECT codigo_ibge, nome, uf, geom FROM ibge_municipios WHERE uf = '{uf}'",
        engine,
        geom_col="geom",
    )
    log.info("  %d municípios carregados.", len(municipios_gdf))
    large_municipios = select_large_municipios(municipios_gdf)

    if limpar:
        clear_existing(engine, uf, distribuidora)

    # ── 2. Rede MT ────────────────────────────────────────────────────────────
    log.info("[2/5] Gerando rede MT sintética...")
    rede_gdf = generate_rede_mt(municipios_gdf, distribuidora, large_municipios)
    insert_rede_mt(rede_gdf, engine)

    # ── 3. Transformadores ────────────────────────────────────────────────────
    log.info("[3/5] Gerando transformadores sintéticos...")
    trans_gdf = generate_transformadores(municipios_gdf, distribuidora, large_municipios)
    insert_transformadores(trans_gdf, engine)

    # ── 4. DEC/FEC ────────────────────────────────────────────────────────────
    log.info("[4/5] Gerando indicadores DEC/FEC...")
    dec_df = generate_dec_fec(municipios_gdf, distribuidora)
    insert_dec_fec(dec_df, engine, distribuidora)

    # ── 5. Score de risco ─────────────────────────────────────────────────────
    log.info("[5/5] Calculando scores de risco...")
    run_calculate_risk(engine, distribuidora)

    elapsed = (datetime.now() - started).total_seconds()
    log.info("=" * 60)
    log.info("Seed concluído em %.1fs.", elapsed)
    log.info("Acesse: http://localhost:3000")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
