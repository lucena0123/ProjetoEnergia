'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

const MapaLocalAlimentador = dynamic(() => import('@/components/MapaLocalAlimentador'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center rounded-xl border border-gray-800 bg-gray-950 text-sm text-gray-400">
      Carregando mapa local...
    </div>
  ),
})

interface MunicipioContexto {
  municipio: string
  uf: string | null
  score_risco: number | null
  dec_medio_12m: number | null
  fec_medio_12m: number | null
  meses_violacao_dec: number | null
  meses_violacao_fec: number | null
  populacao: number | null
}

interface MetricMeta {
  metric_origin: 'observed_public' | 'derived_public' | 'regulatory_context' | 'partner_observed' | 'partner_derived' | 'unavailable'
  data_reference: string
  coverage_status: 'complete' | 'partial' | 'insufficient' | 'unavailable'
  confidence_status: 'high' | 'medium' | 'low' | 'unavailable'
  lacunas: string[]
}

interface AlimentadorDetalhe {
  data_mode: 'public' | 'partner'
  cod_id: string
  distribuidora: string
  uf: string
  subestacao_id: string | null
  tensao_nom: number | null
  infraestrutura: {
    km_mt: number | null
    km_bt: number | null
    n_transformadores: number
  }
  protecao: {
    n_religadores: number
    n_chaves: number
    km_gap_severo: number
    n_gaps_severos: number
    densidade_religadores_km: number | null
    densidade_chaves_km: number | null
    max_dist_religador_km: number | null
    max_dist_equipamento_auto_km: number | null
    max_dist_manobra_km: number | null
    max_dist_transferencia_km: number | null
    km_gap_religamento_auto: number
    n_segmentos_gap_religamento_auto: number
    km_gap_recomposicao: number
    n_segmentos_gap_recomposicao: number
    km_gap_transferencia: number
    n_segmentos_gap_transferencia: number
    metodologia_gap: string | null
  }
  clientes: {
    n_ucbt: number | null
    n_ucmt: number | null
    clientes_bt_total: number | null
    clientes_mt_total: number | null
    clientes_total: number | null
    demanda_mt_total: number | null
    clientes_expostos_gap_severo: number | null
    clientes_gap_severo_bt: number | null
    clientes_gap_severo_mt: number | null
    clientes_gap_severo_total: number | null
    demanda_gap_severo_total: number | null
  }
  contexto_at: {
    subestacao_origem: {
      cod_id: string
      municipio: string | null
      tensao_nom: number | null
    } | null
    circuitos_at_relacionados: Array<{
      cod_id: string
      nome: string | null
      tensao_nom: number | null
      comprimento_km: number | null
    }>
    km_at_relacionado: number | null
    n_transformadores_at: number
    n_religadores_at: number
    n_chaves_at: number
    estrutura_subestacao: Array<{
      component_type: string
      total: number
    }>
  }
  municipios_atendidos: string[]
  contexto_regulatorio: {
    municipios: MunicipioContexto[]
    dec_medio_municipal: number | null
    fec_medio_municipal: number | null
    meses_violacao_total: number
    meses_violacao_dec_total: number
    meses_violacao_fec_total: number
    competencia_max: string | null
  }
  qualidade_dados: {
    clientes_status: 'real' | 'indisponivel'
    exposicao_status: 'real' | 'indisponivel'
    lacunas: string[]
  }
  metricas_metadata: {
    infraestrutura: MetricMeta
    protecao: MetricMeta
    clientes: MetricMeta
    exposicao_publica: MetricMeta
    contexto_regulatorio: MetricMeta
    partner_operacao: MetricMeta
  }
}

function formatCompact(value: number | null | undefined, digits = 1): string {
  if (value == null) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toFixed(digits)
}

function labelOrigin(origin: MetricMeta['metric_origin']): string {
  switch (origin) {
    case 'observed_public':
      return 'observado público'
    case 'derived_public':
      return 'derivado público'
    case 'regulatory_context':
      return 'contexto regulatório'
    case 'partner_observed':
      return 'observado parceiro'
    case 'partner_derived':
      return 'derivado parceiro'
    default:
      return 'indisponível'
  }
}

