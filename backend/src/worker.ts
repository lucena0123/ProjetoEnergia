/**
 * worker.ts — Entrypoint standalone do worker BullMQ
 *
 * Iniciado como processo separado (node dist/worker.js) pelo serviço
 * `worker` no docker-compose, independente do processo da API Fastify.
 */
import dotenv from 'dotenv'
dotenv.config()

// Importar o worker dispara o registro automático na fila 'importacao'
import { worker } from './workers/importacao.worker'

process.on('SIGTERM', async () => {
  console.log('[GridRisk Worker] SIGTERM recebido — encerrando graciosamente...')
  await worker.close()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('[GridRisk Worker] SIGINT recebido — encerrando graciosamente...')
  await worker.close()
  process.exit(0)
})

console.log('[GridRisk Worker] Processo iniciado, aguardando jobs na fila "importacao"...')
