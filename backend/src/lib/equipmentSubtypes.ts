export function buildTechnicalEquipmentJoinSql(
  assetAlias: string,
  family: 'EQCR' | 'EQRE' | 'EQSE' | 'EQTRAT' | 'EQTRMT',
) {
  return `
    LEFT JOIN LATERAL (
      SELECT et.descricao, et.tipo_inst, et.data_imobilizado
      FROM equipamentos_tecnicos et
      WHERE et.family = '${family}'
        AND et.uf = ${assetAlias}.uf
        AND et.distribuidora = ${assetAlias}.distribuidora
        AND et.related_asset_id = ${assetAlias}.cod_id
      ORDER BY et.cod_id ASC NULLS LAST
      LIMIT 1
    ) et ON TRUE
  `
}

export const technicalEquipmentSelectSql = `
  et.descricao AS eq_descricao,
  et.tipo_inst AS eq_tipo_inst,
  et.data_imobilizado::text AS eq_data_imobilizado
`

function blankSql(rawSql: string) {
  return `NULLIF(BTRIM(${rawSql}), '')`
}

function lowerSql(rawSql: string) {
  return `LOWER(COALESCE(${rawSql}, ''))`
}

export function buildUnavailableSubtypeSql(source: string) {
  return `
    NULL::text AS subtipo_raw,
    'sem_subtipo' AS subtipo_normalizado,
    'Subtipo indisponível na BDGD pública' AS subtipo_label,
    'indisponivel' AS subtipo_status,
    '${source}' AS subtipo_source
  `
}

export function buildChaveSubtypeSql(rawSql: string, source: string) {
  const raw = blankSql(rawSql)
  const normalized = lowerSql(rawSql)

  const subtypeCase = `
    CASE
      WHEN ${raw} IS NULL THEN 'sem_subtipo'
      WHEN ${normalized} LIKE '%telecomand%' THEN 'chave_telecomandada'
      WHEN (${normalized} LIKE '%fusível%relig%' OR ${normalized} LIKE '%fusivel%relig%') THEN 'chave_fusivel_religadora'
      WHEN ${normalized} LIKE '%seccionadora%monopolar%' THEN 'chave_seccionadora_monopolar'
      WHEN ${normalized} LIKE '%seccionadora%tripolar%' THEN 'chave_seccionadora_tripolar'
      WHEN ${normalized} LIKE '%seccionalizador%' THEN 'seccionalizador'
      WHEN ${normalized} LIKE '%disjuntor%' THEN 'disjuntor'
      WHEN (${normalized} LIKE '%lâmina%' OR ${normalized} LIKE '%lamina%') THEN 'chave_lamina'
      WHEN (${normalized} LIKE '%fusível%' OR ${normalized} LIKE '%fusivel%') THEN 'chave_fusivel'
      WHEN ${normalized} LIKE '%seccionadora%' THEN 'chave_seccionadora'
      ELSE 'outro'
    END
  `

  const labelCase = `
    CASE ${subtypeCase}
      WHEN 'sem_subtipo' THEN 'Sem subtipo informado'
      WHEN 'chave_telecomandada' THEN 'Chave Telecomandada'
      WHEN 'chave_fusivel_religadora' THEN 'Chave Fusível Religadora'
      WHEN 'chave_seccionadora_monopolar' THEN 'Chave Seccionadora Monopolar'
      WHEN 'chave_seccionadora_tripolar' THEN 'Chave Seccionadora Tripolar'
      WHEN 'seccionalizador' THEN 'Seccionalizador'
      WHEN 'disjuntor' THEN 'Disjuntor'
      WHEN 'chave_lamina' THEN 'Chave Lâmina'
      WHEN 'chave_fusivel' THEN 'Chave Fusível'
      WHEN 'chave_seccionadora' THEN 'Chave Seccionadora'
      ELSE 'Outro subtipo informado'
    END
  `

  return `
    ${rawSql} AS subtipo_raw,
    ${subtypeCase} AS subtipo_normalizado,
    ${labelCase} AS subtipo_label,
    CASE WHEN ${raw} IS NULL THEN 'indisponivel' ELSE 'disponivel' END AS subtipo_status,
    '${source}' AS subtipo_source
  `
}

export function buildSingleValueSubtypeSql(rawSql: string, normalizedValue: string, labelPrefix: string, source: string) {
  const raw = blankSql(rawSql)
  return `
    ${rawSql} AS subtipo_raw,
    CASE WHEN ${raw} IS NULL THEN 'sem_subtipo' ELSE '${normalizedValue}' END AS subtipo_normalizado,
    CASE
      WHEN ${raw} IS NULL THEN 'Subtipo indisponível na BDGD pública'
      ELSE CONCAT('${labelPrefix}', ' (tipo ', ${rawSql}, ')')
    END AS subtipo_label,
    CASE WHEN ${raw} IS NULL THEN 'indisponivel' ELSE 'unico' END AS subtipo_status,
    '${source}' AS subtipo_source
  `
}

export function buildRegulacaoReativosSubtypeSql(alias: string) {
  const raw = blankSql(`${alias}.tipo_unidade`)
  return `
    ${alias}.tipo_unidade AS subtipo_raw,
    CASE
      WHEN ${alias}.nivel_tensao = 'AT' THEN 'regulacao_at'
      WHEN ${alias}.nivel_tensao = 'BT' THEN 'regulacao_bt'
      ELSE 'regulacao_mt'
    END AS subtipo_normalizado,
    CASE
      WHEN ${alias}.nivel_tensao = 'AT' THEN 'Regulação/Reativos AT'
      WHEN ${alias}.nivel_tensao = 'BT' THEN 'Regulação/Reativos BT'
      ELSE 'Regulação/Reativos MT'
    END AS subtipo_label,
    CASE WHEN ${raw} IS NULL THEN 'indisponivel' ELSE 'unico' END AS subtipo_status,
    'BDGD.nivel_tensao/tipo_unidade' AS subtipo_source
  `
}

export function buildSubestacaoComponenteSubtypeSql(alias: string) {
  return `
    ${alias}.component_type AS subtipo_raw,
    CASE
      WHEN ${alias}.component_type IN ('BAR', 'BASE', 'BAY', 'BE') THEN LOWER(${alias}.component_type)
      ELSE 'sem_subtipo'
    END AS subtipo_normalizado,
    CASE ${alias}.component_type
      WHEN 'BAR' THEN 'Barra (BAR)'
      WHEN 'BASE' THEN 'Base de subestação (BASE)'
      WHEN 'BAY' THEN 'Bay de subestação (BAY)'
      WHEN 'BE' THEN 'Elemento BE'
      ELSE 'Subtipo indisponível na BDGD pública'
    END AS subtipo_label,
    CASE WHEN ${alias}.component_type IN ('BAR', 'BASE', 'BAY', 'BE') THEN 'disponivel' ELSE 'indisponivel' END AS subtipo_status,
    'BDGD.component_type' AS subtipo_source
  `
}
