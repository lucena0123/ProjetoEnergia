# GridRisk — Prompt de Implementação para Agente de Código

## CONTEXTO DO PROJETO

Você está trabalhando no repositório **GridRisk** — uma plataforma de mapeamento de risco
da infraestrutura elétrica de distribuidoras brasileiras, usando dados públicos da ANEEL
cruzados com análise geoespacial.

Repositório: `lucena0123/ProjetoEnergia`
Branch de trabalho: `claude/gridrisk-platform-SEgmU`

---

## STACK TÉCNICA (não altere)

- **Backend:** Node.js 20 + Fastify 4 + TypeScript + Prisma 5 + pg (PostGIS direto)
- **Banco:** PostgreSQL 15 + PostGIS 3.4 + extensão `unaccent`
- **Pipeline:** Python 3.11 + GeoPandas + SQLAlchemy + requests + click
- **Frontend:** Next.js 14 App Router + TypeScript + Tailwind CSS + MapboxGL JS v3
- **Filas:** BullMQ + Redis
- **Infra:** Docker Compose

---

## ESTRUTURA ATUAL DO REPOSITÓRIO

```
gridrisk/
├── pipeline/
│   ├── ingest_bdgd.py           # Ingere SSDMT, SSDBT, UNSDAT, EQRE, EQSE do .gpkg
│   ├── ingest_dec_fec.py        # Ingere CSV DEC/FEC da ANEEL
│   ├── ingest_ibge_municipios.py# Baixa polígonos municipais da API IBGE
│   ├── calculate_risk.py        # Calcula score de risco por município
│   ├── seed_demo.py             # Dados sintéticos para demo
│   └── requirements.txt
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── risco.ts         # GET /api/mapa-risco, /ranking-municipios, /kpis
│   │   │   ├── rede.ts          # GET /api/trechos-criticos, /transformadores-criticos
│   │   │   └── jobs.ts          # POST /api/jobs/importar-bdgd, GET /api/jobs/:id/status
│   │   ├── workers/
│   │   │   └── importacao.worker.ts
│   │   ├── db.ts
│   │   ├── server.ts
│   │   └── worker.ts
│   └── prisma/
│       ├── schema.prisma
│       └── init.sql
└── frontend/
    ├── app/
    │   ├── page.tsx             # Dashboard com KPIs e ranking
    │   └── mapa/page.tsx        # Mapa interativo
    └── components/
        ├── MapaRisco.tsx        # MapboxGL choropleth
        ├── PainelRisco.tsx      # Tabela paginada
        └── KpiCard.tsx
```

---

## TABELAS EXISTENTES NO BANCO

```sql
rede_mt          (id, cod_id, distribuidora, municipio, uf, tensao_nom, condutor, comprimento, data_implant, geom LineString 4674)
rede_bt          (id, cod_id, distribuidora, municipio, uf, condutor, comprimento, data_implant, geom LineString 4674)
transformadores  (id, cod_id, distribuidora, municipio, potencia_nom, fabricante, data_implant, geom Point 4674)
religadores      (id, cod_id, distribuidora, municipio, data_implant, geom Point 4674)
subestacoes      (id, cod_id, distribuidora, municipio, tensao_nom, data_implant, geom Point 4674)
indicadores_continuidade (id, distribuidora, municipio, uf, ano, mes, dec_apurado, dec_limite, fec_apurado, fec_limite, violacao_dec GENERATED, violacao_fec GENERATED)
mapa_risco       (id, municipio, distribuidora, uf, score_risco, dec_medio_12m, ratio_dec, meses_violacao, idade_media_anos, atualizado_em)
ibge_municipios  (id, codigo_ibge, nome, nome_norm, uf, geom MultiPolygon 4674)
```

---

## ROTAS EXISTENTES NA API

