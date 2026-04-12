import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { pgPool } from '../db'
import { loadMunicipiosRegulatoryContext } from '../lib/continuityContext'
import {
  DATA_REFERENCES,
  derivedPublicMeta,
  observedPublicMeta,
  regulatoryContextMeta,
  SYSTEM_DATA_MODE,
  unavailableMeta,
} from '../lib/dataMode'

interface AlimentadorMetricasRow {
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
  n_ucbt: number | null
  n_ucmt: number | null
  clientes_bt_total: number | null
  clientes_mt_total: number | null
  clientes_total: number | null
  demanda_mt_total: number | null
  clientes_expostos_gap_severo: number | null
  km_gap_religamento_auto: number | null
  n_segmentos_gap_religamento_auto: number | null
  km_gap_recomposicao: number | null
  n_segmentos_gap_recomposicao: number | null
  km_gap_transferencia: number | null
  n_segmentos_gap_transferencia: number | null
  clientes_gap_severo_bt: number | null
  clientes_gap_severo_mt: number | null
  clientes_gap_severo_total: number | null
  demanda_gap_severo_total: number | null
  max_dist_religador_km: number | null
  max_dist_equipamento_auto_km: number | null
  max_dist_manobra_km: number | null
  max_dist_transferencia_km: number | null
  metodologia_gap: string | null
  lacunas: string[] | null
}

interface MunicipioContextoRow {
  municipio: string
  uf: string | null
  score_risco: number | null
  dec_medio_12m: number | null
  fec_medio_12m: number | null
  meses_violacao_dec: number | null
  meses_violacao_fec: number | null
  populacao: number | null
}

interface CircuitoAtRelacionadoRow {
  cod_id: string
  nome: string | null
  tensao_nom: number | null
  comprimento_km: number | null
}

interface EstruturaSubestacaoRow {
  component_type: string
  total: string
}

interface SubestacaoOrigemRow {
  cod_id: string
  municipio: string | null
  tensao_nom: number | null
}

