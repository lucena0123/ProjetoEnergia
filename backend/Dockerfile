# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Instala dependências (incluindo devDeps para prisma + tsc)
COPY package*.json ./
RUN npm ci

# Copia schema antes de gerar o client Prisma
COPY prisma ./prisma
RUN npx prisma generate

# Copia o restante e compila TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev

# Client Prisma gerado e código compilado
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/server.js"]
