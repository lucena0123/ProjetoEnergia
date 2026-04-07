.PHONY: help setup up down logs seed-demo ingest-ibge ingest-bdgd ingest-dec score pipeline-shell dev-backend dev-frontend

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
	@echo "  make ingest-bdgd ARQUIVO=/data/bdgd.gpkg DISTRIBUIDORA='Equatorial AL' UF=AL"
	@echo "                        Ingere um arquivo BDGD (.gpkg) no banco"
	@echo "  make ingest-dec ARQUIVO=/data/dec_fec.csv"
	@echo "                        Ingere arquivo DEC/FEC da ANEEL"
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

ingest-bdgd:
	@if [ -z "$(ARQUIVO)" ]; then \
		echo "Erro: informe ARQUIVO=/data/arquivo.gpkg"; exit 1; fi
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
	$(PIPELINE) ingest_dec_fec.py --arquivo $(ARQUIVO)

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
	$(PIPELINE) calculate_historico.py

populacao:
	@if [ -z "$(UF)" ]; then echo "Erro: informe UF=XX"; exit 1; fi
	$(PIPELINE) ingest_ibge_populacao.py --uf $(UF)

full-pipeline: ingest-ibge ingest-bdgd ingest-dec score gaps historico populacao
	@echo "Pipeline completo executado."
