.PHONY: help setup up down logs seed-demo ingest-ibge download-bdgd download-dec download-indqual ingest-bdgd ingest-dec score pipeline-shell dev-backend dev-frontend

# ── Variáveis ─────────────────────────────────────────────────────────────────
COMPOSE     = docker compose
PIPELINE    = $(COMPOSE) exec pipeline python
DISTRIBUIDORA ?= ""
UF          ?= ""
ARQUIVO     ?= ""

# ── Help ──────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "GridRisk — comandos disponíveis:"
	@echo ""
	@echo "  make setup            Copia .env.example → .env e sobe toda a stack"
	@echo "  make up               Sobe todos os containers"
	@echo "  make down             Para e remove os containers"
	@echo "  make logs             Acompanha logs de todos os serviços"
	@echo "  make logs s=backend   Acompanha logs de um serviço específico"
	@echo ""
	@echo "  make ingest-bdgd ARQUIVO=/data/bdgd.gdb.zip DISTRIBUIDORA='Enel Ceará' UF=CE"
	@echo "                        Ingere um arquivo BDGD (.gpkg, .gdb ou .gdb.zip) no banco"
	@echo "  make ingest-dec ARQUIVO=/data/dec_fec.csv"
	@echo "                        Ingere arquivo DEC/FEC da ANEEL"
	@echo "  make download-bdgd QUERY=ENEL_CE ANO=2024 SAIDA=/data/enel_ce_2024.gdb.zip"
	@echo "                        Baixa a BDGD oficial no formato .gdb.zip"
	@echo "  make download-dec SAIDA=/data/indicadores_continuidade.csv"
	@echo "                        Baixa o CSV oficial de continuidade (apurado)"
	@echo "  make download-dec TIPO=limite SAIDA=/data/indicadores_continuidade_limite.csv"
	@echo "                        Baixa o CSV oficial de limites DEC/FEC"
	@echo "  make download-indqual SAIDA=/data/indqual_municipio.csv"
	@echo "                        Baixa o vínculo oficial IndQual → município"
	@echo "  make ingest-dec ARQUIVO=/data/indicadores_continuidade.csv ARQUIVO_LIMITE=/data/indicadores_continuidade_limite.csv ARQUIVO_INDQUAL=/data/indqual_municipio.csv UF=CE DISTRIBUIDORA='Enel Ceará' LIMPAR=1"
	@echo "                        Ingere continuidade oficial ANEEL agregada por município"
	@echo "  make score            Recalcula scores de risco para todos os municípios"
	@echo "  make score DISTRIBUIDORA='Equatorial AL'"
	@echo "                        Recalcula scores de uma distribuidora específica"
	@echo ""
	@echo "  make seed-demo            Popula banco com dados de demo (AL) — ~3 min"
	@echo "  make seed-demo UF=PE      Gera demo para outro estado"
	@echo ""
	@echo "  make ingest-ibge UF=AL"
	@echo "                        Importa polígonos municipais do IBGE para um estado"
	@echo "  make ingest-ibge UF=ALL"
	@echo "                        Importa polígonos de todos os 27 estados"
	@echo ""
	@echo "  make pipeline-shell   Abre shell interativo no container Python"
	@echo "  make dev-backend      Inicia backend em modo dev (hot-reload)"
	@echo "  make dev-frontend     Inicia frontend em modo dev (hot-reload)"
	@echo ""

# ── Setup inicial ─────────────────────────────────────────────────────────────
setup:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "✔  .env criado a partir de .env.example"; \
		echo "⚠  Revise .env antes de continuar; ajuste NEXT_PUBLIC_MAP_STYLE_URL se quiser outro basemap"; \
	else \
		echo "✔  .env já existe, pulando"; \
	fi
	$(COMPOSE) up -d --build
	@echo ""
	@echo "✔  Stack iniciada:"
	@echo "   API      → http://localhost:3001"
	@echo "   Frontend → http://localhost:3000"
	@echo "   Health   → http://localhost:3001/health"

# ── Stack ─────────────────────────────────────────────────────────────────────
up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

logs:
ifdef s
	$(COMPOSE) logs -f $(s)
else
	$(COMPOSE) logs -f
endif

