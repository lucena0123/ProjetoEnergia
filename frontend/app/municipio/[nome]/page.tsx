'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import SparkLine from '@/components/SparkLine'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

interface DetalheData {
  data_mode?: 'public' | 'partner'
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
  dec_medio_12m: number | null
  dec_limite: number | null
  ratio_dec: number | null
  meses_violacao: number | null
  meses_violacao_dec: number | null
  fec_medio_12m: number | null
  fec_limite: number | null
  ratio_fec: number | null
  meses_violacao_fec: number | null
  tendencia: string
  rede: {
    comprimento_mt_km: number
    comprimento_bt_km: number
    n_transformadores: number
    potencia_total_kva: number
    idade_media_anos: number | null
    transformadores_criticos: number
  }
  protecao: {
    n_religadores: number
    n_chaves: number
    cobertura_pct: number | null
    km_sem_protecao: number
  }
  social: {
    populacao: number | null
    domicilios: number | null
    densidade_hab_km2: number | null
    pib_per_capita: number | null
  }
  clientes_geracao: {
    clientes_at: number
    geracao_at: number
    geracao_mt: number
    geracao_bt: number
  }
  infraestrutura_at: {
    km_at: number | null
    n_subestacoes: number
    n_transformadores_at: number
    n_religadores_at: number
    n_chaves_at: number
    subestacoes: Array<{
      cod_id: string
      tensao_nom: number | null
      feeders_mt_relacionados: number
      circuitos_at_relacionados: number
    }>
    circuitos_at: Array<{
      cod_id: string
      subestacao_id: string | null
      nome: string | null
      comprimento_km: number | null
      tensao_nom: number | null
    }>
  }
  alimentadores: Array<{
    cod_id: string
    subestacao_id: string | null
    km_mt: number | null
    km_bt: number | null
    n_transformadores: number | null
    n_religadores: number | null
    km_gap_severo: number | null
    clientes_total: number | null
  }>
  qualidade_dados: {
    infraestrutura_status: 'real' | 'parcial' | 'indisponivel'
    historico_meses_disponiveis: number
    historico_status: 'completo' | 'parcial' | 'insuficiente'
    lacunas: string[]
  }
  metricas_metadata?: {
    score_risco: MetricMeta
    continuidade: MetricMeta
    infraestrutura: MetricMeta
    protecao: MetricMeta
    social: MetricMeta
    partner_operacao: MetricMeta
  }
  historico: Array<{
    ano: number
    mes: number
    score_risco: number
    dec_medio: number | null
    fec_medio: number | null
  }>
}

interface MetricMeta {
  metric_origin: 'observed_public' | 'derived_public' | 'regulatory_context' | 'partner_observed' | 'partner_derived' | 'unavailable'
  data_reference: string
  coverage_status: 'complete' | 'partial' | 'insufficient' | 'unavailable'
  confidence_status: 'high' | 'medium' | 'low' | 'unavailable'
  lacunas: string[]
}

interface TransformadorFeature {
  type: 'Feature'
  properties: {
    cod_id: string
    potencia_nom: number | null
    fabricante: string
    idade_anos: number | null
    vida_util_restante_anos: number | null
    status: 'critico' | 'atencao' | 'ok'
    score_equipamento: number | null
  }
}

function scoreColor(score: number | null): string {
  if (score == null) return 'text-gray-400'
  if (score >= 80) return 'text-red-400'
  if (score >= 60) return 'text-orange-400'
  if (score >= 40) return 'text-yellow-400'
  return 'text-green-400'
}

function statusBadge(status: string): string {
  if (status === 'critico') return 'bg-red-900/60 text-red-300 border border-red-700'
  if (status === 'atencao') return 'bg-yellow-900/60 text-yellow-300 border border-yellow-700'
  return 'bg-green-900/60 text-green-300 border border-green-700'
}

