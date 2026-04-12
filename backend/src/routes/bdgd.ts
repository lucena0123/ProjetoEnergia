import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { pgPool } from '../db'
import { withResponseCache } from '../lib/responseCache'
import { buildBboxIntersectSql, parseBbox } from '../lib/spatial'

interface CatalogRow {
  layer_name: string
  surfaced_mode: 'curated' | 'raw'
  target_table: string | null
  has_geometry: boolean
  geometry_type: string | null
  feature_count: string
  column_names: string[] | null
  imported_at: string
}

interface RawFeatureRow {
  source_row_id: number
  feature_key: string | null
  geometry_type: string | null
  properties: Record<string, unknown> | null
  geometry: object | null
}

interface RawRecordRow {
  source_row_id: number
  feature_key: string | null
  geometry_type: string | null
  properties: Record<string, unknown> | null
}

interface LayerQuery {
  uf?: string
  distribuidora?: string
  bbox?: string
  limit?: number
  offset?: number
}

interface TypedEntityQuery {
  uf?: string
  distribuidora?: string
  municipio?: string
  subestacao?: string
  circuito_at?: string
  alimentador?: string
  limit?: number
  offset?: number
}

interface CoverageQuery {
  uf?: string
  distribuidora?: string
}

interface CoverageItem {
  label: string
  source_layer: string
  target_table: string
  has_geometry_publica: boolean
  geometry_type: string | null
  raw_count: number
  typed_count: number
  typed_geom_count: number | null
  imported_at: string | null
  lacunas: string[]
}

interface PromotedCoverageTarget {
  label: string
  source_layer: string
  target_table: string
  geomColumn: string | null
  extraWhere?: string
}

