# GridRisk

**Plataforma de mapeamento de risco da infraestrutura elétrica brasileira**

Cruza dados públicos da ANEEL (BDGD + DEC/FEC) com análise geoespacial para gerar um score de risco de 0 a 100 por município, identificando onde a rede elétrica é mais vulnerável.

> Dados 100% públicos · Open source · Roda com Docker em 5 minutos

---

## Demo

> **Adicione capturas de tela aqui após rodar `make seed-demo`**
>
> Sugestão: tire print do mapa com o choropleth colorido e do dashboard com os KPIs,
> e cole as imagens na pasta `docs/screenshots/`.

---

## Como funciona o Score de Risco

Cada município recebe uma pontuação de **0 a 100** calculada com três componentes:

| Componente | Peso | Cálculo |
|---|---|---|
| Ratio DEC | 40% | `(DEC apurado / DEC limite)`, máx 3× |
| Frequência de violações | 30% | Meses nos últimos 12 com DEC acima do limite |
| Idade média da rede MT | 30% | Média dos anos desde implantação (referência: 40 anos) |

```
score = (ratio_dec / 3.0) × 40
      + (meses_violacao / 12) × 30
      + (idade_media / 40) × 30
```

---

## Arquitetura

```
┌──────────────────────────────────────────────────────────────────────┐
│                             GridRisk                                 │
├─────────────────┬────────────────────────────┬───────────────────────┤
│   Pipeline      │        Backend API          │      Frontend         │
│   Python 3.11   │   Fastify + TypeScript      │    Next.js 14         │
│                 │                             │                       │
│ ingest_ibge     │  GET /api/mapa-risco        │  /mapa                │
│ ingest_bdgd     │  GET /api/trechos-criticos  │  ↳ MapLibre choropleth│
│ ingest_dec_fec  │  GET /api/transformadores   │  ↳ Toggle rede MT     │
│ calculate_risk  │  GET /api/ranking-municipios│  ↳ Popup por município│
│ seed_demo       │  GET /api/kpis              │                       │
│                 │  POST /api/jobs/importar    │  /                    │
│                 │                             │  ↳ KPI cards          │
│                 │   BullMQ Worker             │  ↳ Ranking paginado   │
│                 │   (importação assíncrona)   │  ↳ Filtros            │
├─────────────────┴────────────────────────────┴───────────────────────┤
│          PostgreSQL 15 + PostGIS 3.4          │      Redis 7          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Stack

| Camada | Tecnologia |
|---|---|
| Backend API | Node.js 20 · Fastify 4 · TypeScript |
| ORM | Prisma 5 (tabelas relacionais) + pg direto (PostGIS) |
| Banco de dados | PostgreSQL 15 + PostGIS 3.4 |
| Filas assíncronas | BullMQ 5 + Redis 7 |
| Pipeline de dados | Python 3.11 · GeoPandas · SQLAlchemy |
| Frontend | Next.js 14 (App Router) · Tailwind CSS |
| Mapa | MapLibre GL JS + OpenFreeMap |
| Infra local | Docker Compose |
| Deploy | Vercel (frontend) + Railway (backend + banco) |

---

## Fontes de dados (todas públicas e gratuitas)

| Fonte | Dados | URL |
|---|---|---|
| ANEEL BDGD | Geometria da rede MT/BT, transformadores, subestações | [dadosabertos.aneel.gov.br](https://dadosabertos.aneel.gov.br/dataset/bdgd) |
| ANEEL DEC/FEC | Indicadores de continuidade por município/mês | [dadosabertos.aneel.gov.br](https://dadosabertos.aneel.gov.br/dataset/indicadores-de-continuidade) |
| IBGE Malhas | Polígonos municipais para o mapa | [servicodados.ibge.gov.br](https://servicodados.ibge.gov.br/api/v3/malhas) |

---

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) e Docker Compose
- [Make](https://www.gnu.org/software/make/)

---

## Início rápido (demo automático)

```bash
# 1. Clone e configure
git clone https://github.com/lucena0123/ProjetoEnergia.git
cd ProjetoEnergia
cp .env.example .env
# Opcional: troque NEXT_PUBLIC_MAP_STYLE_URL se quiser usar outro style

