import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { pgPool } from '../db'
import { DATA_REFERENCES, observedPublicMeta, regulatoryContextMeta, SYSTEM_DATA_MODE, unavailableMeta } from '../lib/dataMode'

interface ScopeQuery {
  uf?: string
  distribuidora?: string
}

interface BaseRow {
  cod_id: string
  distribuidora: string
  uf: string
  municipio: string | null
  tensao_nom: number | null
  data_implant: string | null
}

interface AlimentadorMtRow {
  cod_id: string
  tensao_nom: number | null
  km_mt: number | null
  clientes_total: number | null
  n_religadores: number | null
  n_chaves: number | null
}

interface CircuitoAtRow {
  cod_id: string
  nome: string | null
  tensao_nom: number | null
  comprimento_km: number | null
}

interface ComponenteRow {
  cod_id: string | null
  component_type: string
  sub_grupo: string | null
  descricao: string | null
  tensao_nom: number | null
  data_inicio: string | null
  data_fim: string | null
}

const paramsSchema = {
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

function buildScope(codId: string, query: ScopeQuery) {
  const conditions = ['cod_id = $1']
  const params: unknown[] = [codId]
  let idx = 2

  if (query.uf) {
    conditions.push(`uf = $${idx}`)
    params.push(query.uf.toUpperCase())
    idx += 1
  }

  if (query.distribuidora) {
    conditions.push(`distribuidora ILIKE $${idx}`)
    params.push(`%${query.distribuidora}%`)
    idx += 1
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, params }
}

async function loadBase(codId: string, query: ScopeQuery) {
  const scope = buildScope(codId, query)
  const result = await pgPool.query<BaseRow>(
    `
      SELECT cod_id, distribuidora, uf, municipio, tensao_nom, data_implant::text
      FROM subestacoes
      ${scope.where}
      LIMIT 1
    `,
    scope.params,
  )
  return result.rows[0] ?? null
}

export const subestacaoRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    '/subestacao/:codId/alimentadores-mt',
    { schema: paramsSchema },
    async (
      request: FastifyRequest<{ Params: { codId: string }; Querystring: ScopeQuery }>,
      reply: FastifyReply,
    ) => {
      const base = await loadBase(request.params.codId, request.query)
      if (!base) return reply.status(404).send({ error: 'Subestação não encontrada' })

      const result = await pgPool.query<AlimentadorMtRow>(
        `
          SELECT
            am.cod_id,
            am.tensao_nom,
            am.km_mt,
            am.clientes_total,
            am.n_religadores,
            am.n_chaves
          FROM alimentador_metricas am
          WHERE am.subestacao_id = $1
            AND am.distribuidora = $2
            AND am.uf = $3
          ORDER BY am.km_mt DESC NULLS LAST, am.cod_id ASC
        `,
        [base.cod_id, base.distribuidora, base.uf],
      )

      return reply.send({
        cod_id: base.cod_id,
        distribuidora: base.distribuidora,
        uf: base.uf,
        data: result.rows,
      })
    },
  )

  fastify.get(
    '/subestacao/:codId/circuitos-at',
    { schema: paramsSchema },
    async (
      request: FastifyRequest<{ Params: { codId: string }; Querystring: ScopeQuery }>,
      reply: FastifyReply,
    ) => {
      const base = await loadBase(request.params.codId, request.query)
      if (!base) return reply.status(404).send({ error: 'Subestação não encontrada' })

      const result = await pgPool.query<CircuitoAtRow>(
        `
          SELECT cod_id, nome, tensao_nom, comprimento_km
          FROM alimentadores_at
          WHERE subestacao_id = $1
            AND distribuidora = $2
            AND uf = $3
          ORDER BY comprimento_km DESC NULLS LAST, cod_id ASC
        `,
        [base.cod_id, base.distribuidora, base.uf],
      )

      return reply.send({
        cod_id: base.cod_id,
        distribuidora: base.distribuidora,
        uf: base.uf,
        data: result.rows,
      })
    },
  )

  fastify.get(
    '/subestacao/:codId/componentes',
    { schema: paramsSchema },
    async (
      request: FastifyRequest<{ Params: { codId: string }; Querystring: ScopeQuery }>,
      reply: FastifyReply,
    ) => {
      const base = await loadBase(request.params.codId, request.query)
      if (!base) return reply.status(404).send({ error: 'Subestação não encontrada' })

      const result = await pgPool.query<ComponenteRow>(
        `
          SELECT
            cod_id,
            component_type,
            sub_grupo,
            descricao,
            tensao_nom,
            data_inicio::text,
            data_fim::text
          FROM subestacao_componentes
          WHERE subestacao_id = $1
            AND distribuidora = $2
            AND uf = $3
          ORDER BY component_type ASC, cod_id ASC NULLS LAST
        `,
        [base.cod_id, base.distribuidora, base.uf],
      )

      return reply.send({
        cod_id: base.cod_id,
        distribuidora: base.distribuidora,
        uf: base.uf,
        data: result.rows,
      })
    },
  )

  fastify.get(
    '/subestacao/:codId/detalhe',
    { schema: paramsSchema },
    async (
      request: FastifyRequest<{ Params: { codId: string }; Querystring: ScopeQuery }>,
      reply: FastifyReply,
    ) => {
      const base = await loadBase(request.params.codId, request.query)
      if (!base) return reply.status(404).send({ error: 'Subestação não encontrada' })

      const [alimentadoresMtResult, circuitosAtResult, componentesResult, agregadosResult, coberturaResult] = await Promise.all([
        pgPool.query<AlimentadorMtRow>(
          `
            SELECT
              am.cod_id,
              am.tensao_nom,
              am.km_mt,
              am.clientes_total,
              am.n_religadores,
              am.n_chaves
            FROM alimentador_metricas am
            WHERE am.subestacao_id = $1
              AND am.distribuidora = $2
              AND am.uf = $3
            ORDER BY am.km_mt DESC NULLS LAST, am.cod_id ASC
            LIMIT 24
          `,
          [base.cod_id, base.distribuidora, base.uf],
        ),
        pgPool.query<CircuitoAtRow>(
          `
            SELECT cod_id, nome, tensao_nom, comprimento_km
            FROM alimentadores_at
            WHERE subestacao_id = $1
              AND distribuidora = $2
              AND uf = $3
            ORDER BY comprimento_km DESC NULLS LAST, cod_id ASC
            LIMIT 24
          `,
          [base.cod_id, base.distribuidora, base.uf],
        ),
        pgPool.query<ComponenteRow>(
          `
            SELECT
              cod_id,
              component_type,
              sub_grupo,
              descricao,
              tensao_nom,
              data_inicio::text,
              data_fim::text
            FROM subestacao_componentes
            WHERE subestacao_id = $1
              AND distribuidora = $2
              AND uf = $3
            ORDER BY component_type ASC, cod_id ASC NULLS LAST
            LIMIT 200
          `,
          [base.cod_id, base.distribuidora, base.uf],
        ),
        pgPool.query<{
          n_transformadores_at: string
          n_religadores_at: string
          n_chaves_at: string
          clientes_at_total: string
          geracao_at_total: string
          geracao_mt_total: string
          geracao_bt_total: string
        }>(
          `
            SELECT
              (SELECT COUNT(*)::text FROM transformadores_at WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS n_transformadores_at,
              (SELECT COUNT(*)::text FROM religadores_at WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS n_religadores_at,
              (SELECT COUNT(*)::text FROM chaves_at WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS n_chaves_at,
              (SELECT COUNT(*)::text FROM ucat WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS clientes_at_total,
              (SELECT COUNT(*)::text FROM ug_at WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS geracao_at_total,
              (SELECT COUNT(*)::text FROM ug_mt WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS geracao_mt_total,
              (SELECT COUNT(*)::text FROM ug_bt WHERE subestacao_id = $1 AND distribuidora = $2 AND uf = $3) AS geracao_bt_total
          `,
          [base.cod_id, base.distribuidora, base.uf],
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
          [base.distribuidora, base.uf],
        ),
      ])

      const agregados = agregadosResult.rows[0]
      const cobertura = coberturaResult.rows[0]
      const lacunas: string[] = []

      if ((Number.parseInt(cobertura?.religadores_at_total ?? '0', 10) || 0) === 0) {
        lacunas.push('UNREAT_vazio')
      }
      if ((Number.parseInt(cobertura?.base_total ?? '0', 10) || 0) > 0 && (Number.parseInt(cobertura?.base_geom_total ?? '0', 10) || 0) === 0) {
        lacunas.push('BASE_sem_geometria')
      }
      if ((Number.parseInt(cobertura?.be_total ?? '0', 10) || 0) > 0 && (Number.parseInt(cobertura?.be_geom_total ?? '0', 10) || 0) === 0) {
        lacunas.push('BE_sem_geometria')
      }

      return reply.send({
        data_mode: SYSTEM_DATA_MODE,
        cod_id: base.cod_id,
        distribuidora: base.distribuidora,
        uf: base.uf,
        municipio: base.municipio,
        tensao_nom: base.tensao_nom,
        data_implant: base.data_implant,
        alimentadores_mt: alimentadoresMtResult.rows,
        circuitos_at: circuitosAtResult.rows,
        equipamentos_at: {
          n_transformadores_at: Number.parseInt(agregados?.n_transformadores_at ?? '0', 10) || 0,
          n_religadores_at: Number.parseInt(agregados?.n_religadores_at ?? '0', 10) || 0,
          n_chaves_at: Number.parseInt(agregados?.n_chaves_at ?? '0', 10) || 0,
        },
        clientes_geracao: {
          clientes_at_total: Number.parseInt(agregados?.clientes_at_total ?? '0', 10) || 0,
          geracao_at_total: Number.parseInt(agregados?.geracao_at_total ?? '0', 10) || 0,
          geracao_mt_total: Number.parseInt(agregados?.geracao_mt_total ?? '0', 10) || 0,
          geracao_bt_total: Number.parseInt(agregados?.geracao_bt_total ?? '0', 10) || 0,
        },
        estrutura_subestacao: {
          total: componentesResult.rows.length,
          componentes: componentesResult.rows,
          por_tipo: ['BAR', 'BASE', 'BAY', 'BE'].map((componentType) => ({
            component_type: componentType,
            total: componentesResult.rows.filter((item) => item.component_type === componentType).length,
          })),
        },
        qualidade_dados: {
          lacunas,
        },
        metricas_metadata: {
          infraestrutura: observedPublicMeta(DATA_REFERENCES.bdgd, 'complete', 'high', lacunas),
          clientes_geracao: observedPublicMeta(DATA_REFERENCES.bdgd, 'complete', 'medium', lacunas),
          contexto_regulatorio: regulatoryContextMeta(),
          partner_operacao: unavailableMeta('OMS, carga medida e recomposição real dependem da futura integração privada com a distribuidora.', [
            'partner_oms_indisponivel',
            'partner_carga_medida_indisponivel',
            'partner_recomposicao_real_indisponivel',
          ]),
        },
      })
    },
  )
}