```
GET  /api/mapa-risco                   GeoJSON com score + polígono por município
GET  /api/ranking-municipios           Ranking paginado por score
GET  /api/kpis                         score_medio, municipios_criticos, dec_medio_geral, total_meses_violacao
GET  /api/trechos-criticos             GeoJSON segmentos rede_mt em municípios críticos
GET  /api/transformadores-criticos     GeoJSON transformadores de um município
POST /api/jobs/importar-bdgd           Dispara job BullMQ
GET  /api/jobs/:jobId/status           Status do job
GET  /health                           Health check
```

---

## O QUE IMPLEMENTAR — PRIORIDADE E ORDEM OBRIGATÓRIA

---

### BLOCO 1 — CORRIGIR SEED DEMO (URGENTE)

**Arquivo:** `pipeline/seed_demo.py`

**Problema:** os scores gerados ficam todos abaixo de 70. O mapa não fica vermelho.
O campo "Municípios Críticos" mostra 0, o que torna o demo sem impacto visual.

**Solução:** ajustar os parâmetros de geração de DEC/FEC para criar 3 perfis claros:

```python
# Perfil CRÍTICO (30% dos municípios) — score esperado: 75–95
dec_base = 28.0, dec_lim = 12.0, fec_base = 18.0, fec_lim = 8.0
jitter_d = 4.0, jitter_f = 3.0

# Perfil ALTO (25% dos municípios) — score esperado: 55–74
dec_base = 18.0, dec_lim = 12.0, fec_base = 11.0, fec_lim = 8.0
jitter_d = 3.0, jitter_f = 2.5

# Perfil MÉDIO (25% dos municípios) — score esperado: 35–54
dec_base = 13.0, dec_lim = 12.0, fec_base = 8.0, fec_lim = 8.0
jitter_d = 2.5, jitter_f = 2.0

# Perfil BOM (20% dos municípios) — score esperado: 10–34
dec_base = 6.0, dec_lim = 12.0, fec_base = 4.0, fec_lim = 8.0
jitter_d = 2.0, jitter_f = 1.5
```

Também ajustar a geração de rede MT para variar mais a idade:
- Perfil crítico: `data_implant` entre 25 e 40 anos atrás
- Perfil bom: `data_implant` entre 2 e 15 anos atrás

Manter `random.seed(42)` para reprodutibilidade.

---

### BLOCO 2 — NOVAS TABELAS NO BANCO

**Arquivo:** `backend/prisma/init.sql`

Adicionar ao final do arquivo (usar `CREATE TABLE IF NOT EXISTS`):

```sql
-- Conjuntos de MT (alimentadores/circuitos) — camada CTMT do BDGD
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

-- Chaves e seccionadoras — camada EQCHAVE do BDGD
CREATE TABLE IF NOT EXISTS chaves (
  id            SERIAL PRIMARY KEY,
  cod_id        VARCHAR(50) UNIQUE,
  distribuidora VARCHAR(100),
  municipio     VARCHAR(100),
  uf            CHAR(2),
  tipo_chave    VARCHAR(50),   -- FUSIVEL, SECCIONADORA, RELIGADOR, DISJUNTOR
  operacao      VARCHAR(20),   -- MANUAL, AUTOMATICA, TELECOMANDADA
  data_implant  DATE,
  geom          GEOMETRY(Point, 4674)
);

-- Gaps de proteção — trechos de rede MT sem cobertura de religador
CREATE TABLE IF NOT EXISTS gaps_protecao (
  id              SERIAL PRIMARY KEY,
  distribuidora   VARCHAR(100),
  municipio       VARCHAR(100),
  uf              CHAR(2),
  comprimento_km  FLOAT,
  score_vulnerabilidade FLOAT,  -- 0 a 100
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  geom            GEOMETRY(LineString, 4674)
);

-- Histórico mensal de score — para tendência e série temporal
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

-- Dados populacionais do IBGE por município
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

-- Índices espaciais e de lookup
CREATE INDEX IF NOT EXISTS idx_alimentadores_geom ON alimentadores USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_chaves_geom        ON chaves        USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_gaps_geom          ON gaps_protecao USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_historico_municipio ON historico_score(municipio, distribuidora, ano, mes);
CREATE INDEX IF NOT EXISTS idx_ibge_pop_codigo    ON ibge_populacao(codigo_ibge);
```

