import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { pgPool } from '../db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MapaRiscoRow {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
  dec_medio_12m: number | null
  ratio_dec: number | null
  meses_violacao: number | null
  idade_media_anos: number | null
  geometry: object | null
}

interface KpisRow {
  score_medio: string | null
  municipios_criticos: string
  dec_medio_geral: string | null
  total_meses_violacao: string
}

// ---------------------------------------------------------------------------
// Query-string schemas
// ---------------------------------------------------------------------------

const mapaRiscoSchema = {
  querystring: {
    type: 'object',
    properties: {
      distribuidora: { type: 'string' },
      uf: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

const rankingSchema = {
  querystring: {
    type: 'object',
    properties: {
      distribuidora: { type: 'string' },
      uf: { type: 'string' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
    },
    additionalProperties: false,
  },
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a WHERE clause and params array from optional filter args.
 * Pass a table alias (e.g. 'mr') to prefix columns when using JOINs.
 */
function buildFilters(
  tableAlias: string | undefined,
  distribuidora: string | undefined,
  uf: string | undefined,
  startIndex = 1,
): { where: string; params: unknown[]; nextIndex: number } {
  const conditions: string[] = []
  const params: unknown[] = []
  let idx = startIndex
  const prefix = tableAlias ? `${tableAlias}.` : ''

  if (distribuidora) {
    conditions.push(`${prefix}distribuidora ILIKE $${idx}`)
    params.push(`%${distribuidora}%`)
    idx++
  }

  if (uf) {
    conditions.push(`${prefix}uf = $${idx}`)
    params.push(uf.toUpperCase())
    idx++
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { where, params, nextIndex: idx }
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const riscoRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * GET /api/mapa-risco
   *
   * Returns a GeoJSON FeatureCollection of risk scores per municipality,
   * joined with IBGE municipality boundaries (ibge_municipios table).
   * Features without a matching boundary still appear with geometry: null
   * so the ranking sidebar and popup remain functional even before the
   * IBGE layer is loaded.
   */
  fastify.get(
    '/mapa-risco',
    { schema: mapaRiscoSchema },
    async (
      request: FastifyRequest<{
        Querystring: { distribuidora?: string; uf?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const { distribuidora, uf } = request.query
      const { where, params } = buildFilters('mr', distribuidora, uf)

      const sql = `
        SELECT
          mr.municipio,
          mr.distribuidora,
          mr.uf,
          mr.score_risco,
          mr.dec_medio_12m,
          mr.ratio_dec,
          mr.meses_violacao,
          mr.idade_media_anos,
          ST_AsGeoJSON(ST_Transform(im.geom, 4326))::json AS geometry
        FROM mapa_risco mr
        LEFT JOIN ibge_municipios im
          ON im.nome_norm = lower(unaccent(mr.municipio))
         AND im.uf        = mr.uf
        ${where}
        ORDER BY mr.score_risco DESC NULLS LAST
      `

      const result = await pgPool.query<MapaRiscoRow>(sql, params)

      const features = result.rows.map((row) => ({
        type: 'Feature' as const,
        geometry: row.geometry ?? null,
        properties: {
          municipio: row.municipio,
          distribuidora: row.distribuidora,
          uf: row.uf,
          score_risco: row.score_risco,
          dec_medio_12m: row.dec_medio_12m,
          ratio_dec: row.ratio_dec,
          meses_violacao: row.meses_violacao,
          idade_media_anos: row.idade_media_anos,
        },
      }))

      return reply.send({
        type: 'FeatureCollection',
        features,
      })
    },
  )

  /**
   * GET /api/ranking-municipios
   *
   * Returns a paginated list of municipalities ordered by risk score descending.
   */
  fastify.get(
    '/ranking-municipios',
    { schema: rankingSchema },
    async (
      request: FastifyRequest<{
        Querystring: {
          distribuidora?: string
          uf?: string
          page?: number
          limit?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      const page = request.query.page ?? 1
      const limit = request.query.limit ?? 20
      const offset = (page - 1) * limit

      const { distribuidora, uf } = request.query
      const { where, params, nextIndex } = buildFilters(undefined, distribuidora, uf)

      // Count query
      const countSql = `SELECT COUNT(*) AS total FROM mapa_risco ${where}`
      const countResult = await pgPool.query<{ total: string }>(countSql, params)
      const total = parseInt(countResult.rows[0]?.total ?? '0', 10)

      // Data query — append pagination params
      const dataSql = `
        SELECT
          municipio,
          distribuidora,
          uf,
          score_risco,
          dec_medio_12m,
          meses_violacao,
          idade_media_anos
        FROM mapa_risco
        ${where}
        ORDER BY score_risco DESC NULLS LAST
        LIMIT $${nextIndex} OFFSET $${nextIndex + 1}
      `
      const dataResult = await pgPool.query<MapaRiscoRow>(dataSql, [
        ...params,
        limit,
        offset,
      ])

      return reply.send({
        data: dataResult.rows,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      })
    },
  )

  /**
   * GET /api/kpis
   *
   * Returns high-level KPIs aggregated across all municipalities.
   */
  fastify.get('/kpis', async (_request: FastifyRequest, reply: FastifyReply) => {
    const sql = `
      SELECT
        ROUND(AVG(score_risco)::numeric, 2)              AS score_medio,
        COUNT(*) FILTER (WHERE score_risco > 70)         AS municipios_criticos,
        ROUND(AVG(dec_medio_12m)::numeric, 4)            AS dec_medio_geral,
        COALESCE(SUM(meses_violacao), 0)                 AS total_meses_violacao
      FROM mapa_risco
    `
    const result = await pgPool.query<KpisRow>(sql)
    const row = result.rows[0]

    return reply.send({
      score_medio: row?.score_medio != null ? parseFloat(row.score_medio) : null,
      municipios_criticos: row ? parseInt(row.municipios_criticos, 10) : 0,
      dec_medio_geral: row?.dec_medio_geral != null ? parseFloat(row.dec_medio_geral) : null,
      total_meses_violacao: row ? parseInt(row.total_meses_violacao, 10) : 0,
    })
  })
}
