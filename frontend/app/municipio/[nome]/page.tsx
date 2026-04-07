'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import SparkLine from '@/components/SparkLine'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

interface DetalheData {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
  dec_medio_12m: number | null
  dec_limite: number | null
  ratio_dec: number | null
  meses_violacao: number | null
  tendencia: string
  rede: {
    comprimento_mt_km: number
    comprimento_bt_km: number
    n_transformadores: number
    potencia_total_kva: number
    idade_media_anos: number
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
  qualidade_dados: {
    infraestrutura: 'sintetica' | 'real'
    historico_meses_disponiveis: number
    historico_status: 'completo' | 'parcial' | 'insuficiente'
  }
  historico: Array<{
    ano: number
    mes: number
    score_risco: number
    dec_medio: number | null
  }>
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
  const [detalhe, setDetalhe] = useState<DetalheData | null>(null)
  const [transformadores, setTransformadores] = useState<TransformadorFeature[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [detRes, transRes] = await Promise.all([
          fetch(`${API_URL}/api/municipio/${encodeURIComponent(nome)}/detalhe`),
          fetch(`${API_URL}/api/municipio/${encodeURIComponent(nome)}/transformadores-aging`),
        ])

        if (!detRes.ok) {
          setError(`Município "${nome}" não encontrado.`)
          return
        }

        const detData: DetalheData = await detRes.json()
        setDetalhe(detData)

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
  }, [nome])

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
  const criticosTrans = transformadores
    .filter((t) => t.properties.status === 'critico')
    .slice(0, 20)
  const historicoSuficiente = detalhe.qualidade_dados.historico_status !== 'insuficiente'

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
              Dashboard
            </Link>
            <span className="text-gray-700">|</span>
            <h1 className="text-white font-bold text-lg">
              <span className="text-red-500">Grid</span>Risk — {detalhe.municipio}
            </h1>
          </div>
          <Link
            href="/mapa"
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            Ver no Mapa →
          </Link>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {(detalhe.qualidade_dados.infraestrutura === 'sintetica'
          || detalhe.qualidade_dados.historico_status !== 'completo') && (
          <section className="rounded-xl border border-amber-700/60 bg-amber-950/40 px-5 py-4 text-sm text-amber-100">
            <div className="font-semibold tracking-wide text-amber-300">
              Confiabilidade dos dados
            </div>
            <div className="mt-2 space-y-1 text-amber-50/90">
              {detalhe.qualidade_dados.infraestrutura === 'sintetica' && (
                <p>
                  Infraestrutura, proteção e criticidade desta página ainda usam base demonstrativa.
                  Use estes números apenas para validação do produto.
                </p>
              )}
              {detalhe.qualidade_dados.historico_status !== 'completo' && (
                <p>
                  Histórico disponível: {detalhe.qualidade_dados.historico_meses_disponiveis} mês(es).
                  A tendência ainda não deve ser tratada como série histórica robusta.
                </p>
              )}
              <p>
                População e densidade vêm do IBGE. O score continua sendo uma métrica derivada do projeto.
              </p>
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
              </div>
            ) : (
              <div className="shrink-0 rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3 text-xs text-gray-400">
                Histórico insuficiente para exibir tendência com confiança.
              </div>
            )}
          </div>
        </section>

        {/* KPI mini cards */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide">DEC Médio</p>
            <p className="text-2xl font-bold text-orange-400 mt-1">
              {detalhe.dec_medio_12m?.toFixed(1) ?? '—'}h
            </p>
            <p className="text-gray-600 text-xs mt-0.5">Limite: {detalhe.dec_limite ?? 12}h</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide">Violações DEC</p>
            <p className="text-2xl font-bold text-red-400 mt-1">
              {detalhe.meses_violacao ?? '—'}<span className="text-sm text-gray-500">/12</span>
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
                <dd className="text-white font-medium">{detalhe.rede.idade_media_anos?.toFixed(1)} anos</dd>
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
