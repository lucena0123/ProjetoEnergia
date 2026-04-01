import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { pgPool } from '../db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrechoRow {
  cod_id: string | null
  distribuidora: string | null
  municipio: string | null
  tensao_nom: number | null
  condutor: string | null
  comprimento: number | null
  score_risco: number | null
  geometry: object | null
}

interface TransformadorRow {
  cod_id: string | null
  distribuidora: string | null
  municipio: string | null
  potencia_nom: number | null
  fabricante: string | null
  score_risco: number
  geometry: object | null
}

// ---------------------------------------------------------------------------
// Query-string schemas
// ---------------------------------------------------------------------------

const trechosCriticosSchema = {
  querystring: {
    type: 'object',
    properties: {
      score_min: { type: 'number', default: 70 },
      limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
    },
    additionalProperties: false,
  },
} as const

const transformadoresSchema = {
  querystring: {
    type: 'object',
    required: ['municipio'],
    properties: {
      municipio: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a GeoJSON FeatureCollection from rows that contain a `geometry` field. */
function toFeatureCollection(
  rows: Array<Record<string, unknown>>,
): object {
  const features = rows.map((row) => {
    const { geometry, ...properties } = row
    return {
      type: 'Feature' as const,
      geometry: geometry ?? null,
      properties,
    }
  })
  return { type: 'FeatureCollection', features }
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const redeRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * GET /api/trechos-criticos
   *
   * Returns medium-voltage grid segments (rede_mt) joined with risk scores
   * where score_risco >= score_min as a GeoJSON FeatureCollection.
   */
  fastify.get(
    '/trechos-criticos',
    { schema: trechosCriticosSchema },
    async (
      request: FastifyRequest<{
        Querystring: { score_min?: number; limit?: number }
      }>,
      reply: FastifyReply,
    ) => {
      const scoreMin = request.query.score_min ?? 70
      const limit = request.query.limit ?? 500

      const sql = `
        SELECT
          r.cod_id,
          r.distribuidora,
          r.municipio,
          r.tensao_nom,
          r.condutor,
          r.comprimento,
          mr.score_risco,
          ST_AsGeoJSON(ST_Transform(r.geom, 4326))::json AS geometry
        FROM rede_mt r
        JOIN mapa_risco mr
          ON r.municipio     = mr.municipio
         AND r.distribuidora = mr.distribuidora
        WHERE mr.score_risco >= $1
        ORDER BY mr.score_risco DESC
        LIMIT $2
      `

      const result = await pgPool.query<TrechoRow>(sql, [scoreMin, limit])
      return reply.send(toFeatureCollection(result.rows as Array<Record<string, unknown>>))
    },
  )

  /**
   * GET /api/transformadores-criticos
   *
   * Returns transformers in a given municipality with their risk scores
   * as a GeoJSON FeatureCollection. Uses LEFT JOIN so transformers without
   * a risk entry are still returned (score_risco defaults to 0).
   */
  fastify.get(
    '/transformadores-criticos',
    { schema: transformadoresSchema },
    async (
      request: FastifyRequest<{
        Querystring: { municipio: string }
      }>,
      reply: FastifyReply,
    ) => {
      const { municipio } = request.query

      const sql = `
        SELECT
          t.cod_id,
          t.distribuidora,
          t.municipio,
          t.potencia_nom,
          t.fabricante,
          COALESCE(mr.score_risco, 0) AS score_risco,
          ST_AsGeoJSON(ST_Transform(t.geom, 4326))::json AS geometry
        FROM transformadores t
        LEFT JOIN mapa_risco mr
          ON t.municipio     = mr.municipio
         AND t.distribuidora = mr.distribuidora
        WHERE t.municipio = $1
        LIMIT 1000
      `

      const result = await pgPool.query<TransformadorRow>(sql, [municipio])

      if (result.rows.length === 0) {
        return reply.send({ type: 'FeatureCollection', features: [] })
      }

      return reply.send(toFeatureCollection(result.rows as Array<Record<string, unknown>>))
    },
  )
}
