import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { pgPool } from '../db'
import { loadScopeRegulatoryContext } from '../lib/continuityContext'
import {
  buildDataModePayload,
  ConfidenceStatus,
  CoverageStatus,
  DATA_REFERENCES,
  derivedPublicMeta,
  observedPublicMeta,
  PARTNER_READY,
  regulatoryContextMeta,
  SYSTEM_DATA_MODE,
  unavailableMeta,
} from '../lib/dataMode'
import { withResponseCache } from '../lib/responseCache'

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

interface RankingMunicipioRow {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
  dec_medio_12m: number | null
  meses_violacao: number | null
  idade_media_anos: number | null
  populacao: number | null
  km_sem_protecao: number | null
  n_transformadores_criticos: number | null
  tendencia: string | null
}

interface RankingAlimentadorRow {
  cod_id: string
  distribuidora: string
  uf: string
  subestacao_id: string | null
  tensao_nom: number | null
  municipios_atendidos: string[] | null
  km_mt: number | null
  km_bt: number | null
  n_transformadores: number | null
  n_religadores: number | null
  n_chaves: number | null
  km_gap_severo: number | null
  n_gaps_severos: number | null
  densidade_religadores_km: number | null
  densidade_chaves_km: number | null
  clientes_bt_total: number | null
  clientes_mt_total: number | null
  clientes_total: number | null
  clientes_gap_severo_total: number | null
  max_dist_religador_km: number | null
  max_dist_equipamento_auto_km: number | null
  max_dist_manobra_km: number | null
  max_dist_transferencia_km: number | null
  km_gap_transferencia: number | null
  km_por_equipamento_auto: number | null
  metodologia_gap: string | null
  lacunas: string[] | null
  municipios_count: number | null
}

interface KpisRow {
  alimentadores_monitorados: string
  alimentadores_com_gap_severo: string
  km_mt_total: string | null
  densidade_media_automacao: string | null
  subestacoes_total: string
  km_gap_severo_total: string | null
  clientes_gap_severo_total: string | null
  alimentadores_com_exposicao_disponivel: string
  clientes_bt_total: string | null
  clientes_mt_total: string | null
}

interface KpisAtRow {
  circuitos_at: string
  km_at_total: string | null
  transformadores_at: string
  religadores_at: string
  chaves_at: string
  clientes_at: string
  geracao_at: string
  geracao_mt: string
  geracao_bt: string
  subestacoes_com_estrutura: string
  componentes_subestacao_total: string
}

interface TopSubestacaoAtRow {
  subestacao_id: string
  feeders_mt: string
  circuitos_at: string
  componentes_estrutura: string
}

interface ContextoRegulatorioResponse {
  dec_medio_municipal_12m: number | null
  fec_medio_municipal_12m: number | null
  municipios_com_violacao_dec: number
  municipios_com_violacao_fec: number
  municipios_com_continuidade: number
  competencia_max: string | null
}

interface RankingAlimentadorResponseRow extends RankingAlimentadorRow {
  metricas_metadata: {
    infraestrutura: ReturnType<typeof observedPublicMeta>
    clientes: ReturnType<typeof observedPublicMeta> | ReturnType<typeof unavailableMeta>
    exposicao_publica: ReturnType<typeof derivedPublicMeta> | ReturnType<typeof unavailableMeta>
    contexto_regulatorio: ReturnType<typeof regulatoryContextMeta>
    partner_operacao: ReturnType<typeof unavailableMeta>
  }
}

interface DisponibilidadeCountsRow {
  municipios_com_score: string
  historico_meses_max: string
  possui_data_implant_mt: boolean
  alimentadores_count: string
  alimentador_metricas_count: string
  subestacoes_count: string
  rede_mt_count: string
  rede_bt_count: string
  transformadores_count: string
  religadores_count: string
  chaves_count: string
  gaps_severos_mt_count: string
  ucbt_count: string
  ucmt_count: string
  alimentadores_at_count: string
  rede_at_count: string
  transformadores_at_count: string
  religadores_at_count: string
  chaves_at_count: string
  ucat_count: string
  ug_at_count: string
  ug_mt_count: string
  ug_bt_count: string
  chaves_bt_count: string
  regulacao_reativos_count: string
  equipamentos_tecnicos_count: string
  subestacao_componentes_total_count: string
  bar_count: string
  base_count: string
  bay_count: string
  be_count: string
}

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

const rankingAlimentadoresSchema = {
  querystring: {
    type: 'object',
    properties: {
      distribuidora: { type: 'string' },
      uf: { type: 'string' },
      municipio: { type: 'string' },
      order_by: {
        type: 'string',
        enum: ['max_dist_equipamento_auto_km', 'max_dist_religador_km', 'max_dist_manobra_km', 'max_dist_transferencia_km', 'km_por_equipamento_auto', 'clientes_gap_severo_total', 'n_transformadores', 'km_mt'],
        default: 'max_dist_equipamento_auto_km',
      },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
    },
    additionalProperties: false,
  },
} as const

