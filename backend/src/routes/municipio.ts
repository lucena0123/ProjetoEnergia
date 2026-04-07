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
  score_risco: number | string
  dec_medio: number | string | null
}

interface QualidadeRow {
  infraestrutura_sintetica: boolean
}

interface LimiteRow {
  dec_limite: string | null
}

interface TransformadorAgingRow {
  cod_id: string | null
  potencia_nom: number | string | null
  fabricante: string | null
  idade_anos: number | string | null
  vida_util_restante_anos: number | string | null
  status: string
  score_equipamento: number | string | null
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

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const parsed = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
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

      // 5. Continuity limit based on the last available 12 months
      const limiteSql = `
        SELECT ROUND(AVG(dec_limite)::numeric, 1) AS dec_limite
        FROM indicadores_continuidade
        WHERE municipio = $1
          AND distribuidora = $2
          AND (ano * 12 + mes) >= (
            SELECT MAX(ano * 12 + mes) - 11
            FROM indicadores_continuidade
            WHERE municipio = $1 AND distribuidora = $2
          )
      `
      const limiteResult = await pgPool.query<LimiteRow>(limiteSql, [municipio, dist])
      const decLimite = parseFloat(limiteResult.rows[0]?.dec_limite ?? '12') || 12

      // 6. Historical scores (rolling monthly score based on real DEC/FEC series)
      const historSql = `
        WITH monthly AS (
          SELECT
            ano,
            mes,
            dec_apurado,
            dec_limite,
            CASE WHEN violacao_dec THEN 1 ELSE 0 END AS violacao_dec
          FROM indicadores_continuidade
          WHERE municipio = $1 AND distribuidora = $2
        ),
        rolling AS (
          SELECT
            ano,
            mes,
            COUNT(*) OVER w AS pontos_janela,
            AVG(dec_apurado) OVER w AS dec_medio_12m,
            AVG(dec_limite) OVER w AS dec_limite_12m,
            SUM(violacao_dec) OVER w AS meses_violacao_12m
          FROM monthly
          WINDOW w AS (ORDER BY ano, mes ROWS BETWEEN 11 PRECEDING AND CURRENT ROW)
        ),
        idade_rede AS (
          SELECT COALESCE(AVG(EXTRACT(YEAR FROM AGE(NOW(), data_implant))), 20) AS idade_media_anos
          FROM rede_mt
          WHERE municipio = $1 AND distribuidora = $2 AND data_implant IS NOT NULL
        )
        SELECT
          r.ano,
          r.mes,
          ROUND((
            LEAST(
              CASE
                WHEN COALESCE(r.dec_limite_12m, 0) > 0
                THEN LEAST(r.dec_medio_12m / r.dec_limite_12m, 3.0) / 3.0
                ELSE 0
              END,
              1.0
            ) * 40
            + LEAST(COALESCE(r.meses_violacao_12m, 0)::float / 12.0, 1.0) * 30
            + LEAST(COALESCE(ir.idade_media_anos, 20) / 40.0, 1.0) * 30
          )::numeric, 2) AS score_risco,
          ROUND(r.dec_medio_12m::numeric, 2) AS dec_medio
        FROM rolling r
        CROSS JOIN idade_rede ir
        WHERE r.pontos_janela >= 3
        ORDER BY r.ano DESC, r.mes DESC
        LIMIT 12
      `
      const historResult = await pgPool.query<HistoricoRow>(historSql, [municipio, dist])
      const historico = historResult.rows.reverse() // chronological order

      // 7. Data quality flags
      const qualidadeSql = `
        SELECT (
          EXISTS(
            SELECT 1 FROM rede_mt
            WHERE municipio = $1 AND distribuidora = $2 AND cod_id ILIKE '%DEMO%'
          )
          OR EXISTS(
            SELECT 1 FROM transformadores
            WHERE municipio = $1 AND distribuidora = $2 AND cod_id ILIKE '%DEMO%'
          )
          OR EXISTS(
            SELECT 1 FROM religadores
            WHERE municipio = $1 AND distribuidora = $2 AND cod_id ILIKE '%DEMO%'
          )
          OR EXISTS(
            SELECT 1 FROM chaves
            WHERE municipio = $1 AND distribuidora = $2 AND cod_id ILIKE '%DEMO%'
          )
        ) AS infraestrutura_sintetica
      `
      const qualidadeResult = await pgPool.query<QualidadeRow>(qualidadeSql, [municipio, dist])
      const qualidade = qualidadeResult.rows[0]

      // 8. Trend: compare last 3 vs previous 3 months from the assembled history
      const orderedHistory = [...historico].reverse()
      const recent = orderedHistory.slice(0, 3)
      const previous = orderedHistory.slice(3, 6)
      const mediaRecente = recent.length > 0
        ? recent.reduce((sum, item) => sum + parseFloat(String(item.score_risco)), 0) / recent.length
        : null
      const mediaAnterior = previous.length > 0
        ? previous.reduce((sum, item) => sum + parseFloat(String(item.score_risco)), 0) / previous.length
        : null
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
        dec_limite: decLimite,
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
        qualidade_dados: {
          infraestrutura: qualidade?.infraestrutura_sintetica ? 'sintetica' : 'real',
          historico_meses_disponiveis: historico.length,
          historico_status:
            historico.length >= 12 ? 'completo'
            : historico.length >= 6 ? 'parcial'
            : 'insuficiente',
        },
        historico: historico.map((h) => ({
          ano: h.ano,
          mes: h.mes,
          score_risco: parseFloat(String(h.score_risco)),
          dec_medio: h.dec_medio != null ? parseFloat(String(h.dec_medio)) : null,
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
      const normalizedRows = result.rows.map((row) => ({
        ...row,
        potencia_nom: toNullableNumber(row.potencia_nom),
        idade_anos: toNullableNumber(row.idade_anos),
        vida_util_restante_anos: toNullableNumber(row.vida_util_restante_anos),
        score_equipamento: toNullableNumber(row.score_equipamento),
      }))

      return reply.send(toFeatureCollection(normalizedRows))
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
