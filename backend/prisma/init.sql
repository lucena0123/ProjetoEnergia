-- =============================================================
-- GridRisk - Database Initialization Script
-- Requires PostgreSQL with PostGIS extension
-- =============================================================

-- Enable PostGIS extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- -------------------------------------------------------------
-- rede_mt: Medium-voltage grid segments (MultiLineString geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rede_mt (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  alimentador_id VARCHAR(50),
  tensao_nom    FLOAT,
  condutor      VARCHAR(50),
  comprimento   FLOAT,
  data_implant  DATE,
  geom          GEOMETRY(MultiLineString, 4674)
);

-- -------------------------------------------------------------
-- rede_bt: Low-voltage grid segments (MultiLineString geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rede_bt (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  alimentador_id VARCHAR(50),
  condutor      VARCHAR(50),
  comprimento   FLOAT,
  data_implant  DATE,
  geom          GEOMETRY(MultiLineString, 4674)
);

-- -------------------------------------------------------------
-- transformadores: Distribution transformers (Point geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transformadores (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  alimentador_id VARCHAR(50),
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
  uf            CHAR(2),
  alimentador_id VARCHAR(50),
  data_implant  DATE,
  geom          GEOMETRY(Point, 4674)
);

-- -------------------------------------------------------------
-- subestacoes: Substations (Point geometry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subestacoes (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50),
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  tensao_nom    FLOAT,
  data_implant  DATE,
  geom          GEOMETRY(Point, 4674)
);

-- -------------------------------------------------------------
-- alimentadores_at: AT circuits/feeders derived from CTAT + SSDAT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alimentadores_at (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50),
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  subestacao_id VARCHAR(50),
  nome          VARCHAR(150),
  descricao     TEXT,
  pac_ini       VARCHAR(80),
  tensao_nom    FLOAT,
  comprimento_km FLOAT,
  geom          GEOMETRY(MultiLineString, 4674),
  UNIQUE (cod_id, distribuidora, uf)
);

-- -------------------------------------------------------------
-- rede_at: AT line segments from SSDAT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rede_at (
  id              SERIAL PRIMARY KEY,
  cod_id          VARCHAR(50),
  distribuidora   VARCHAR(100),
  municipio       VARCHAR(100),
  uf              CHAR(2),
  subestacao_id   VARCHAR(50),
  alimentador_at_id VARCHAR(50),
  condutor        VARCHAR(50),
  comprimento     FLOAT,
  descricao       TEXT,
  tip_inst        VARCHAR(50),
  geom            GEOMETRY(MultiLineString, 4674),
  UNIQUE (cod_id, distribuidora, uf)
);

-- -------------------------------------------------------------
-- transformadores_at: AT transformers from UNTRAT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transformadores_at (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50),
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  subestacao_id VARCHAR(50),
  potencia_nom  FLOAT,
  tipo_trafo    VARCHAR(50),
  data_implant  DATE,
  descricao     TEXT,
  geom          GEOMETRY(Point, 4674),
  UNIQUE (cod_id, distribuidora, uf)
);

-- -------------------------------------------------------------
-- religadores_at: AT reclosers from UNREAT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS religadores_at (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50),
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  subestacao_id VARCHAR(50),
  tipo_regu     VARCHAR(50),
  data_implant  DATE,
  descricao     TEXT,
  geom          GEOMETRY(Point, 4674),
  UNIQUE (cod_id, distribuidora, uf)
);

-- -------------------------------------------------------------
-- chaves_at: AT switches from UNSEAT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chaves_at (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(80),
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  subestacao_id VARCHAR(50),
  tipo_chave    TEXT,
  operacao      VARCHAR(20),
  data_implant  DATE,
  descricao     TEXT,
  geom          GEOMETRY(Point, 4674),
  UNIQUE (cod_id, distribuidora, uf)
);