const disponibilidadeSchema = {
  querystring: {
    type: 'object',
    properties: {
      uf: { type: 'string' },
      distribuidora: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

const kpisSchema = {
  querystring: {
    type: 'object',
    properties: {
      distribuidora: { type: 'string' },
      uf: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

const kpisAtSchema = {
  querystring: {
    type: 'object',
    properties: {
      distribuidora: { type: 'string' },
      uf: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

const contextoRegulatorioSchema = {
  querystring: {
    type: 'object',
    properties: {
      distribuidora: { type: 'string' },
      uf: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

const SUPPORTED_REAL_UFS = [
  { uf: 'AL', nome: 'Alagoas', distribuidora: 'Equatorial Alagoas' },
  { uf: 'CE', nome: 'Ceará', distribuidora: 'Enel Ceará' },
] as const

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

function toInt(value: string | null | undefined): number {
  return Number.parseInt(value ?? '0', 10) || 0
}

function toFloat(value: string | null | undefined): number | null {
  if (value == null) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function buildLayerAvailability(count: number, emptyReason: string) {
  return {
    enabled: count > 0,
    count,
    reason: count > 0 ? null : emptyReason,
  }
}

function inferCoverageStatus(lacunas: string[] = []): CoverageStatus {
  if (lacunas.length === 0) return 'complete'
  return lacunas.includes('exposicao_clientes_gap_indisponivel') ? 'insufficient' : 'partial'
}

function inferConfidenceStatus(lacunas: string[] = []): ConfidenceStatus {
  if (lacunas.length === 0) return 'high'
  return lacunas.includes('exposicao_clientes_gap_indisponivel') ? 'low' : 'medium'
}

function buildRankingMetricMetadata(row: RankingAlimentadorRow): RankingAlimentadorResponseRow['metricas_metadata'] {
  const lacunas = row.lacunas ?? []
  const coverage = inferCoverageStatus(lacunas)
  const confidence = inferConfidenceStatus(lacunas)

  return {
    infraestrutura: observedPublicMeta(DATA_REFERENCES.bdgd, 'complete', 'high', []),
    clientes:
      row.clientes_total == null
        ? unavailableMeta('Clientes BT/MT indisponíveis no modo público atual.', ['clientes_publicos_indisponiveis'])
        : observedPublicMeta(DATA_REFERENCES.bdgd, coverage === 'insufficient' ? 'partial' : 'complete', coverage === 'insufficient' ? 'medium' : 'high', lacunas),
    exposicao_publica:
      row.clientes_gap_severo_total == null
        ? unavailableMeta('Exposição de clientes em gap severo indisponível para este alimentador no modo público atual.', ['exposicao_clientes_gap_indisponivel'])
        : derivedPublicMeta(DATA_REFERENCES.publicDerived, coverage, confidence, lacunas),
    contexto_regulatorio: regulatoryContextMeta(DATA_REFERENCES.continuity, 'complete', 'high', []),
    partner_operacao: unavailableMeta('OMS, carga medida e recomposição real dependem da futura integração privada com a distribuidora.', [
      'partner_oms_indisponivel',
      'partner_carga_medida_indisponivel',
      'partner_recomposicao_real_indisponivel',
    ]),
  }
}

async function loadUfDisponibilidade(uf: string, distribuidora: string) {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM mapa_risco WHERE uf = $1 AND distribuidora = $2) AS municipios_com_score,
      (
        SELECT COUNT(DISTINCT (ano * 100 + mes))
        FROM historico_score
        WHERE uf = $1 AND distribuidora = $2
      ) AS historico_meses_max,
      EXISTS(
        SELECT 1
        FROM rede_mt
        WHERE uf = $1 AND distribuidora = $2 AND data_implant IS NOT NULL
      ) AS possui_data_implant_mt,
      (
        SELECT COUNT(*)
        FROM alimentadores
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS alimentadores_count,
      (
        SELECT COUNT(*)
        FROM alimentador_metricas
        WHERE uf = $1 AND distribuidora = $2
      ) AS alimentador_metricas_count,
      (
        SELECT COUNT(*)
        FROM subestacoes
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS subestacoes_count,
      (
        SELECT COUNT(*)
        FROM rede_mt
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS rede_mt_count,
      (
        SELECT COUNT(*)
        FROM rede_bt
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS rede_bt_count,
      (
        SELECT COUNT(*)
        FROM transformadores
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS transformadores_count,
      (
        SELECT COUNT(*)
        FROM religadores
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS religadores_count,
      (
        SELECT COUNT(*)
        FROM chaves
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS chaves_count,
      (
        SELECT COUNT(*)
        FROM gaps_protecao
        WHERE uf = $1 AND distribuidora = $2 AND score_vulnerabilidade >= 20
      ) AS gaps_severos_mt_count,
      (
        SELECT COUNT(*)
        FROM ucbt
        WHERE uf = $1 AND distribuidora = $2
      ) AS ucbt_count,
      (
        SELECT COUNT(*)
        FROM ucmt
        WHERE uf = $1 AND distribuidora = $2
      ) AS ucmt_count
      ,
      (
        SELECT COUNT(*)
        FROM alimentadores_at
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS alimentadores_at_count,
      (
        SELECT COUNT(*)
        FROM rede_at
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS rede_at_count,
      (
        SELECT COUNT(*)
        FROM transformadores_at
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS transformadores_at_count,
      (
        SELECT COUNT(*)
        FROM religadores_at
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS religadores_at_count,
      (
        SELECT COUNT(*)
        FROM chaves_at
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS chaves_at_count,
      (
        SELECT COUNT(*)
        FROM ucat
        WHERE uf = $1 AND distribuidora = $2
      ) AS ucat_count,
      (
        SELECT COUNT(*)
        FROM ug_at
        WHERE uf = $1 AND distribuidora = $2
      ) AS ug_at_count,
      (
        SELECT COUNT(*)
        FROM ug_mt
        WHERE uf = $1 AND distribuidora = $2
      ) AS ug_mt_count,
      (
        SELECT COUNT(*)
        FROM ug_bt
        WHERE uf = $1 AND distribuidora = $2
      ) AS ug_bt_count,
      (
        SELECT COUNT(*)
        FROM chaves_bt
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS chaves_bt_count,
      (
        SELECT COUNT(*)
        FROM regulacao_reativos
        WHERE uf = $1 AND distribuidora = $2 AND geom IS NOT NULL
      ) AS regulacao_reativos_count,
      (
        SELECT COUNT(*)
        FROM equipamentos_tecnicos
        WHERE uf = $1 AND distribuidora = $2
      ) AS equipamentos_tecnicos_count,
      (
        SELECT COUNT(*)
        FROM subestacao_componentes
        WHERE uf = $1 AND distribuidora = $2
      ) AS subestacao_componentes_total_count,
      (
        SELECT COUNT(*)
        FROM subestacao_componentes
        WHERE uf = $1 AND distribuidora = $2 AND component_type = 'BAR' AND geom IS NOT NULL
      ) AS bar_count,
      (
        SELECT COUNT(*)
        FROM subestacao_componentes
        WHERE uf = $1 AND distribuidora = $2 AND component_type = 'BASE' AND geom IS NOT NULL
      ) AS base_count,
      (
        SELECT COUNT(*)
        FROM subestacao_componentes
        WHERE uf = $1 AND distribuidora = $2 AND component_type = 'BAY' AND geom IS NOT NULL
      ) AS bay_count,
      (
        SELECT COUNT(*)
        FROM subestacao_componentes
        WHERE uf = $1 AND distribuidora = $2 AND component_type = 'BE' AND geom IS NOT NULL
      ) AS be_count
  `

  const result = await pgPool.query<DisponibilidadeCountsRow>(sql, [uf, distribuidora])
  const row = result.rows[0]
  const municipiosComScore = toInt(row?.municipios_com_score)
  const historicoMesesMax = toInt(row?.historico_meses_max)
  const possuiDataImplantMt = Boolean(row?.possui_data_implant_mt)
  const camadas = {
    alimentadores: buildLayerAvailability(toInt(row?.alimentadores_count), 'Sem alimentadores geoespaciais validados para a UF.'),
    alimentador_metricas: buildLayerAvailability(toInt(row?.alimentador_metricas_count), 'Sem métricas operacionais por alimentador para a UF.'),
    subestacoes: buildLayerAvailability(toInt(row?.subestacoes_count), 'Sem subestações geoespaciais validadas para a UF.'),
    rede_mt: buildLayerAvailability(toInt(row?.rede_mt_count), 'Sem rede MT geoespacial validada para a UF.'),
    rede_bt: buildLayerAvailability(toInt(row?.rede_bt_count), 'Sem rede BT geoespacial validada para a UF.'),
    transformadores: buildLayerAvailability(toInt(row?.transformadores_count), 'Sem transformadores geoespaciais validados para a UF.'),
    religadores: buildLayerAvailability(toInt(row?.religadores_count), 'Sem religadores geoespaciais validados para a UF.'),
    chaves: buildLayerAvailability(toInt(row?.chaves_count), 'Sem chaves geoespaciais validadas para a UF.'),
    gaps_severos_mt: buildLayerAvailability(toInt(row?.gaps_severos_mt_count), 'Nenhum gap severo identificado no corte atual.'),
    ucbt: buildLayerAvailability(toInt(row?.ucbt_count), 'Sem unidades consumidoras BT vinculadas por alimentador na UF.'),
    ucmt: buildLayerAvailability(toInt(row?.ucmt_count), 'Sem unidades consumidoras MT vinculadas por alimentador na UF.'),
    alimentadores_at: buildLayerAvailability(toInt(row?.alimentadores_at_count), 'Sem circuitos AT geoespaciais validados para a UF.'),
    rede_at: buildLayerAvailability(toInt(row?.rede_at_count), 'Sem rede AT geoespacial validada para a UF.'),
    transformadores_at: buildLayerAvailability(toInt(row?.transformadores_at_count), 'Sem transformadores AT geoespaciais validados para a UF.'),
    religadores_at: buildLayerAvailability(toInt(row?.religadores_at_count), 'Sem religadores AT geoespaciais validados para a UF.'),
    chaves_at: buildLayerAvailability(toInt(row?.chaves_at_count), 'Sem chaves AT geoespaciais validadas para a UF.'),
    ucat: buildLayerAvailability(toInt(row?.ucat_count), 'Sem clientes AT tabulares vinculados à UF.'),
    ug_at: buildLayerAvailability(toInt(row?.ug_at_count), 'Sem geração AT tabular vinculada à UF.'),
    ug_mt: buildLayerAvailability(toInt(row?.ug_mt_count), 'Sem geração MT tabular vinculada à UF.'),
    ug_bt: buildLayerAvailability(toInt(row?.ug_bt_count), 'Sem geração BT tabular vinculada à UF.'),
    chaves_bt: buildLayerAvailability(toInt(row?.chaves_bt_count), 'Sem chaves BT geoespaciais validadas para a UF.'),
    regulacao_reativos: buildLayerAvailability(toInt(row?.regulacao_reativos_count), 'Sem ativos de regulação/reativos geoespaciais validados para a UF.'),
    equipamentos_tecnicos: buildLayerAvailability(toInt(row?.equipamentos_tecnicos_count), 'Sem dicionários técnicos EQ* promovidos para a UF.'),
    bar: buildLayerAvailability(toInt(row?.bar_count), 'Sem barras de subestação georreferenciadas na UF.'),
    base: buildLayerAvailability(toInt(row?.base_count), 'Sem bases de subestação georreferenciadas na UF.'),
    bay: buildLayerAvailability(toInt(row?.bay_count), 'Sem bays de subestação georreferenciados na UF.'),
    be: buildLayerAvailability(toInt(row?.be_count), 'Sem elementos BE georreferenciados na UF.'),
    subestacao_componentes: buildLayerAvailability(toInt(row?.subestacao_componentes_total_count), 'Sem estrutura tipada de subestação na UF.'),
  }

  const feedReady =
    camadas.alimentadores.enabled
    && camadas.alimentador_metricas.enabled
    && camadas.rede_mt.enabled
    && camadas.transformadores.enabled

  const status =
    municipiosComScore === 0 ? 'indisponivel'
    : feedReady && historicoMesesMax >= 12 ? 'real'
    : 'parcial'

  return {
    uf,
    nome: SUPPORTED_REAL_UFS.find((item) => item.uf === uf)?.nome ?? uf,
    distribuidora,
    status,
    municipios_com_score: municipiosComScore,
    historico_meses_max: historicoMesesMax,
    possui_data_implant_mt: possuiDataImplantMt,
    camadas,
  }
}

const ALIMENTADOR_ORDER_SQL: Record<string, string> = {
  max_dist_equipamento_auto_km: 'am.max_dist_equipamento_auto_km DESC NULLS LAST, am.max_dist_religador_km DESC NULLS LAST, am.km_mt DESC NULLS LAST, am.cod_id ASC',
  max_dist_religador_km: 'am.max_dist_equipamento_auto_km DESC NULLS LAST, am.max_dist_religador_km DESC NULLS LAST, am.km_mt DESC NULLS LAST, am.cod_id ASC',
  max_dist_manobra_km: 'am.max_dist_manobra_km DESC NULLS LAST, am.max_dist_equipamento_auto_km DESC NULLS LAST, am.cod_id ASC',
  max_dist_transferencia_km: 'am.max_dist_transferencia_km DESC NULLS LAST, am.max_dist_equipamento_auto_km DESC NULLS LAST, am.cod_id ASC',
  km_por_equipamento_auto: 'km_por_equipamento_auto DESC NULLS LAST, am.max_dist_equipamento_auto_km DESC NULLS LAST, am.cod_id ASC',
  clientes_gap_severo_total: 'am.clientes_gap_severo_total DESC NULLS LAST, am.max_dist_equipamento_auto_km DESC NULLS LAST, am.cod_id ASC',
  n_transformadores: 'am.n_transformadores DESC NULLS LAST, am.max_dist_equipamento_auto_km DESC NULLS LAST, am.cod_id ASC',
  km_mt: 'am.km_mt DESC NULLS LAST, am.max_dist_equipamento_auto_km DESC NULLS LAST, am.cod_id ASC',
}

export const riscoRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    '/disponibilidade-uf',
    { schema: disponibilidadeSchema },
    async (
      request: FastifyRequest<{
        Querystring: { uf?: string; distribuidora?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const requestedUf = request.query.uf?.toUpperCase()
      const requestedDistribuidora = request.query.distribuidora
      const cacheKey = `disponibilidade-uf:${requestedUf ?? 'all'}:${requestedDistribuidora ?? 'default'}`

      if (requestedUf) {
        const support = SUPPORTED_REAL_UFS.find((item) => item.uf === requestedUf)
        if (!support) {
          return reply.status(404).send({ error: 'UF fora do escopo real suportado' })
        }

        const payload = await withResponseCache(cacheKey, async () => ({
          ...(await loadUfDisponibilidade(requestedUf, requestedDistribuidora ?? support.distribuidora)),
          data_mode: SYSTEM_DATA_MODE,
          partner_ready: PARTNER_READY,
        }))
        return reply.send(payload)
      }

      const payload = await withResponseCache(cacheKey, async () => {
        const responses = await Promise.all(
          SUPPORTED_REAL_UFS.map((support) =>
            loadUfDisponibilidade(support.uf, requestedDistribuidora ?? support.distribuidora),
          ),
        )
        return {
        data_mode: SYSTEM_DATA_MODE,
        partner_ready: PARTNER_READY,
        data: responses,
        }
      })
      return reply.send(payload)
    },
  )

  fastify.get('/data-mode', async (_request, reply) => reply.send(buildDataModePayload()))

  fastify.get(
    '/kpis-at',
    { schema: kpisAtSchema },
    async (
      request: FastifyRequest<{
        Querystring: { distribuidora?: string; uf?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const cacheKey = `kpis-at:${request.query.uf ?? 'all'}:${request.query.distribuidora ?? 'all'}`
      const payload = await withResponseCache(cacheKey, async () => {
      const circuitoScope = buildFilters(undefined, request.query.distribuidora, request.query.uf)
      const redeScope = buildFilters(undefined, request.query.distribuidora, request.query.uf)
      const trafosScope = buildFilters(undefined, request.query.distribuidora, request.query.uf)
      const religadoresScope = buildFilters(undefined, request.query.distribuidora, request.query.uf)
      const chavesScope = buildFilters(undefined, request.query.distribuidora, request.query.uf)
      const componentesScope = buildFilters(undefined, request.query.distribuidora, request.query.uf)
      const topScope = buildFilters('a', request.query.distribuidora, request.query.uf)

      const [
        circuitosResult,
        redeResult,
        trafosResult,
        religadoresResult,
        chavesResult,
        clientesAtResult,
        geracaoAtResult,
        geracaoMtResult,
        geracaoBtResult,
        componentesResult,
        topResult,
      ] = await Promise.all([
        pgPool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM alimentadores_at ${circuitoScope.where}`, circuitoScope.params),
        pgPool.query<{ total: string | null }>(`SELECT ROUND((COALESCE(SUM(comprimento), 0) / 1000.0)::numeric, 1)::text AS total FROM rede_at ${redeScope.where}`, redeScope.params),
        pgPool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM transformadores_at ${trafosScope.where}`, trafosScope.params),
        pgPool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM religadores_at ${religadoresScope.where}`, religadoresScope.params),
        pgPool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM chaves_at ${chavesScope.where}`, chavesScope.params),
        pgPool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM ucat ${circuitoScope.where}`, circuitoScope.params),
        pgPool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM ug_at ${circuitoScope.where}`, circuitoScope.params),
        pgPool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM ug_mt ${circuitoScope.where}`, circuitoScope.params),
        pgPool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM ug_bt ${circuitoScope.where}`, circuitoScope.params),
        pgPool.query<KpisAtRow>(
          `
            SELECT
              COUNT(*)::text AS componentes_subestacao_total,
              (COUNT(DISTINCT subestacao_id) FILTER (WHERE subestacao_id IS NOT NULL))::text AS subestacoes_com_estrutura
            FROM subestacao_componentes
            ${componentesScope.where}
          `,
          componentesScope.params,
        ),
        pgPool.query<TopSubestacaoAtRow>(
          `
            SELECT
              a.subestacao_id,
              COUNT(*)::text AS feeders_mt,
              COALESCE((
                SELECT COUNT(*)::text
                FROM alimentadores_at at
                WHERE at.subestacao_id = a.subestacao_id
                  ${request.query.distribuidora ? 'AND at.distribuidora ILIKE $' + (topScope.params.length + 1) : ''}
                  ${request.query.uf ? 'AND at.uf = $' + (topScope.params.length + (request.query.distribuidora ? 2 : 1)) : ''}
              ), '0') AS circuitos_at,
              COALESCE((
                SELECT COUNT(*)::text
                FROM subestacao_componentes sc
                WHERE sc.subestacao_id = a.subestacao_id
                  ${request.query.distribuidora ? 'AND sc.distribuidora ILIKE $' + (topScope.params.length + 1) : ''}
                  ${request.query.uf ? 'AND sc.uf = $' + (topScope.params.length + (request.query.distribuidora ? 2 : 1)) : ''}
              ), '0') AS componentes_estrutura
            FROM alimentadores a
            ${topScope.where}
            ${topScope.where ? 'AND' : 'WHERE'} a.subestacao_id IS NOT NULL
            GROUP BY a.subestacao_id
            ORDER BY COUNT(*) DESC, a.subestacao_id ASC
            LIMIT 8
          `,
          [
            ...topScope.params,
            ...(request.query.distribuidora ? [`%${request.query.distribuidora}%`] : []),
            ...(request.query.uf ? [request.query.uf.toUpperCase()] : []),
          ],
        ),
      ])

      const row = componentesResult.rows[0]
      return {
        circuitos_at: toInt(circuitosResult.rows[0]?.total),
        km_at_total: toFloat(redeResult.rows[0]?.total),
        transformadores_at: toInt(trafosResult.rows[0]?.total),
        religadores_at: toInt(religadoresResult.rows[0]?.total),
        chaves_at: toInt(chavesResult.rows[0]?.total),
        clientes_at: toInt(clientesAtResult.rows[0]?.total),
        geracao_at: toInt(geracaoAtResult.rows[0]?.total),
        geracao_mt: toInt(geracaoMtResult.rows[0]?.total),
        geracao_bt: toInt(geracaoBtResult.rows[0]?.total),
        subestacoes_com_estrutura: toInt(row?.subestacoes_com_estrutura),
        componentes_subestacao_total: toInt(row?.componentes_subestacao_total),
        top_subestacoes_mt: topResult.rows.map((item) => ({
          subestacao_id: item.subestacao_id,
          feeders_mt: toInt(item.feeders_mt),
          circuitos_at: toInt(item.circuitos_at),
          componentes_estrutura: toInt(item.componentes_estrutura),
        })),
      }
      })
      return reply.send(payload)
    },
  )

  fastify.get(
    '/contexto-regulatorio',
    { schema: contextoRegulatorioSchema },
    async (
      request: FastifyRequest<{
        Querystring: { distribuidora?: string; uf?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const cacheKey = `contexto-regulatorio:${request.query.uf ?? 'all'}:${request.query.distribuidora ?? 'all'}`
      const payload = await withResponseCache(cacheKey, async () => {
      const contexto = await loadScopeRegulatoryContext(pgPool, {
        distribuidora: request.query.distribuidora,
        uf: request.query.uf,
      })

      const payload: ContextoRegulatorioResponse = {
        dec_medio_municipal_12m: contexto.dec_medio_municipal_12m,
        fec_medio_municipal_12m: contexto.fec_medio_municipal_12m,
        municipios_com_violacao_dec: contexto.municipios_com_violacao_dec,
        municipios_com_violacao_fec: contexto.municipios_com_violacao_fec,
        municipios_com_continuidade: contexto.municipios_com_continuidade,
        competencia_max: contexto.competencia_max,
      }

      return {
        ...payload,
        metricas_metadata: {
          contexto_regulatorio: regulatoryContextMeta(),
        },
      }
      })
      return reply.send(payload)
    },
  )

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
      const cacheKey = `mapa-risco:${uf ?? 'all'}:${distribuidora ?? 'all'}`
      const payload = await withResponseCache(cacheKey, async () => {
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
         AND im.uf = mr.uf
        ${where}
        ORDER BY mr.score_risco DESC NULLS LAST
      `

      const result = await pgPool.query<MapaRiscoRow>(sql, params)
      return {
        type: 'FeatureCollection',
        features: result.rows.map((row) => ({
          type: 'Feature',
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
        })),
      }
      })
      return reply.send(payload)
    },
  )

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
      const cacheKey = `ranking-municipios:${uf ?? 'all'}:${distribuidora ?? 'all'}:${page}:${limit}`
      const payload = await withResponseCache(cacheKey, async () => {
      const { where, params, nextIndex } = buildFilters('mr', distribuidora, uf)

      const countResult = await pgPool.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM mapa_risco mr ${where}`,
        params,
      )
      const total = toInt(countResult.rows[0]?.total)

      const sql = `
        WITH page_rows AS (
          SELECT
            mr.municipio,
            mr.distribuidora,
            mr.uf,
            mr.score_risco,
            mr.dec_medio_12m,
            mr.meses_violacao,
            mr.idade_media_anos,
            COALESCE(pop.populacao, 0) AS populacao
          FROM mapa_risco mr
          LEFT JOIN ibge_municipios im
            ON im.nome_norm = lower(unaccent(mr.municipio))
           AND im.uf = mr.uf
          LEFT JOIN ibge_populacao pop
            ON pop.codigo_ibge = im.codigo_ibge
          ${where}
          ORDER BY mr.score_risco DESC NULLS LAST
          LIMIT $${nextIndex} OFFSET $${nextIndex + 1}
        )
        SELECT
          pr.municipio,
          pr.distribuidora,
          pr.uf,
          pr.score_risco,
          pr.dec_medio_12m,
          pr.meses_violacao,
          pr.idade_media_anos,
          pr.populacao,
          COALESCE(gaps.km_sem_protecao, 0) AS km_sem_protecao,
          COALESCE(trafos.n_transformadores_criticos, 0) AS n_transformadores_criticos,
          COALESCE(hist.tendencia, 'estavel') AS tendencia
        FROM page_rows pr
        LEFT JOIN LATERAL (
          SELECT SUM(gp.comprimento_km) AS km_sem_protecao
            FROM gaps_protecao gp
          WHERE gp.municipio = pr.municipio
            AND gp.distribuidora = pr.distribuidora
            AND gp.uf = pr.uf
        ) gaps ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS n_transformadores_criticos
            FROM transformadores t
          WHERE t.municipio = pr.municipio
            AND t.distribuidora = pr.distribuidora
            AND t.uf = pr.uf
            AND EXTRACT(YEAR FROM AGE(NOW(), t.data_implant)) > 25
        ) trafos ON TRUE
        LEFT JOIN LATERAL (
          SELECT CASE
            WHEN AVG(hs.score_risco) FILTER (WHERE rn <= 3) >
                 AVG(hs.score_risco) FILTER (WHERE rn BETWEEN 4 AND 6) + 2
            THEN 'piorando'
            WHEN AVG(hs.score_risco) FILTER (WHERE rn <= 3) <
                 AVG(hs.score_risco) FILTER (WHERE rn BETWEEN 4 AND 6) - 2
            THEN 'melhorando'
            ELSE 'estavel'
          END AS tendencia
          FROM (
            SELECT
              hs2.score_risco,
              ROW_NUMBER() OVER (ORDER BY hs2.ano DESC, hs2.mes DESC) AS rn
            FROM historico_score hs2
            WHERE hs2.municipio = pr.municipio
              AND hs2.distribuidora = pr.distribuidora
              AND hs2.uf = pr.uf
          ) hs
        ) hist ON TRUE
        ORDER BY pr.score_risco DESC NULLS LAST
      `

      const result = await pgPool.query<RankingMunicipioRow>(sql, [...params, limit, offset])

      return {
        data: result.rows,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      }
      })
      return reply.send(payload)
    },
  )

  fastify.get(
    '/ranking-alimentadores',
    { schema: rankingAlimentadoresSchema },
    async (
      request: FastifyRequest<{
        Querystring: {
          distribuidora?: string
          uf?: string
          municipio?: string
          order_by?: keyof typeof ALIMENTADOR_ORDER_SQL
          page?: number
          limit?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      const page = request.query.page ?? 1
      const limit = request.query.limit ?? 20
      const offset = (page - 1) * limit
      const orderBy = request.query.order_by ?? 'max_dist_equipamento_auto_km'
      const orderBySql = ALIMENTADOR_ORDER_SQL[orderBy] ?? ALIMENTADOR_ORDER_SQL.max_dist_equipamento_auto_km
      const cacheKey = `ranking-alimentadores:${request.query.uf ?? 'all'}:${request.query.distribuidora ?? 'all'}:${request.query.municipio ?? 'all'}:${orderBy}:${page}:${limit}`
      const payload = await withResponseCache(cacheKey, async () => {

      const filters = buildFilters('am', request.query.distribuidora, request.query.uf)
      const conditions = filters.where ? [filters.where.replace(/^WHERE\s+/i, '')] : []
      const params = [...filters.params]
      let idx = filters.nextIndex

      if (request.query.municipio) {
        conditions.push(`EXISTS (
          SELECT 1
          FROM unnest(COALESCE(am.municipios_atendidos, ARRAY[]::text[])) AS m(nome)
          WHERE lower(unaccent(m.nome)) = lower(unaccent($${idx}))
        )`)
        params.push(request.query.municipio)
        idx++
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      const countResult = await pgPool.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM alimentador_metricas am ${whereClause}`,
        params,
      )
      const total = toInt(countResult.rows[0]?.total)

      const sql = `
        SELECT
          am.cod_id,
          am.distribuidora,
          am.uf,
          am.subestacao_id,
          am.tensao_nom,
          am.municipios_atendidos,
          am.km_mt,
          am.km_bt,
          am.n_transformadores,
          am.n_religadores,
          am.n_chaves,
          am.km_gap_severo,
          am.n_gaps_severos,
          am.densidade_religadores_km,
          am.densidade_chaves_km,
          am.clientes_bt_total,
          am.clientes_mt_total,
          am.clientes_total,
          am.clientes_gap_severo_total,
          am.max_dist_religador_km,
          am.max_dist_equipamento_auto_km,
          am.max_dist_manobra_km,
          am.max_dist_transferencia_km,
          am.km_gap_transferencia,
          am.metodologia_gap,
          am.lacunas,
          COALESCE(cardinality(am.municipios_atendidos), 0) AS municipios_count,
          ROUND(
            (am.km_mt / NULLIF(
              am.n_religadores + COALESCE((
                SELECT COUNT(*)::int FROM chaves c
                WHERE c.alimentador_id = am.cod_id
                  AND c.distribuidora = am.distribuidora
                  AND c.uf = am.uf
                  AND c.tipo_chave IN ('Tripsaver','Fusesaver','Chave Fusível Religadora','Disjuntor','Seccionalizador')
              ), 0),
              0
            ))::numeric, 1
          ) AS km_por_equipamento_auto
        FROM alimentador_metricas am
        ${whereClause}
        ORDER BY ${orderBySql}
        LIMIT $${idx} OFFSET $${idx + 1}
      `

      const result = await pgPool.query<RankingAlimentadorRow>(sql, [...params, limit, offset])
      return {
        data: result.rows.map<RankingAlimentadorResponseRow>((row) => ({
          ...row,
          km_por_equipamento_auto: toFloat(row.km_por_equipamento_auto as unknown as string),
          metricas_metadata: buildRankingMetricMetadata(row),
        })),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        order_by: orderBy,
        data_mode: SYSTEM_DATA_MODE,
      }
      })
      return reply.send(payload)
    },
  )

  fastify.get(
    '/kpis',
    { schema: kpisSchema },
    async (
      request: FastifyRequest<{
        Querystring: { distribuidora?: string; uf?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const cacheKey = `kpis:${request.query.uf ?? 'all'}:${request.query.distribuidora ?? 'all'}`
      const payload = await withResponseCache(cacheKey, async () => {
      const metricasScope = buildFilters('am', request.query.distribuidora, request.query.uf)
      const subestacoesScope = buildFilters('s', request.query.distribuidora, request.query.uf)
      const clientesBtScope = buildFilters('u', request.query.distribuidora, request.query.uf)
      const clientesMtScope = buildFilters('u', request.query.distribuidora, request.query.uf)

      const metricasSql = `
        SELECT
          COUNT(*)::text AS alimentadores_monitorados,
          COUNT(*) FILTER (WHERE COALESCE(am.n_gaps_severos, 0) > 0)::text AS alimentadores_com_gap_severo,
          ROUND(COALESCE(SUM(am.km_mt), 0)::numeric, 1) AS km_mt_total,
          ROUND(COALESCE(SUM(am.km_gap_severo_topologico), 0)::numeric, 1) AS km_gap_severo_total,
          ROUND(AVG(COALESCE(am.densidade_religadores_km, 0) + COALESCE(am.densidade_chaves_km, 0))::numeric, 4)
            AS densidade_media_automacao,
          COUNT(*) FILTER (WHERE am.clientes_gap_severo_total IS NOT NULL)::text AS alimentadores_com_exposicao_disponivel,
          CASE
            WHEN COUNT(am.clientes_gap_severo_total) FILTER (WHERE am.clientes_gap_severo_total IS NOT NULL) > 0
            THEN SUM(am.clientes_gap_severo_total)::text
            ELSE NULL
          END AS clientes_gap_severo_total
        FROM alimentador_metricas am
        ${metricasScope.where}
      `

      const subestacoesSql = `
        SELECT COUNT(DISTINCT s.cod_id)::text AS subestacoes_total
        FROM subestacoes s
        ${subestacoesScope.where}
      `

      const clientesBtSql = `
        SELECT CASE
          WHEN COUNT(*) > 0 THEN COUNT(*)::text
          ELSE NULL
        END AS clientes_bt_total
        FROM ucbt u
        ${clientesBtScope.where}
      `

      const clientesMtSql = `
        SELECT CASE
          WHEN COUNT(*) > 0 THEN COUNT(*)::text
          ELSE NULL
        END AS clientes_mt_total
        FROM ucmt u
        ${clientesMtScope.where}
      `

      const [metricasResult, subestacoesResult, clientesBtResult, clientesMtResult] = await Promise.all([
        pgPool.query<Omit<KpisRow, 'subestacoes_total' | 'clientes_bt_total' | 'clientes_mt_total'>>(metricasSql, metricasScope.params),
        pgPool.query<Pick<KpisRow, 'subestacoes_total'>>(subestacoesSql, subestacoesScope.params),
        pgPool.query<Pick<KpisRow, 'clientes_bt_total'>>(clientesBtSql, clientesBtScope.params),
        pgPool.query<Pick<KpisRow, 'clientes_mt_total'>>(clientesMtSql, clientesMtScope.params),
      ])

      const row = {
        ...(metricasResult.rows[0] ?? {}),
        ...(subestacoesResult.rows[0] ?? {}),
        ...(clientesBtResult.rows[0] ?? {}),
        ...(clientesMtResult.rows[0] ?? {}),
      } as KpisRow

      return {
        alimentadores_monitorados: toInt(row?.alimentadores_monitorados),
        alimentadores_com_gap_severo: toInt(row?.alimentadores_com_gap_severo),
        km_mt_total: toFloat(row?.km_mt_total),
        km_gap_severo_total: toFloat(row?.km_gap_severo_total),
        densidade_media_automacao: toFloat(row?.densidade_media_automacao),
        subestacoes_total: toInt(row?.subestacoes_total),
        clientes_gap_severo_total: row?.clientes_gap_severo_total != null ? toInt(row.clientes_gap_severo_total) : null,
        alimentadores_com_exposicao_disponivel: toInt(row?.alimentadores_com_exposicao_disponivel),
        clientes_bt_total: row?.clientes_bt_total != null ? toInt(row.clientes_bt_total) : null,
        clientes_mt_total: row?.clientes_mt_total != null ? toInt(row.clientes_mt_total) : null,
        metricas_metadata: {
          infraestrutura_publica: observedPublicMeta(DATA_REFERENCES.bdgd, 'complete', 'high', []),
          exposicao_publica: derivedPublicMeta(DATA_REFERENCES.publicDerived, 'partial', 'medium', []),
          contexto_regulatorio: regulatoryContextMeta(),
          partner_operacao: unavailableMeta('Carga medida, OMS e clientes interrompidos observados dependem de integração privada.'),
        },
      }
      })
      return reply.send(payload)
    },
  )

  void Promise.all([
    withResponseCache('disponibilidade-uf:all:default', async () => {
      const responses = await Promise.all(
        SUPPORTED_REAL_UFS.map((support) => loadUfDisponibilidade(support.uf, support.distribuidora)),
      )
      return {
        data_mode: SYSTEM_DATA_MODE,
        partner_ready: PARTNER_READY,
        data: responses,
      }
    }),
    ...SUPPORTED_REAL_UFS.map((support) =>
      withResponseCache(`disponibilidade-uf:${support.uf}:default`, async () => ({
        ...(await loadUfDisponibilidade(support.uf, support.distribuidora)),
        data_mode: SYSTEM_DATA_MODE,
        partner_ready: PARTNER_READY,
      })),
    ),
  ]).catch((error) => {
    fastify.log.warn({ error }, 'availability cache prewarm failed')
  })
}
