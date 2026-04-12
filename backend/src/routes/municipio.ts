import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { pgPool } from '../db'
import { buildTransformadorScoreSql, buildTransformadorStatusSql } from '../lib/equipmentRisk'
import { buildBboxIntersectSql, parseBbox } from '../lib/spatial'
import {
  loadMunicipioRegulatoryHistory,
  loadMunicipioRegulatorySummary,
} from '../lib/continuityContext'
import {
  DATA_REFERENCES,
  derivedPublicMeta,
  observedPublicMeta,
  regulatoryContextMeta,
  SYSTEM_DATA_MODE,
  unavailableMeta,
} from '../lib/dataMode'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DetalheRow {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
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

interface AlimentadorResumoRow {
  cod_id: string
  subestacao_id: string | null
  km_mt: number | null
  km_bt: number | null
  n_transformadores: number | null
  n_religadores: number | null
  km_gap_severo: number | null
  clientes_total: number | null
}

interface InfraAtResumoRow {
  km_at: string | null
  n_subestacoes: string
  n_transformadores_at: string
  n_religadores_at: string
  n_chaves_at: string
}

interface SubestacaoAtMunicipioRow {
  cod_id: string
  tensao_nom: number | null
  feeders_mt_relacionados: string
  circuitos_at_relacionados: string
}

interface CircuitoAtMunicipioRow {
  cod_id: string
  subestacao_id: string | null
  nome: string | null
  comprimento_km: number | null
  tensao_nom: number | null
}

interface ClientesGeracaoMunicipioRow {
  clientes_at: string
  geracao_at: string
  geracao_mt: string
  geracao_bt: string
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
  alimentador_id: string | null
  comprimento_km: number | null
  dist_religador_km: number | null
  dist_chave_km: number | null
  dist_equipamento_auto_km: number | null
  dist_manobra_km: number | null
  dist_transferencia_km: number | null
  score_vulnerabilidade: number | null
  score_recomposicao: number | null
  gap_religamento_auto: boolean | null
  gap_recomposicao: boolean | null
  gap_transferencia: boolean | null
  equipamentos_auto_considerados: string[] | null
  equipamentos_manobra_considerados: string[] | null
  equipamentos_transferencia_considerados: string[] | null
  clientes_bt_total: number | null
  clientes_mt_total: number | null
  clientes_total: number | null
  demanda_mt_total: number | null
  metodologia: string | null
  lacunas: string[] | null
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
      alimentador: { type: 'string' },
      bbox: { type: 'string', minLength: 7 },
      gap_tipo: {
        type: 'string',
        enum: ['auto', 'recomposicao', 'transferencia', 'ambos', 'operacional'],
        default: 'auto',
      },
      score_min: { type: 'number', default: 20 },
      limit: { type: 'integer', minimum: 1, maximum: 20000, default: 200 },
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

function buildMunicipioMetricMetadata(
  infraestruturaStatus: 'real' | 'parcial' | 'indisponivel',
  historicoStatus: 'completo' | 'parcial' | 'insuficiente',
  hasSocial: boolean,
  lacunas: string[],
) {
  return {
    score_risco: derivedPublicMeta(
      DATA_REFERENCES.publicDerived,
      infraestruturaStatus === 'real' ? 'complete' : 'partial',
      infraestruturaStatus === 'real' ? 'medium' : 'low',
      lacunas,
    ),
    continuidade: regulatoryContextMeta(
      DATA_REFERENCES.continuity,
      historicoStatus === 'completo' ? 'complete' : historicoStatus === 'parcial' ? 'partial' : 'insufficient',
      historicoStatus === 'completo' ? 'high' : historicoStatus === 'parcial' ? 'medium' : 'low',
      lacunas.filter((item) => item.startsWith('historico_')),
    ),
    infraestrutura:
      infraestruturaStatus === 'indisponivel'
        ? unavailableMeta('Infraestrutura pública indisponível para este município no modo atual.', ['infraestrutura_publica_indisponivel'])
        : observedPublicMeta(
          DATA_REFERENCES.bdgd,
          infraestruturaStatus === 'real' ? 'complete' : 'partial',
          infraestruturaStatus === 'real' ? 'high' : 'medium',
          lacunas.filter((item) => item === 'idade_rede_mt_indisponivel'),
        ),
    protecao:
      infraestruturaStatus === 'indisponivel'
        ? unavailableMeta('Proteção geoespacial indisponível para este município no modo atual.', ['protecao_publica_indisponivel'])
        : derivedPublicMeta(
          DATA_REFERENCES.publicDerived,
          infraestruturaStatus === 'real' ? 'complete' : 'partial',
          infraestruturaStatus === 'real' ? 'medium' : 'low',
          lacunas,
        ),
    social:
      hasSocial
        ? observedPublicMeta(DATA_REFERENCES.ibge, 'complete', 'high', [])
        : unavailableMeta('Contexto social do IBGE indisponível para este município no recorte atual.', ['contexto_social_indisponivel']),
    partner_operacao: unavailableMeta('OMS, carga medida e recomposição real dependem da futura integração privada com a distribuidora.', [
      'partner_oms_indisponivel',
      'partner_carga_medida_indisponivel',
      'partner_recomposicao_real_indisponivel',
    ]),
  }
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
        SELECT municipio, distribuidora, uf, score_risco
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
      const continuidade = await loadMunicipioRegulatorySummary(pgPool, municipio, dist)

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
          ROUND((
            SELECT AVG(EXTRACT(YEAR FROM AGE(NOW(), data_implant)))
            FROM rede_mt
            WHERE municipio = $1 AND distribuidora = $2 AND data_implant IS NOT NULL
          )::numeric, 1) AS idade_media_anos,
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

      const alimentadoresSql = `
        SELECT
          cod_id,
          subestacao_id,
          km_mt,
          km_bt,
          n_transformadores,
          n_religadores,
          km_gap_severo,
          clientes_total
        FROM alimentador_metricas
        WHERE $1 = ANY(municipios_atendidos)
          AND distribuidora = $2
          AND uf = $3
        ORDER BY km_gap_severo DESC NULLS LAST, km_mt DESC NULLS LAST, cod_id ASC
        LIMIT 12
      `
      const alimentadoresResult = await pgPool.query<AlimentadorResumoRow>(alimentadoresSql, [
        municipio,
        dist,
        risco.uf,
      ])

      const infraAtSql = `
        SELECT
          ROUND(COALESCE((
            SELECT SUM(comprimento)
            FROM rede_at
            WHERE municipio = $1 AND distribuidora = $2
          ) / 1000.0, 0)::numeric, 1) AS km_at,
          (SELECT COUNT(*) FROM subestacoes
           WHERE municipio = $1 AND distribuidora = $2)::text AS n_subestacoes,
          (SELECT COUNT(*) FROM transformadores_at
           WHERE municipio = $1 AND distribuidora = $2)::text AS n_transformadores_at,
          (SELECT COUNT(*) FROM religadores_at
           WHERE municipio = $1 AND distribuidora = $2)::text AS n_religadores_at,
          (SELECT COUNT(*) FROM chaves_at
           WHERE municipio = $1 AND distribuidora = $2)::text AS n_chaves_at
      `
      const infraAtResult = await pgPool.query<InfraAtResumoRow>(infraAtSql, [municipio, dist])

      const subestacoesAtSql = `
        SELECT
          s.cod_id,
          s.tensao_nom,
          COALESCE((
            SELECT COUNT(*)::text
            FROM alimentadores a
            WHERE a.subestacao_id = s.cod_id
              AND a.distribuidora = s.distribuidora
              AND a.uf = s.uf
          ), '0') AS feeders_mt_relacionados,
          COALESCE((
            SELECT COUNT(*)::text
            FROM alimentadores_at aa
            WHERE aa.subestacao_id = s.cod_id
              AND aa.distribuidora = s.distribuidora
              AND aa.uf = s.uf
          ), '0') AS circuitos_at_relacionados
        FROM subestacoes s
        WHERE s.municipio = $1 AND s.distribuidora = $2
        ORDER BY s.cod_id ASC
        LIMIT 12
      `
      const subestacoesAtResult = await pgPool.query<SubestacaoAtMunicipioRow>(subestacoesAtSql, [municipio, dist])

      const circuitosAtSql = `
        SELECT
          cod_id,
          subestacao_id,
          nome,
          comprimento_km,
          tensao_nom
        FROM alimentadores_at
        WHERE municipio = $1 AND distribuidora = $2
        ORDER BY comprimento_km DESC NULLS LAST, cod_id ASC
        LIMIT 12
      `
      const circuitosAtResult = await pgPool.query<CircuitoAtMunicipioRow>(circuitosAtSql, [municipio, dist])

      const clientesGeracaoResult = await pgPool.query<ClientesGeracaoMunicipioRow>(
        `
          SELECT
            (SELECT COUNT(*)::text FROM ucat WHERE municipio = $1 AND distribuidora = $2 AND uf = $3) AS clientes_at,
            (SELECT COUNT(*)::text FROM ug_at WHERE municipio = $1 AND distribuidora = $2 AND uf = $3) AS geracao_at,
            (SELECT COUNT(*)::text FROM ug_mt WHERE municipio = $1 AND distribuidora = $2 AND uf = $3) AS geracao_mt,
            (SELECT COUNT(*)::text FROM ug_bt WHERE municipio = $1 AND distribuidora = $2 AND uf = $3) AS geracao_bt
        `,
        [municipio, dist, risco.uf],
      )

      const historico = await loadMunicipioRegulatoryHistory(pgPool, municipio, dist)

      // 5. Trend: compare last 3 vs previous 3 months from the assembled history
      const orderedHistory = [...historico].reverse()
      const recent = orderedHistory.slice(0, 3)
      const previous = orderedHistory.slice(3, 6)
      const mediaRecente = recent.length > 0
        ? recent.reduce((sum, item) => sum + item.score_risco, 0) / recent.length
        : null
      const mediaAnterior = previous.length > 0
        ? previous.reduce((sum, item) => sum + item.score_risco, 0) / previous.length
        : null
      const tendencia = calcTendencia(mediaRecente, mediaAnterior)

      // Compute protection coverage %
      const kmMt = parseFloat(infra?.comprimento_mt_km ?? '0') || 0
      const kmBt = parseFloat(infra?.comprimento_bt_km ?? '0') || 0
      const nTransformadores = parseInt(infra?.n_transformadores ?? '0', 10)
      const nReligadores = parseInt(protecao?.n_religadores ?? '0', 10)
      const nChaves = parseInt(protecao?.n_chaves ?? '0', 10)
      const kmSemProt = parseFloat(protecao?.km_sem_protecao ?? '0') || 0
      const coberturaPct = kmMt > 0 ? Math.max(0, Math.round((1 - kmSemProt / kmMt) * 100)) : null
      const historicoStatus =
        historico.length >= 12 ? 'completo'
        : historico.length >= 6 ? 'parcial'
        : 'insuficiente'
      const possuiInfraestrutura = kmMt > 0 || kmBt > 0 || nTransformadores > 0 || nReligadores > 0 || nChaves > 0
      const lacunas: string[] = []

      if (toNullableNumber(infra?.idade_media_anos) == null) {
        lacunas.push('idade_rede_mt_indisponivel')
      }

      if (historicoStatus === 'parcial') {
        lacunas.push('historico_parcial')
      } else if (historicoStatus === 'insuficiente') {
        lacunas.push('historico_insuficiente')
      }

      const infraestruturaStatus =
        !possuiInfraestrutura ? 'indisponivel'
        : lacunas.includes('idade_rede_mt_indisponivel') ? 'parcial'
        : 'real'

      const densidade =
        social?.populacao != null && social?.area_km2 != null && social.area_km2 > 0
          ? Math.round(social.populacao / social.area_km2)
          : null
      const metricasMetadata = buildMunicipioMetricMetadata(infraestruturaStatus, historicoStatus, social != null, lacunas)

      return reply.send({
        data_mode: SYSTEM_DATA_MODE,
        municipio: risco.municipio,
        distribuidora: risco.distribuidora,
        uf: risco.uf,
        score_risco: risco.score_risco,
        dec_medio_12m: continuidade?.dec_medio_12m ?? null,
        dec_limite: continuidade?.dec_limite ?? null,
        ratio_dec: continuidade?.ratio_dec ?? null,
        meses_violacao: continuidade?.meses_violacao_dec ?? null,
        meses_violacao_dec: continuidade?.meses_violacao_dec ?? null,
        fec_medio_12m: continuidade?.fec_medio_12m ?? null,
        fec_limite: continuidade?.fec_limite ?? null,
        ratio_fec: continuidade?.ratio_fec ?? null,
        meses_violacao_fec: continuidade?.meses_violacao_fec ?? null,
        tendencia,
        rede: {
          comprimento_mt_km: kmMt,
          comprimento_bt_km: kmBt,
          n_transformadores: nTransformadores,
          potencia_total_kva: parseFloat(infra?.potencia_total_kva ?? '0'),
          idade_media_anos: toNullableNumber(infra?.idade_media_anos),
          transformadores_criticos: parseInt(infra?.transformadores_criticos ?? '0', 10),
        },
        protecao: {
          n_religadores: nReligadores,
          n_chaves: nChaves,
          cobertura_pct: coberturaPct,
          km_sem_protecao: kmSemProt,
        },
        social: {
          populacao: social?.populacao ?? null,
          domicilios: social?.domicilios ?? null,
          densidade_hab_km2: densidade,
          pib_per_capita: social?.pib_per_capita ?? null,
        },
        infraestrutura_at: {
          km_at: toNullableNumber(infraAtResult.rows[0]?.km_at),
          n_subestacoes: parseInt(infraAtResult.rows[0]?.n_subestacoes ?? '0', 10),
          n_transformadores_at: parseInt(infraAtResult.rows[0]?.n_transformadores_at ?? '0', 10),
          n_religadores_at: parseInt(infraAtResult.rows[0]?.n_religadores_at ?? '0', 10),
          n_chaves_at: parseInt(infraAtResult.rows[0]?.n_chaves_at ?? '0', 10),
          subestacoes: subestacoesAtResult.rows.map((item) => ({
            cod_id: item.cod_id,
            tensao_nom: item.tensao_nom,
            feeders_mt_relacionados: parseInt(item.feeders_mt_relacionados, 10) || 0,
            circuitos_at_relacionados: parseInt(item.circuitos_at_relacionados, 10) || 0,
          })),
          circuitos_at: circuitosAtResult.rows,
        },
        clientes_geracao: {
          clientes_at: parseInt(clientesGeracaoResult.rows[0]?.clientes_at ?? '0', 10),
          geracao_at: parseInt(clientesGeracaoResult.rows[0]?.geracao_at ?? '0', 10),
          geracao_mt: parseInt(clientesGeracaoResult.rows[0]?.geracao_mt ?? '0', 10),
          geracao_bt: parseInt(clientesGeracaoResult.rows[0]?.geracao_bt ?? '0', 10),
        },
        alimentadores: alimentadoresResult.rows,
        qualidade_dados: {
          infraestrutura_status: infraestruturaStatus,
          historico_meses_disponiveis: historico.length,
          historico_status: historicoStatus,
          lacunas,
        },
        historico: historico.map((h) => ({
          ano: h.ano,
          mes: h.mes,
          score_risco: h.score_risco,
          dec_medio: h.dec_medio,
          fec_medio: h.fec_medio,
        })),
        contexto_regulatorio: {
          competencia_max: continuidade?.competencia_max ?? null,
        },
        metricas_metadata: metricasMetadata,
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
      const scoreSql = buildTransformadorScoreSql('t')
      const statusSql = buildTransformadorStatusSql('t')

      const sql = `
        SELECT
          t.cod_id,
          t.potencia_nom,
          t.fabricante,
          EXTRACT(YEAR FROM AGE(NOW(), t.data_implant))::int AS idade_anos,
          GREATEST(0, 30 - EXTRACT(YEAR FROM AGE(NOW(), t.data_implant))::int) AS vida_util_restante_anos,
          ${statusSql} AS status,
          ${scoreSql} AS score_equipamento,
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
          alimentador?: string
          bbox?: string
          gap_tipo?: 'auto' | 'recomposicao' | 'transferencia' | 'ambos' | 'operacional'
          score_min?: number
          limit?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      const {
        uf,
        distribuidora,
        alimentador,
        bbox,
        gap_tipo = 'auto',
        score_min = 20,
        limit = 200,
      } = request.query

      let parsedBbox
      try {
        parsedBbox = parseBbox(bbox)
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : 'bbox inválido',
        })
      }

      const conditions: string[] = []
      const params: unknown[] = [score_min]
      let idx = 2

      if (gap_tipo === 'recomposicao') {
        conditions.push('COALESCE(score_recomposicao, 0) >= $1')
      } else if (gap_tipo === 'transferencia') {
        conditions.push('(gap_transferencia IS TRUE OR COALESCE(dist_transferencia_km, 0) >= ($1 / 10.0))')
      } else if (gap_tipo === 'ambos') {
        conditions.push('COALESCE(score_vulnerabilidade, 0) >= $1')
        conditions.push('COALESCE(score_recomposicao, 0) >= $1')
      } else if (gap_tipo === 'operacional') {
        conditions.push('(COALESCE(score_vulnerabilidade, 0) >= $1 OR COALESCE(score_recomposicao, 0) >= $1 OR gap_transferencia IS TRUE)')
      } else {
        conditions.push('COALESCE(score_vulnerabilidade, 0) >= $1')
      }

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

      if (alimentador) {
        conditions.push(`alimentador_id = $${idx}`)
        params.push(alimentador)
        idx++
      }

      if (parsedBbox) {
        conditions.push(buildBboxIntersectSql('geom', idx))
        params.push(parsedBbox.minLng, parsedBbox.minLat, parsedBbox.maxLng, parsedBbox.maxLat)
        idx += 4
      }

      params.push(limit)

      const orderSql = gap_tipo === 'recomposicao'
        ? 'score_recomposicao DESC NULLS LAST, score_vulnerabilidade DESC NULLS LAST'
        : gap_tipo === 'transferencia'
          ? 'dist_transferencia_km DESC NULLS LAST, score_recomposicao DESC NULLS LAST'
        : gap_tipo === 'operacional'
          ? 'GREATEST(COALESCE(score_vulnerabilidade, 0), COALESCE(score_recomposicao, 0), CASE WHEN gap_transferencia IS TRUE THEN 100 ELSE 0 END) DESC'
          : 'score_vulnerabilidade DESC NULLS LAST, score_recomposicao DESC NULLS LAST'

      const sql = `
        SELECT
          distribuidora,
          municipio,
          uf,
          alimentador_id,
          comprimento_km,
          dist_religador_km,
          dist_chave_km,
          dist_equipamento_auto_km,
          dist_manobra_km,
          dist_transferencia_km,
          score_vulnerabilidade,
          score_recomposicao,
          gap_religamento_auto,
          gap_recomposicao,
          gap_transferencia,
          equipamentos_auto_considerados,
          equipamentos_manobra_considerados,
          equipamentos_transferencia_considerados,
          clientes_bt_total,
          clientes_mt_total,
          clientes_total,
          demanda_mt_total,
          metodologia,
          lacunas,
          ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM segmentos_mt_topologicos
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderSql}
        LIMIT $${idx}
      `

      const result = await pgPool.query<GapsRow>(sql, params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )
}