# 2. Sobe a stack
make setup

# 3. Popula com dados de demonstração (AL — automático, ~3 min)
make seed-demo

# 4. Acesse
open http://localhost:3000        # Dashboard
open http://localhost:3000/mapa   # Mapa interativo
```

---

## Uso com dados reais da ANEEL

```bash
# Polígonos municipais (obrigatório antes da BDGD; usados no vínculo municipal)
make ingest-ibge UF=AL

# Rede elétrica (baixa a BDGD oficial da ANEEL em .gdb.zip)
make download-bdgd \
  QUERY=ENEL_CE \
  ANO=2024 \
  SAIDA=/data/enel_ce_2024.gdb.zip

make ingest-bdgd \
  ARQUIVO=/data/enel_ce_2024.gdb.zip \
  DISTRIBUIDORA='Enel Ceará' \
  UF=CE

# Continuidade oficial ANEEL: apurado + limite + vínculo IndQual → município
make download-dec SAIDA=/data/indicadores_continuidade.csv
make download-dec TIPO=limite SAIDA=/data/indicadores_continuidade_limite.csv
make download-indqual SAIDA=/data/indqual_municipio.csv

# Agrega DEC/FEC por município usando NumCon como peso
make ingest-dec \
  ARQUIVO=/data/indicadores_continuidade.csv \
  ARQUIVO_LIMITE=/data/indicadores_continuidade_limite.csv \
  ARQUIVO_INDQUAL=/data/indqual_municipio.csv \
  UF=CE \
  DISTRIBUIDORA='Enel Ceará' \
  LIMPAR=1

# Calcula scores de risco
make score
```

Observações importantes:
- A ingestão da BDGD depende das malhas do IBGE para preencher `municipio` por `spatial join`.
- O artefato oficial da BDGD normalmente vem como `File Geodatabase` compactada (`.gdb.zip`). O importador também aceita `.gdb` e `.gpkg`.
- O parâmetro `QUERY` do `download-bdgd` usa o termo do portal ArcGIS da ANEEL, como `ENEL_CE`. Se você já souber o `item id`, pode usar `ITEM_ID=<arcgis-item-id>`.
- Na continuidade, a ANEEL publica o apurado, os limites e a chave `IndQual Município` em arquivos separados.
- No modo oficial, `ingest_dec_fec.py` junta esses 3 arquivos e agrega os conjuntos para município ponderando por `NumCon`.
- `score_risco`, `cobertura` e criticidade de equipamentos continuam sendo métricas derivadas do projeto, mesmo quando a base elétrica é real.
- Enquanto a infraestrutura vier do `seed_demo.py`, a UI deve ser tratada como demonstrativa.

---

## Confiabilidade dos dados

- `IBGE`: malhas, população, densidade.
- `ANEEL`: BDGD, DEC/FEC.
- `Derivado pelo projeto`: score de risco, gaps de proteção, criticidade estimada de transformadores, tendência.
- `Demo`: qualquer ativo com `cod_id` no padrão `*-DEMO-*` foi gerado sinteticamente e não representa inventário operacional real.

---

## Endpoints da API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/mapa-risco` | GeoJSON com score de risco por município |
| GET | `/api/trechos-criticos?score_min=70` | Segmentos de rede MT em municípios críticos |
| GET | `/api/transformadores-criticos?municipio=Maceió` | Transformadores com score herdado |
| GET | `/api/ranking-municipios?uf=AL&page=1` | Ranking paginado por score |
| GET | `/api/kpis` | Score médio, municípios críticos, DEC médio |
| POST | `/api/jobs/importar-bdgd` | Dispara importação assíncrona de BDGD |
| GET | `/api/jobs/:id/status` | Status do job de importação |
| GET | `/health` | Health check |