function labelStatus(status: MetricMeta['confidence_status'] | MetricMeta['coverage_status']): string {
  switch (status) {
    case 'high':
      return 'alta'
    case 'medium':
      return 'média'
    case 'low':
      return 'baixa'
    case 'complete':
      return 'completa'
    case 'partial':
      return 'parcial'
    case 'insufficient':
      return 'insuficiente'
    default:
      return 'indisponível'
  }
}

export default function AlimentadorPage() {
  const params = useParams<{ codId: string }>()
  const searchParams = useSearchParams()
  const codId = decodeURIComponent(params.codId)
  const uf = searchParams.get('uf') ?? ''
  const distribuidora = searchParams.get('distribuidora') ?? ''

  const [detalhe, setDetalhe] = useState<AlimentadorDetalhe | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)

      try {
        const qs = new URLSearchParams()
        if (uf) qs.set('uf', uf)
        if (distribuidora) qs.set('distribuidora', distribuidora)
        const response = await fetch(`${API_URL}/api/alimentador/${encodeURIComponent(codId)}/detalhe?${qs.toString()}`)

        if (!response.ok) {
          setError('Alimentador não encontrado.')
          return
        }

        const data: AlimentadorDetalhe = await response.json()
        setDetalhe(data)
      } catch (loadError) {
        console.error(loadError)
        setError('Erro ao carregar o detalhe do alimentador.')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [codId, distribuidora, uf])

  const lacunas = useMemo(() => detalhe?.qualidade_dados.lacunas ?? [], [detalhe])
  const metricCards: Array<{ label: string; meta: MetricMeta }> = detalhe
    ? [
      { label: 'Infraestrutura', meta: detalhe.metricas_metadata.infraestrutura },
      { label: 'Proteção', meta: detalhe.metricas_metadata.protecao },
      { label: 'Clientes', meta: detalhe.metricas_metadata.clientes },
      { label: 'Exposição pública', meta: detalhe.metricas_metadata.exposicao_publica },
      { label: 'Contexto regulatório', meta: detalhe.metricas_metadata.contexto_regulatorio },
      { label: 'Operação parceira', meta: detalhe.metricas_metadata.partner_operacao },
    ]
    : []

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="space-y-3 text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <p className="text-sm text-gray-400">Carregando alimentador {codId}...</p>
        </div>
      </div>
    )
  }

  if (error || !detalhe) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="space-y-3 text-center">
          <p className="text-sm text-red-400">{error ?? 'Dados não encontrados.'}</p>
          <Link href="/" className="text-sm text-blue-400 hover:underline">
            ← Voltar ao painel
          </Link>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-1 text-sm text-gray-400 transition-colors hover:text-white">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Painel
            </Link>
            <span className="text-gray-700">|</span>
            <h1 className="text-lg font-bold text-white">
              <span className="text-red-500">Grid</span>Risk — Alimentador {detalhe.cod_id}
            </h1>
          </div>
          <Link href={`/mapa?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`} className="text-sm text-blue-400 transition-colors hover:text-blue-300">
            Abrir mapa operacional →
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm text-gray-400">{detalhe.distribuidora} · {detalhe.uf}</p>
              <h2 className="mt-1 text-3xl font-bold text-white">{detalhe.cod_id}</h2>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Subestação</p>
                  <div className="mt-1 text-lg font-semibold text-white">
                    {detalhe.subestacao_id ? (
                      <Link
                        href={`/subestacao/${encodeURIComponent(detalhe.subestacao_id)}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
                        className="transition-colors hover:text-blue-400"
                      >
                        {detalhe.subestacao_id}
                      </Link>
                    ) : '—'}
                  </div>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Tensão</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detalhe.tensao_nom ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Municípios</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detalhe.municipios_atendidos.length}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Clientes</p>
                  <p className="mt-1 text-lg font-semibold text-white">{formatCompact(detalhe.clientes.clientes_total, 0)}</p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3 text-sm text-gray-300">
              <div className="font-semibold text-gray-200">Leitura operacional</div>
              <div className="mt-2 space-y-1 text-xs leading-5 text-gray-400">
                <p>Contexto regulatório municipal é exibido como referência territorial de DEC/FEC, não como indicador do alimentador.</p>
                <p>Gaps severos usam distância topológica a equipamentos públicos de proteção/religamento automático; a página também mostra contexto de manobra/recomposição.</p>
              </div>
            </div>
          </div>
        </section>

        {lacunas.length > 0 && (
          <section className="rounded-xl border border-amber-700/60 bg-amber-950/40 px-5 py-4 text-sm text-amber-100">
            <div className="font-semibold tracking-wide text-amber-300">Lacunas da base pública</div>
            <ul className="mt-2 space-y-1 text-amber-50/90">
              {lacunas.map((lacuna) => (
                <li key={lacuna}>{lacuna}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Origem e confiança dos dados</h3>
              <p className="mt-1 text-xs text-gray-500">
                Este detalhe separa explicitamente dado observado público, métrica derivada pública, contexto regulatório e o que permanece indisponível até uma parceria com a distribuidora.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {metricCards.map(({ label, meta }) => (
              <div key={label} className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
                <div className="mt-2 space-y-1 text-sm text-gray-300">
                  <div><span className="text-gray-500">Origem:</span> {labelOrigin(meta.metric_origin)}</div>
                  <div><span className="text-gray-500">Cobertura:</span> {labelStatus(meta.coverage_status)}</div>
                  <div><span className="text-gray-500">Confiança:</span> {labelStatus(meta.confidence_status)}</div>
                </div>
                <div className="mt-2 text-xs leading-5 text-gray-400">{meta.data_reference}</div>
                {meta.lacunas.length > 0 && (
                  <div className="mt-2 text-[11px] text-amber-300">
                    Lacunas: {meta.lacunas.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-300">Infraestrutura</h3>
            <dl className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Rede MT</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.infraestrutura.km_mt, 1)} km</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Rede BT</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.infraestrutura.km_bt, 1)} km</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Transformadores</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.infraestrutura.n_transformadores, 0)}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-300">Proteção</h3>
            <dl className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Religadores</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.protecao.n_religadores, 0)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Chaves</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.protecao.n_chaves, 0)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Gap religamento auto</dt>
                <dd className="font-medium text-orange-400">{formatCompact(detalhe.protecao.km_gap_religamento_auto ?? detalhe.protecao.km_gap_severo, 1)} km</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Relig./km MT</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.protecao.densidade_religadores_km, 3)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Dist. máx. equip. auto</dt>
                <dd className="font-medium text-white">{detalhe.protecao.max_dist_equipamento_auto_km == null ? detalhe.protecao.max_dist_religador_km == null ? '—' : `${detalhe.protecao.max_dist_religador_km.toFixed(1)} km` : `${detalhe.protecao.max_dist_equipamento_auto_km.toFixed(1)} km`}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Chaves/km MT</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.protecao.densidade_chaves_km, 3)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Gap recomposição</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.protecao.km_gap_recomposicao, 1)} km</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Dist. máx. manobra</dt>
                <dd className="font-medium text-white">{detalhe.protecao.max_dist_manobra_km == null ? '—' : `${detalhe.protecao.max_dist_manobra_km.toFixed(1)} km`}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Gap transferência</dt>
                <dd className="font-medium text-sky-300">{formatCompact(detalhe.protecao.km_gap_transferencia, 1)} km</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Dist. máx. transferência</dt>
                <dd className="font-medium text-white">{detalhe.protecao.max_dist_transferencia_km == null ? '—' : `${detalhe.protecao.max_dist_transferencia_km.toFixed(1)} km`}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Metodologia</dt>
                <dd className="font-medium text-white">{detalhe.protecao.metodologia_gap ?? '—'}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-300">Municípios atendidos</h3>
            <div className="flex flex-wrap gap-2">
              {detalhe.municipios_atendidos.length === 0 ? (
                <span className="text-sm text-gray-500">Nenhum município vinculado.</span>
              ) : (
                detalhe.municipios_atendidos.map((municipio) => (
                  <Link
                    key={municipio}
                    href={`/municipio/${encodeURIComponent(municipio)}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
                    className="rounded-full border border-gray-700 bg-gray-950/70 px-3 py-1 text-xs text-gray-300 transition-colors hover:border-blue-500 hover:text-white"
                  >
                    {municipio}
                  </Link>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-300">Exposição pública</h3>
            <dl className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">BT</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.clientes.clientes_bt_total, 0)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">MT</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.clientes.clientes_mt_total, 0)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Total</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.clientes.clientes_total, 0)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Demanda MT</dt>
                <dd className="font-medium text-white">{formatCompact(detalhe.clientes.demanda_mt_total, 2)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Status da exposição</dt>
                <dd className="font-medium text-white">
                  {detalhe.qualidade_dados.exposicao_status}
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Clientes BT em gap severo</dt>
                <dd className="font-medium text-white">
                  {detalhe.clientes.clientes_gap_severo_bt == null ? 'indisponível' : formatCompact(detalhe.clientes.clientes_gap_severo_bt, 0)}
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Clientes MT em gap severo</dt>
                <dd className="font-medium text-white">
                  {detalhe.clientes.clientes_gap_severo_mt == null ? 'indisponível' : formatCompact(detalhe.clientes.clientes_gap_severo_mt, 0)}
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Clientes totais em gap severo</dt>
                <dd className="font-medium text-white">
                  {detalhe.clientes.clientes_gap_severo_total == null ? 'indisponível' : formatCompact(detalhe.clientes.clientes_gap_severo_total, 0)}
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Demanda MT em gap severo</dt>
                <dd className="font-medium text-white">
                  {detalhe.clientes.demanda_gap_severo_total == null ? 'indisponível' : formatCompact(detalhe.clientes.demanda_gap_severo_total, 2)}
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5 lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Contexto AT</h3>
                <p className="mt-1 text-xs text-gray-500">Contexto sistêmico da subestação de origem e dos circuitos AT relacionados.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Subestação de origem</div>
                <div className="mt-2 text-lg font-semibold text-white">
                  {detalhe.contexto_at.subestacao_origem?.cod_id || detalhe.subestacao_id ? (
                    <Link
                      href={`/subestacao/${encodeURIComponent(detalhe.contexto_at.subestacao_origem?.cod_id ?? detalhe.subestacao_id ?? '')}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
                      className="transition-colors hover:text-blue-400"
                    >
                      {detalhe.contexto_at.subestacao_origem?.cod_id ?? detalhe.subestacao_id}
                    </Link>
                  ) : '—'}
                </div>
                <div className="mt-1 text-xs text-gray-500">{detalhe.contexto_at.subestacao_origem?.municipio ?? 'município indisponível'}</div>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Rede AT relacionada</div>
                <div className="mt-2 text-lg font-semibold text-white">{formatCompact(detalhe.contexto_at.km_at_relacionado, 1)} km</div>
                <div className="mt-1 text-xs text-gray-500">{detalhe.contexto_at.circuitos_at_relacionados.length} circuito(s) AT</div>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Equipamentos AT</div>
                <div className="mt-2 text-lg font-semibold text-white">{detalhe.contexto_at.n_transformadores_at} TR</div>
                <div className="mt-1 text-xs text-gray-500">{detalhe.contexto_at.n_religadores_at} religadores · {detalhe.contexto_at.n_chaves_at} chaves</div>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Estrutura da SE</div>
                <div className="mt-2 text-lg font-semibold text-white">
                  {detalhe.contexto_at.estrutura_subestacao.reduce((sum, item) => sum + item.total, 0)}
                </div>
                <div className="mt-1 text-xs text-gray-500">componentes tipados BAR / BASE / BAY / BE</div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr,0.8fr]">
              <div className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950/40">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-400">
                      <th className="px-3 py-3">Circuito AT</th>
                      <th className="px-3 py-3">Nome</th>
                      <th className="px-3 py-3 text-right">Tensão</th>
                      <th className="px-3 py-3 text-right">Comprimento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detalhe.contexto_at.circuitos_at_relacionados.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-3 py-4 text-center text-xs text-gray-500">
                          Nenhum circuito AT relacionado à subestação de origem.
                        </td>
                      </tr>
                    ) : (
                      detalhe.contexto_at.circuitos_at_relacionados.map((item) => (
                        <tr key={item.cod_id} className="border-b border-gray-800/60">
                          <td className="px-3 py-3 font-medium text-white">{item.cod_id}</td>
                          <td className="px-3 py-3 text-gray-300">{item.nome ?? '—'}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.tensao_nom ?? '—'}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.comprimento_km?.toFixed(1) ?? '—'} km</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4">
                <div className="text-xs uppercase tracking-wide text-gray-500">Estrutura da subestação de origem</div>
                <div className="mt-3 space-y-2">
                  {detalhe.contexto_at.estrutura_subestacao.length === 0 ? (
                    <div className="text-sm text-gray-500">Sem componentes tipados relacionados a esta subestação.</div>
                  ) : (
                    detalhe.contexto_at.estrutura_subestacao.map((item) => (
                      <div key={item.component_type} className="flex items-center justify-between rounded border border-gray-800 bg-gray-900/70 px-3 py-2 text-sm">
                        <span className="text-gray-300">{item.component_type}</span>
                        <span className="font-semibold text-white">{item.total}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>

        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-300">Contexto regulatório</h3>
          <div className="mb-2 text-xs text-gray-500">
            Competência disponível: {detalhe.contexto_regulatorio.competencia_max ?? '—'}
          </div>
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-gray-500">DEC médio municipal</p>
              <p className="mt-1 text-2xl font-bold text-orange-400">{formatCompact(detalhe.contexto_regulatorio.dec_medio_municipal, 2)}h</p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-gray-500">FEC médio municipal</p>
              <p className="mt-1 text-2xl font-bold text-yellow-300">{formatCompact(detalhe.contexto_regulatorio.fec_medio_municipal, 2)}</p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-gray-500">Violações DEC</p>
              <p className="mt-1 text-2xl font-bold text-red-400">{formatCompact(detalhe.contexto_regulatorio.meses_violacao_dec_total, 0)}</p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-gray-500">Violações FEC</p>
              <p className="mt-1 text-2xl font-bold text-red-400">{formatCompact(detalhe.contexto_regulatorio.meses_violacao_fec_total, 0)}</p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-gray-500">Status clientes</p>
              <p className="mt-1 text-2xl font-bold text-blue-400">{detalhe.qualidade_dados.clientes_status}</p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3 sm:col-span-3 xl:col-span-5">
              <p className="text-xs uppercase tracking-wide text-gray-500">Status exposição</p>
              <p className="mt-1 text-2xl font-bold text-blue-400">{detalhe.qualidade_dados.exposicao_status}</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-400">
                  <th className="px-3 py-3">Município</th>
                  <th className="px-3 py-3 text-right">Score</th>
                  <th className="px-3 py-3 text-right">DEC médio</th>
                  <th className="px-3 py-3 text-right">FEC médio</th>
                  <th className="px-3 py-3 text-right">Viol. DEC</th>
                  <th className="px-3 py-3 text-right">Viol. FEC</th>
                  <th className="px-3 py-3 text-right">População</th>
                </tr>
              </thead>
              <tbody>
                {detalhe.contexto_regulatorio.municipios.map((item) => (
                  <tr key={item.municipio} className="border-b border-gray-800/60">
                    <td className="px-3 py-3">
                      <Link href={`/municipio/${encodeURIComponent(item.municipio)}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`} className="text-white transition-colors hover:text-blue-400">
                        {item.municipio}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.score_risco?.toFixed(1) ?? '—'}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.dec_medio_12m?.toFixed(2) ?? '—'}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.fec_medio_12m?.toFixed(2) ?? '—'}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.meses_violacao_dec ?? '—'}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.meses_violacao_fec ?? '—'}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-gray-300">{formatCompact(item.populacao, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Mapa local</h3>
              <p className="mt-1 text-xs text-gray-500">Camadas reais filtradas por alimentador.</p>
            </div>
          </div>
          <MapaLocalAlimentador codId={detalhe.cod_id} uf={detalhe.uf} distribuidora={detalhe.distribuidora} />
        </section>
      </div>
    </main>
  )
}
