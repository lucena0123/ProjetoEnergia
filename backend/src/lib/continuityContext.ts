import { Pool } from 'pg'

interface RegulatorySummaryRow {
  dec_medio_12m: string | number | null
  dec_limite: string | number | null
  ratio_dec: string | number | null
  meses_violacao_dec: string | number | null
  fec_medio_12m: string | number | null
  fec_limite: string | number | null
  ratio_fec: string | number | null
  meses_violacao_fec: string | number | null
  competencia_max: string | null
}

interface RegulatoryHistoryRow {
  ano: number
  mes: number
  score_risco: number | string
  dec_medio: number | string | null
  fec_medio: number | string | null
}

interface MunicipioContextRow {
  municipio: string
  uf: string | null
  score_risco: number | null
  dec_medio_12m: number | string | null
  fec_medio_12m: number | string | null
  meses_violacao_dec: number | string | null
  meses_violacao_fec: number | string | null
  populacao: number | null
  competencia_max: string | null
}

interface ScopeContextRow {
  dec_medio_municipal_12m: string | number | null
  fec_medio_municipal_12m: string | number | null
  municipios_com_violacao_dec: string | number | null
  municipios_com_violacao_fec: string | number | null
  municipios_com_continuidade: string | number | null
  competencia_max: string | null
}

export interface RegulatorySummary {
  dec_medio_12m: number | null
  dec_limite: number | null
  ratio_dec: number | null
  meses_violacao_dec: number
  fec_medio_12m: number | null
  fec_limite: number | null
  ratio_fec: number | null
  meses_violacao_fec: number
  competencia_max: string | null
}

export interface RegulatoryHistoryItem {
  ano: number
  mes: number
  score_risco: number
  dec_medio: number | null
  fec_medio: number | null
}

export interface RegulatoryMunicipioContextItem {
  municipio: string
  uf: string | null
  score_risco: number | null
  dec_medio_12m: number | null
  fec_medio_12m: number | null
  meses_violacao_dec: number | null
  meses_violacao_fec: number | null
  populacao: number | null
}

export interface RegulatoryMunicipiosContext {
  municipios: RegulatoryMunicipioContextItem[]
  competencia_max: string | null
}