---

## Deploy em produção

### Frontend → Vercel (gratuito)

```bash
cd frontend
npx vercel

# Configurar variáveis de ambiente no painel Vercel:
# NEXT_PUBLIC_API_URL      = https://seu-backend.railway.app
# NEXT_PUBLIC_MAP_STYLE_URL = https://tiles.openfreemap.org/styles/liberty  # opcional
```

### Backend + Banco + Redis → Railway

```bash
# 1. Instale a CLI do Railway
npm install -g @railway/cli && railway login

# 2. Crie o projeto
cd backend && railway init

# 3. Adicione os plugins no painel Railway:
#    - PostgreSQL (habilite a extensão postgis manualmente)
#    - Redis

# 4. Deploy
railway up

# Variáveis configuradas automaticamente pelo Railway:
# DATABASE_URL, REDIS_URL
```

Após o deploy do backend, atualize `NEXT_PUBLIC_API_URL` no Vercel com a URL gerada pelo Railway.

---

## Desenvolvimento local (sem Docker)

```bash
# Backend
cd backend
npm install
cp ../.env.example .env   # ajustar DATABASE_URL e REDIS_URL
npm run dev               # API na porta 3001

# Worker (terminal separado)
npm run dev:worker

# Frontend
cd frontend
npm install
npm run dev               # http://localhost:3000

# Pipeline
cd pipeline
pip install -r requirements.txt
cp .env.example .env      # ajustar DATABASE_URL
python seed_demo.py --uf AL
```

---

## Comandos Make

```
make setup                  Configura .env e sobe toda a stack
make seed-demo              Popula banco com dados de demonstração (AL)
make ingest-ibge UF=AL      Importa polígonos municipais do IBGE
make download-bdgd ...      Baixa BDGD oficial da ANEEL (.gdb.zip)
make ingest-bdgd ...        Ingere arquivo BDGD (.gpkg, .gdb ou .gdb.zip)
make download-dec ...       Baixa CSV oficial de continuidade ANEEL
make download-indqual ...   Baixa vínculo oficial IndQual → município
make ingest-dec ...         Ingere continuidade municipal (legado ou oficial)
make score                  Recalcula todos os scores de risco
make logs s=backend         Acompanha logs de um serviço
make pipeline-shell         Shell interativo no container Python
make down                   Para todos os containers
```

---

## Estrutura do projeto

```
gridrisk/
├── pipeline/                   Scripts Python de ingestão
│   ├── ingest_ibge_municipios.py   Polígonos municipais (IBGE API)
│   ├── download_aneel.py           Download oficial BDGD + DEC/FEC (ANEEL)
│   ├── ingest_bdgd.py              Rede elétrica (GeoPackage/FileGDB ANEEL)
│   ├── ingest_dec_fec.py           Indicadores DEC/FEC (CSV ANEEL)
│   ├── calculate_risk.py           Scoring de risco por município
│   ├── seed_demo.py                Dados de demonstração automáticos
│   └── requirements.txt
├── backend/                    API Fastify
│   ├── src/
│   │   ├── routes/             Endpoints REST
│   │   ├── workers/            Worker BullMQ
│   │   ├── db.ts               Prisma + pg Pool
│   │   └── server.ts
│   └── prisma/
│       ├── schema.prisma
│       └── init.sql            Schema PostGIS completo
├── frontend/                   Next.js App
│   ├── app/
│   │   ├── page.tsx            Dashboard com KPIs
│   │   └── mapa/page.tsx       Mapa interativo
│   └── components/
│       ├── MapaRisco.tsx       MapLibre choropleth
│       ├── PainelRisco.tsx     Tabela paginada
│       └── KpiCard.tsx
└── docker-compose.yml
```

---

## Licença

MIT — veja [LICENSE](LICENSE)