const catalogSchema = {
  querystring: {
    type: 'object',
    properties: {
      uf: { type: 'string', minLength: 2, maxLength: 2 },
      distribuidora: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
} as const

const featureSchema = {
  params: {
    type: 'object',
    properties: {
      layer: { type: 'string', minLength: 1 },
    },
    required: ['layer'],
  },
  querystring: {
    type: 'object',
    properties: {
      uf: { type: 'string', minLength: 2, maxLength: 2 },
      distribuidora: { type: 'string', minLength: 1 },
      bbox: { type: 'string', minLength: 7 },
      limit: { type: 'integer', minimum: 1, maximum: 50000, default: 5000 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
    additionalProperties: false,
  },
} as const

const typedEntitySchema = {
  querystring: {
    type: 'object',
    properties: {
      uf: { type: 'string', minLength: 2, maxLength: 2 },
      distribuidora: { type: 'string', minLength: 1 },
      municipio: { type: 'string', minLength: 1 },
      subestacao: { type: 'string', minLength: 1 },
      circuito_at: { type: 'string', minLength: 1 },
      alimentador: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 10000, default: 500 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
    additionalProperties: false,
  },
} as const

const equipamentosTecnicosSchema = {
  params: {
    type: 'object',
    properties: {
      family: { type: 'string', enum: ['EQCR', 'EQRE', 'EQSE', 'EQTRAT', 'EQTRM', 'EQTRMT'] },
    },
    required: ['family'],
  },
  querystring: typedEntitySchema.querystring,
} as const

const coberturaSchema = {
  querystring: {
    type: 'object',
    properties: {
      uf: { type: 'string', minLength: 2, maxLength: 2 },
      distribuidora: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
} as const

const PROMOTED_COVERAGE_TARGETS: PromotedCoverageTarget[] = [
  { label: 'Clientes AT', source_layer: 'UCAT_tab', target_table: 'ucat', geomColumn: null },
  { label: 'Geração AT', source_layer: 'UGAT_tab', target_table: 'ug_at', geomColumn: null },
  { label: 'Geração MT', source_layer: 'UGMT_tab', target_table: 'ug_mt', geomColumn: null },
  { label: 'Geração BT', source_layer: 'UGBT_tab', target_table: 'ug_bt', geomColumn: null },
  { label: 'Chaves BT', source_layer: 'UNSEBT', target_table: 'chaves_bt', geomColumn: 'geom' },
  { label: 'Regulação/Reativos AT', source_layer: 'UNCRAT', target_table: 'regulacao_reativos', geomColumn: 'geom', extraWhere: `nivel_tensao = 'AT'` },
  { label: 'Regulação/Reativos BT', source_layer: 'UNCRBT', target_table: 'regulacao_reativos', geomColumn: 'geom', extraWhere: `nivel_tensao = 'BT'` },
  { label: 'Regulação/Reativos MT', source_layer: 'UNCRMT', target_table: 'regulacao_reativos', geomColumn: 'geom', extraWhere: `nivel_tensao = 'MT'` },
  { label: 'Dicionário EQCR', source_layer: 'EQCR', target_table: 'equipamentos_tecnicos', geomColumn: null, extraWhere: `family = 'EQCR'` },
  { label: 'Dicionário EQRE', source_layer: 'EQRE', target_table: 'equipamentos_tecnicos', geomColumn: null, extraWhere: `family = 'EQRE'` },
  { label: 'Dicionário EQSE', source_layer: 'EQSE', target_table: 'equipamentos_tecnicos', geomColumn: null, extraWhere: `family = 'EQSE'` },
  { label: 'Dicionário EQTRAT', source_layer: 'EQTRAT', target_table: 'equipamentos_tecnicos', geomColumn: null, extraWhere: `family = 'EQTRAT'` },
  { label: 'Dicionário EQTRM', source_layer: 'EQTRM', target_table: 'equipamentos_tecnicos', geomColumn: null, extraWhere: `family = 'EQTRM'` },
  { label: 'Dicionário EQTRMT', source_layer: 'EQTRMT', target_table: 'equipamentos_tecnicos', geomColumn: null, extraWhere: `family = 'EQTRMT'` },
] as const

function parseBboxOrReply(reply: FastifyReply, raw?: string) {
  try {
    return parseBbox(raw)
  } catch (error) {
    reply.status(400).send({
      error: error instanceof Error ? error.message : 'bbox inválido',
    })
    return undefined
  }
}

function buildScopeConditions(filters: LayerQuery, startIndex = 1) {
  const conditions: string[] = []
  const params: unknown[] = []
  let idx = startIndex

  if (filters.uf) {
    conditions.push(`uf = $${idx}`)
    params.push(filters.uf.toUpperCase())
    idx++
  }

  if (filters.distribuidora) {
    conditions.push(`distribuidora ILIKE $${idx}`)
    params.push(`%${filters.distribuidora}%`)
    idx++
  }

  return { conditions, params, nextIndex: idx }
}

function buildTypedEntityConditions(filters: TypedEntityQuery, startIndex = 1) {
  const conditions: string[] = []
  const params: unknown[] = []
  let idx = startIndex

  if (filters.uf) {
    conditions.push(`uf = $${idx}`)
    params.push(filters.uf.toUpperCase())
    idx += 1
  }

  if (filters.distribuidora) {
    conditions.push(`distribuidora ILIKE $${idx}`)
    params.push(`%${filters.distribuidora}%`)
    idx += 1
  }

  if (filters.municipio) {
    conditions.push(`municipio = $${idx}`)
    params.push(filters.municipio)
    idx += 1
  }

  if (filters.subestacao) {
    conditions.push(`subestacao_id = $${idx}`)
    params.push(filters.subestacao)
    idx += 1
  }

  if (filters.circuito_at) {
    conditions.push(`circuito_at_id = $${idx}`)
    params.push(filters.circuito_at)
    idx += 1
  }

  if (filters.alimentador) {
    conditions.push(`alimentador_id = $${idx}`)
    params.push(filters.alimentador)
    idx += 1
  }

  return { conditions, params, nextIndex: idx }
}

function toFeatureCollection(rows: RawFeatureRow[]) {
  return {
    type: 'FeatureCollection' as const,
    features: rows.map((row) => ({
      type: 'Feature' as const,
      geometry: row.geometry,
      properties: {
        source_row_id: row.source_row_id,
        feature_key: row.feature_key,
        geometry_type: row.geometry_type,
        ...normalizeProperties(row.properties),
      },
    })),
  }
}

function normalizeProperties(value: RawFeatureRow['properties'] | string | null | undefined): Record<string, unknown> {
  if (value == null) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' ? value : {}
}

export const bdgdRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    '/clientes-at',
    { schema: typedEntitySchema },
    async (
      request: FastifyRequest<{ Querystring: TypedEntityQuery }>,
      reply: FastifyReply,
    ) => {
      const built = buildTypedEntityConditions(request.query)
      const params = [...built.params, request.query.limit ?? 500, request.query.offset ?? 0]
      const sql = `
        SELECT cod_id, distribuidora, municipio, uf, subestacao_id, circuito_at_id, classe_consumo, demanda_contratada, descricao, data_ligacao::text
        FROM ucat
        ${built.conditions.length > 0 ? `WHERE ${built.conditions.join(' AND ')}` : ''}
        ORDER BY cod_id ASC
        LIMIT $${built.nextIndex}
        OFFSET $${built.nextIndex + 1}
      `
      const result = await pgPool.query(sql, params)
      return reply.send({ data: result.rows })
    },
  )

  fastify.get(
    '/geracao-at',
    { schema: typedEntitySchema },
    async (
      request: FastifyRequest<{ Querystring: TypedEntityQuery }>,
      reply: FastifyReply,
    ) => {
      const built = buildTypedEntityConditions(request.query)
      const params = [...built.params, request.query.limit ?? 500, request.query.offset ?? 0]
      const sql = `
        SELECT cod_id, distribuidora, municipio, uf, subestacao_id, circuito_at_id, classe_consumo, demanda_contratada, descricao, ceg_gd, data_ligacao::text
        FROM ug_at
        ${built.conditions.length > 0 ? `WHERE ${built.conditions.join(' AND ')}` : ''}
        ORDER BY cod_id ASC
        LIMIT $${built.nextIndex}
        OFFSET $${built.nextIndex + 1}
      `
      const result = await pgPool.query(sql, params)
      return reply.send({ data: result.rows })
    },
  )

  fastify.get(
    '/geracao-mt',
    { schema: typedEntitySchema },
    async (
      request: FastifyRequest<{ Querystring: TypedEntityQuery }>,
      reply: FastifyReply,
    ) => {
      const built = buildTypedEntityConditions(request.query)
      const params = [...built.params, request.query.limit ?? 500, request.query.offset ?? 0]
      const sql = `
        SELECT cod_id, distribuidora, municipio, uf, subestacao_id, alimentador_id, classe_consumo, demanda_contratada, descricao, ceg_gd, data_ligacao::text
        FROM ug_mt
        ${built.conditions.length > 0 ? `WHERE ${built.conditions.join(' AND ')}` : ''}
        ORDER BY cod_id ASC
        LIMIT $${built.nextIndex}
        OFFSET $${built.nextIndex + 1}
      `
      const result = await pgPool.query(sql, params)
      return reply.send({ data: result.rows })
    },
  )

  fastify.get(
    '/geracao-bt',
    { schema: typedEntitySchema },
    async (
      request: FastifyRequest<{ Querystring: TypedEntityQuery }>,
      reply: FastifyReply,
    ) => {
      const built = buildTypedEntityConditions(request.query)
      const params = [...built.params, request.query.limit ?? 500, request.query.offset ?? 0]
      const sql = `
        SELECT cod_id, distribuidora, municipio, uf, subestacao_id, alimentador_id, classe_consumo, demanda_contratada, descricao, ceg_gd, data_ligacao::text
        FROM ug_bt
        ${built.conditions.length > 0 ? `WHERE ${built.conditions.join(' AND ')}` : ''}
        ORDER BY cod_id ASC
        LIMIT $${built.nextIndex}
        OFFSET $${built.nextIndex + 1}
      `
      const result = await pgPool.query(sql, params)
      return reply.send({ data: result.rows })
    },
  )

  fastify.get(
    '/equipamentos-tecnicos/:family',
    { schema: equipamentosTecnicosSchema },
    async (
      request: FastifyRequest<{ Params: { family: string }; Querystring: TypedEntityQuery }>,
      reply: FastifyReply,
    ) => {
      const built = buildTypedEntityConditions(request.query, 2)
      const params = [request.params.family, ...built.params, request.query.limit ?? 500, request.query.offset ?? 0]
      const sql = `
        SELECT family, cod_id, distribuidora, uf, related_asset_id, subestacao_id, alimentador_id, nivel_tensao, descricao, tipo_inst, data_imobilizado::text, attributes
        FROM equipamentos_tecnicos
        WHERE family = $1
          ${built.conditions.length > 0 ? `AND ${built.conditions.join(' AND ')}` : ''}
        ORDER BY cod_id ASC
        LIMIT $${built.nextIndex}
        OFFSET $${built.nextIndex + 1}
      `
      const result = await pgPool.query(sql, params)
      return reply.send({ data: result.rows })
    },
  )

  fastify.get(
    '/cobertura-bdgd',
    { schema: coberturaSchema },
    async (
      request: FastifyRequest<{ Querystring: CoverageQuery }>,
      reply: FastifyReply,
    ) => {
      const cacheKey = `cobertura-bdgd:${request.query.uf ?? 'all'}:${request.query.distribuidora ?? 'all'}`
      const payload = await withResponseCache(cacheKey, async () => {
      const built = buildScopeConditions(request.query)
      const whereClause = built.conditions.length > 0 ? `WHERE ${built.conditions.join(' AND ')}` : ''
      const catalogResult = await pgPool.query<CatalogRow>(
        `
          SELECT layer_name, surfaced_mode, target_table, has_geometry, geometry_type, feature_count::text, column_names, imported_at::text
          FROM bdgd_layer_catalog
          ${whereClause}
        `,
        built.params,
      )

      const catalogByLayer = new Map<string, CatalogRow>(
        catalogResult.rows.map((row) => [row.layer_name, row]),
      )

      const items: CoverageItem[] = []
      for (const target of PROMOTED_COVERAGE_TARGETS) {
        const catalog = catalogByLayer.get(target.source_layer)
        const scopeClauses = []
        const scopeParams: unknown[] = []
        let idx = 1
        if (request.query.uf) {
          scopeClauses.push(`uf = $${idx}`)
          scopeParams.push(request.query.uf.toUpperCase())
          idx += 1
        }
        if (request.query.distribuidora) {
          scopeClauses.push(`distribuidora ILIKE $${idx}`)
          scopeParams.push(`%${request.query.distribuidora}%`)
          idx += 1
        }
        if (target.extraWhere) {
          scopeClauses.push(target.extraWhere)
        }
        const typedWhere = scopeClauses.length > 0 ? `WHERE ${scopeClauses.join(' AND ')}` : ''
        const typedCountResult = await pgPool.query<{ total: string; geom_total?: string }>(
          `
            SELECT
              COUNT(*)::text AS total
              ${target.geomColumn ? `, COUNT(*) FILTER (WHERE ${target.geomColumn} IS NOT NULL)::text AS geom_total` : ''}
            FROM ${target.target_table}
            ${typedWhere}
          `,
          scopeParams,
        )
        const typedRow = typedCountResult.rows[0]
        const typedCount = Number.parseInt(typedRow?.total ?? '0', 10) || 0
        const typedGeomCount = target.geomColumn ? Number.parseInt(typedRow?.geom_total ?? '0', 10) || 0 : null
        const rawCount = Number.parseInt(catalog?.feature_count ?? '0', 10) || 0
        const lacunas: string[] = []

        if (rawCount === 0) {
          lacunas.push(`${target.source_layer}_vazio`)
        }
        if (catalog && !catalog.has_geometry) {
          lacunas.push('sem_geometria_publica')
        }
        if (target.geomColumn && typedCount > 0 && typedGeomCount === 0) {
          lacunas.push(`${target.source_layer}_sem_geometria_tipada`)
        }
        if (rawCount > 0 && typedCount === 0) {
          lacunas.push('promovida_sem_registros_tipados')
        }

        items.push({
          label: target.label,
          source_layer: target.source_layer,
          target_table: target.target_table,
          has_geometry_publica: catalog?.has_geometry ?? false,
          geometry_type: catalog?.geometry_type ?? null,
          raw_count: rawCount,
          typed_count: typedCount,
          typed_geom_count: typedGeomCount,
          imported_at: catalog?.imported_at ?? null,
          lacunas,
        })
      }

      return {
        data: items,
      }
      })
      return reply.send(payload)
    },
  )

  fastify.get(
    '/bdgd/layers',
    { schema: catalogSchema },
    async (
      request: FastifyRequest<{
      Querystring: Pick<LayerQuery, 'uf' | 'distribuidora'>
      }>,
      reply: FastifyReply,
    ) => {
      const cacheKey = `bdgd-layers:${request.query.uf ?? 'all'}:${request.query.distribuidora ?? 'all'}`
      const payload = await withResponseCache(cacheKey, async () => {
      const built = buildScopeConditions(request.query)
      const whereClause = built.conditions.length > 0 ? `WHERE ${built.conditions.join(' AND ')}` : ''
      const sql = `
        SELECT
          layer_name,
          surfaced_mode,
          target_table,
          has_geometry,
          geometry_type,
          feature_count::text,
          column_names,
          imported_at::text
        FROM bdgd_layer_catalog
        ${whereClause}
        ORDER BY has_geometry DESC, surfaced_mode ASC, layer_name ASC
      `

      const result = await pgPool.query<CatalogRow>(sql, built.params)
      return {
        data: result.rows.map((row) => ({
          ...row,
          feature_count: Number.parseInt(row.feature_count, 10) || 0,
        })),
      }
      })
      return reply.send(payload)
    },
  )

  fastify.get(
    '/bdgd/layers/:layer/features',
    { schema: featureSchema },
    async (
      request: FastifyRequest<{
        Params: { layer: string }
        Querystring: LayerQuery
      }>,
      reply: FastifyReply,
    ) => {
      const parsedBbox = parseBboxOrReply(reply, request.query.bbox)
      if (parsedBbox === undefined) return

      const built = buildScopeConditions(request.query, 2)
      const conditions = ['layer_name = $1', 'geom IS NOT NULL', ...built.conditions]
      const params: unknown[] = [request.params.layer, ...built.params]
      let nextIndex = built.nextIndex

      if (parsedBbox) {
        conditions.push(buildBboxIntersectSql('geom', nextIndex))
        params.push(parsedBbox.minLng, parsedBbox.minLat, parsedBbox.maxLng, parsedBbox.maxLat)
        nextIndex += 4
      }

      params.push(request.query.limit ?? 5000, request.query.offset ?? 0)
      const sql = `
        SELECT
          source_row_id,
          feature_key,
          geometry_type,
          properties,
          ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM bdgd_raw_features
        WHERE ${conditions.join(' AND ')}
        ORDER BY source_row_id ASC
        LIMIT $${nextIndex}
        OFFSET $${nextIndex + 1}
      `

      const result = await pgPool.query<RawFeatureRow>(sql, params)
      return reply.send(toFeatureCollection(result.rows))
    },
  )

  fastify.get(
    '/bdgd/layers/:layer/records',
    { schema: featureSchema },
    async (
      request: FastifyRequest<{
        Params: { layer: string }
        Querystring: LayerQuery
      }>,
      reply: FastifyReply,
    ) => {
      const built = buildScopeConditions(request.query, 2)
      const params: unknown[] = [request.params.layer, ...built.params, request.query.limit ?? 5000, request.query.offset ?? 0]
      const sql = `
        SELECT
          source_row_id,
          feature_key,
          geometry_type,
          properties
        FROM bdgd_raw_features
        WHERE layer_name = $1
          ${built.conditions.length > 0 ? `AND ${built.conditions.join(' AND ')}` : ''}
        ORDER BY source_row_id ASC
        LIMIT $${built.nextIndex}
        OFFSET $${built.nextIndex + 1}
      `

      const result = await pgPool.query<RawRecordRow>(sql, params)
      return reply.send({
        data: result.rows.map((row) => ({
          source_row_id: row.source_row_id,
          feature_key: row.feature_key,
          geometry_type: row.geometry_type,
          ...normalizeProperties(row.properties),
        })),
      })
    },
  )
}