export interface ScopeRegulatoryContext {
  dec_medio_municipal_12m: number | null
  fec_medio_municipal_12m: number | null
  municipios_com_violacao_dec: number
  municipios_com_violacao_fec: number
  municipios_com_continuidade: number
  competencia_max: string | null
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toInt(value: string | number | null | undefined): number {
  if (value == null) return 0
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function buildContinuitySummaryCtes(scopeWhereSql: string): string {
  return `
    WITH scoped AS (
      SELECT
        municipio,
        distribuidora,
        uf,
        ano,
        mes,
        dec_apurado,
        dec_limite,
        fec_apurado,
        fec_limite,
        violacao_dec,
        violacao_fec
      FROM indicadores_continuidade
      ${scopeWhereSql}
    ),
    latest AS (
      SELECT
        municipio,
        distribuidora,
        uf,
        MAX(ano * 12 + mes) AS max_ord
      FROM scoped
      GROUP BY municipio, distribuidora, uf
    ),
    windowed AS (
      SELECT s.*
      FROM scoped s
      JOIN latest l
        ON l.municipio = s.municipio
       AND l.distribuidora = s.distribuidora
       AND l.uf = s.uf
       AND (s.ano * 12 + s.mes) >= l.max_ord - 11
    ),
    summary AS (
      SELECT
        municipio,
        distribuidora,
        uf,
        AVG(dec_apurado) AS dec_medio_12m,
        AVG(dec_limite) AS dec_limite,
        CASE
          WHEN AVG(dec_limite) > 0
          THEN LEAST(AVG(dec_apurado) / AVG(dec_limite), 3.0)
          ELSE 0
        END AS ratio_dec,
        COUNT(*) FILTER (WHERE violacao_dec) AS meses_violacao_dec,
        AVG(fec_apurado) AS fec_medio_12m,
        AVG(fec_limite) AS fec_limite,
        CASE
          WHEN AVG(fec_limite) > 0
          THEN LEAST(AVG(fec_apurado) / AVG(fec_limite), 3.0)
          ELSE 0
        END AS ratio_fec,
        COUNT(*) FILTER (WHERE violacao_fec) AS meses_violacao_fec
      FROM windowed
      GROUP BY municipio, distribuidora, uf
    ),
    competencia AS (
      SELECT TO_CHAR(MAKE_DATE(ano, mes, 1), 'YYYY-MM') AS competencia_max
      FROM scoped
      ORDER BY ano DESC, mes DESC
      LIMIT 1
    )
  `
}

export async function loadMunicipioRegulatorySummary(
  pool: Pool,
  municipio: string,
  distribuidora: string,
): Promise<RegulatorySummary | null> {
  const sql = `
    ${buildContinuitySummaryCtes('WHERE municipio = $1 AND distribuidora = $2')}
    SELECT
      s.dec_medio_12m,
      s.dec_limite,
      s.ratio_dec,
      s.meses_violacao_dec,
      s.fec_medio_12m,
      s.fec_limite,
      s.ratio_fec,
      s.meses_violacao_fec,
      c.competencia_max
    FROM summary s
    LEFT JOIN competencia c ON true
    ORDER BY s.uf ASC
    LIMIT 1
  `

  const result = await pool.query<RegulatorySummaryRow>(sql, [municipio, distribuidora])
  const row = result.rows[0]
  if (!row) return null

  return {
    dec_medio_12m: toNullableNumber(row.dec_medio_12m),
    dec_limite: toNullableNumber(row.dec_limite),
    ratio_dec: toNullableNumber(row.ratio_dec),
    meses_violacao_dec: toInt(row.meses_violacao_dec),
    fec_medio_12m: toNullableNumber(row.fec_medio_12m),
    fec_limite: toNullableNumber(row.fec_limite),
    ratio_fec: toNullableNumber(row.ratio_fec),
    meses_violacao_fec: toInt(row.meses_violacao_fec),
    competencia_max: row.competencia_max,
  }
}

export async function loadMunicipioRegulatoryHistory(
  pool: Pool,
  municipio: string,
  distribuidora: string,
): Promise<RegulatoryHistoryItem[]> {
  const sql = `
    WITH monthly AS (
      SELECT
        ano,
        mes,
        dec_apurado,
        dec_limite,
        fec_apurado,
        fec_limite,
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
        AVG(fec_apurado) OVER w AS fec_medio_12m,
        AVG(fec_limite) OVER w AS fec_limite_12m,
        SUM(violacao_dec) OVER w AS meses_violacao_12m
      FROM monthly
      WINDOW w AS (ORDER BY ano, mes ROWS BETWEEN 11 PRECEDING AND CURRENT ROW)
    ),
    idade_rede AS (
      SELECT AVG(EXTRACT(YEAR FROM AGE(NOW(), data_implant))) AS idade_media_anos
      FROM rede_mt
      WHERE municipio = $1 AND distribuidora = $2 AND data_implant IS NOT NULL
    )
    SELECT
      r.ano,
      r.mes,
      ROUND((((
        LEAST(
          CASE
            WHEN COALESCE(r.dec_limite_12m, 0) > 0
            THEN LEAST(r.dec_medio_12m / r.dec_limite_12m, 3.0) / 3.0
            ELSE 0
          END,
          1.0
        ) * 40
        + LEAST(COALESCE(r.meses_violacao_12m, 0)::float / 12.0, 1.0) * 30
        + COALESCE(
          CASE
            WHEN ir.idade_media_anos IS NOT NULL
            THEN LEAST(ir.idade_media_anos / 40.0, 1.0) * 30
            ELSE NULL
          END,
          0
        )
      ) / (70 + CASE WHEN ir.idade_media_anos IS NOT NULL THEN 30 ELSE 0 END)) * 100)::numeric, 2)
      AS score_risco,
      ROUND(r.dec_medio_12m::numeric, 2) AS dec_medio,
      ROUND(r.fec_medio_12m::numeric, 2) AS fec_medio
    FROM rolling r
    CROSS JOIN idade_rede ir
    WHERE r.pontos_janela >= 3
    ORDER BY r.ano DESC, r.mes DESC
    LIMIT 12
  `

  const result = await pool.query<RegulatoryHistoryRow>(sql, [municipio, distribuidora])
  return result.rows.reverse().map((row) => ({
    ano: row.ano,
    mes: row.mes,
    score_risco: toNullableNumber(row.score_risco) ?? 0,
    dec_medio: toNullableNumber(row.dec_medio),
    fec_medio: toNullableNumber(row.fec_medio),
  }))
}

export async function loadMunicipiosRegulatoryContext(
  pool: Pool,
  municipios: string[],
  distribuidora: string,
  uf: string,
): Promise<RegulatoryMunicipiosContext> {
  if (!municipios.length) {
    return { municipios: [], competencia_max: null }
  }

  const sql = `
    ${buildContinuitySummaryCtes('WHERE municipio = ANY($1::text[]) AND distribuidora = $2 AND uf = $3')}
    SELECT
      s.municipio,
      mr.uf,
      mr.score_risco,
      s.dec_medio_12m,
      s.fec_medio_12m,
      s.meses_violacao_dec,
      s.meses_violacao_fec,
      pop.populacao,
      c.competencia_max
    FROM summary s
    LEFT JOIN mapa_risco mr
      ON mr.municipio = s.municipio
     AND mr.distribuidora = s.distribuidora
     AND mr.uf = s.uf
    LEFT JOIN ibge_municipios im
      ON im.nome_norm = lower(unaccent(s.municipio))
     AND im.uf = s.uf
    LEFT JOIN ibge_populacao pop
      ON pop.codigo_ibge = im.codigo_ibge
    LEFT JOIN competencia c ON true
    ORDER BY mr.score_risco DESC NULLS LAST, s.municipio ASC
  `

  const result = await pool.query<MunicipioContextRow>(sql, [municipios, distribuidora, uf])
  return {
    municipios: result.rows.map((row) => ({
      municipio: row.municipio,
      uf: row.uf,
      score_risco: row.score_risco,
      dec_medio_12m: toNullableNumber(row.dec_medio_12m),
      fec_medio_12m: toNullableNumber(row.fec_medio_12m),
      meses_violacao_dec: row.meses_violacao_dec == null ? null : toInt(row.meses_violacao_dec),
      meses_violacao_fec: row.meses_violacao_fec == null ? null : toInt(row.meses_violacao_fec),
      populacao: row.populacao,
    })),
    competencia_max: result.rows[0]?.competencia_max ?? null,
  }
}

export async function loadScopeRegulatoryContext(
  pool: Pool,
  scope: {
    uf?: string
    distribuidora?: string
  },
): Promise<ScopeRegulatoryContext> {
  const conditions: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (scope.distribuidora) {
    conditions.push(`distribuidora ILIKE $${idx}`)
    params.push(`%${scope.distribuidora}%`)
    idx++
  }

  if (scope.uf) {
    conditions.push(`uf = $${idx}`)
    params.push(scope.uf.toUpperCase())
    idx++
  }

  const scopeWhereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `
    ${buildContinuitySummaryCtes(scopeWhereSql)}
    SELECT
      ROUND(AVG(s.dec_medio_12m)::numeric, 2) AS dec_medio_municipal_12m,
      ROUND(AVG(s.fec_medio_12m)::numeric, 2) AS fec_medio_municipal_12m,
      COUNT(*) FILTER (WHERE COALESCE(s.meses_violacao_dec, 0) > 0) AS municipios_com_violacao_dec,
      COUNT(*) FILTER (WHERE COALESCE(s.meses_violacao_fec, 0) > 0) AS municipios_com_violacao_fec,
      COUNT(*) AS municipios_com_continuidade,
      c.competencia_max
    FROM summary s
    LEFT JOIN competencia c ON true
    GROUP BY c.competencia_max
  `

  const result = await pool.query<ScopeContextRow>(sql, params)
  const row = result.rows[0]
  if (!row) {
    return {
      dec_medio_municipal_12m: null,
      fec_medio_municipal_12m: null,
      municipios_com_violacao_dec: 0,
      municipios_com_violacao_fec: 0,
      municipios_com_continuidade: 0,
      competencia_max: null,
    }
  }

  return {
    dec_medio_municipal_12m: toNullableNumber(row.dec_medio_municipal_12m),
    fec_medio_municipal_12m: toNullableNumber(row.fec_medio_municipal_12m),
    municipios_com_violacao_dec: toInt(row.municipios_com_violacao_dec),
    municipios_com_violacao_fec: toInt(row.municipios_com_violacao_fec),
    municipios_com_continuidade: toInt(row.municipios_com_continuidade),
    competencia_max: row.competencia_max,
  }
}
