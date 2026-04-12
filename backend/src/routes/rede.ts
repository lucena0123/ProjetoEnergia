import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { pgPool } from '../db'
import { buildTransformadorScoreSql, buildTransformadorStatusSql } from '../lib/equipmentRisk'
import {
  buildChaveSubtypeSql,
  buildRegulacaoReativosSubtypeSql,
  buildSingleValueSubtypeSql,
  buildSubestacaoComponenteSubtypeSql,
  buildTechnicalEquipmentJoinSql,
  buildUnavailableSubtypeSql,
  technicalEquipmentSelectSql,
} from '../lib/equipmentSubtypes'
import { buildBboxIntersectSql, parseBbox, ParsedBbox } from '../lib/spatial'

interface GeoJsonRow {
  geometry: object | null
  [key: string]: unknown
}

interface TrechoRow extends GeoJsonRow {
  cod_id: string | null
  distribuidora: string | null
  municipio: string | null
  uf: string | null
  tensao_nom: number | null
  condutor: string | null
  comprimento: number | null
  score_risco: number | null
}

interface TransformadorRow extends GeoJsonRow {
  cod_id: string | null
  distribuidora: string | null
  municipio: string | null
  uf: string | null
  potencia_nom: number | null
  fabricante: string | null
  data_implant: string | null
  status: string
  score_equipamento: number | null
}

interface SubestacaoComponentRow extends GeoJsonRow {
  cod_id: string | null
  distribuidora: string | null
  municipio: string | null
  uf: string | null
  subestacao_id: string | null
  component_type: string | null
  sub_grupo: string | null
  descricao: string | null
  tensao_nom: number | null
  data_inicio: string | null
  data_fim: string | null
}

interface RegulacaoReativosRow extends GeoJsonRow {
  cod_id: string | null
  distribuidora: string | null
  municipio: string | null
  uf: string | null
  nivel_tensao: string | null
  subestacao_id: string | null
  alimentador_id: string | null
  tipo_unidade: string | null
  banco: number | null
  posicao: string | null
  potencia_nom: number | null
  descricao: string | null
  data_implant: string | null
}

interface CommonInfraQuery {
  municipio?: string
  uf?: string
  distribuidora?: string
  alimentador?: string
  subestacao?: string
  circuito_at?: string
  bbox?: string
  limit?: number
}

const commonQueryProperties = {
  municipio: { type: 'string', minLength: 1 },
  uf: { type: 'string', minLength: 2, maxLength: 2 },
  distribuidora: { type: 'string', minLength: 1 },
  alimentador: { type: 'string', minLength: 1 },
  subestacao: { type: 'string', minLength: 1 },
  circuito_at: { type: 'string', minLength: 1 },
  bbox: { type: 'string', minLength: 7 },
} as const

const trechosCriticosSchema = {
  querystring: {
    type: 'object',
    properties: {
      ...commonQueryProperties,
      score_min: { type: 'number' },
      limit: { type: 'integer', minimum: 1, maximum: 50000, default: 20000 },
    },
    additionalProperties: false,
  },
} as const

const transformadoresSchema = {
  querystring: {
    type: 'object',
    properties: {
      ...commonQueryProperties,
      limit: { type: 'integer', minimum: 1, maximum: 20000, default: 10000 },
    },
    additionalProperties: false,
  },
} as const

const subestacaoComponentesSchema = {
  querystring: {
    type: 'object',
    properties: {
      municipio: { type: 'string', minLength: 1 },
      uf: { type: 'string', minLength: 2, maxLength: 2 },
      distribuidora: { type: 'string', minLength: 1 },
      subestacao: { type: 'string', minLength: 1 },
      bbox: { type: 'string', minLength: 7 },
      component_type: { type: 'string', enum: ['BAR', 'BASE', 'BAY', 'BE'] },
      limit: { type: 'integer', minimum: 1, maximum: 10000, default: 5000 },
    },
    additionalProperties: false,
  },
} as const