# ── Pipeline de dados ─────────────────────────────────────────────────────────
seed-demo:
	$(PIPELINE) seed_demo.py --uf $(if $(UF),$(UF),AL) --limpar

ingest-ibge:
	@if [ -z "$(UF)" ]; then \
		echo "Erro: informe UF=XX (ex: AL) ou UF=ALL para todos os estados"; exit 1; fi
	$(PIPELINE) ingest_ibge_municipios.py --uf $(UF)

download-bdgd:
	@if [ -z "$(ITEM_ID)" ] && [ -z "$(QUERY)" ]; then \
		echo "Erro: informe QUERY=ENEL_CE ou ITEM_ID=<arcgis-item-id>"; exit 1; fi
	$(PIPELINE) download_aneel.py bdgd \
		$(if $(QUERY),--query "$(QUERY)",) \
		$(if $(ANO),--ano $(ANO),) \
		$(if $(ITEM_ID),--item-id $(ITEM_ID),) \
		$(if $(SAIDA),--saida $(SAIDA),)

download-dec:
	$(PIPELINE) download_aneel.py continuidade \
		$(if $(TIPO),--tipo $(TIPO),) \
		$(if $(RESOURCE_ID),--resource-id $(RESOURCE_ID),) \
		$(if $(SAIDA),--saida $(SAIDA),)

download-indqual:
	$(PIPELINE) download_aneel.py indqual \
		$(if $(RESOURCE_ID),--resource-id $(RESOURCE_ID),) \
		$(if $(SAIDA),--saida $(SAIDA),)

ingest-bdgd:
	@if [ -z "$(ARQUIVO)" ]; then \
		echo "Erro: informe ARQUIVO=/data/arquivo.gpkg ou /data/arquivo.gdb.zip"; exit 1; fi
	@if [ -z "$(DISTRIBUIDORA)" ]; then \
		echo "Erro: informe DISTRIBUIDORA='Nome da Distribuidora'"; exit 1; fi
	@if [ -z "$(UF)" ]; then \
		echo "Erro: informe UF=XX"; exit 1; fi
	$(PIPELINE) ingest_bdgd.py \
		--arquivo $(ARQUIVO) \
		--distribuidora "$(DISTRIBUIDORA)" \
		--uf $(UF)

ingest-dec:
	@if [ -z "$(ARQUIVO)" ]; then \
		echo "Erro: informe ARQUIVO=/data/arquivo.csv"; exit 1; fi
	$(PIPELINE) ingest_dec_fec.py \
		--arquivo $(ARQUIVO) \
		$(if $(ARQUIVO_LIMITE),--arquivo-limite $(ARQUIVO_LIMITE),) \
		$(if $(ARQUIVO_INDQUAL),--arquivo-indqual $(ARQUIVO_INDQUAL),) \
		$(if $(UF),--uf $(UF),) \
		$(if $(DISTRIBUIDORA),--distribuidora "$(DISTRIBUIDORA)",) \
		$(if $(LIMPAR),--limpar,)

score:
ifdef DISTRIBUIDORA
	$(PIPELINE) calculate_risk.py --distribuidora "$(DISTRIBUIDORA)"
else
	$(PIPELINE) calculate_risk.py
endif

# ── Desenvolvimento ───────────────────────────────────────────────────────────
pipeline-shell:
	$(COMPOSE) exec pipeline /bin/bash

dev-backend:
	cd backend && npm run dev

dev-frontend:
	cd frontend && npm run dev

gaps:
	$(PIPELINE) calculate_gaps.py $(if $(UF),--uf $(UF),) $(if $(DISTRIBUIDORA),--distribuidora "$(DISTRIBUIDORA)",)

historico:
	$(PIPELINE) calculate_historico.py \
		$(if $(REBUILD),--rebuild,) \
		$(if $(UF),--uf $(UF),) \
		$(if $(DISTRIBUIDORA),--distribuidora "$(DISTRIBUIDORA)",) \
		$(if $(LIMPAR),--limpar,)

populacao:
	@if [ -z "$(UF)" ]; then echo "Erro: informe UF=XX"; exit 1; fi
	$(PIPELINE) ingest_ibge_populacao.py --uf $(UF)

full-pipeline: ingest-ibge ingest-bdgd ingest-dec score gaps historico populacao
	@echo "Pipeline completo executado."
