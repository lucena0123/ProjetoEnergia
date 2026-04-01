import { Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null, // required by BullMQ
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/**
 * Resolves the path to the Python pipeline scripts directory.
 * Expects the scripts to live at ../../pipeline/ relative to this file
 * (i.e. /home/user/ProjetoEnergia/pipeline/).
 */
function pipelineScript(scriptName: string): string {
  return path.resolve(__dirname, '..', '..', '..', 'pipeline', scriptName)
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

interface ImportacaoJobData {
  distribuidora: string
  uf: string
  ano: number
  arquivo?: string
}

async function processImportacao(job: Job<ImportacaoJobData>): Promise<object> {
  const { distribuidora, uf, ano, arquivo } = job.data

  console.log(
    `[Worker] Starting import job ${job.id} — distribuidora=${distribuidora} uf=${uf} ano=${ano}`,
  )

  // -------------------------------------------------------------------------
  // Step 1 – Locate BDGD source file (0%)
  // -------------------------------------------------------------------------
  await job.updateProgress(0)
  console.log(`[Worker] ${job.id} — Locating BDGD file for ${distribuidora} ${uf} ${ano}...`)

  const resolvedArquivo = arquivo ?? `bdgd_${uf}_${distribuidora}_${ano}.zip`
  const dataDir = process.env.BDGD_DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data')
  const filePath = path.join(dataDir, resolvedArquivo)

  console.log(`[Worker] ${job.id} — Resolved file path: ${filePath}`)

  // -------------------------------------------------------------------------
  // Step 2 – Run ingest_bdgd.py (25%)
  // -------------------------------------------------------------------------
  await job.updateProgress(25)
  console.log(`[Worker] ${job.id} — Running ingest_bdgd pipeline...`)

  const ingestScript = pipelineScript('ingest_bdgd.py')
  try {
    const { stdout: ingestStdout, stderr: ingestStderr } = await execFileAsync(
      process.env.PYTHON_BIN ?? 'python3',
      [
        ingestScript,
        '--arquivo', filePath,
        '--distribuidora', distribuidora,
        '--uf', uf,
      ],
      {
        env: { ...process.env },
        timeout: 30 * 60 * 1000, // 30 minutes
      },
    )

    if (ingestStdout) console.log(`[Worker:ingest] stdout:\n${ingestStdout}`)
    if (ingestStderr) console.warn(`[Worker:ingest] stderr:\n${ingestStderr}`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `ingest_bdgd failed for ${distribuidora}/${uf}/${ano}: ${message}`,
    )
  }

  // -------------------------------------------------------------------------
  // Step 3 – Run calculate_risk.py (75%)
  // -------------------------------------------------------------------------
  await job.updateProgress(75)
  console.log(`[Worker] ${job.id} — Running calculate_risk pipeline...`)

  const riskScript = pipelineScript('calculate_risk.py')
  try {
    const { stdout: riskStdout, stderr: riskStderr } = await execFileAsync(
      process.env.PYTHON_BIN ?? 'python3',
      [
        riskScript,
        '--distribuidora', distribuidora,
      ],
      {
        env: { ...process.env },
        timeout: 20 * 60 * 1000, // 20 minutes
      },
    )

    if (riskStdout) console.log(`[Worker:risk] stdout:\n${riskStdout}`)
    if (riskStderr) console.warn(`[Worker:risk] stderr:\n${riskStderr}`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `calculate_risk failed for ${distribuidora}/${uf}/${ano}: ${message}`,
    )
  }

  // -------------------------------------------------------------------------
  // Step 4 – Done (100%)
  // -------------------------------------------------------------------------
  await job.updateProgress(100)
  console.log(`[Worker] ${job.id} — Import completed successfully.`)

  return {
    distribuidora,
    uf,
    ano,
    completedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Worker instance
// ---------------------------------------------------------------------------

const worker = new Worker<ImportacaoJobData>('importacao', processImportacao, {
  connection: redisConnection,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
})

worker.on('active', (job) => {
  console.log(`[Worker] Job ${job.id} is now active.`)
})

worker.on('completed', (job, result) => {
  console.log(`[Worker] Job ${job.id} completed.`, result)
})

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id ?? 'unknown'} failed:`, err.message)
})

worker.on('progress', (job, progress) => {
  console.log(`[Worker] Job ${job.id} progress: ${progress}%`)
})

worker.on('error', (err) => {
  console.error('[Worker] Unexpected worker error:', err)
})

console.log('[GridRisk Worker] importacao worker started, waiting for jobs...')

export { worker }
