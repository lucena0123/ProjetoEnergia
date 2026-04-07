'use client'

import { useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import KpiCard from '@/components/KpiCard'
import PainelRisco from '@/components/PainelRisco'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

const fetcher = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }
  return response.json()
}

interface KpisData {
  score_medio: number
  municipios_criticos: number
  dec_medio_geral: number
  total_meses_violacao: number
}

interface MunicipioRisco {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number
  dec_medio_12m: number
  meses_violacao: number
  idade_media_anos: number
}

interface RankingResponse {
  data: MunicipioRisco[]
  total: number
  page: number
  limit: number
  pages: number
}

export default function HomePage() {
  const [distribuidora, setDistribuidora] = useState('')
  const [uf, setUf] = useState('')
  const [page, setPage] = useState(1)

  const { data: kpis, error: kpisError, isLoading: kpisLoading } = useSWR<KpisData>(
    `${API_URL}/api/kpis`,
    fetcher
  )

  const rankingParams = new URLSearchParams({ page: String(page), limit: '20' })
  if (distribuidora) rankingParams.set('distribuidora', distribuidora)
  if (uf) rankingParams.set('uf', uf.toUpperCase())

  const { data: ranking, error: rankingError, isLoading: rankingLoading } = useSWR<RankingResponse>(
    `${API_URL}/api/ranking-municipios?${rankingParams.toString()}`,
    fetcher
  )

  const distribuidoras = ranking?.data
    ? Array.from(new Set(ranking.data.map((m) => m.distribuidora))).sort()
    : []

  const handleDistribuidoraChange = (value: string) => {
    setDistribuidora(value)
    setPage(1)
  }

  const handleUfChange = (value: string) => {
    setUf(value)
    setPage(1)
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">
              <span className="text-red-500">Grid</span>Risk
            </h1>
            <p className="text-gray-400 text-sm mt-0.5">
              Dashboard de Risco da Rede Elétrica Brasileira
            </p>
          </div>
          <Link
            href="/mapa"
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 transition-colors text-white text-sm font-medium px-4 py-2 rounded-lg"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
              />
            </svg>
            Ver Mapa
          </Link>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* KPI Cards */}
        <section>
          <h2 className="text-lg font-semibold text-gray-300 mb-4">Indicadores Gerais</h2>
          {kpisError ? (
            <div className="text-red-400 text-sm bg-red-950 border border-red-800 rounded-lg px-4 py-3">
              Erro ao carregar KPIs. Verifique a conexão com a API.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                title="Score Médio"
                value={kpisLoading ? '—' : (kpis?.score_medio?.toFixed(1) ?? '—')}
                subtitle="Índice de risco consolidado"
                color={
                  kpis?.score_medio == null
                    ? 'blue'
                    : kpis.score_medio >= 80
                    ? 'red'
                    : kpis.score_medio >= 60
                    ? 'orange'
                    : kpis.score_medio >= 40
                    ? 'yellow'
                    : 'green'
                }
              />
              <KpiCard
                title="Municípios Críticos (>70)"
                value={kpisLoading ? '—' : (kpis?.municipios_criticos ?? '—')}
                subtitle="Score de risco acima de 70"
                color="red"
              />
              <KpiCard
                title="DEC Médio (h)"
                value={kpisLoading ? '—' : (kpis?.dec_medio_geral?.toFixed(2) ?? '—')}
                subtitle="Duração equiv. de interrupção"
                color="orange"
              />
              <KpiCard
                title="Meses c/ Violação"
                value={kpisLoading ? '—' : (kpis?.total_meses_violacao ?? '—')}
                subtitle="Meses com DEC acima do limite"
                color="yellow"
              />
            </div>
          )}
        </section>

        {/* Filters */}
        <section>
          <h2 className="text-lg font-semibold text-gray-300 mb-4">Filtros</h2>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="distribuidora-select" className="text-xs text-gray-400 uppercase tracking-wide">
                Distribuidora
              </label>
              <select
                id="distribuidora-select"
                value={distribuidora}
                onChange={(e) => handleDistribuidoraChange(e.target.value)}
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 min-w-[220px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">Todas as distribuidoras</option>
                {distribuidoras.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="uf-input" className="text-xs text-gray-400 uppercase tracking-wide">
                UF (Estado)
              </label>
              <input
                id="uf-input"
                type="text"
                placeholder="Ex: SP, RJ, MG..."
                value={uf}
                onChange={(e) => handleUfChange(e.target.value)}
                maxLength={2}
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 w-32 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-500 uppercase"
              />
            </div>

            {(distribuidora || uf) && (
              <div className="flex flex-col justify-end">
                <button
                  onClick={() => {
                    setDistribuidora('')
                    setUf('')
                    setPage(1)
                  }}
                  className="text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 transition-colors rounded-lg px-3 py-2"
                >
                  Limpar filtros
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Ranking Table */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-300">
              Ranking de Municípios por Risco
            </h2>
            {ranking?.total != null && (
              <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1 rounded-full">
                {ranking.total.toLocaleString('pt-BR')} municípios
              </span>
            )}
          </div>

          {rankingError ? (
            <div className="text-red-400 text-sm bg-red-950 border border-red-800 rounded-lg px-4 py-3">
              Erro ao carregar ranking. Verifique a conexão com a API.
            </div>
          ) : (
            <PainelRisco
              data={ranking?.data ?? []}
              total={ranking?.total ?? 0}
              page={page}
              onPageChange={setPage}
              loading={rankingLoading}
            />
          )}
        </section>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-800 mt-12 px-6 py-4">
        <div className="max-w-7xl mx-auto text-center text-gray-600 text-xs">
          GridRisk — Plataforma de análise de risco da distribuição de energia elétrica no Brasil
        </div>
      </footer>
    </main>
  )
}
