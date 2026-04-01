import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { Queue, Job } from 'bullmq'
import IORedis from 'ioredis'

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null, // required by BullMQ
})

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const importacaoQueue = new Queue('importacao', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportarBdgdBody {
  distribuidora: string
  uf: string
  ano: number
}

interface JobStatusParams {
  jobId: string
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const importarBdgdSchema = {
  body: {
    type: 'object',
    required: ['distribuidora', 'uf', 'ano'],
    properties: {
      distribuidora: { type: 'string', minLength: 1 },
      uf: { type: 'string', minLength: 2, maxLength: 2 },
      ano: { type: 'integer', minimum: 2000, maximum: 2100 },
    },
    additionalProperties: false,
  },
} as const

const jobStatusSchema = {
  params: {
    type: 'object',
    required: ['jobId'],
    properties: {
      jobId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps BullMQ job state strings to a simplified status label.
 */
function mapBullMqState(state: string): string {
  const stateMap: Record<string, string> = {
    waiting: 'queued',
    'waiting-children': 'queued',
    active: 'processing',
    completed: 'completed',
    failed: 'failed',
    delayed: 'delayed',
    paused: 'paused',
    prioritized: 'queued',
    unknown: 'unknown',
  }
  return stateMap[state] ?? state
}

/**
 * Serializes a BullMQ Job into a plain status object safe for JSON response.
 */
async function serializeJob(job: Job): Promise<object> {
  const state = await job.getState()
  return {
    jobId: job.id,
    status: mapBullMqState(state),
    progress: job.progress,
    result: job.returnvalue ?? null,
    failedReason: job.failedReason ?? null,
    createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  }
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const jobsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /api/jobs/importar-bdgd
   *
   * Enqueues a BDGD import job for the given distributor / state / year.
   * Uses a deterministic jobId so that duplicate submissions are idempotent.
   */
  fastify.post(
    '/jobs/importar-bdgd',
    { schema: importarBdgdSchema },
    async (
      request: FastifyRequest<{ Body: ImportarBdgdBody }>,
      reply: FastifyReply,
    ) => {
      const { distribuidora, uf, ano } = request.body
      const jobId = `bdgd-${uf.toUpperCase()}-${distribuidora}-${ano}`

      // Check if the job already exists and is not in a terminal state
      const existingJob = await importacaoQueue.getJob(jobId)
      if (existingJob) {
        const state = await existingJob.getState()
        if (state !== 'completed' && state !== 'failed') {
          return reply.status(409).send({
            error: 'Conflict',
            message: `Job ${jobId} already exists with status: ${mapBullMqState(state)}`,
            jobId,
            status: mapBullMqState(state),
          })
        }
      }

      const job = await importacaoQueue.add(
        'importar-bdgd',
        { distribuidora, uf: uf.toUpperCase(), ano },
        { jobId },
      )

      return reply.status(202).send({
        jobId: job.id,
        status: 'queued',
      })
    },
  )

  /**
   * GET /api/jobs/:jobId/status
   *
   * Returns the current status and metadata of an import job.
   */
  fastify.get(
    '/jobs/:jobId/status',
    { schema: jobStatusSchema },
    async (
      request: FastifyRequest<{ Params: JobStatusParams }>,
      reply: FastifyReply,
    ) => {
      const { jobId } = request.params
      const job = await importacaoQueue.getJob(jobId)

      if (!job) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Job '${jobId}' not found`,
        })
      }

      return reply.send(await serializeJob(job))
    },
  )
}
