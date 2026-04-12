export type SystemDataMode = 'public' | 'partner'

export type MetricOrigin =
  | 'observed_public'
  | 'derived_public'
  | 'regulatory_context'
  | 'partner_observed'
  | 'partner_derived'
  | 'unavailable'

export type ConfidenceStatus = 'high' | 'medium' | 'low' | 'unavailable'
export type CoverageStatus = 'complete' | 'partial' | 'insufficient' | 'unavailable'

export interface MetricMeta {
  metric_origin: MetricOrigin
  data_reference: string
  coverage_status: CoverageStatus
  confidence_status: ConfidenceStatus
  lacunas: string[]
}

export interface DataModePayload {
  mode: SystemDataMode
  partner_ready: boolean
  supported_sources: Array<{
    id: string
    label: string
    origin: MetricOrigin
    status: 'available' | 'prepared'
  }>
  available_metrics: Array<{
    id: string
    label: string
    origin: MetricOrigin
    description: string
  }>
}

export const SYSTEM_DATA_MODE: SystemDataMode = 'public'
export const PARTNER_READY = true

export const DATA_REFERENCES = {
  bdgd: 'BDGD ANEEL 2024 com infraestrutura e vínculos públicos carregados localmente.',
  continuity: 'Continuidade ANEEL mensal agregada por município a partir de DEC/FEC oficial.',
  ibge: 'Malhas, população e contexto territorial do IBGE.',
  publicDerived: 'Métrica derivada do GridRisk sobre base pública real carregada localmente.',
} as const

function buildMetricMeta(
  metric_origin: MetricOrigin,
  data_reference: string,
  coverage_status: CoverageStatus,
  confidence_status: ConfidenceStatus,
  lacunas: string[] = [],
): MetricMeta {
  return {
    metric_origin,
    data_reference,
    coverage_status,
    confidence_status,
    lacunas,
  }
}

export function observedPublicMeta(
  data_reference: string = DATA_REFERENCES.bdgd,
  coverage_status: CoverageStatus = 'complete',
  confidence_status: ConfidenceStatus = 'high',
  lacunas: string[] = [],
): MetricMeta {
  return buildMetricMeta('observed_public', data_reference, coverage_status, confidence_status, lacunas)
}

export function regulatoryContextMeta(
  data_reference: string = DATA_REFERENCES.continuity,
  coverage_status: CoverageStatus = 'complete',
  confidence_status: ConfidenceStatus = 'high',
  lacunas: string[] = [],
): MetricMeta {
  return buildMetricMeta('regulatory_context', data_reference, coverage_status, confidence_status, lacunas)
}

export function derivedPublicMeta(
  data_reference: string = DATA_REFERENCES.publicDerived,
  coverage_status: CoverageStatus = 'partial',
  confidence_status: ConfidenceStatus = 'medium',
  lacunas: string[] = [],
): MetricMeta {
  return buildMetricMeta('derived_public', data_reference, coverage_status, confidence_status, lacunas)
}

export function unavailableMeta(
  data_reference: string = 'Indisponível no modo público atual.',
  lacunas: string[] = [],
): MetricMeta {
  return buildMetricMeta('unavailable', data_reference, 'unavailable', 'unavailable', lacunas)
}

export function buildDataModePayload(): DataModePayload {
  return {
    mode: SYSTEM_DATA_MODE,
    partner_ready: PARTNER_READY,
    supported_sources: [
      {
        id: 'aneel_bdgd',
        label: 'BDGD ANEEL',
        origin: 'observed_public',
        status: 'available',
      },
      {
        id: 'aneel_continuidade',
        label: 'DEC/FEC ANEEL',
        origin: 'regulatory_context',
        status: 'available',
      },
      {
        id: 'ibge',
        label: 'IBGE',
        origin: 'observed_public',
        status: 'available',
      },
      {
        id: 'partner_private',
        label: 'Integração privada da distribuidora',
        origin: 'partner_observed',
        status: 'prepared',
      },
    ],
    available_metrics: [
      {
        id: 'infrastructure_public',
        label: 'Infraestrutura pública observada',
        origin: 'observed_public',
        description: 'Rede, proteção, subestações, transformadores, clientes BT/MT e topologia pública.',
      },
      {
        id: 'regulatory_context',
        label: 'Contexto regulatório',
        origin: 'regulatory_context',
        description: 'DEC/FEC municipais oficiais da ANEEL como referência territorial.',
      },
      {
        id: 'derived_public_risk',
        label: 'Priorização derivada pública',
        origin: 'derived_public',
        description: 'Score, gaps, criticidade e métricas centradas no alimentador calculadas sobre base pública real.',
      },
      {
        id: 'partner_operational_metrics',
        label: 'Métricas operacionais privadas',
        origin: 'partner_observed',
        description: 'Carga medida, OMS, recomposição e blocos operacionais reais, prontos para futura integração.',
      },
    ],
  }
}
