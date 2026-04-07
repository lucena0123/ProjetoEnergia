# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

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
FROM node:20-alpine AS runtime

WORKDIR /app

# Apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev

# Client Prisma gerado e código compilado
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/server.js"]