const alimentadorParamsSchema = {
  params: {
    type: 'object',
    required: ['codId'],
    properties: {
      codId: { type: 'string', minLength: 1 },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      uf: { type: 'string' },
      distribuidora: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const

function buildScope(codId: string, uf?: string, distribuidora?: string) {
  const conditions = ['cod_id = $1']
  const params: unknown[] = [codId]
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

  return {
    where: `WHERE ${conditions.join(' AND ')}`,
    params,
  }
}

function buildClientesStatus(lacunas: string[]): 'real' | 'indisponivel' {
  return lacunas.some((item) => item === 'clientes_bt_indisponiveis' || item === 'clientes_mt_indisponiveis')
    ? 'indisponivel'
    : 'real'
}

function buildExposicaoStatus(lacunas: string[], clientesGapSeveroTotal: number | null): 'real' | 'indisponivel' {
  if (lacunas.includes('exposicao_clientes_gap_indisponivel')) {
    return 'indisponivel'
  }
  return clientesGapSeveroTotal == null ? 'indisponivel' : 'real'
}

function buildMetricMetadata(metricas: AlimentadorMetricasRow, lacunas: string[]) {
  const clientesStatus = buildClientesStatus(lacunas)
  const exposicaoStatus = buildExposicaoStatus(lacunas, metricas.clientes_gap_severo_total)

  return {
    infraestrutura: observedPublicMeta(DATA_REFERENCES.bdgd, 'complete', 'high', []),
    protecao: derivedPublicMeta(
      DATA_REFERENCES.publicDerived,
      lacunas.length === 0 ? 'complete' : 'partial',
      lacunas.length === 0 ? 'high' : 'medium',
      lacunas,
    ),
    clientes:
      clientesStatus === 'real'
        ? observedPublicMeta(DATA_REFERENCES.bdgd, lacunas.length === 0 ? 'complete' : 'partial', lacunas.length === 0 ? 'high' : 'medium', lacunas)
        : unavailableMeta('Clientes BT/MT indisponíveis para este alimentador no modo público atual.', ['clientes_publicos_indisponiveis']),
    exposicao_publica:
      exposicaoStatus === 'real'
        ? derivedPublicMeta(
          DATA_REFERENCES.publicDerived,
          lacunas.length === 0 ? 'complete' : 'partial',
          lacunas.length === 0 ? 'high' : 'medium',
          lacunas,
        )
        : unavailableMeta('Exposição de clientes em gap severo indisponível para este alimentador no modo público atual.', ['exposicao_clientes_gap_indisponivel']),
    contexto_regulatorio: regulatoryContextMeta(),
    partner_operacao: unavailableMeta('OMS, carga medida e recomposição real dependem da futura integração privada com a distribuidora.', [
      'partner_oms_indisponivel',
      'partner_carga_medida_indisponivel',
      'partner_recomposicao_real_indisponivel',
    ]),
  }
}

async function loadMetricas(codId: string, uf?: string, distribuidora?: string) {
  const { where, params } = buildScope(codId, uf, distribuidora)
  const sql = `
    SELECT
      cod_id,
      distribuidora,
      uf,
      subestacao_id,
      tensao_nom,
      municipios_atendidos,
      km_mt,
      km_bt,
      n_transformadores,
      n_religadores,
      n_chaves,
      km_gap_severo,
      n_gaps_severos,
      densidade_religadores_km,
      densidade_chaves_km,
      n_ucbt,
      n_ucmt,
      clientes_bt_total,
      clientes_mt_total,
      clientes_total,
      demanda_mt_total,
      clientes_expostos_gap_severo,
      km_gap_religamento_auto,
      n_segmentos_gap_religamento_auto,
      km_gap_recomposicao,
      n_segmentos_gap_recomposicao,
      km_gap_transferencia,
      n_segmentos_gap_transferencia,
      clientes_gap_severo_bt,
      clientes_gap_severo_mt,
      clientes_gap_severo_total,
      demanda_gap_severo_total,
      max_dist_religador_km,
      max_dist_equipamento_auto_km,
      max_dist_manobra_km,
      max_dist_transferencia_km,
      metodologia_gap,
      lacunas
    FROM alimentador_metricas
    ${where}
    ORDER BY distribuidora ASC
    LIMIT 1
  `

  const result = await pgPool.query<AlimentadorMetricasRow>(sql, params)
  return result.rows[0] ?? null
}

async function loadMunicipiosContexto(metricas: AlimentadorMetricasRow) {
  const result = await loadMunicipiosRegulatoryContext(
    pgPool,
    metricas.municipios_atendidos ?? [],
    metricas.distribuidora,
    metricas.uf,
  )

  return {
    municipios: result.municipios as MunicipioContextoRow[],
    competenciaMax: result.competencia_max,
  }
}

async function loadContextoAt(metricas: AlimentadorMetricasRow) {
  if (!metricas.subestacao_id) {
    return {
      subestacao_origem: null,
      circuitos_at_relacionados: [],
      km_at_relacionado: null,
      n_transformadores_at: 0,
      n_religadores_at: 0,
      n_chaves_at: 0,
      estrutura_subestacao: [] as Array<{ component_type: string; total: number }>,
      lacunas_at: [] as string[],
    }
  }

  const scope = [metricas.subestacao_id, metricas.distribuidora, metricas.uf]
  const [subestacaoResult, circuitosResult, agregadosResult, estruturaResult, coberturaResult] = await Promise.all([
    pgPool.query<SubestacaoOrigemRow>(
      `
        SELECT cod_id, municipio, tensao_nom
        FROM subestacoes
        WHERE cod_id = $1 AND distribuidora = $2 AND uf = $3
        LIMIT 1
      `,
      scope,
    ),
    pgPool.query<CircuitoAtRelacionadoRow>(
      `
        SELECT cod_id, nome, tensao_nom, comprimento_km
        FROM alimentadores_at
        WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3
        ORDER BY comprimento_km DESC NULLS LAST, cod_id ASC
        LIMIT 12
      `,
      scope,
    ),
    pgPool.query<{
      km_at_relacionado: string | null
      n_transformadores_at: string
      n_religadores_at: string
      n_chaves_at: string
    }>(
      `
        SELECT
          (SELECT ROUND(COALESCE(SUM(comprimento_km), 0)::numeric, 1)::text FROM alimentadores_at WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS km_at_relacionado,
          (SELECT COUNT(*)::text FROM transformadores_at WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS n_transformadores_at,
          (SELECT COUNT(*)::text FROM religadores_at WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS n_religadores_at,
          (SELECT COUNT(*)::text FROM chaves_at WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS n_chaves_at
      `,
      scope,
    ),
    pgPool.query<EstruturaSubestacaoRow>(
      `
        SELECT component_type, COUNT(*)::text AS total
        FROM subestacao_componentes
        WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3
        GROUP BY component_type
        ORDER BY component_type ASC
      `,
      scope,
    ),
    pgPool.query<{
      religadores_at_total: string
      base_total: string
      base_geom_total: string
      be_total: string
      be_geom_total: string
    }>(
      `
        SELECT
          (SELECT COUNT(*)::text FROM religadores_at WHERE distribuidora = $1 AND uf = $2) AS religadores_at_total,
          (SELECT COUNT(*)::text FROM subestacao_componentes WHERE distribuidora = $1 AND uf = $2 AND component_type = 'BASE') AS base_total,
          (SELECT COUNT(*)::text FROM subestacao_componentes WHERE distribuidora = $1 AND uf = $2 AND component_type = 'BASE' AND geom IS NOT NULL) AS base_geom_total,
          (SELECT COUNT(*)::text FROM subestacao_componentes WHERE distribuidora = $1 AND uf = $2 AND component_type = 'BE') AS be_total,
          (SELECT COUNT(*)::text FROM subestacao_componentes WHERE distribuidora = $1 AND uf = $2 AND component_type = 'BE' AND geom IS NOT NULL) AS be_geom_total
      `,
      [metricas.distribuidora, metricas.uf],
    ),
  ])

  const agregados = agregadosResult.rows[0]
  const cobertura = coberturaResult.rows[0]
  const lacunasAt: string[] = []
  if ((Number.parseInt(cobertura?.religadores_at_total ?? '0', 10) || 0) === 0) lacunasAt.push('UNREAT_vazio')
  if ((Number.parseInt(cobertura?.base_total ?? '0', 10) || 0) > 0 && (Number.parseInt(cobertura?.base_geom_total ?? '0', 10) || 0) === 0) lacunasAt.push('BASE_sem_geometria')
  if ((Number.parseInt(cobertura?.be_total ?? '0', 10) || 0) > 0 && (Number.parseInt(cobertura?.be_geom_total ?? '0', 10) || 0) === 0) lacunasAt.push('BE_sem_geometria')
  return {
    subestacao_origem: subestacaoResult.rows[0] ?? null,
    circuitos_at_relacionados: circuitosResult.rows,
    km_at_relacionado: agregados?.km_at_relacionado != null ? Number.parseFloat(agregados.km_at_relacionado) : null,
    n_transformadores_at: Number.parseInt(agregados?.n_transformadores_at ?? '0', 10) || 0,
    n_religadores_at: Number.parseInt(agregados?.n_religadores_at ?? '0', 10) || 0,
    n_chaves_at: Number.parseInt(agregados?.n_chaves_at ?? '0', 10) || 0,
    estrutura_subestacao: estruturaResult.rows.map((item) => ({
      component_type: item.component_type,
      total: Number.parseInt(item.total, 10) || 0,
    })),
    lacunas_at: lacunasAt,
  }
}

export const alimentadorRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    '/alimentador/:codId/detalhe',
    { schema: alimentadorParamsSchema },
    async (
      request: FastifyRequest<{
        Params: { codId: string }
        Querystring: { uf?: string; distribuidora?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const metricas = await loadMetricas(
        request.params.codId,
        request.query.uf,
        request.query.distribuidora,
      )

      if (!metricas) {
        return reply.status(404).send({ error: 'Alimentador não encontrado' })
      }

      const { municipios, competenciaMax } = await loadMunicipiosContexto(metricas)
      const contextoAt = await loadContextoAt(metricas)
      const lacunas = [...(metricas.lacunas ?? []), ...(contextoAt.lacunas_at ?? [])]
      const metricasMetadata = buildMetricMetadata(metricas, lacunas)

      const mediaDecMunicipal =
        municipios.length > 0
          ? municipios.reduce((sum, item) => sum + (item.dec_medio_12m ?? 0), 0) / municipios.length
          : null
      const mediaFecMunicipal =
        municipios.length > 0
          ? municipios.reduce((sum, item) => sum + (item.fec_medio_12m ?? 0), 0) / municipios.length
          : null
      const somaMesesViolacaoDec = municipios.reduce((sum, item) => sum + (item.meses_violacao_dec ?? 0), 0)
      const somaMesesViolacaoFec = municipios.reduce((sum, item) => sum + (item.meses_violacao_fec ?? 0), 0)

      return reply.send({
        data_mode: SYSTEM_DATA_MODE,
        cod_id: metricas.cod_id,
        distribuidora: metricas.distribuidora,
        uf: metricas.uf,
        subestacao_id: metricas.subestacao_id,
        tensao_nom: metricas.tensao_nom,
        infraestrutura: {
          km_mt: metricas.km_mt,
          km_bt: metricas.km_bt,
          n_transformadores: metricas.n_transformadores ?? 0,
        },
        protecao: {
          n_religadores: metricas.n_religadores ?? 0,
          n_chaves: metricas.n_chaves ?? 0,
          km_gap_severo: metricas.km_gap_severo ?? 0,
          n_gaps_severos: metricas.n_gaps_severos ?? 0,
          densidade_religadores_km: metricas.densidade_religadores_km,
          densidade_chaves_km: metricas.densidade_chaves_km,
          max_dist_religador_km: metricas.max_dist_religador_km,
          max_dist_equipamento_auto_km: metricas.max_dist_equipamento_auto_km ?? metricas.max_dist_religador_km,
          max_dist_manobra_km: metricas.max_dist_manobra_km,
          km_gap_religamento_auto: metricas.km_gap_religamento_auto ?? metricas.km_gap_severo ?? 0,
          n_segmentos_gap_religamento_auto: metricas.n_segmentos_gap_religamento_auto ?? metricas.n_gaps_severos ?? 0,
          km_gap_recomposicao: metricas.km_gap_recomposicao ?? 0,
          n_segmentos_gap_recomposicao: metricas.n_segmentos_gap_recomposicao ?? 0,
          km_gap_transferencia: metricas.km_gap_transferencia ?? 0,
          n_segmentos_gap_transferencia: metricas.n_segmentos_gap_transferencia ?? 0,
          metodologia_gap: metricas.metodologia_gap,
          max_dist_transferencia_km: metricas.max_dist_transferencia_km,
        },
        clientes: {
          n_ucbt: metricas.n_ucbt,
          n_ucmt: metricas.n_ucmt,
          clientes_bt_total: metricas.clientes_bt_total,
          clientes_mt_total: metricas.clientes_mt_total,
          clientes_total: metricas.clientes_total,
          demanda_mt_total: metricas.demanda_mt_total,
          clientes_expostos_gap_severo: metricas.clientes_expostos_gap_severo,
          clientes_gap_severo_bt: metricas.clientes_gap_severo_bt,
          clientes_gap_severo_mt: metricas.clientes_gap_severo_mt,
          clientes_gap_severo_total: metricas.clientes_gap_severo_total,
          demanda_gap_severo_total: metricas.demanda_gap_severo_total,
        },
        contexto_at: contextoAt,
        municipios_atendidos: metricas.municipios_atendidos ?? [],
        contexto_regulatorio: {
          municipios,
          dec_medio_municipal: mediaDecMunicipal,
          fec_medio_municipal: mediaFecMunicipal,
          meses_violacao_total: somaMesesViolacaoDec,
          meses_violacao_dec_total: somaMesesViolacaoDec,
          meses_violacao_fec_total: somaMesesViolacaoFec,
          competencia_max: competenciaMax,
        },
        qualidade_dados: {
          clientes_status: buildClientesStatus(lacunas),
          exposicao_status: buildExposicaoStatus(lacunas, metricas.clientes_gap_severo_total),
          lacunas,
        },
        metricas_metadata: metricasMetadata,
      })
    },
  )

  fastify.get(
    '/alimentador/:codId/municipios',
    { schema: alimentadorParamsSchema },
    async (
      request: FastifyRequest<{
        Params: { codId: string }
        Querystring: { uf?: string; distribuidora?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const metricas = await loadMetricas(
        request.params.codId,
        request.query.uf,
        request.query.distribuidora,
      )

      if (!metricas) {
        return reply.status(404).send({ error: 'Alimentador não encontrado' })
      }

      const municipios = await loadMunicipiosContexto(metricas)
      return reply.send({
        cod_id: metricas.cod_id,
        distribuidora: metricas.distribuidora,
        uf: metricas.uf,
        data: municipios,
      })
    },
  )
}