-- -------------------------------------------------------------
-- subestacao_componentes: BAR / BASE / BAY / BE
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subestacao_componentes (
  id             SERIAL PRIMARY KEY,
  cod_id         VARCHAR(100),
  distribuidora  VARCHAR(100),
  municipio      VARCHAR(100),
  uf             CHAR(2),
  subestacao_id  VARCHAR(50),
  component_type VARCHAR(10) NOT NULL,
  sub_grupo      VARCHAR(50),
  descricao      TEXT,
  tensao_nom     FLOAT,
  data_inicio    DATE,
  data_fim       DATE,
  attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom           GEOMETRY(Point, 4674)
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
CREATE INDEX IF NOT EXISTS idx_alimentadores_at_geom ON alimentadores_at USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_rede_at_geom ON rede_at USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_transformadores_at_geom ON transformadores_at USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_religadores_at_geom ON religadores_at USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_chaves_at_geom ON chaves_at USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_subestacao_componentes_geom ON subestacao_componentes USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_alimentadores_at_scope ON alimentadores_at(uf, distribuidora, subestacao_id);
CREATE INDEX IF NOT EXISTS idx_rede_at_scope ON rede_at(uf, distribuidora, subestacao_id, alimentador_at_id);
CREATE INDEX IF NOT EXISTS idx_transformadores_at_scope ON transformadores_at(uf, distribuidora, subestacao_id);
CREATE INDEX IF NOT EXISTS idx_religadores_at_scope ON religadores_at(uf, distribuidora, subestacao_id);
CREATE INDEX IF NOT EXISTS idx_chaves_at_scope ON chaves_at(uf, distribuidora, subestacao_id);
CREATE INDEX IF NOT EXISTS idx_subestacao_componentes_scope ON subestacao_componentes(uf, distribuidora, component_type, subestacao_id);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subestacoes_cod_id_key'
  ) THEN
    ALTER TABLE subestacoes DROP CONSTRAINT subestacoes_cod_id_key;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subestacoes_cod_id_dist_uf_key'
  ) THEN
    ALTER TABLE subestacoes
      ADD CONSTRAINT subestacoes_cod_id_dist_uf_key UNIQUE (cod_id, distribuidora, uf);
  END IF;
END $$;

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
-- ucbt: Low-voltage consumer units linked to feeder / transformer
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ucbt (
  id               SERIAL PRIMARY KEY,
  cod_id           VARCHAR(128),
  distribuidora    VARCHAR(100),
  municipio        VARCHAR(100),
  uf               CHAR(2),
  alimentador_id   VARCHAR(50),
  transformador_id VARCHAR(50),
  classe_consumo   VARCHAR(50),
  data_ligacao     DATE,
  geom             GEOMETRY(Point, 4674)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ucbt_cod_id_dist_uf_key'
  ) THEN
    ALTER TABLE ucbt
      ADD CONSTRAINT ucbt_cod_id_dist_uf_key UNIQUE (cod_id, distribuidora, uf);
  END IF;
END $$;

-- -------------------------------------------------------------
-- ucmt: Medium-voltage consumer units linked to feeder
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ucmt (
  id                 SERIAL PRIMARY KEY,
  cod_id             VARCHAR(128),
  distribuidora      VARCHAR(100),
  municipio          VARCHAR(100),
  uf                 CHAR(2),
  alimentador_id     VARCHAR(50),
  classe_consumo     VARCHAR(50),
  demanda_contratada FLOAT,
  data_ligacao       DATE,
  geom               GEOMETRY(Point, 4674)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ucmt_cod_id_dist_uf_key'
  ) THEN
    ALTER TABLE ucmt
      ADD CONSTRAINT ucmt_cod_id_dist_uf_key UNIQUE (cod_id, distribuidora, uf);
  END IF;
END $$;

-- -------------------------------------------------------------
-- ucat: AT consumer units linked to substation / circuito AT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ucat (
  id                 SERIAL PRIMARY KEY,
  cod_id             VARCHAR(128),
  distribuidora      VARCHAR(100),
  municipio          VARCHAR(100),
  uf                 CHAR(2),
  subestacao_id      VARCHAR(50),
  circuito_at_id     VARCHAR(50),
  classe_consumo     VARCHAR(50),
  demanda_contratada FLOAT,
  descricao          TEXT,
  data_ligacao       DATE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ucat_cod_id_dist_uf_key'
  ) THEN
    ALTER TABLE ucat
      ADD CONSTRAINT ucat_cod_id_dist_uf_key UNIQUE (cod_id, distribuidora, uf);
  END IF;
END $$;

