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