---

### BLOCO 3 — NOVOS SCRIPTS PYTHON

#### 3.1 `pipeline/ingest_ibge_populacao.py`

Script que:
- Busca dados populacionais via API IBGE:
  - URL nomes/população: `https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios`
  - URL estimativas populacionais: `https://servicodados.ibge.gov.br/api/v3/agregados/6579/periodos/2022/variaveis/9324?localidades=N6[all]`
- CLI: `--uf AL` ou `--uf ALL`, `--db-url`
- Insere em `ibge_populacao` (idempotente por `codigo_ibge`)
- Faz JOIN com `ibge_municipios` para pegar área em km² via `ST_Area(ST_Transform(geom, 31983))/1e6`
- Loga: total de municípios inseridos por UF

#### 3.2 `pipeline/calculate_gaps.py`

Script que calcula gaps de proteção usando PostGIS:
- CLI: `--distribuidora`, `--uf`, `--raio_m` (default: 500), `--db-url`
- Lógica SQL (executar via SQLAlchemy):

```sql
-- 1. Buffer ao redor de todos os religadores (raio configurável, default 500m)
-- 2. Subtrair o buffer da geometria de rede_mt
-- 3. Resultado = trechos de rede sem cobertura de religador
-- 4. Calcular comprimento em km de cada trecho exposto
-- 5. Calcular score_vulnerabilidade = LEAST(comprimento_km / 10.0, 1.0) * 100

DELETE FROM gaps_protecao WHERE distribuidora = :dist AND uf = :uf;

INSERT INTO gaps_protecao (distribuidora, municipio, uf, comprimento_km, score_vulnerabilidade, geom)
SELECT
  r.distribuidora,
  r.municipio,
  r.uf,
  ST_Length(ST_Transform(
    ST_Difference(r.geom, COALESCE(ST_Union(ST_Buffer(rel.geom::geography, :raio_m)::geometry), ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4674)))
  , 31983)) / 1000.0 AS comprimento_km,
  LEAST(
    ST_Length(ST_Transform(..., 31983)) / 1000.0 / 10.0,
    1.0
  ) * 100 AS score_vulnerabilidade,
  ST_Difference(r.geom, ...) AS geom
FROM rede_mt r
LEFT JOIN religadores rel
  ON r.distribuidora = rel.distribuidora
  AND ST_DWithin(r.geom::geography, rel.geom::geography, :raio_m)
WHERE r.distribuidora = :dist AND r.uf = :uf
GROUP BY r.id, r.distribuidora, r.municipio, r.uf, r.geom
HAVING ST_Length(ST_Difference(...), 31983) > 100  -- mínimo 100m
```

- Loga: total de gaps encontrados, km total exposto, pior município

#### 3.3 `pipeline/calculate_historico.py`

Script que snapshot o `mapa_risco` atual para `historico_score`:
- CLI: `--db-url`
- Insere o estado atual de `mapa_risco` em `historico_score` com `ano` e `mes` do mês corrente
- Usa `INSERT ... ON CONFLICT DO UPDATE` (upsert)
- Deve ser executado mensalmente (via cron ou BullMQ scheduled job)
- Loga: quantos municípios foram snapshotados

#### 3.4 Atualizar `pipeline/ingest_bdgd.py`

Adicionar suporte a 2 novas camadas do BDGD no `LAYER_MAP`:

```python
"CTMT": (
    "alimentadores",
    {
        "cod_id": "COD_ID",
        "subestacao_id": "COD_SSDMT",    # ou campo equivalente
        "n_consumidores": "QTD_UC",
        "comprimento_km": "COMP_TREC",
        "tensao_nom": "TEN_NOM",
        "data_implant": "DAT_INS",
        "geom": "geometry",
    },
),
"EQCHAVE": (
    "chaves",
    {
        "cod_id": "COD_ID",
        "tipo_chave": "TIP_EQMT",
        "operacao": "OPE_CHAVE",
        "data_implant": "DAT_INS",
        "geom": "geometry",
    },
),
```