const regulacaoReativosSchema = {
  querystring: {
    type: 'object',
    properties: {
      ...commonQueryProperties,
      nivel_tensao: { type: 'string', enum: ['AT', 'MT', 'BT'] },
      limit: { type: 'integer', minimum: 1, maximum: 10000, default: 5000 },
    },
    additionalProperties: false,
  },
} as const

function buildInfraSchema(defaultLimit: number, maxLimit: number) {
  return {
    querystring: {
      type: 'object',
      properties: {
        ...commonQueryProperties,
        limit: { type: 'integer', minimum: 1, maximum: maxLimit, default: defaultLimit },
      },
      additionalProperties: false,
    },
  } as const
}

function toFeatureCollection<T extends GeoJsonRow>(rows: T[]): object {
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

function parseBboxOrReply(reply: FastifyReply, raw?: string): ParsedBbox | null | undefined {
  try {
    return parseBbox(raw)
  } catch (error) {
    reply.status(400).send({
      error: error instanceof Error ? error.message : 'bbox inválido',
    })
    return undefined
  }
}

function buildCommonConditions(
  alias: string,
  filters: CommonInfraQuery,
  parsedBbox: ParsedBbox | null,
  options?: {
    requireScopedLookup?: boolean
    alimentadorColumn?: string
    alimentadorSql?: string
    subestacaoColumn?: string
    circuitoAtColumn?: string
  },
) {
  if (options?.requireScopedLookup && !filters.municipio && !filters.alimentador && !filters.subestacao && !filters.circuito_at && !parsedBbox) {
    return {
      error: {
        statusCode: 400,
        body: { error: 'Forneça municipio, alimentador, subestacao, circuito_at ou bbox para consultar esta camada.' },
      },
    }
  }

  const conditions: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (filters.municipio) {
    conditions.push(`${alias}.municipio = $${idx}`)
    params.push(filters.municipio)
    idx++
  }

  if (filters.uf) {
    conditions.push(`${alias}.uf = $${idx}`)
    params.push(filters.uf.toUpperCase())
    idx++
  }

  if (filters.distribuidora) {
    conditions.push(`${alias}.distribuidora ILIKE $${idx}`)
    params.push(`%${filters.distribuidora}%`)
    idx++
  }

  if (filters.alimentador) {
    const alimentadorClause = options?.alimentadorSql
      ? options.alimentadorSql.replace(/__IDX__/g, String(idx))
      : `${options?.alimentadorColumn ?? `${alias}.alimentador_id`} = $${idx}`
    conditions.push(alimentadorClause)
    params.push(filters.alimentador)
    idx++
  }

  if (filters.subestacao) {
    conditions.push(`${options?.subestacaoColumn ?? `${alias}.subestacao_id`} = $${idx}`)
    params.push(filters.subestacao)
    idx++
  }

  if (filters.circuito_at) {
    conditions.push(`${options?.circuitoAtColumn ?? `${alias}.circuito_at_id`} = $${idx}`)
    params.push(filters.circuito_at)
    idx++
  }

  if (parsedBbox) {
    conditions.push(buildBboxIntersectSql(`${alias}.geom`, idx))
    params.push(parsedBbox.minLng, parsedBbox.minLat, parsedBbox.maxLng, parsedBbox.maxLat)
    idx += 4
  }

  return { conditions, params, nextIndex: idx }
}

function registerSimpleInfraRoute(
  fastify: FastifyInstance,
  options: {
    path: string
    schema: ReturnType<typeof buildInfraSchema>
    table: string
    alias: string
    selectSql: string
    joinSql?: string
    orderBy: string
    alimentadorColumn?: string
    alimentadorSql?: string
    subestacaoColumn?: string
    circuitoAtColumn?: string
  },
) {
  fastify.get(
    options.path,
    { schema: options.schema },
    async (
      request: FastifyRequest<{
        Querystring: CommonInfraQuery
      }>,
      reply: FastifyReply,
    ) => {
      const { bbox, limit = 1000, ...filters } = request.query
      const parsedBbox = parseBboxOrReply(reply, bbox)
      if (parsedBbox === undefined) return

      const built = buildCommonConditions(options.alias, filters, parsedBbox, {
        requireScopedLookup: true,
        alimentadorColumn: options.alimentadorColumn ?? (options.alias === 'a' ? 'a.cod_id' : `${options.alias}.alimentador_id`),
        alimentadorSql: options.alimentadorSql,
        subestacaoColumn: options.subestacaoColumn,
        circuitoAtColumn: options.circuitoAtColumn,
      })
      if (built.error) {
        return reply.status(built.error.statusCode).send(built.error.body)
      }

      built.params.push(limit)
      const whereClause = built.conditions.length > 0 ? `WHERE ${built.conditions.join(' AND ')}` : ''
      const sql = `
        SELECT
          ${options.selectSql},
          ST_AsGeoJSON(ST_Transform(${options.alias}.geom, 4326))::json AS geometry
        FROM ${options.table} ${options.alias}
        ${options.joinSql ?? ''}
        ${whereClause}
        ORDER BY ${options.orderBy}
        LIMIT $${built.nextIndex}
      `

      const result = await pgPool.query<GeoJsonRow>(sql, built.params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )
}

export const redeRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    '/trechos-criticos',
    { schema: trechosCriticosSchema },
    async (
      request: FastifyRequest<{
        Querystring: CommonInfraQuery & {
          score_min?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      const {
        bbox,
        score_min: scoreMin,
        limit = 20000,
        ...filters
      } = request.query

      const parsedBbox = parseBboxOrReply(reply, bbox)
      if (parsedBbox === undefined) return

      const built = buildCommonConditions('r', filters, parsedBbox)
      if (built.error) {
        return reply.status(built.error.statusCode).send(built.error.body)
      }

      let idx = built.nextIndex
      if (scoreMin != null) {
        built.conditions.push(`COALESCE(mr.score_risco, 0) >= $${idx}`)
        built.params.push(scoreMin)
        idx++
      }

      built.params.push(limit)
      const whereClause = built.conditions.length > 0 ? `WHERE ${built.conditions.join(' AND ')}` : ''

      const sql = `
        SELECT
          r.cod_id,
          r.distribuidora,
          r.municipio,
          r.uf,
          r.tensao_nom,
          r.condutor,
          r.comprimento,
          mr.score_risco,
          ST_AsGeoJSON(ST_Transform(r.geom, 4326))::json AS geometry
        FROM rede_mt r
        LEFT JOIN mapa_risco mr
          ON r.municipio = mr.municipio
         AND r.distribuidora = mr.distribuidora
         AND r.uf = mr.uf
        ${whereClause}
        ORDER BY r.cod_id ASC
        LIMIT $${idx}
      `

      const result = await pgPool.query<TrechoRow>(sql, built.params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )

  fastify.get(
    '/transformadores-criticos',
    { schema: transformadoresSchema },
    async (
      request: FastifyRequest<{
        Querystring: CommonInfraQuery
      }>,
      reply: FastifyReply,
    ) => {
      const {
        bbox,
        limit = 10000,
        ...filters
      } = request.query

      const parsedBbox = parseBboxOrReply(reply, bbox)
      if (parsedBbox === undefined) return

      const built = buildCommonConditions('t', filters, parsedBbox, {
        requireScopedLookup: true,
        alimentadorColumn: 't.alimentador_id',
      })
      if (built.error) {
        return reply.status(built.error.statusCode).send(built.error.body)
      }

      const scoreSql = buildTransformadorScoreSql('t')
      const statusSql = buildTransformadorStatusSql('t')
      built.params.push(limit)

      const sql = `
        SELECT
          t.cod_id,
          t.distribuidora,
          t.municipio,
          t.uf,
          t.potencia_nom,
          t.fabricante,
          t.data_implant,
          ${statusSql} AS status,
          ${scoreSql} AS score_equipamento,
          ${buildUnavailableSubtypeSql('sem_campo_publico_confiavel')},
          ${technicalEquipmentSelectSql},
          ST_AsGeoJSON(ST_Transform(t.geom, 4326))::json AS geometry
        FROM transformadores t
        ${buildTechnicalEquipmentJoinSql('t', 'EQTRMT')}
        WHERE ${built.conditions.join(' AND ')}
        ORDER BY score_equipamento DESC NULLS LAST, t.cod_id ASC
        LIMIT $${built.nextIndex}
      `

      const result = await pgPool.query<TransformadorRow>(sql, built.params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )

  registerSimpleInfraRoute(fastify, {
    path: '/rede-bt',
    schema: buildInfraSchema(25000, 50000),
    table: 'rede_bt',
    alias: 'r',
    selectSql: `
      r.cod_id,
      r.distribuidora,
      r.municipio,
      r.uf,
      r.condutor,
      r.comprimento,
      r.data_implant
    `,
    orderBy: 'r.cod_id ASC',
  })

  registerSimpleInfraRoute(fastify, {
    path: '/religadores',
    schema: buildInfraSchema(5000, 10000),
    table: 'religadores',
    alias: 'r',
    selectSql: `
      r.cod_id,
      r.distribuidora,
      r.municipio,
      r.uf,
      r.data_implant,
      ${buildUnavailableSubtypeSql('sem_campo_publico_confiavel')},
      ${technicalEquipmentSelectSql}
    `,
    orderBy: 'r.cod_id ASC',
    joinSql: buildTechnicalEquipmentJoinSql('r', 'EQRE'),
  })

  registerSimpleInfraRoute(fastify, {
    path: '/chaves',
    schema: buildInfraSchema(10000, 20000),
    table: 'chaves',
    alias: 'c',
    selectSql: `
      c.cod_id,
      c.distribuidora,
      c.municipio,
      c.uf,
      c.tipo_chave,
      c.operacao,
      c.data_implant,
      ${buildChaveSubtypeSql('c.tipo_chave', 'BDGD.tipo_chave')},
      ${technicalEquipmentSelectSql}
    `,
    orderBy: 'c.cod_id ASC',
    joinSql: buildTechnicalEquipmentJoinSql('c', 'EQSE'),
  })

  registerSimpleInfraRoute(fastify, {
    path: '/chaves-bt',
    schema: buildInfraSchema(10000, 20000),
    table: 'chaves_bt',
    alias: 'c',
    selectSql: `
      c.cod_id,
      c.distribuidora,
      c.municipio,
      c.uf,
      c.alimentador_id,
      c.tipo_chave,
      c.operacao,
      c.data_implant,
      c.descricao,
      ${buildChaveSubtypeSql('c.tipo_chave', 'BDGD.tipo_chave')}
    `,
    orderBy: 'c.cod_id ASC',
  })

  registerSimpleInfraRoute(fastify, {
    path: '/subestacoes',
    schema: buildInfraSchema(2000, 5000),
    table: 'subestacoes',
    alias: 's',
    selectSql: `
      s.cod_id,
      s.distribuidora,
      s.municipio,
      s.uf,
      s.tensao_nom,
      s.data_implant,
      ${buildUnavailableSubtypeSql('sem_campo_publico_confiavel')}
    `,
    orderBy: 's.cod_id ASC',
    alimentadorSql: 's.cod_id IN (SELECT a2.subestacao_id FROM alimentadores a2 WHERE a2.cod_id = $__IDX__)',
    subestacaoColumn: 's.cod_id',
  })

  registerSimpleInfraRoute(fastify, {
    path: '/alimentadores',
    schema: buildInfraSchema(5000, 10000),
    table: 'alimentadores',
    alias: 'a',
    selectSql: `
      a.cod_id,
      a.distribuidora,
      a.municipio,
      a.uf,
      a.subestacao_id,
      a.n_consumidores,
      a.comprimento_km,
      a.tensao_nom,
      a.data_implant
    `,
    orderBy: 'a.cod_id ASC',
  })

  registerSimpleInfraRoute(fastify, {
    path: '/alimentadores-at',
    schema: buildInfraSchema(5000, 10000),
    table: 'alimentadores_at',
    alias: 'a',
    selectSql: `
      a.cod_id,
      a.distribuidora,
      a.municipio,
      a.uf,
      a.subestacao_id,
      a.nome,
      a.descricao,
      a.pac_ini,
      a.tensao_nom,
      a.comprimento_km
    `,
    orderBy: 'a.cod_id ASC',
    alimentadorColumn: 'a.cod_id',
    subestacaoColumn: 'a.subestacao_id',
    circuitoAtColumn: 'a.cod_id',
  })

  registerSimpleInfraRoute(fastify, {
    path: '/rede-at',
    schema: buildInfraSchema(20000, 50000),
    table: 'rede_at',
    alias: 'r',
    selectSql: `
      r.cod_id,
      r.distribuidora,
      r.municipio,
      r.uf,
      r.subestacao_id,
      r.alimentador_at_id,
      r.condutor,
      r.comprimento,
      r.descricao,
      r.tip_inst
    `,
    orderBy: 'r.cod_id ASC',
    subestacaoColumn: 'r.subestacao_id',
    circuitoAtColumn: 'r.alimentador_at_id',
  })

  registerSimpleInfraRoute(fastify, {
    path: '/transformadores-at',
    schema: buildInfraSchema(5000, 10000),
    table: 'transformadores_at',
    alias: 't',
    selectSql: `
      t.cod_id,
      t.distribuidora,
      t.municipio,
      t.uf,
      t.subestacao_id,
      t.potencia_nom,
      t.tipo_trafo,
      t.data_implant,
      t.descricao,
      ${buildSingleValueSubtypeSql('t.tipo_trafo', 'transformador_at', 'Transformador AT', 'BDGD.tipo_trafo')},
      ${technicalEquipmentSelectSql}
    `,
    orderBy: 't.cod_id ASC',
    subestacaoColumn: 't.subestacao_id',
    joinSql: buildTechnicalEquipmentJoinSql('t', 'EQTRAT'),
  })

  registerSimpleInfraRoute(fastify, {
    path: '/religadores-at',
    schema: buildInfraSchema(5000, 10000),
    table: 'religadores_at',
    alias: 'r',
    selectSql: `
      r.cod_id,
      r.distribuidora,
      r.municipio,
      r.uf,
      r.subestacao_id,
      r.tipo_regu,
      r.data_implant,
      r.descricao,
      ${buildSingleValueSubtypeSql('r.tipo_regu', 'religador_at', 'Religador AT', 'BDGD.tipo_regu')},
      ${technicalEquipmentSelectSql}
    `,
    orderBy: 'r.cod_id ASC',
    subestacaoColumn: 'r.subestacao_id',
    joinSql: buildTechnicalEquipmentJoinSql('r', 'EQRE'),
  })

  registerSimpleInfraRoute(fastify, {
    path: '/chaves-at',
    schema: buildInfraSchema(10000, 20000),
    table: 'chaves_at',
    alias: 'c',
    selectSql: `
      c.cod_id,
      c.distribuidora,
      c.municipio,
      c.uf,
      c.subestacao_id,
      c.tipo_chave,
      c.operacao,
      c.data_implant,
      c.descricao,
      ${buildChaveSubtypeSql('c.tipo_chave', 'BDGD.tipo_chave')},
      ${technicalEquipmentSelectSql}
    `,
    orderBy: 'c.cod_id ASC',
    subestacaoColumn: 'c.subestacao_id',
    joinSql: buildTechnicalEquipmentJoinSql('c', 'EQSE'),
  })

  fastify.get(
    '/subestacao-componentes',
    { schema: subestacaoComponentesSchema },
    async (
      request: FastifyRequest<{
        Querystring: {
          municipio?: string
          uf?: string
          distribuidora?: string
          subestacao?: string
          bbox?: string
          component_type?: 'BAR' | 'BASE' | 'BAY' | 'BE'
          limit?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      const { bbox, limit = 5000, component_type, ...filters } = request.query
      const parsedBbox = parseBboxOrReply(reply, bbox)
      if (parsedBbox === undefined) return

      const built = buildCommonConditions('sc', filters, parsedBbox, {
        requireScopedLookup: true,
      })
      if (built.error) {
        return reply.status(built.error.statusCode).send(built.error.body)
      }

      let nextIndex = built.nextIndex
      if (component_type) {
        built.conditions.push(`sc.component_type = $${nextIndex}`)
        built.params.push(component_type)
        nextIndex++
      }

      built.conditions.push('sc.geom IS NOT NULL')
      built.params.push(limit)

      const sql = `
        SELECT
          sc.cod_id,
          sc.distribuidora,
          sc.municipio,
          sc.uf,
          sc.subestacao_id,
          sc.component_type,
          sc.sub_grupo,
          sc.descricao,
          sc.tensao_nom,
          sc.data_inicio,
          sc.data_fim,
          ${buildSubestacaoComponenteSubtypeSql('sc')},
          ST_AsGeoJSON(ST_Transform(sc.geom, 4326))::json AS geometry
        FROM subestacao_componentes sc
        WHERE ${built.conditions.join(' AND ')}
        ORDER BY sc.subestacao_id ASC NULLS LAST, sc.component_type ASC, sc.cod_id ASC NULLS LAST
        LIMIT $${nextIndex}
      `

      const result = await pgPool.query<SubestacaoComponentRow>(sql, built.params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )

  fastify.get(
    '/regulacao-reativos',
    { schema: regulacaoReativosSchema },
    async (
      request: FastifyRequest<{
        Querystring: CommonInfraQuery & { nivel_tensao?: 'AT' | 'MT' | 'BT'; limit?: number }
      }>,
      reply: FastifyReply,
    ) => {
      const { bbox, limit = 5000, nivel_tensao, ...filters } = request.query
      const parsedBbox = parseBboxOrReply(reply, bbox)
      if (parsedBbox === undefined) return

      const built = buildCommonConditions('rr', filters, parsedBbox, {
        requireScopedLookup: true,
      })
      if (built.error) {
        return reply.status(built.error.statusCode).send(built.error.body)
      }

      let nextIndex = built.nextIndex
      if (nivel_tensao) {
        built.conditions.push(`rr.nivel_tensao = $${nextIndex}`)
        built.params.push(nivel_tensao)
        nextIndex += 1
      }

      built.conditions.push('rr.geom IS NOT NULL')
      built.params.push(limit)

      const sql = `
        SELECT
          rr.cod_id,
          rr.distribuidora,
          rr.municipio,
          rr.uf,
          rr.nivel_tensao,
          rr.subestacao_id,
          rr.alimentador_id,
          rr.tipo_unidade,
          rr.banco,
          rr.posicao,
          rr.potencia_nom,
          rr.descricao,
          rr.data_implant::text,
          ${buildRegulacaoReativosSubtypeSql('rr')},
          ${technicalEquipmentSelectSql},
          ST_AsGeoJSON(ST_Transform(rr.geom, 4326))::json AS geometry
        FROM regulacao_reativos rr
        ${buildTechnicalEquipmentJoinSql('rr', 'EQCR')}
        WHERE ${built.conditions.join(' AND ')}
        ORDER BY rr.nivel_tensao ASC, rr.cod_id ASC
        LIMIT $${nextIndex}
      `

      const result = await pgPool.query<RegulacaoReativosRow>(sql, built.params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )
}