function formatN(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString('pt-BR')
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
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

function normalizeTransformadorFeatures(features: unknown[]): TransformadorFeature[] {
  return features.flatMap((feature) => {
    if (!feature || typeof feature !== 'object') return []

    const candidate = feature as {
      type?: string
      properties?: Record<string, unknown>
    }

    if (candidate.type !== 'Feature' || !candidate.properties) return []

    return [{
      type: 'Feature' as const,
      properties: {
        cod_id: String(candidate.properties.cod_id ?? ''),
        potencia_nom: toNumber(candidate.properties.potencia_nom),
        fabricante: String(candidate.properties.fabricante ?? '—'),
        idade_anos: toNumber(candidate.properties.idade_anos),
        vida_util_restante_anos: toNumber(candidate.properties.vida_util_restante_anos),
        status: (candidate.properties.status as TransformadorFeature['properties']['status']) ?? 'ok',
        score_equipamento: toNumber(candidate.properties.score_equipamento),
      },
    }]
  })
}

export default function MunicipioPage({ params }: { params: { nome: string } }) {
  const nome = decodeURIComponent(params.nome)
  const searchParams = useSearchParams()
  const uf = searchParams.get('uf') ?? ''
  const distribuidora = searchParams.get('distribuidora') ?? ''
  const [detalhe, setDetalhe] = useState<DetalheData | null>(null)
  const [transformadores, setTransformadores] = useState<TransformadorFeature[]>([])
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
        const detRes = await fetch(`${API_URL}/api/municipio/${encodeURIComponent(nome)}/detalhe?${qs.toString()}`)

        if (!detRes.ok) {
          setError(`Município "${nome}" não encontrado.`)
          return
        }

        const detData: DetalheData = await detRes.json()
        setDetalhe(detData)

        const transUrl = new URL(`${API_URL}/api/municipio/${encodeURIComponent(nome)}/transformadores-aging`)
        if (detData.distribuidora) {
          transUrl.searchParams.set('distribuidora', detData.distribuidora)
        }
        const transRes = await fetch(transUrl.toString())
        if (transRes.ok) {
          const transData = await transRes.json()
          setTransformadores(normalizeTransformadorFeatures(transData.features ?? []))
        }
      } catch (err) {
        setError('Erro ao conectar com a API.')
        console.error(err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [distribuidora, nome, uf])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-gray-400 text-sm">Carregando dados de {nome}...</p>
        </div>
      </div>
    )
  }

  if (error || !detalhe) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-red-400 text-sm">{error ?? 'Dados não encontrados.'}</p>
          <Link href="/" className="text-blue-400 hover:underline text-sm">
            ← Voltar ao Dashboard
          </Link>
        </div>
      </div>
    )
  }

  const tendIcon =
    detalhe.tendencia === 'piorando' ? '📈' : detalhe.tendencia === 'melhorando' ? '📉' : '➡️'
  const tendLabel =
    detalhe.tendencia === 'piorando' ? 'Piorando' : detalhe.tendencia === 'melhorando' ? 'Melhorando' : 'Estável'
  const tendColor =
    detalhe.tendencia === 'piorando' ? 'text-red-400' : detalhe.tendencia === 'melhorando' ? 'text-green-400' : 'text-gray-400'

  const sparkData = detalhe.historico.map((h) => h.score_risco)
  const historicoRegulatorio = detalhe.historico.slice(-6)
  const criticosTrans = transformadores
    .filter((t) => t.properties.status === 'critico')
    .slice(0, 20)
  const historicoSuficiente = detalhe.qualidade_dados.historico_status !== 'insuficiente'
  const lacunas = detalhe.qualidade_dados.lacunas ?? []
  const ageUnavailable = lacunas.includes('idade_rede_mt_indisponivel')
  const metricCards: Array<{ label: string; meta: MetricMeta }> = detalhe.metricas_metadata
    ? [
      { label: 'Score de risco', meta: detalhe.metricas_metadata.score_risco },
      { label: 'Continuidade', meta: detalhe.metricas_metadata.continuidade },
      { label: 'Infraestrutura', meta: detalhe.metricas_metadata.infraestrutura },
      { label: 'Proteção', meta: detalhe.metricas_metadata.protecao },
      { label: 'Social', meta: detalhe.metricas_metadata.social },
      { label: 'Operação parceira', meta: detalhe.metricas_metadata.partner_operacao },
    ]
    : []

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-gray-400 hover:text-white transition-colors text-sm flex items-center gap-1">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Painel
            </Link>
            <span className="text-gray-700">|</span>
            <h1 className="text-white font-bold text-lg">
              <span className="text-red-500">Grid</span>Risk — {detalhe.municipio}
            </h1>
          </div>
          <Link
            href={`/mapa?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            Ver no Mapa →
          </Link>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {(detalhe.qualidade_dados.infraestrutura_status !== 'real'
          || detalhe.qualidade_dados.historico_status !== 'completo'
          || ageUnavailable) && (
          <section className="rounded-xl border border-amber-700/60 bg-amber-950/40 px-5 py-4 text-sm text-amber-100">
            <div className="font-semibold tracking-wide text-amber-300">
              Confiabilidade dos dados
            </div>
            <div className="mt-2 space-y-1 text-amber-50/90">
              {detalhe.qualidade_dados.infraestrutura_status === 'indisponivel' && (
                <p>
                  Infraestrutura elétrica indisponível para este município no recorte público atual.
                </p>
              )}
              {detalhe.qualidade_dados.infraestrutura_status === 'parcial' && (
                <p>
                  A infraestrutura é real, mas esta base pública ainda tem lacunas para parte dos campos exibidos.
                </p>
              )}
              {detalhe.qualidade_dados.historico_status !== 'completo' && (
                <p>
                  Histórico disponível: {detalhe.qualidade_dados.historico_meses_disponiveis} mês(es).
                  A tendência ainda não deve ser tratada como série histórica robusta.
                </p>
              )}
              {ageUnavailable && (
                <p>
                  A BDGD deste recorte não traz data de implantação segmentada para a rede MT.
                  A idade da rede não está disponível nesta tela e o score usa apenas componentes reais disponíveis.
                </p>
              )}
              <p>
                População e densidade vêm do IBGE. O score continua sendo uma métrica derivada do projeto.
              </p>
            </div>
          </section>
        )}

        {detalhe.metricas_metadata && (
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="mb-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">
                Origem e confiança dos dados
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                Este município separa o que é observado na base pública, o que é derivado pelo GridRisk e o que permanece indisponível até uma integração privada.
              </p>
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
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Hero: score + trend + sparkline */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-start gap-6">
            <div className="flex-1">
              <p className="text-gray-400 text-sm">{detalhe.distribuidora} · {detalhe.uf}</p>
              <h2 className="text-3xl font-bold text-white mt-1">{detalhe.municipio}</h2>
              <div className="flex items-center gap-4 mt-3">
                <span className={`text-5xl font-black tabular-nums ${scoreColor(detalhe.score_risco)}`}>
                  {detalhe.score_risco?.toFixed(0) ?? '—'}
                </span>
                <div>
                  <p className="text-gray-500 text-xs">Score de Risco</p>
                  <p className={`text-sm font-semibold ${tendColor}`}>{tendIcon} {tendLabel}</p>
                </div>
              </div>
            </div>

            {sparkData.length > 1 && historicoSuficiente ? (
              <div className="shrink-0">
                <p className="text-xs text-gray-500 mb-2">
                  Histórico de Score ({detalhe.qualidade_dados.historico_meses_disponiveis} meses)
                </p>
                <SparkLine data={sparkData} width={240} height={64} />
                <div className="flex justify-between text-xs text-gray-600 mt-1">
                  {detalhe.historico[0] && (
                    <span>{detalhe.historico[0].mes}/{detalhe.historico[0].ano}</span>
                  )}
                  {detalhe.historico[detalhe.historico.length - 1] && (
                    <span>
                      {detalhe.historico[detalhe.historico.length - 1].mes}/
                      {detalhe.historico[detalhe.historico.length - 1].ano}
                    </span>
                  )}
                </div>
                {historicoRegulatorio.length > 0 && (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">DEC histórico</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {historicoRegulatorio.map((item) => (
                          <span key={`dec-${item.ano}-${item.mes}`} className="rounded-full border border-gray-800 bg-gray-900 px-2 py-1 text-[11px] text-gray-300">
                            {item.mes}/{item.ano}: {item.dec_medio?.toFixed(2) ?? '—'}h
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">FEC histórico</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {historicoRegulatorio.map((item) => (
                          <span key={`fec-${item.ano}-${item.mes}`} className="rounded-full border border-gray-800 bg-gray-900 px-2 py-1 text-[11px] text-gray-300">
                            {item.mes}/{item.ano}: {item.fec_medio?.toFixed(2) ?? '—'}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="shrink-0 rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3 text-xs text-gray-400">
                Histórico insuficiente para exibir tendência com confiança.
              </div>
            )}
          </div>
        </section>

        {/* KPI mini cards */}
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide">DEC Médio</p>
            <p className="text-2xl font-bold text-orange-400 mt-1">
              {detalhe.dec_medio_12m?.toFixed(1) ?? '—'}h
            </p>
            <p className="text-gray-600 text-xs mt-0.5">Limite: {detalhe.dec_limite ?? 12}h</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide">FEC Médio</p>
            <p className="text-2xl font-bold text-yellow-300 mt-1">
              {detalhe.fec_medio_12m?.toFixed(2) ?? '—'}
            </p>
            <p className="text-gray-600 text-xs mt-0.5">Limite: {detalhe.fec_limite?.toFixed(2) ?? '—'}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide">Violações DEC</p>
            <p className="text-2xl font-bold text-red-400 mt-1">
              {detalhe.meses_violacao_dec ?? detalhe.meses_violacao ?? '—'}<span className="text-sm text-gray-500">/12</span>
            </p>
            <p className="text-gray-600 text-xs mt-0.5">meses acima do limite</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide">Violações FEC</p>
            <p className="text-2xl font-bold text-red-400 mt-1">
              {detalhe.meses_violacao_fec ?? '—'}<span className="text-sm text-gray-500">/12</span>
            </p>
            <p className="text-gray-600 text-xs mt-0.5">meses acima do limite</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide">Cobertura</p>
            <p className={`text-2xl font-bold mt-1 ${
              (detalhe.protecao.cobertura_pct ?? 100) < 50 ? 'text-red-400' : 'text-green-400'
            }`}>
              {detalhe.protecao.cobertura_pct ?? '—'}%
            </p>
            <p className="text-gray-600 text-xs mt-0.5">proteção de rede</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide">População</p>
            <p className="text-2xl font-bold text-blue-400 mt-1">
              {formatN(detalhe.social.populacao)}
            </p>
            <p className="text-gray-600 text-xs mt-0.5">IBGE 2025</p>
          </div>
        </section>

        {/* Infrastructure + Protection + Social */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Infrastructure */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">
              Infraestrutura
            </h3>
            <dl className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Rede MT</dt>
                <dd className="text-white font-medium">{detalhe.rede.comprimento_mt_km} km</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Rede BT</dt>
                <dd className="text-white font-medium">{detalhe.rede.comprimento_bt_km} km</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Transformadores</dt>
                <dd className="text-white font-medium">{detalhe.rede.n_transformadores}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Trafo críticos (&gt;25a)</dt>
                <dd className="text-red-400 font-bold">{detalhe.rede.transformadores_criticos}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Potência instalada</dt>
                <dd className="text-white font-medium">
                  {detalhe.rede.potencia_total_kva
                    ? `${(detalhe.rede.potencia_total_kva / 1000).toFixed(1)} MVA`
                    : '—'}
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Idade média rede</dt>
                <dd className="text-white font-medium">
                  {detalhe.rede.idade_media_anos != null
                    ? `${detalhe.rede.idade_media_anos.toFixed(1)} anos`
                    : '—'}
                </dd>
              </div>
            </dl>
          </div>

          {/* Protection */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">
              Proteção
            </h3>
            <dl className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Religadores</dt>
                <dd className="text-white font-medium">{detalhe.protecao.n_religadores}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Chaves</dt>
                <dd className="text-white font-medium">{detalhe.protecao.n_chaves}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Cobertura</dt>
                <dd className={`font-bold ${
                  (detalhe.protecao.cobertura_pct ?? 100) < 50 ? 'text-red-400' : 'text-green-400'
                }`}>
                  {detalhe.protecao.cobertura_pct ?? '—'}%
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Km sem proteção</dt>
                <dd className="text-orange-400 font-medium">{detalhe.protecao.km_sem_protecao} km</dd>
              </div>
            </dl>
          </div>

          {/* Social */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">
              Contexto Social
            </h3>
            <dl className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">População</dt>
                <dd className="text-white font-medium">{formatN(detalhe.social.populacao)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-500">Domicílios</dt>
                <dd className="text-white font-medium">{formatN(detalhe.social.domicilios)}</dd>
              </div>
              {detalhe.social.densidade_hab_km2 != null && (
                <div className="flex justify-between text-sm">
                  <dt className="text-gray-500">Densidade</dt>
                  <dd className="text-white font-medium">{formatN(detalhe.social.densidade_hab_km2)} hab/km²</dd>
                </div>
              )}
              {detalhe.social.pib_per_capita != null && (
                <div className="flex justify-between text-sm">
                  <dt className="text-gray-500">PIB per capita</dt>
                  <dd className="text-white font-medium">
                    R$ {detalhe.social.pib_per_capita.toLocaleString('pt-BR')}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>

        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Infraestrutura AT</h3>
            <p className="mt-1 text-xs text-gray-500">Contexto sistêmico de alta tensão e subestações presentes no município.</p>
          </div>

          <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Rede AT</div>
              <div className="mt-2 text-2xl font-bold text-red-400">{detalhe.infraestrutura_at.km_at?.toFixed(1) ?? '—'} km</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Subestações</div>
              <div className="mt-2 text-2xl font-bold text-blue-300">{detalhe.infraestrutura_at.n_subestacoes}</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Transformadores AT</div>
              <div className="mt-2 text-2xl font-bold text-violet-300">{detalhe.infraestrutura_at.n_transformadores_at}</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Religadores AT</div>
              <div className="mt-2 text-2xl font-bold text-cyan-300">{detalhe.infraestrutura_at.n_religadores_at}</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Chaves AT</div>
              <div className="mt-2 text-2xl font-bold text-amber-300">{detalhe.infraestrutura_at.n_chaves_at}</div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[0.9fr,1.1fr]">
            <div className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950/40">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-400">
                    <th className="px-3 py-3">Subestação</th>
                    <th className="px-3 py-3 text-right">Tensão</th>
                    <th className="px-3 py-3 text-right">Alimentadores MT</th>
                    <th className="px-3 py-3 text-right">Circuitos AT</th>
                  </tr>
                </thead>
                <tbody>
                  {detalhe.infraestrutura_at.subestacoes.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-center text-xs text-gray-500">
                        Sem subestações relacionadas neste município.
                      </td>
                    </tr>
                  ) : (
                    detalhe.infraestrutura_at.subestacoes.map((item) => (
                      <tr key={item.cod_id} className="border-b border-gray-800/60">
                        <td className="px-3 py-3 font-medium text-white">
                          <Link
                            href={`/subestacao/${encodeURIComponent(item.cod_id)}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
                            className="transition-colors hover:text-blue-400"
                          >
                            {item.cod_id}
                          </Link>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.tensao_nom ?? '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.feeders_mt_relacionados}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.circuitos_at_relacionados}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950/40">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-400">
                    <th className="px-3 py-3">Circuito AT</th>
                    <th className="px-3 py-3">Subestação</th>
                    <th className="px-3 py-3 text-right">Tensão</th>
                    <th className="px-3 py-3 text-right">Comprimento</th>
                  </tr>
                </thead>
                <tbody>
                  {detalhe.infraestrutura_at.circuitos_at.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-center text-xs text-gray-500">
                        Sem circuitos AT relacionados neste município.
                      </td>
                    </tr>
                  ) : (
                    detalhe.infraestrutura_at.circuitos_at.map((item) => (
                        <tr key={item.cod_id} className="border-b border-gray-800/60">
                          <td className="px-3 py-3 font-medium text-white">{item.cod_id}</td>
                          <td className="px-3 py-3 text-gray-300">
                            {item.subestacao_id ? (
                              <Link
                                href={`/subestacao/${encodeURIComponent(item.subestacao_id)}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
                                className="transition-colors hover:text-blue-400"
                              >
                                {item.subestacao_id}
                              </Link>
                            ) : '—'}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.tensao_nom ?? '—'}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.comprimento_km?.toFixed(1) ?? '—'} km</td>
                        </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Clientes AT e Geração</h3>
            <p className="mt-1 text-xs text-gray-500">Cadastro público associado ao município. Não representa despacho, fluxo ou operação observada.</p>
          </div>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Clientes AT</div>
              <div className="mt-2 text-2xl font-bold text-blue-300">{formatN(detalhe.clientes_geracao.clientes_at)}</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Geração AT</div>
              <div className="mt-2 text-2xl font-bold text-emerald-300">{formatN(detalhe.clientes_geracao.geracao_at)}</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Geração MT</div>
              <div className="mt-2 text-2xl font-bold text-emerald-300">{formatN(detalhe.clientes_geracao.geracao_mt)}</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Geração BT</div>
              <div className="mt-2 text-2xl font-bold text-emerald-300">{formatN(detalhe.clientes_geracao.geracao_bt)}</div>
            </div>
          </div>
        </section>

        {detalhe.alimentadores.length > 0 && (
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">
                Alimentadores relacionados
              </h3>
              <span className="text-xs text-gray-500">
                Drilldown operacional do município
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-400">
                    <th className="px-3 py-3">Alimentador</th>
                    <th className="px-3 py-3">Subestação</th>
                    <th className="px-3 py-3 text-right">MT</th>
                    <th className="px-3 py-3 text-right">Gap severo</th>
                    <th className="px-3 py-3 text-right">Transform.</th>
                    <th className="px-3 py-3 text-right">Relig.</th>
                    <th className="px-3 py-3 text-right">Clientes</th>
                  </tr>
                </thead>
                <tbody>
                  {detalhe.alimentadores.map((alimentador) => (
                    <tr key={alimentador.cod_id} className="border-b border-gray-800/60">
                      <td className="px-3 py-3">
                        <Link
                          href={`/alimentador/${encodeURIComponent(alimentador.cod_id)}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
                          className="font-medium text-white transition-colors hover:text-blue-400"
                        >
                          {alimentador.cod_id}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-gray-300">
                        {alimentador.subestacao_id ? (
                          <Link
                            href={`/subestacao/${encodeURIComponent(alimentador.subestacao_id)}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
                            className="transition-colors hover:text-blue-400"
                          >
                            {alimentador.subestacao_id}
                          </Link>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-300">{alimentador.km_mt?.toFixed(1) ?? '—'} km</td>
                      <td className="px-3 py-3 text-right tabular-nums text-orange-400">{alimentador.km_gap_severo?.toFixed(1) ?? '—'} km</td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-300">{alimentador.n_transformadores ?? '—'}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-300">{alimentador.n_religadores ?? '—'}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-300">{formatN(alimentador.clientes_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Critical transformers table */}
        {criticosTrans.length > 0 && (
          <section>
            <h3 className="text-lg font-semibold text-gray-300 mb-4">
              Transformadores em Atenção
              <span className="ml-2 text-xs text-gray-500 font-normal">
                (criticidade estimada por idade + proximidade de religadores)
              </span>
            </h3>
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-800/80 text-gray-400 text-xs uppercase tracking-wider">
                      <th className="px-3 py-3 text-left">Código</th>
                      <th className="px-3 py-3 text-left">Fabricante</th>
                      <th className="px-3 py-3 text-right">Potência (kVA)</th>
                      <th className="px-3 py-3 text-right">Idade (anos)</th>
                      <th className="px-3 py-3 text-right">Vida restante</th>
                      <th className="px-3 py-3 text-center">Status</th>
                      <th className="px-3 py-3 text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {criticosTrans.map((t, i) => (
                      <tr key={t.properties.cod_id ?? i}
                          className="border-b border-gray-800/60 hover:bg-gray-800/40 transition-colors">
                        <td className="px-3 py-2.5 text-gray-300 font-mono text-xs">
                          {t.properties.cod_id ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-gray-400 text-xs">
                          {t.properties.fabricante ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-300 tabular-nums text-xs">
                          {t.properties.potencia_nom?.toFixed(0) ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-300 tabular-nums text-xs">
                          {t.properties.idade_anos ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-400 tabular-nums text-xs">
                          {t.properties.vida_util_restante_anos ?? '—'} a
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusBadge(t.properties.status)}`}>
                          {t.properties.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                        <span className={scoreColor(t.properties.score_equipamento)}>
                            {t.properties.score_equipamento?.toFixed(0) ?? '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  )
}