#### 3.5 Atualizar `pipeline/seed_demo.py`

Adicionar geração de dados para as novas tabelas após as etapas existentes:

**Etapa 6 — Chaves sintéticas:**
- Para cada município, gerar `n_religadores / 2` chaves adicionais (tipo SECCIONADORA, operação MANUAL)
- Distribuir aleatoriamente dentro dos polígonos municipais
- Inserir em `chaves`

**Etapa 7 — Gaps de proteção:**
- Chamar `calculate_gaps.py` via subprocess OU executar o SQL de gaps diretamente
- Usar raio de 500m

**Etapa 8 — População IBGE:**
- Executar `ingest_ibge_populacao.py` para a UF do seed

**Etapa 9 — Histórico:**
- Executar `calculate_historico.py` para criar o primeiro snapshot

Atualizar log de conclusão para mostrar todas as 9 etapas.

---

### BLOCO 4 — NOVOS ENDPOINTS DA API

**Arquivo:** `backend/src/routes/municipio.ts` (novo arquivo)

Registrar em `server.ts` com prefix `/api`.

#### 4.1 `GET /api/municipio/:municipio/detalhe`

Retorna painel completo de um município para o popup do mapa:

```typescript
// Query params: distribuidora (opcional)
// Resposta:
{
  municipio: string,
  distribuidora: string,
  uf: string,

  // Score e DEC
  score_risco: number,
  dec_medio_12m: number,
  dec_limite: number,
  ratio_dec: number,
  meses_violacao: number,
  tendencia: 'piorando' | 'estavel' | 'melhorando',  // comparar últimos 3 meses vs anteriores 3

  // Infraestrutura (da BDGD)
  rede: {
    comprimento_mt_km: number,    // SUM(comprimento) FROM rede_mt WHERE municipio
    comprimento_bt_km: number,
    n_transformadores: number,
    potencia_total_kva: number,
    idade_media_anos: number,
    transformadores_criticos: number  // count WHERE EXTRACT(YEAR FROM AGE(NOW(), data_implant)) > 25
  },

  // Proteção
  protecao: {
    n_religadores: number,
    n_chaves: number,
    cobertura_pct: number,         // 100 - (km_sem_protecao / km_total * 100)
    km_sem_protecao: number        // FROM gaps_protecao WHERE municipio
  },

  // Contexto social (IBGE)
  social: {
    populacao: number,
    domicilios: number,
    densidade_hab_km2: number,
    pib_per_capita: number
  },

  // Série histórica (últimos 12 meses)
  historico: Array<{
    ano: number,
    mes: number,
    score_risco: number,
    dec_medio: number
  }>
}
```

SQL para tendência:
```sql
WITH ultimos_6 AS (
  SELECT score_risco, ano, mes,
    ROW_NUMBER() OVER (ORDER BY ano DESC, mes DESC) AS rn
  FROM historico_score
  WHERE municipio = $1 AND distribuidora = $2
)
SELECT
  AVG(score_risco) FILTER (WHERE rn <= 3) AS media_recente,
  AVG(score_risco) FILTER (WHERE rn BETWEEN 4 AND 6) AS media_anterior
FROM ultimos_6
-- tendencia: se media_recente > media_anterior + 2 → 'piorando'
--            se media_recente < media_anterior - 2 → 'melhorando'
--            else → 'estavel'
```

#### 4.2 `GET /api/municipio/:municipio/transformadores-aging`

Lista transformadores ordenados por criticidade para um município:

```typescript
// Resposta: GeoJSON FeatureCollection
// Properties por feature:
{
  cod_id: string,
  potencia_nom: number,
  fabricante: string,
  idade_anos: number,           // EXTRACT(YEAR FROM AGE(NOW(), data_implant))
  vida_util_restante_anos: number,  // MAX(0, 30 - idade_anos)
  status: 'critico' | 'atencao' | 'ok',  // critico: >25a, atencao: 20-25a, ok: <20a
  distancia_religador_m: number,  // ST_Distance(tr.geom, nearest religador)
  score_equipamento: number       // idade_pct*60 + (distancia>2000 ? 40 : distancia/2000*40)
}
// ORDER BY score_equipamento DESC
```

