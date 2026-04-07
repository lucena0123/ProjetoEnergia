-- =============================================================
-- GridRisk - Database Initialization Script
-- Requires PostgreSQL with PostGIS extension
-- =============================================================

-- Enable PostGIS extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- -------------------------------------------------------------
-- rede_mt: Medium-voltage grid segments (LineString geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rede_mt (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  tensao_nom    FLOAT,
  condutor      VARCHAR(50),
  comprimento   FLOAT,
  data_implant  DATE,
  geom          GEOMETRY(LineString, 4674)
);

-- -------------------------------------------------------------
-- rede_bt: Low-voltage grid segments (LineString geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rede_bt (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  condutor      VARCHAR(50),
  comprimento   FLOAT,
  data_implant  DATE,
  geom          GEOMETRY(LineString, 4674)
);

-- -------------------------------------------------------------
-- transformadores: Distribution transformers (Point geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transformadores (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  potencia_nom  FLOAT,
  fabricante    VARCHAR(100),
  data_implant  DATE,
  geom          GEOMETRY(Point, 4674)
);

-- -------------------------------------------------------------
-- religadores: Automatic reclosers (Point geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS religadores (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  data_implant  DATE,
  geom          GEOMETRY(Point, 4674)
);

-- -------------------------------------------------------------
-- subestacoes: Substations (Point geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subestacoes (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  tensao_nom    FLOAT,
  data_implant  DATE,
  geom          GEOMETRY(Point, 4674)
);

-- -------------------------------------------------------------
-- indicadores_continuidade: DEC/FEC continuity indicators
-- violacao_dec and violacao_fec are computed (GENERATED ALWAYS)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indicadores_continuidade (
  id            SERIAL PRIMARY KEY,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  ano           INT,
  mes           INT,
  dec_apurado   FLOAT,
  dec_limite    FLOAT,
  fec_apurado   FLOAT,
  fec_limite    FLOAT,
  violacao_dec  BOOLEAN GENERATED ALWAYS AS (dec_apurado > dec_limite) STORED,
  violacao_fec  BOOLEAN GENERATED ALWAYS AS (fec_apurado > fec_limite) STORED
);

-- -------------------------------------------------------------
-- mapa_risco: Aggregated risk score per municipality
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mapa_risco (
  id               SERIAL PRIMARY KEY,
  municipio        VARCHAR(100),
  distribuidora    VARCHAR(100),
  uf               CHAR(2),
  score_risco      FLOAT,
  dec_medio_12m    FLOAT,
  ratio_dec        FLOAT,
  meses_violacao   INT,
  idade_media_anos FLOAT,
  atualizado_em    TIMESTAMP DEFAULT NOW()
);

-- -------------------------------------------------------------
-- Spatial indexes (GIST) for geometry columns
-- -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_rede_mt_geom ON rede_mt      USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_rede_bt_geom ON rede_bt      USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_transf_geom  ON transformadores USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_relg_geom    ON religadores  USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_subs_geom    ON subestacoes  USING GIST(geom);

-- Composite index for continuity indicator lookups
CREATE INDEX IF NOT EXISTS idx_ic_municipio ON indicadores_continuidade(municipio, ano, mes);

-- -------------------------------------------------------------
-- ibge_municipios: Municipality boundaries from IBGE
-- Source: https://servicodados.ibge.gov.br/api/v3/malhas/municipios
-- CRS: SIRGAS 2000 (EPSG:4674)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ibge_municipios (
  id           SERIAL PRIMARY KEY,
  codigo_ibge  VARCHAR(7) UNIQUE NOT NULL,
  nome         VARCHAR(120)      NOT NULL,
  nome_norm    VARCHAR(120)      NOT NULL,  -- lower + unaccented, for JOIN
  uf           CHAR(2)           NOT NULL,
  geom         GEOMETRY(MultiPolygon, 4674)
);

CREATE INDEX IF NOT EXISTS idx_ibge_municipios_geom
  ON ibge_municipios USING GIST(geom);

CREATE INDEX IF NOT EXISTS idx_ibge_municipios_nome
  ON ibge_municipios(nome_norm, uf);

-- -------------------------------------------------------------
-- alimentadores: MT feeders/circuits (CTMT layer from BDGD)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alimentadores (
  id              SERIAL PRIMARY KEY,
  cod_id          VARCHAR(50) UNIQUE,
  distribuidora   VARCHAR(100),
  municipio       VARCHAR(100),
  uf              CHAR(2),
  subestacao_id   VARCHAR(50),
  n_consumidores  INT,
  comprimento_km  FLOAT,
  tensao_nom      FLOAT,
  data_implant    DATE,
  geom            GEOMETRY(MultiLineString, 4674)
);

-- -------------------------------------------------------------
-- chaves: Switches and sectionalizers (EQCHAVE layer from BDGD)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chaves (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  tipo_chave    VARCHAR(50),
  operacao      VARCHAR(20),
  data_implant  DATE,
  geom          GEOMETRY(Point, 4674)
);

-- -------------------------------------------------------------
-- gaps_protecao: MT segments without recloser coverage
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gaps_protecao (
  id              SERIAL PRIMARY KEY,
  distribuidora   VARCHAR(100),
  municipio       VARCHAR(100),
  uf              CHAR(2),
  comprimento_km  FLOAT,
  score_vulnerabilidade FLOAT,
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  geom            GEOMETRY(MultiLineString, 4674)
);

ALTER TABLE IF EXISTS gaps_protecao
  ALTER COLUMN geom TYPE GEOMETRY(MultiLineString, 4674)
  USING CASE
    WHEN geom IS NULL THEN NULL
    ELSE ST_Multi(ST_CollectionExtract(geom, 2))
  END;

-- -------------------------------------------------------------
-- historico_score: Monthly score snapshots for trend analysis
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historico_score (
  id            SERIAL PRIMARY KEY,
  municipio     VARCHAR(100),
  distribuidora VARCHAR(100),
  uf            CHAR(2),
  ano           INT,
  mes           INT,
  score_risco   FLOAT,
  dec_medio     FLOAT,
  calculado_em  TIMESTAMP DEFAULT NOW(),
  UNIQUE(municipio, distribuidora, ano, mes)
);

-- -------------------------------------------------------------
-- ibge_populacao: Population data from IBGE census
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ibge_populacao (
  id            SERIAL PRIMARY KEY,
  codigo_ibge   VARCHAR(7) UNIQUE,
  municipio     VARCHAR(120),
  uf            CHAR(2),
  populacao     INT,
  domicilios    INT,
  pib_per_capita FLOAT,
  area_km2      FLOAT,
  atualizado_em TIMESTAMP DEFAULT NOW()
);

-- Spatial and lookup indexes
CREATE INDEX IF NOT EXISTS idx_alimentadores_geom ON alimentadores USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_chaves_geom        ON chaves        USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_gaps_geom          ON gaps_protecao USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_historico_municipio ON historico_score(municipio, distribuidora, ano, mes);
CREATE INDEX IF NOT EXISTS idx_ibge_pop_codigo    ON ibge_populacao(codigo_ibge);