-- -------------------------------------------------------------
-- ug_*: Public generation units by voltage level
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ug_at (
  id                 SERIAL PRIMARY KEY,
  cod_id             VARCHAR(128),
  distribuidora      VARCHAR(100),
  municipio          VARCHAR(100),
  uf                 CHAR(2),
  subestacao_id      VARCHAR(50),
  circuito_at_id     VARCHAR(50),
  classe_consumo     VARCHAR(50),
  demanda_contratada FLOAT,
  descricao          TEXT,
  ceg_gd             VARCHAR(120),
  data_ligacao       DATE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ug_at_cod_id_dist_uf_key'
  ) THEN
    ALTER TABLE ug_at
      ADD CONSTRAINT ug_at_cod_id_dist_uf_key UNIQUE (cod_id, distribuidora, uf);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ug_mt (
  id                 SERIAL PRIMARY KEY,
  cod_id             VARCHAR(128),
  distribuidora      VARCHAR(100),
  municipio          VARCHAR(100),
  uf                 CHAR(2),
  subestacao_id      VARCHAR(50),
  alimentador_id     VARCHAR(50),
  classe_consumo     VARCHAR(50),
  demanda_contratada FLOAT,
  descricao          TEXT,
  ceg_gd             VARCHAR(120),
  data_ligacao       DATE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ug_mt_cod_id_dist_uf_key'
  ) THEN
    ALTER TABLE ug_mt
      ADD CONSTRAINT ug_mt_cod_id_dist_uf_key UNIQUE (cod_id, distribuidora, uf);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ug_bt (
  id                 SERIAL PRIMARY KEY,
  cod_id             VARCHAR(128),
  distribuidora      VARCHAR(100),
  municipio          VARCHAR(100),
  uf                 CHAR(2),
  subestacao_id      VARCHAR(50),
  alimentador_id     VARCHAR(50),
  classe_consumo     VARCHAR(50),
  demanda_contratada FLOAT,
  descricao          TEXT,
  ceg_gd             VARCHAR(120),
  data_ligacao       DATE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ug_bt_cod_id_dist_uf_key'
  ) THEN
    ALTER TABLE ug_bt
      ADD CONSTRAINT ug_bt_cod_id_dist_uf_key UNIQUE (cod_id, distribuidora, uf);
  END IF;
END $$;

-- -------------------------------------------------------------
-- chaves: Switches and sectionalizers (EQCHAVE layer from BDGD)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chaves (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  alimentador_id VARCHAR(50),
  tipo_chave    TEXT,
  operacao      VARCHAR(20),
  data_implant  DATE,
  geom          GEOMETRY(Point, 4674)
);

-- -------------------------------------------------------------
-- chaves_bt: BT switches / devices from UNSEBT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chaves_bt (
  id             SERIAL PRIMARY KEY,
  cod_id         VARCHAR(80),
  distribuidora  VARCHAR(100),
  municipio      VARCHAR(100),
  uf             CHAR(2),
  alimentador_id VARCHAR(50),
  tipo_chave     TEXT,
  operacao       VARCHAR(20),
  data_implant   DATE,
  descricao      TEXT,
  geom           GEOMETRY(Point, 4674),
  UNIQUE (cod_id, distribuidora, uf)
);

-- -------------------------------------------------------------
-- regulacao_reativos: UNCRAT / UNCRBT / UNCRMT unified
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regulacao_reativos (
  id             SERIAL PRIMARY KEY,
  cod_id         VARCHAR(100),
  distribuidora  VARCHAR(100),
  municipio      VARCHAR(100),
  uf             CHAR(2),
  nivel_tensao   VARCHAR(2) NOT NULL,
  subestacao_id  VARCHAR(50),
  alimentador_id VARCHAR(50),
  tipo_unidade   VARCHAR(50),
  banco          INT,
  posicao        VARCHAR(20),
  potencia_nom   FLOAT,
  descricao      TEXT,
  data_implant   DATE,
  attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom           GEOMETRY(Point, 4674),
  UNIQUE (cod_id, distribuidora, uf, nivel_tensao)
);

-- -------------------------------------------------------------
-- equipamentos_tecnicos: EQ* technical dictionaries
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS equipamentos_tecnicos (
  id               SERIAL PRIMARY KEY,
  family           VARCHAR(20) NOT NULL,
  cod_id           VARCHAR(100),
  distribuidora    VARCHAR(100),
  uf               CHAR(2),
  related_asset_id VARCHAR(100),
  subestacao_id    VARCHAR(50),
  alimentador_id   VARCHAR(50),
  nivel_tensao     VARCHAR(10),
  descricao        TEXT,
  tipo_inst        VARCHAR(50),
  data_imobilizado DATE,
  attributes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (family, cod_id, distribuidora, uf)
);