#### 4.3 `GET /api/gaps-protecao`

```typescript
// Query params: uf, distribuidora, score_min (default 30), limit (default 200)
// Resposta: GeoJSON FeatureCollection
// Properties: distribuidora, municipio, uf, comprimento_km, score_vulnerabilidade
```

#### 4.4 `GET /api/kpis` — ATUALIZAR EXISTENTE

Adicionar ao response existente:
```typescript
{
  // campos existentes...
  consumidores_afetados: number,   // SUM(populacao * 0.37) dos municípios críticos via ibge_populacao
  km_rede_sem_protecao: number,    // SUM(comprimento_km) FROM gaps_protecao
  transformadores_criticos: number // COUNT WHERE EXTRACT(YEAR FROM AGE(...)) > 25
}
```

#### 4.5 `GET /api/ranking-municipios` — ATUALIZAR EXISTENTE

Adicionar colunas ao response de cada município:
```typescript
{
  // campos existentes...
  populacao: number,          // FROM ibge_populacao
  tendencia: string,          // 'piorando' | 'estavel' | 'melhorando'
  km_sem_protecao: number,    // FROM gaps_protecao
  n_transformadores_criticos: number
}
```

---

### BLOCO 5 — ATUALIZAÇÕES NO FRONTEND

#### 5.1 Atualizar `frontend/app/page.tsx`

**KPI Cards — adicionar 3 novos cards:**
```
Card 5: "Consumidores em Risco"    → kpis.consumidores_afetados  (cor: vermelho)
Card 6: "Km Sem Proteção"          → kpis.km_rede_sem_protecao   (cor: laranja)
Card 7: "Transformadores Críticos" → kpis.transformadores_criticos (cor: amarelo)
```

Layout: manter 4 cards na primeira linha, 3 na segunda.

**Tabela PainelRisco — adicionar colunas:**
- "Tendência": ícone 📈 (piorando, vermelho), ➡️ (estável, cinza), 📉 (melhorando, verde)
- "Pop. Afetada": populacao formatado (ex: "23.8k")
- "Km s/ Proteção": km_sem_protecao com 1 decimal

#### 5.2 Atualizar `frontend/components/MapaRisco.tsx`

**Substituir o popup simples pelo painel rico:**

Quando um município é clicado, fazer fetch para `GET /api/municipio/:municipio/detalhe`
e exibir um popup com 4 seções via HTML inline no Mapbox Popup:

```html
<!-- Cabeçalho -->
<div>GIRAU DO PONCIANO — AL · Equatorial Alagoas</div>
<div>Score: 87/100 🔴 · Tendência: 📈 Piorando</div>

<!-- Seção 1: DEC/FEC -->
DEC Médio: 21.8h / limite 12.0h (ratio 1.82×)
Violações: 11 dos últimos 12 meses

<!-- Seção 2: Infraestrutura -->
Rede MT: 142km · BT: 89km
Transformadores: 38 total · 12 críticos (>25 anos)
Potência instalada: 2.850 kVA

<!-- Seção 3: Proteção -->
Religadores: 3 · Chaves: 8
Cobertura: 67% · Exposto: 46km

<!-- Seção 4: Contexto -->
População: 23.847 hab · Domicílios: 7.200
PIB per capita: R$ 12.400
```

**Adicionar novo toggle de camada "Gaps de Proteção":**
- Quando ativo, chama `GET /api/gaps-protecao?uf=<uf_atual>&score_min=30`
- Renderiza como linhas vermelhas tracejadas no mapa
- Layer type: `line` com `line-dasharray: [2, 2]`, cor `#ef4444`, width 2

**Adicionar mini gráfico de tendência no popup:**
- Usar o `historico` do detalhe do município
- Renderizar como sparkline SVG inline (sem dependência externa)
- 12 pontos, cor baseada na tendência

