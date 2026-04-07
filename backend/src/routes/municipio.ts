import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { pgPool } from '../db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DetalheRow {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
  dec_medio_12m: number | null
  dec_limite: number | null
  ratio_dec: number | null
  meses_violacao: number | null
}

interface InfraRow {
  comprimento_mt_km: string | null
  comprimento_bt_km: string | null
  n_transformadores: string
  potencia_total_kva: string | null
  idade_media_anos: string | null
  transformadores_criticos: string
}

interface ProtecaoRow {
  n_religadores: string
  n_chaves: string
  km_sem_protecao: string | null
}

interface SocialRow {
  populacao: number | null
  domicilios: number | null
  pib_per_capita: number | null
  area_km2: number | null
}

interface HistoricoRow {
  ano: number
  mes: number
  score_risco: number
  dec_medio: number | null
}

interface TransformadorAgingRow {
  cod_id: string | null
  potencia_nom: number | null
  fabricante: string | null
  idade_anos: number | null
  vida_util_restante_anos: number | null
  status: string
  score_equipamento: number | null
  geometry: object | null
}

interface GapsRow {
  distribuidora: string | null
  municipio: string | null
  uf: string | null
  comprimento_km: number | null
  score_vulnerabilidade: number | null
  geometry: object | null
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const detalheParamsSchema = {
  params: {
    type: 'object',
    required: ['municipio'],
    properties: {
      municipio: { type: 'string', minLength: 1 },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      distribuidora: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

const gapsSchema = {
  querystring: {
    type: 'object',
    properties: {
      uf: { type: 'string' },
      distribuidora: { type: 'string' },
      score_min: { type: 'number', default: 30 },
      limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
    },
    additionalProperties: false,
  },
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFeatureCollection<T extends { geometry: object | null }>(rows: T[]): object {
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => {
      const { geometry, ...properties } = row
      return { type: 'Feature' as const, geometry: geometry ?? null, properties }
    }),
  }
}

function calcTendencia(mediaRecente: number | null, mediaAnterior: number | null): string {
  if (mediaRecente == null || mediaAnterior == null) return 'estavel'
  if (mediaRecente > mediaAnterior + 2) return 'piorando'
  if (mediaRecente < mediaAnterior - 2) return 'melhorando'
  return 'estavel'
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const municipioRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * GET /api/municipio/:municipio/detalhe
   *
   * Returns a rich detail panel for a given municipality including:
   * risk scores, infrastructure stats, protection coverage, social context,
   * and 12-month score history.
   */
  fastify.get(
    '/municipio/:municipio/detalhe',
    { schema: detalheParamsSchema },
    async (
      request: FastifyRequest<{
        Params: { municipio: string }
        Querystring: { distribuidora?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const { municipio } = request.params
      const { distribuidora } = request.query

      const distFilter = distribuidora
        ? `AND distribuidora ILIKE '%' || $2 || '%'`
        : ''
      const distParam = distribuidora ? [municipio, distribuidora] : [municipio]

      // 1. Base risk data
      const riscoSql = `
        SELECT municipio, distribuidora, uf, score_risco, dec_medio_12m,
               ratio_dec, meses_violacao
        FROM mapa_risco
        WHERE municipio = $1 ${distFilter}
        ORDER BY score_risco DESC NULLS LAST
        LIMIT 1
      `
      const riscoResult = await pgPool.query<DetalheRow>(riscoSql, distParam)
      const risco = riscoResult.rows[0]

      if (!risco) {
        return reply.status(404).send({ error: 'Município não encontrado' })
      }

      const dist = risco.distribuidora

      // 2. Infrastructure stats
      const infraSql = `
        SELECT
          ROUND(COALESCE((
            SELECT SUM(comprimento) FROM rede_mt
            WHERE municipio = $1 AND distribuidora = $2
          ) / 1000.0, 0)::numeric, 1) AS comprimento_mt_km,
          ROUND(COALESCE((
            SELECT SUM(comprimento) FROM rede_bt
            WHERE municipio = $1 AND distribuidora = $2
          ) / 1000.0, 0)::numeric, 1) AS comprimento_bt_km,
          (SELECT COUNT(*) FROM transformadores
           WHERE municipio = $1 AND distribuidora = $2)::text AS n_transformadores,
          ROUND(COALESCE((
            SELECT SUM(potencia_nom) FROM transformadores
            WHERE municipio = $1 AND distribuidora = $2
          ), 0)::numeric, 0) AS potencia_total_kva,
          ROUND(COALESCE((
            SELECT AVG(EXTRACT(YEAR FROM AGE(NOW(), data_implant)))
            FROM rede_mt
            WHERE municipio = $1 AND distribuidora = $2 AND data_implant IS NOT NULL
          ), 0)::numeric, 1) AS idade_media_anos,
          (SELECT COUNT(*) FROM transformadores
           WHERE municipio = $1 AND distribuidora = $2
             AND EXTRACT(YEAR FROM AGE(NOW(), data_implant)) > 25)::text AS transformadores_criticos
      `
      const infraResult = await pgPool.query<InfraRow>(infraSql, [municipio, dist])
      const infra = infraResult.rows[0]

      // 3. Protection coverage
      const protecaoSql = `
        SELECT
          (SELECT COUNT(*) FROM religadores
           WHERE municipio = $1 AND distribuidora = $2)::text AS n_religadores,
          (SELECT COUNT(*) FROM chaves
           WHERE municipio = $1 AND distribuidora = $2)::text AS n_chaves,
          ROUND(COALESCE((
            SELECT SUM(comprimento_km) FROM gaps_protecao
            WHERE municipio = $1 AND distribuidora = $2
          ), 0)::numeric, 1) AS km_sem_protecao
      `
      const protecaoResult = await pgPool.query<ProtecaoRow>(protecaoSql, [municipio, dist])
      const protecao = protecaoResult.rows[0]

      // 4. Social context
      const socialSql = `
        SELECT pop.populacao, pop.domicilios, pop.pib_per_capita, pop.area_km2
        FROM ibge_populacao pop
        JOIN ibge_municipios im ON im.codigo_ibge = pop.codigo_ibge
        WHERE lower(unaccent(im.nome)) = lower(unaccent($1))
          AND im.uf = $2
        LIMIT 1
      `
      const socialResult = await pgPool.query<SocialRow>(socialSql, [municipio, risco.uf])
      const social = socialResult.rows[0] ?? null

      // 5. Historical scores (last 12 months)
      const historSql = `
        SELECT ano, mes, score_risco, dec_medio
        FROM historico_score
        WHERE municipio = $1 AND distribuidora = $2
        ORDER BY ano DESC, mes DESC
        LIMIT 12
      `
      const historResult = await pgPool.query<HistoricoRow>(historSql, [municipio, dist])
      const historico = historResult.rows.reverse() // chronological order

      // 6. Trend: compare last 3 vs previous 3 months
      const tendenciaSql = `
        WITH ultimos_6 AS (
          SELECT score_risco,
            ROW_NUMBER() OVER (ORDER BY ano DESC, mes DESC) AS rn
          FROM historico_score
          WHERE municipio = $1 AND distribuidora = $2
        )
        SELECT
          AVG(score_risco) FILTER (WHERE rn <= 3)         AS media_recente,
          AVG(score_risco) FILTER (WHERE rn BETWEEN 4 AND 6) AS media_anterior
        FROM ultimos_6
      `
      const tendResult = await pgPool.query(tendenciaSql, [municipio, dist])
      const tRow = tendResult.rows[0]
      const mediaRecente = tRow?.media_recente != null ? parseFloat(tRow.media_recente) : null
      const mediaAnterior = tRow?.media_anterior != null ? parseFloat(tRow.media_anterior) : null
      const tendencia = calcTendencia(mediaRecente, mediaAnterior)

      // Compute protection coverage %
      const kmMt = parseFloat(infra?.comprimento_mt_km ?? '0') || 0
      const kmSemProt = parseFloat(protecao?.km_sem_protecao ?? '0') || 0
      const coberturaPct = kmMt > 0 ? Math.max(0, Math.round((1 - kmSemProt / kmMt) * 100)) : null

      const densidade =
        social?.populacao != null && social?.area_km2 != null && social.area_km2 > 0
          ? Math.round(social.populacao / social.area_km2)
          : null

      return reply.send({
        municipio: risco.municipio,
        distribuidora: risco.distribuidora,
        uf: risco.uf,
        score_risco: risco.score_risco,
        dec_medio_12m: risco.dec_medio_12m,
        dec_limite: 12.0, // standard ANEEL limit
        ratio_dec: risco.ratio_dec,
        meses_violacao: risco.meses_violacao,
        tendencia,
        rede: {
          comprimento_mt_km: parseFloat(infra?.comprimento_mt_km ?? '0'),
          comprimento_bt_km: parseFloat(infra?.comprimento_bt_km ?? '0'),
          n_transformadores: parseInt(infra?.n_transformadores ?? '0', 10),
          potencia_total_kva: parseFloat(infra?.potencia_total_kva ?? '0'),
          idade_media_anos: parseFloat(infra?.idade_media_anos ?? '0'),
          transformadores_criticos: parseInt(infra?.transformadores_criticos ?? '0', 10),
        },
        protecao: {
          n_religadores: parseInt(protecao?.n_religadores ?? '0', 10),
          n_chaves: parseInt(protecao?.n_chaves ?? '0', 10),
          cobertura_pct: coberturaPct,
          km_sem_protecao: kmSemProt,
        },
        social: {
          populacao: social?.populacao ?? null,
          domicilios: social?.domicilios ?? null,
          densidade_hab_km2: densidade,
          pib_per_capita: social?.pib_per_capita ?? null,
        },
        historico: historico.map((h) => ({
          ano: h.ano,
          mes: h.mes,
          score_risco: h.score_risco,
          dec_medio: h.dec_medio,
        })),
      })
    },
  )

  /**
   * GET /api/municipio/:municipio/transformadores-aging
   *
   * Returns transformers ordered by criticality (age + distance from recloser).
   * Response is a GeoJSON FeatureCollection.
   */
  fastify.get(
    '/municipio/:municipio/transformadores-aging',
    { schema: detalheParamsSchema },
    async (
      request: FastifyRequest<{
        Params: { municipio: string }
        Querystring: { distribuidora?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const { municipio } = request.params
      const { distribuidora } = request.query

      const distFilter = distribuidora ? `AND t.distribuidora ILIKE '%' || $2 || '%'` : ''
      const params = distribuidora ? [municipio, distribuidora] : [municipio]

      const sql = `
        SELECT
          t.cod_id,
          t.potencia_nom,
          t.fabricante,
          EXTRACT(YEAR FROM AGE(NOW(), t.data_implant))::int AS idade_anos,
          GREATEST(0, 30 - EXTRACT(YEAR FROM AGE(NOW(), t.data_implant))::int) AS vida_util_restante_anos,
          CASE
            WHEN EXTRACT(YEAR FROM AGE(NOW(), t.data_implant)) > 25 THEN 'critico'
            WHEN EXTRACT(YEAR FROM AGE(NOW(), t.data_implant)) > 20 THEN 'atencao'
            ELSE 'ok'
          END AS status,
          ROUND(
            (
              LEAST(EXTRACT(YEAR FROM AGE(NOW(), t.data_implant)) / 30.0, 1.0) * 60
              + CASE
                  WHEN NOT EXISTS (SELECT 1 FROM religadores WHERE distribuidora = t.distribuidora) THEN 40
                  ELSE LEAST(
                    (SELECT ST_Distance(t.geom::geography, rel.geom::geography)
                     FROM religadores rel WHERE rel.distribuidora = t.distribuidora
                     ORDER BY t.geom <-> rel.geom LIMIT 1) / 2000.0,
                    1.0
                  ) * 40
                END
            )::numeric,
            1
          ) AS score_equipamento,
          ST_AsGeoJSON(ST_Transform(t.geom, 4326))::json AS geometry
        FROM transformadores t
        WHERE t.municipio = $1 ${distFilter}
        ORDER BY score_equipamento DESC
        LIMIT 500
      `

      const result = await pgPool.query<TransformadorAgingRow>(sql, params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )

  /**
   * GET /api/gaps-protecao
   *
   * Returns protection gaps as a GeoJSON FeatureCollection.
   * Optional filters: uf, distribuidora, score_min, limit.
   */
  fastify.get(
    '/gaps-protecao',
    { schema: gapsSchema },
    async (
      request: FastifyRequest<{
        Querystring: {
          uf?: string
          distribuidora?: string
          score_min?: number
          limit?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      const { uf, distribuidora, score_min = 30, limit = 200 } = request.query

      const conditions: string[] = ['score_vulnerabilidade >= $1']
      const params: unknown[] = [score_min]
      let idx = 2

      if (uf) {
        conditions.push(`uf = $${idx}`)
        params.push(uf.toUpperCase())
        idx++
      }

      if (distribuidora) {
        conditions.push(`distribuidora ILIKE $${idx}`)
        params.push(`%${distribuidora}%`)
        idx++
      }

      params.push(limit)

      const sql = `
        SELECT
          distribuidora,
          municipio,
          uf,
          comprimento_km,
          score_vulnerabilidade,
          ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM gaps_protecao
        WHERE ${conditions.join(' AND ')}
        ORDER BY score_vulnerabilidade DESC
        LIMIT $${idx}
      `

      const result = await pgPool.query<GapsRow>(sql, params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )
}