-- -------------------------------------------------------------
-- gaps_protecao: MT segments without recloser coverage
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gaps_protecao (
  id              SERIAL PRIMARY KEY,
  distribuidora   VARCHAR(100),
  municipio       VARCHAR(100),
  uf              CHAR(2),
  alimentador_id  VARCHAR(50),
  comprimento_km  FLOAT,
  score_vulnerabilidade FLOAT,
  dist_religador_km FLOAT,
  dist_chave_km FLOAT,
  dist_equipamento_auto_km FLOAT,
  dist_manobra_km FLOAT,
  dist_transferencia_km FLOAT,
  score_recomposicao FLOAT,
  gap_religamento_auto BOOLEAN,
  gap_recomposicao BOOLEAN,
  gap_transferencia BOOLEAN,
  equipamentos_auto_considerados TEXT[],
  equipamentos_manobra_considerados TEXT[],
  equipamentos_transferencia_considerados TEXT[],
  clientes_bt_total INT,
  clientes_mt_total INT,
  clientes_total INT,
  demanda_mt_total FLOAT,
  metodologia    VARCHAR(50),
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  geom            GEOMETRY(MultiLineString, 4674)
);

-- -------------------------------------------------------------
-- segmentos_mt_topologicos: Public topological MT segments
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS segmentos_mt_topologicos (
  id                   SERIAL PRIMARY KEY,
  distribuidora        VARCHAR(100),
  municipio            VARCHAR(100),
  uf                   CHAR(2),
  alimentador_id       VARCHAR(50),
  subestacao_id        VARCHAR(50),
  rede_mt_cod_id       VARCHAR(50),
  source_segment_key   VARCHAR(150),
  node_start_id        VARCHAR(150),
  node_end_id          VARCHAR(150),
  comprimento_km       FLOAT,
  dist_religador_km    FLOAT,
  dist_chave_km        FLOAT,
  dist_equipamento_auto_km FLOAT,
  dist_manobra_km      FLOAT,
  dist_transferencia_km FLOAT,
  score_vulnerabilidade FLOAT,
  score_recomposicao   FLOAT,
  gap_religamento_auto BOOLEAN,
  gap_recomposicao     BOOLEAN,
  gap_transferencia    BOOLEAN,
  equipamentos_auto_considerados TEXT[],
  equipamentos_manobra_considerados TEXT[],
  equipamentos_transferencia_considerados TEXT[],
  clientes_bt_total    INT,
  clientes_mt_total    INT,
  clientes_total       INT,
  demanda_mt_total     FLOAT,
  metodologia          VARCHAR(50),
  lacunas              TEXT[],
  atualizado_em        TIMESTAMP DEFAULT NOW(),
  geom                 GEOMETRY(MultiLineString, 4674)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'segmentos_mt_topologicos_source_scope_key'
  ) THEN
    ALTER TABLE segmentos_mt_topologicos
      ADD CONSTRAINT segmentos_mt_topologicos_source_scope_key
      UNIQUE (source_segment_key, distribuidora, uf);
  END IF;
END $$;