#### 5.3 Criar `frontend/components/SparkLine.tsx`

Componente SVG puro (sem biblioteca) que recebe:
```typescript
interface SparkLineProps {
  data: number[]     // até 12 valores de score
  width?: number     // default 120
  height?: number    // default 32
  color?: string     // default baseado no último valor
}
```
Renderiza uma polyline SVG normalizada entre 0 e 100.

#### 5.4 Criar `frontend/app/municipio/[nome]/page.tsx`

Página de detalhe de município (rota dinâmica):
- Busca `GET /api/municipio/:nome/detalhe`
- Busca `GET /api/municipio/:nome/transformadores-aging`
- Exibe:
  - Header com nome, score, tendência
  - 4 cards de KPI do município (DEC, violações, cobertura, pop. afetada)
  - Gráfico de série histórica (SparkLine ampliado — 300×80px)
  - Mapa miniatura com transformadores coloridos por criticidade
  - Tabela de transformadores críticos ordenada por score_equipamento

Link para esta página no popup do mapa principal: "Ver detalhe completo →"

---

### BLOCO 6 — MAKEFILE

Adicionar ao `Makefile`:

```makefile
gaps:
	$(PIPELINE) calculate_gaps.py $(if $(UF),--uf $(UF),) $(if $(DISTRIBUIDORA),--distribuidora "$(DISTRIBUIDORA)",)

historico:
	$(PIPELINE) calculate_historico.py

populacao:
	@if [ -z "$(UF)" ]; then echo "Erro: informe UF=XX"; exit 1; fi
	$(PIPELINE) ingest_ibge_populacao.py --uf $(UF)

full-pipeline: ingest-ibge ingest-bdgd ingest-dec score gaps historico populacao
	@echo "Pipeline completo executado."
```

---

## REGRAS DE IMPLEMENTAÇÃO

1. **Todo código em TypeScript** no backend e frontend. Sem `any` implícito.
2. **Todo SQL geoespacial usa EPSG:4326 na saída** — sempre `ST_Transform(geom, 4326)` antes de `ST_AsGeoJSON`.
3. **Todos os endpoints novos tratam resultados vazios** — retornam `[]` ou `{}` com campos nulos, nunca 500.
4. **Scripts Python são idempotentes** — DELETE + INSERT ou upsert, nunca duplicam dados.
5. **Logs com timestamp** em todos os scripts Python: `[2024-01-15 10:23:45] [INFO] mensagem`.
6. **Sem mock data** — se dado não existe no banco, retorna null/zero, não inventa valor.
7. **Manter compatibilidade** — não alterar assinaturas de rotas existentes, apenas adicionar campos.
8. **Registrar novas rotas em `server.ts`** — importar e registrar `municipioRoutes` com prefix `/api`.

---

## ORDEM DE EXECUÇÃO

```
1. Bloco 1  — seed_demo.py (scores dramáticos)
2. Bloco 2  — init.sql (novas tabelas)
3. Bloco 3  — scripts Python (nova ingestão)
4. Bloco 4  — rotas API (novos endpoints + atualizações)
5. Bloco 5  — frontend (popup rico + novas camadas + página detalhe)
6. Bloco 6  — Makefile

Após cada bloco, commitar com mensagem descritiva.
Branch: claude/gridrisk-platform-SEgmU
```

---

## RESULTADO ESPERADO APÓS IMPLEMENTAÇÃO

O dashboard mostrará:
- Score médio realista (~55), municípios críticos (~25–30), consumidores afetados (~180k
- Tendências de melhora/piora por município

O mapa mostrará:
- Choropleth de municípios com cores dramáticas (verde → vermelho)
- Popup rico com 4 seções de dados ao clicar em município
- Toggle "Gaps de Proteção" com linhas vermelhas tracejadas nos trechos expostos
- Mini sparkline de tendência no popup

A página de detalhe mostrará:
- Série histórica de score do município
- Lista de transformadores críticos com mapa
- Cobertura de proteção real vs. exposição