-- -------------------------------------------------------------
-- alimentador_metricas: feeder-first operational metrics
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alimentador_metricas (
  id                           SERIAL PRIMARY KEY,
  cod_id                       VARCHAR(50),
  distribuidora                VARCHAR(100),
  uf                           CHAR(2),
  subestacao_id                VARCHAR(50),
  tensao_nom                   FLOAT,
  municipios_atendidos         TEXT[],
  km_mt                        FLOAT,
  km_bt                        FLOAT,
  n_transformadores            INT,
  n_religadores                INT,
  n_chaves                     INT,
  km_gap_severo                FLOAT,
  n_gaps_severos               INT,
  densidade_religadores_km     FLOAT,
  densidade_chaves_km          FLOAT,
  n_ucbt                       INT,
  n_ucmt                       INT,
  clientes_bt_total            INT,
  clientes_mt_total            INT,
  clientes_total               INT,
  demanda_mt_total             FLOAT,
  clientes_expostos_gap_severo INT,
  km_gap_religamento_auto    FLOAT,
  n_segmentos_gap_religamento_auto INT,
  km_gap_recomposicao        FLOAT,
  n_segmentos_gap_recomposicao INT,
  km_gap_transferencia       FLOAT,
  n_segmentos_gap_transferencia INT,
  km_gap_severo_topologico     FLOAT,
  n_segmentos_gap_severo       INT,
  clientes_gap_severo_bt       INT,
  clientes_gap_severo_mt       INT,
  clientes_gap_severo_total    INT,
  demanda_gap_severo_total     FLOAT,
  max_dist_religador_km        FLOAT,
  max_dist_equipamento_auto_km FLOAT,
  max_dist_manobra_km          FLOAT,
  max_dist_transferencia_km    FLOAT,
  metodologia_gap              VARCHAR(50),
  lacunas                      TEXT[],
  atualizado_em                TIMESTAMP DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'alimentador_metricas_cod_id_dist_uf_key'
  ) THEN
    ALTER TABLE alimentador_metricas
      ADD CONSTRAINT alimentador_metricas_cod_id_dist_uf_key UNIQUE (cod_id, distribuidora, uf);
  END IF;
END $$;

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

ALTER TABLE IF EXISTS rede_mt
  ADD COLUMN IF NOT EXISTS alimentador_id VARCHAR(50);

ALTER TABLE IF EXISTS rede_bt
  ADD COLUMN IF NOT EXISTS alimentador_id VARCHAR(50);

ALTER TABLE IF EXISTS transformadores
  ADD COLUMN IF NOT EXISTS alimentador_id VARCHAR(50);

ALTER TABLE IF EXISTS religadores
  ADD COLUMN IF NOT EXISTS alimentador_id VARCHAR(50);

ALTER TABLE IF EXISTS chaves
  ADD COLUMN IF NOT EXISTS alimentador_id VARCHAR(50);

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS alimentador_id VARCHAR(50);

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS dist_religador_km FLOAT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS dist_chave_km FLOAT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS dist_equipamento_auto_km FLOAT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS dist_manobra_km FLOAT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS dist_transferencia_km FLOAT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS score_recomposicao FLOAT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS gap_religamento_auto BOOLEAN;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS gap_recomposicao BOOLEAN;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS gap_transferencia BOOLEAN;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS equipamentos_auto_considerados TEXT[];

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS equipamentos_manobra_considerados TEXT[];

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS equipamentos_transferencia_considerados TEXT[];

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS dist_equipamento_auto_km FLOAT;

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS dist_manobra_km FLOAT;

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS dist_transferencia_km FLOAT;

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS score_recomposicao FLOAT;

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS gap_religamento_auto BOOLEAN;

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS gap_recomposicao BOOLEAN;

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS gap_transferencia BOOLEAN;

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS equipamentos_auto_considerados TEXT[];

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS equipamentos_manobra_considerados TEXT[];

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS equipamentos_transferencia_considerados TEXT[];

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS clientes_bt_total INT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS clientes_mt_total INT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS clientes_total INT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS demanda_mt_total FLOAT;

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS metodologia VARCHAR(50);

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS km_gap_severo_topologico FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS km_gap_religamento_auto FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS n_segmentos_gap_religamento_auto INT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS km_gap_recomposicao FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS n_segmentos_gap_recomposicao INT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS km_gap_transferencia FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS n_segmentos_gap_transferencia INT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS n_segmentos_gap_severo INT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS clientes_gap_severo_bt INT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS clientes_gap_severo_mt INT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS clientes_gap_severo_total INT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS demanda_gap_severo_total FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS max_dist_religador_km FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS max_dist_equipamento_auto_km FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS max_dist_manobra_km FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS max_dist_transferencia_km FLOAT;

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS metodologia_gap VARCHAR(50);

-- Spatial and lookup indexes
CREATE INDEX IF NOT EXISTS idx_alimentadores_geom ON alimentadores USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_chaves_geom        ON chaves        USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_gaps_geom          ON gaps_protecao USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_segmentos_mt_topologicos_geom
  ON segmentos_mt_topologicos USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_historico_municipio ON historico_score(municipio, distribuidora, ano, mes);
CREATE INDEX IF NOT EXISTS idx_historico_scope_municipio ON historico_score(uf, distribuidora, municipio, ano DESC, mes DESC);
CREATE INDEX IF NOT EXISTS idx_mapa_risco_scope_score ON mapa_risco(uf, distribuidora, score_risco DESC);
CREATE INDEX IF NOT EXISTS idx_ibge_pop_codigo    ON ibge_populacao(codigo_ibge);
CREATE INDEX IF NOT EXISTS idx_rede_mt_alimentador ON rede_mt(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_rede_bt_alimentador ON rede_bt(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_transf_alimentador ON transformadores(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_relg_alimentador ON religadores(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_chaves_alimentador ON chaves(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_gaps_alimentador ON gaps_protecao(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_segmentos_mt_topologicos_scope
  ON segmentos_mt_topologicos(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_ucbt_alimentador ON ucbt(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_ucmt_alimentador ON ucmt(alimentador_id, distribuidora, uf);
CREATE INDEX IF NOT EXISTS idx_ucbt_geom ON ucbt USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_ucmt_geom ON ucmt USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_rede_mt_scope_geom ON rede_mt(uf, distribuidora) WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rede_bt_scope_geom ON rede_bt(uf, distribuidora) WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transformadores_scope_geom ON transformadores(uf, distribuidora) WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_religadores_scope_geom ON religadores(uf, distribuidora) WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chaves_scope_geom ON chaves(uf, distribuidora) WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gaps_scope_severo ON gaps_protecao(uf, distribuidora) WHERE score_vulnerabilidade >= 20;
CREATE INDEX IF NOT EXISTS idx_gaps_municipio_scope ON gaps_protecao(uf, distribuidora, municipio);
CREATE INDEX IF NOT EXISTS idx_transformadores_municipio_scope ON transformadores(uf, distribuidora, municipio, data_implant);
CREATE INDEX IF NOT EXISTS idx_ucbt_scope ON ucbt(uf, distribuidora);
CREATE INDEX IF NOT EXISTS idx_ucmt_scope ON ucmt(uf, distribuidora);
CREATE INDEX IF NOT EXISTS idx_alimentador_metricas_scope ON alimentador_metricas(uf, distribuidora);
CREATE INDEX IF NOT EXISTS idx_ucat_scope ON ucat(uf, distribuidora, subestacao_id, circuito_at_id);
CREATE INDEX IF NOT EXISTS idx_ug_at_scope ON ug_at(uf, distribuidora, subestacao_id, circuito_at_id);
CREATE INDEX IF NOT EXISTS idx_ug_mt_scope ON ug_mt(uf, distribuidora, alimentador_id, subestacao_id);
CREATE INDEX IF NOT EXISTS idx_ug_bt_scope ON ug_bt(uf, distribuidora, alimentador_id, subestacao_id);
CREATE INDEX IF NOT EXISTS idx_chaves_bt_geom ON chaves_bt USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_chaves_bt_scope ON chaves_bt(uf, distribuidora, alimentador_id);
CREATE INDEX IF NOT EXISTS idx_regulacao_reativos_geom ON regulacao_reativos USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_regulacao_reativos_scope ON regulacao_reativos(uf, distribuidora, nivel_tensao, subestacao_id, alimentador_id);
CREATE INDEX IF NOT EXISTS idx_equipamentos_tecnicos_scope ON equipamentos_tecnicos(family, uf, distribuidora, related_asset_id, subestacao_id, alimentador_id);

ALTER TABLE IF EXISTS rede_mt
  ALTER COLUMN geom TYPE GEOMETRY(MultiLineString, 4674)
  USING CASE
    WHEN geom IS NULL THEN NULL
    ELSE ST_Multi(ST_CollectionExtract(geom, 2))
  END;

ALTER TABLE IF EXISTS rede_bt
  ALTER COLUMN geom TYPE GEOMETRY(MultiLineString, 4674)
  USING CASE
    WHEN geom IS NULL THEN NULL
    ELSE ST_Multi(ST_CollectionExtract(geom, 2))
  END;

ALTER TABLE IF EXISTS transformadores
  ADD COLUMN IF NOT EXISTS uf CHAR(2);

ALTER TABLE IF EXISTS religadores
  ADD COLUMN IF NOT EXISTS uf CHAR(2);

ALTER TABLE IF EXISTS subestacoes
  ADD COLUMN IF NOT EXISTS uf CHAR(2);

-- -------------------------------------------------------------
-- Partner-ready governance
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_config (
  id                SERIAL PRIMARY KEY,
  tenant_id         VARCHAR(100) UNIQUE NOT NULL,
  mode              VARCHAR(20) NOT NULL DEFAULT 'public',
  enabled           BOOLEAN NOT NULL DEFAULT false,
  supported_sources TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS data_batches (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         VARCHAR(100) NOT NULL DEFAULT 'public',
  source_system     VARCHAR(100) NOT NULL,
  batch_label       VARCHAR(150),
  status            VARCHAR(30) NOT NULL DEFAULT 'completed',
  started_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMP,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS source_files (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT REFERENCES data_batches(id) ON DELETE SET NULL,
  tenant_id         VARCHAR(100) NOT NULL DEFAULT 'public',
  source_system     VARCHAR(100) NOT NULL,
  source_name       VARCHAR(150) NOT NULL,
  source_path       TEXT,
  source_timestamp  TIMESTAMP,
  checksum          VARCHAR(120),
  created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_coverage (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT REFERENCES data_batches(id) ON DELETE SET NULL,
  tenant_id         VARCHAR(100) NOT NULL DEFAULT 'public',
  source_system     VARCHAR(100) NOT NULL,
  scope_type        VARCHAR(50) NOT NULL,
  scope_id          VARCHAR(100) NOT NULL,
  coverage_status   VARCHAR(30) NOT NULL DEFAULT 'complete',
  details           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS mapa_risco
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(100) NOT NULL DEFAULT 'gridrisk_public',
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES data_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE IF EXISTS gaps_protecao
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(100) NOT NULL DEFAULT 'gridrisk_public',
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES data_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE IF EXISTS segmentos_mt_topologicos
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(100) NOT NULL DEFAULT 'gridrisk_public',
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES data_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE IF EXISTS alimentador_metricas
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(100) NOT NULL DEFAULT 'gridrisk_public',
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES data_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE IF EXISTS historico_score
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(100) NOT NULL DEFAULT 'gridrisk_public',
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES data_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS idx_data_batches_tenant_source
  ON data_batches(tenant_id, source_system, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_coverage_scope
  ON source_coverage(tenant_id, source_system, scope_type, scope_id);

-- -------------------------------------------------------------
-- BDGD complete coverage catalog
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bdgd_layer_catalog (
  id                BIGSERIAL PRIMARY KEY,
  distribuidora     VARCHAR(100) NOT NULL,
  uf                CHAR(2) NOT NULL,
  layer_name        VARCHAR(80) NOT NULL,
  surfaced_mode     VARCHAR(20) NOT NULL DEFAULT 'raw',
  target_table      VARCHAR(80),
  has_geometry      BOOLEAN NOT NULL DEFAULT false,
  geometry_type     VARCHAR(40),
  feature_count     BIGINT NOT NULL DEFAULT 0,
  column_names      TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  imported_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  source_system     VARCHAR(100) NOT NULL DEFAULT 'bdgd',
  source_timestamp  TIMESTAMP,
  UNIQUE (distribuidora, uf, layer_name)
);

CREATE TABLE IF NOT EXISTS bdgd_raw_features (
  id                BIGSERIAL PRIMARY KEY,
  distribuidora     VARCHAR(100) NOT NULL,
  uf                CHAR(2) NOT NULL,
  layer_name        VARCHAR(80) NOT NULL,
  source_row_id     BIGINT NOT NULL,
  feature_key       VARCHAR(160),
  geometry_type     VARCHAR(40),
  properties        JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom              GEOMETRY(Geometry, 4674),
  imported_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (distribuidora, uf, layer_name, source_row_id)
);

CREATE INDEX IF NOT EXISTS idx_bdgd_layer_catalog_scope
  ON bdgd_layer_catalog(uf, distribuidora, layer_name);
CREATE INDEX IF NOT EXISTS idx_bdgd_raw_features_scope
  ON bdgd_raw_features(uf, distribuidora, layer_name, source_row_id);
CREATE INDEX IF NOT EXISTS idx_bdgd_raw_features_geom
  ON bdgd_raw_features USING GIST(geom);
