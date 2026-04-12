'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import KpiCard from '@/components/KpiCard'
import PainelAlimentadores from '@/components/PainelAlimentadores'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

const fetcher = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }
  return response.json()
}

interface KpisData {
  alimentadores_monitorados: number
  alimentadores_com_gap_severo: number
  km_mt_total: number | null
  km_gap_severo_total: number | null
  densidade_media_automacao: number | null
  subestacoes_total: number
  clientes_gap_severo_total: number | null
  alimentadores_com_exposicao_disponivel: number
  clientes_bt_total: number | null
  clientes_mt_total: number | null
}

interface RegulatoryContextData {
  dec_medio_municipal_12m: number | null
  fec_medio_municipal_12m: number | null
  municipios_com_violacao_dec: number
  municipios_com_violacao_fec: number
  municipios_com_continuidade: number
  competencia_max: string | null
}

interface KpisAtData {
  circuitos_at: number
  km_at_total: number | null
  transformadores_at: number
  religadores_at: number
  chaves_at: number
  clientes_at: number
  geracao_at: number
  geracao_mt: number
  geracao_bt: number
  subestacoes_com_estrutura: number
  componentes_subestacao_total: number
  top_subestacoes_mt: Array<{
    subestacao_id: string
    feeders_mt: number
    circuitos_at: number
    componentes_estrutura: number
  }>
}

interface UfAvailability {
  uf: string
  nome: string
  distribuidora: string
  status: 'real' | 'parcial' | 'indisponivel'
  municipios_com_score: number
  historico_meses_max: number
}

interface DisponibilidadeResponse {
  data: UfAvailability[]
}

interface AlimentadorItem {
  cod_id: string
  distribuidora: string
  uf: string
  subestacao_id: string | null
  tensao_nom: number | null
  municipios_atendidos: string[] | null
  km_mt: number | null
  km_bt: number | null
  n_transformadores: number | null
  n_religadores: number | null
  n_chaves: number | null
  km_gap_severo: number | null
  n_gaps_severos: number | null
  densidade_religadores_km: number | null
  densidade_chaves_km: number | null
  clientes_bt_total: number | null
  clientes_mt_total: number | null
  clientes_total: number | null
  clientes_gap_severo_total: number | null
  max_dist_religador_km: number | null
  max_dist_equipamento_auto_km: number | null
  max_dist_manobra_km: number | null
  max_dist_transferencia_km: number | null
  km_gap_transferencia: number | null
  km_por_equipamento_auto: number | null
  metodologia_gap: string | null
  lacunas: string[] | null
  municipios_count: number | null
}

interface RankingAlimentadoresResponse {
  data: AlimentadorItem[]
  total: number
  page: number
  limit: number
  pages: number
  order_by: string
}

interface CoberturaBdgdItem {
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

interface CoberturaBdgdResponse {
  data: CoberturaBdgdItem[]
}

function formatLargeNumber(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export default function HomePage() {
  const [uf, setUf] = useState('CE')
  const [distribuidora, setDistribuidora] = useState('')
  const [orderBy, setOrderBy] = useState('max_dist_equipamento_auto_km')
  const [page, setPage] = useState(1)
  const [urlReady, setUrlReady] = useState(false)

  const { data: disponibilidade, error: disponibilidadeError } = useSWR<DisponibilidadeResponse>(
    `${API_URL}/api/disponibilidade-uf`,
    fetcher,
  )

  const suportadas = disponibilidade?.data ?? []
  const selectedUfInfo = suportadas.find((item) => item.uf === uf)
  const distribuidoras = useMemo(
    () => Array.from(new Set(suportadas.filter((item) => item.uf === uf).map((item) => item.distribuidora))).sort(),
    [suportadas, uf],
  )
  const scopedDistribuidora = distribuidora && distribuidoras.includes(distribuidora) ? distribuidora : ''

  useEffect(() => {
    if (!suportadas.length) return
    if (!suportadas.some((item) => item.uf === uf)) {
      setUf(suportadas[0].uf)
    }
  }, [suportadas, uf])

  useEffect(() => {
    if (!distribuidora || distribuidoras.includes(distribuidora)) return
    setDistribuidora('')
    setPage(1)
  }, [distribuidora, distribuidoras])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const nextUf = (params.get('uf') ?? 'CE').toUpperCase()
    const nextDistribuidora = params.get('distribuidora') ?? ''
    const nextOrderBy = params.get('order_by') ?? 'max_dist_equipamento_auto_km'
    const nextPage = Number.parseInt(params.get('page') ?? '1', 10)

    if (nextUf) setUf(nextUf)
    if (nextDistribuidora) setDistribuidora(nextDistribuidora)
    if (nextOrderBy) setOrderBy(nextOrderBy)
    if (Number.isFinite(nextPage) && nextPage > 0) setPage(nextPage)
    setUrlReady(true)
  }, [])

  useEffect(() => {
    if (!urlReady || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    params.set('uf', uf)
    if (scopedDistribuidora) params.set('distribuidora', scopedDistribuidora)
    else params.delete('distribuidora')
    if (orderBy && orderBy !== 'max_dist_equipamento_auto_km') params.set('order_by', orderBy)
    else params.delete('order_by')
    if (page > 1) params.set('page', String(page))
    else params.delete('page')
    const nextUrl = `${window.location.pathname}?${params.toString()}`
    const currentUrl = `${window.location.pathname}${window.location.search}`
    if (nextUrl !== currentUrl) {
      window.history.replaceState(null, '', nextUrl)
    }
  }, [orderBy, page, scopedDistribuidora, uf, urlReady])

  const kpiParams = new URLSearchParams()
  if (uf) kpiParams.set('uf', uf)
  if (scopedDistribuidora) kpiParams.set('distribuidora', scopedDistribuidora)

  const rankingParams = new URLSearchParams({
    page: String(page),
    limit: '20',
    order_by: orderBy,
  })
  if (uf) rankingParams.set('uf', uf)
  if (scopedDistribuidora) rankingParams.set('distribuidora', scopedDistribuidora)

  const { data: kpis, error: kpisError, isLoading: kpisLoading } = useSWR<KpisData>(
    `${API_URL}/api/kpis?${kpiParams.toString()}`,
    fetcher,
  )

  const {
    data: regulatoryContext,
    error: regulatoryContextError,
    isLoading: regulatoryContextLoading,
  } = useSWR<RegulatoryContextData>(
    `${API_URL}/api/contexto-regulatorio?${kpiParams.toString()}`,
    fetcher,
  )

  const { data: kpisAt, error: kpisAtError, isLoading: kpisAtLoading } = useSWR<KpisAtData>(
    `${API_URL}/api/kpis-at?${kpiParams.toString()}`,
    fetcher,
  )

  const { data: coberturaBdgd, error: coberturaBdgdError, isLoading: coberturaBdgdLoading } = useSWR<CoberturaBdgdResponse>(
    `${API_URL}/api/cobertura-bdgd?${kpiParams.toString()}`,
    fetcher,
  )

  const { data: ranking, error: rankingError, isLoading: rankingLoading } = useSWR<RankingAlimentadoresResponse>(
    `${API_URL}/api/ranking-alimentadores?${rankingParams.toString()}`,
    fetcher,
  )

  return (
    <main className="min-h-screen bg-[#030712] text-white">
      <header className="border-b border-gray-800/80 bg-gray-950/95 backdrop-blur-sm px-6 py-4 sticky top-0 z-30">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight font-mono">
              <span className="text-blue-500">Grid</span><span className="text-white">Risk</span>
              <span className="ml-2 text-xs font-sans font-normal text-gray-600 tracking-normal align-middle">v2</span>
            </h1>
            <p className="mt-0.5 text-xs text-gray-500 font-sans">
              Painel operacional · Redes de distribuição MT · AL e CE · Base pública BDGD
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/mapa?uf=${encodeURIComponent(uf)}&distribuidora=${encodeURIComponent(scopedDistribuidora || selectedUfInfo?.distribuidora || '')}`}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all duration-150 hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-900/40 cursor-pointer"
            >
              Ver mapa
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr,1fr]">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-gray-500">Estado operacional</div>
                <select
                  aria-label="Estado operacional"
                  value={uf}
                  onChange={(event) => {
                    setUf(event.target.value)
                    setDistribuidora('')
                    setPage(1)
                  }}
                  className="mt-1 rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                >
                  {suportadas.map((item) => (
                    <option key={item.uf} value={item.uf}>
                      {item.uf} · {item.nome}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-gray-500">Distribuidora</div>
                <select
                  aria-label="Distribuidora"
                  value={distribuidora}
                  onChange={(event) => {
                    setDistribuidora(event.target.value)
                    setPage(1)
                  }}
                  className="mt-1 rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                >
                  <option value="">Todas as distribuidoras suportadas</option>
                  {distribuidoras.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>

              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-gray-500">Ordenação</div>
                <select
                  aria-label="Ordenação do ranking"
                  value={orderBy}
                  onChange={(event) => {
                    setOrderBy(event.target.value)
                    setPage(1)
                  }}
                  className="mt-1 rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                >
                  <option value="max_dist_equipamento_auto_km">Maior distância a equipamento automático</option>
                  <option value="max_dist_manobra_km">Maior distância a ponto de manobra</option>
                  <option value="max_dist_transferencia_km">Maior distância a transferência candidata</option>
                  <option value="km_por_equipamento_auto">Maior km por equipamento automático</option>
                  <option value="clientes_gap_severo_total">Mais clientes sem cobertura automática</option>
                  <option value="n_transformadores">Mais transformadores</option>
                  <option value="km_mt">Maior extensão MT</option>
                </select>
              </div>

              {(distribuidora || orderBy !== 'max_dist_equipamento_auto_km') && (
                <button
                  type="button"
                  onClick={() => {
                    setDistribuidora('')
                    setOrderBy('max_dist_equipamento_auto_km')
                    setPage(1)
                  }}
                  className="mt-5 rounded border border-gray-700 px-3 py-2 text-sm text-gray-400 transition-colors hover:border-gray-500 hover:text-white cursor-pointer"
                >
                  Limpar filtros
                </button>
              )}
            </div>

            <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/70 px-4 py-3 text-sm text-gray-300">
              <div className="font-semibold text-gray-200">Leitura operacional centrada no alimentador</div>
              <div className="mt-2 space-y-1 text-xs leading-5 text-gray-400">
                <p>Priorização por distância topológica ao equipamento público de proteção/religamento automático mais próximo. A leitura de manobra/recomposição aparece como contexto separado.</p>
                <p>Continuidade ANEEL permanece como contexto regulatório municipal de DEC/FEC, não como indicador do circuito.</p>
                <p>Clientes sem cobertura automática são vinculados topologicamente quando ≥95% dos transformadores do alimentador estão mapeados.</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-gray-500">Cobertura real</div>
            {disponibilidadeError ? (
              <div className="mt-3 rounded border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
                Não foi possível carregar a disponibilidade das UFs suportadas.
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {suportadas.map((item) => (
                  <div key={item.uf} className={`rounded-lg border px-4 py-3 ${item.uf === uf ? 'border-blue-700 bg-blue-950/40' : 'border-gray-800 bg-gray-950/50'}`}>
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-white">{item.uf} · {item.nome}</div>
                      <span className="rounded-full border border-emerald-800 bg-emerald-950 px-2 py-0.5 text-[11px] text-emerald-300">
                        {item.status}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-gray-400">
                      {item.distribuidora} · {item.municipios_com_score} municípios com score · {item.historico_meses_max} meses de histórico
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-300">KPIs operacionais</h2>
          {kpisError ? (
            <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-400">
              Erro ao carregar KPIs operacionais.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <KpiCard
                title="Alimentadores monitorados"
                value={kpisLoading ? '—' : kpis?.alimentadores_monitorados ?? '—'}
                subtitle={selectedUfInfo?.distribuidora ?? 'Escopo real suportado'}
                color="blue"
              />
              <KpiCard
                title="Sem cobertura automática"
                value={kpisLoading ? '—' : kpis?.alimentadores_com_gap_severo ?? '—'}
                subtitle="Alimentadores com trechos a mais de 2 km de equipamento automático"
                color="red"
              />
              <KpiCard
                title="Rede sem automação de religamento"
                value={kpisLoading ? '—' : (kpis?.km_gap_severo_total != null ? `${kpis.km_gap_severo_total.toFixed(1)} km` : '—')}
                subtitle="Extensão MT além de 2 km do equipamento automático mais próximo"
                color="red"
              />
              <KpiCard
                title="Rede MT total"
                value={kpisLoading ? '—' : (kpis?.km_mt_total != null ? `${kpis.km_mt_total.toFixed(1)} km` : '—')}
                subtitle="Extensão MT monitorada por alimentador"
                color="orange"
              />
              <KpiCard
                title="Densidade média de proteção/manobra"
                value={kpisLoading ? '—' : (kpis?.densidade_media_automacao != null ? kpis.densidade_media_automacao.toFixed(3) : '—')}
                subtitle="Religadores + chaves cadastradas por km MT"
                color="yellow"
              />
              <KpiCard
                title="Subestações"
                value={kpisLoading ? '—' : kpis?.subestacoes_total ?? '—'}
                subtitle="Subestações reais importadas da BDGD"
                color="blue"
              />
              <KpiCard
                title="Clientes reais"
                value={kpisLoading ? '—' : `${formatLargeNumber(kpis?.clientes_bt_total)} BT / ${formatLargeNumber(kpis?.clientes_mt_total)} MT`}
                subtitle="UCBT e UCMT vinculados por alimentador"
                color="green"
              />
              <KpiCard
                title="Clientes sem cobertura automática"
                value={kpisLoading ? '—' : formatLargeNumber(kpis?.clientes_gap_severo_total)}
                subtitle={kpisLoading ? '—' : `${kpis?.alimentadores_com_exposicao_disponivel ?? 0} alimentadores com vínculo topológico disponível`}
                color="yellow"
              />
            </div>
          )}
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-300">Infraestrutura AT e Subestação</h2>
              <p className="mt-1 text-sm text-gray-500">
                Camada sistêmica de alta tensão e estrutura de subestação, tratada como contexto operacional secundário.
              </p>
            </div>
          </div>

          {kpisAtError ? (
            <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-400">
              Erro ao carregar a infraestrutura AT e a estrutura de subestação.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard
                  title="Circuitos AT"
                  value={kpisAtLoading ? '—' : kpisAt?.circuitos_at ?? '—'}
                  subtitle="Circuitos tipados a partir de CTAT + SSDAT"
                  color="purple"
                />
                <KpiCard
                  title="Rede AT total"
                  value={kpisAtLoading ? '—' : (kpisAt?.km_at_total != null ? `${kpisAt.km_at_total.toFixed(1)} km` : '—')}
                  subtitle="Extensão AT observada em SSDAT"
                  color="red"
                />
                <KpiCard
                  title="Equipamentos AT"
                  value={kpisAtLoading ? '—' : `${formatLargeNumber(kpisAt?.transformadores_at)} TR / ${formatLargeNumber(kpisAt?.religadores_at)} RE / ${formatLargeNumber(kpisAt?.chaves_at)} CH`}
                  subtitle="Transformadores, religadores e chaves AT"
                  color="orange"
                />
                <KpiCard
                  title="Estrutura de subestação"
                  value={kpisAtLoading ? '—' : `${kpisAt?.subestacoes_com_estrutura ?? '—'} SE`}
                  subtitle={kpisAtLoading ? '—' : `${formatLargeNumber(kpisAt?.componentes_subestacao_total)} componentes BAR/BASE/BAY/BE`}
                  color="blue"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard
                  title="Clientes AT"
                  value={kpisAtLoading ? '—' : formatLargeNumber(kpisAt?.clientes_at)}
                  subtitle="UCAT promovidos da BDGD pública"
                  color="blue"
                />
                <KpiCard
                  title="Geração AT"
                  value={kpisAtLoading ? '—' : formatLargeNumber(kpisAt?.geracao_at)}
                  subtitle="UGAT tabular promovida"
                  color="green"
                />
                <KpiCard
                  title="Geração MT"
                  value={kpisAtLoading ? '—' : formatLargeNumber(kpisAt?.geracao_mt)}
                  subtitle="UGMT tabular promovida"
                  color="green"
                />
                <KpiCard
                  title="Geração BT"
                  value={kpisAtLoading ? '—' : formatLargeNumber(kpisAt?.geracao_bt)}
                  subtitle="UGBT tabular promovida"
                  color="green"
                />
              </div>

              <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
                <div className="border-b border-gray-800 px-4 py-3">
                  <div className="text-sm font-semibold text-gray-200">Top subestações por alimentadores MT relacionados</div>
                  <div className="mt-1 text-xs text-gray-500">Visão rápida para navegar entre a malha de alimentadores e o contexto AT/subestação.</div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-800/80 text-xs uppercase tracking-wider text-gray-400">
                        <th className="px-3 py-3 text-left">Subestação</th>
                        <th className="px-3 py-3 text-right">Alimentadores MT</th>
                        <th className="px-3 py-3 text-right">Circuitos AT</th>
                        <th className="px-3 py-3 text-right">Componentes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(kpisAt?.top_subestacoes_mt ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-xs text-gray-500">
                            Nenhuma subestação AT disponível no recorte selecionado.
                          </td>
                        </tr>
                      ) : (
                        (kpisAt?.top_subestacoes_mt ?? []).map((item) => (
                          <tr key={item.subestacao_id} className="border-b border-gray-800/60">
                            <td className="px-3 py-3 font-medium text-white">
                              <Link
                                href={`/subestacao/${encodeURIComponent(item.subestacao_id)}?uf=${encodeURIComponent(uf)}&distribuidora=${encodeURIComponent(scopedDistribuidora || selectedUfInfo?.distribuidora || '')}`}
                                className="transition-colors hover:text-blue-400"
                              >
                                {item.subestacao_id}
                              </Link>
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.feeders_mt}</td>
                            <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.circuitos_at}</td>
                            <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.componentes_estrutura}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </section>

        <section>
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-300">Cobertura da base pública</h2>
            <p className="mt-1 text-sm text-gray-500">
              Reconciliação entre o catálogo raw da BDGD e as tabelas tipadas promovidas para produto.
            </p>
          </div>
          {coberturaBdgdError ? (
            <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-400">
              Erro ao carregar a cobertura da base pública.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-900">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-400">
                    <th className="px-3 py-3">Layer</th>
                    <th className="px-3 py-3">Tabela</th>
                    <th className="px-3 py-3 text-right">Raw</th>
                    <th className="px-3 py-3 text-right">Tipado</th>
                    <th className="px-3 py-3 text-right">Geom. tipada</th>
                    <th className="px-3 py-3">Lacunas</th>
                  </tr>
                </thead>
                <tbody>
                  {coberturaBdgdLoading ? (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-gray-500">Carregando cobertura...</td></tr>
                  ) : (
                    (coberturaBdgd?.data ?? []).map((item) => (
                      <tr key={item.source_layer} className="border-b border-gray-800/60">
                        <td className="px-3 py-3 font-medium text-white">{item.label}</td>
                        <td className="px-3 py-3 text-gray-300">{item.target_table}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.raw_count.toLocaleString('pt-BR')}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.typed_count.toLocaleString('pt-BR')}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.typed_geom_count == null ? '—' : item.typed_geom_count.toLocaleString('pt-BR')}</td>
                        <td className="px-3 py-3 text-xs text-amber-300">{item.lacunas.length > 0 ? item.lacunas.join(', ') : 'sem lacunas relevantes'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-300">Contexto regulatório ANEEL</h2>
              <p className="mt-1 text-sm text-gray-500">
                DEC e FEC continuam como referência municipal do território atendido, não como indicadores do circuito.
              </p>
            </div>
            <span className="rounded-full bg-gray-800 px-3 py-1 text-xs text-gray-400">
              Competência disponível: {regulatoryContextLoading ? '—' : regulatoryContext?.competencia_max ?? '—'}
            </span>
          </div>

          {regulatoryContextError ? (
            <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-400">
              Erro ao carregar o contexto regulatório da ANEEL.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <KpiCard
                title="DEC médio municipal"
                value={regulatoryContextLoading ? '—' : (regulatoryContext?.dec_medio_municipal_12m != null ? `${regulatoryContext.dec_medio_municipal_12m.toFixed(2)}h` : '—')}
                subtitle="Média municipal dos últimos 12 meses disponíveis"
                color="orange"
              />
              <KpiCard
                title="FEC médio municipal"
                value={regulatoryContextLoading ? '—' : (regulatoryContext?.fec_medio_municipal_12m != null ? regulatoryContext.fec_medio_municipal_12m.toFixed(2) : '—')}
                subtitle="Frequência média municipal nos últimos 12 meses"
                color="yellow"
              />
              <KpiCard
                title="Municípios com DEC em violação"
                value={regulatoryContextLoading ? '—' : regulatoryContext?.municipios_com_violacao_dec ?? '—'}
                subtitle="Pelo menos uma violação DEC na janela disponível"
                color="red"
              />
              <KpiCard
                title="Municípios com FEC em violação"
                value={regulatoryContextLoading ? '—' : regulatoryContext?.municipios_com_violacao_fec ?? '—'}
                subtitle="Pelo menos uma violação FEC na janela disponível"
                color="red"
              />
              <KpiCard
                title="Municípios com continuidade"
                value={regulatoryContextLoading ? '—' : regulatoryContext?.municipios_com_continuidade ?? '—'}
                subtitle={selectedUfInfo?.distribuidora ?? 'Escopo regulatório selecionado'}
                color="blue"
              />
            </div>
          )}
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-300">Ranking operacional de alimentadores</h2>
              <p className="mt-1 text-sm text-gray-500">
                Ordenação padrão por extensão de gap severo. Use a ordenação para destacar baixa automação, alta carga de ativos ou maior extensão.
              </p>
            </div>
            {ranking?.total != null && (
              <span className="rounded-full bg-gray-800 px-3 py-1 text-xs text-gray-500">
                {ranking.total.toLocaleString('pt-BR')} alimentadores
              </span>
            )}
          </div>

          {rankingError ? (
            <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-400">
              Erro ao carregar ranking de alimentadores.
            </div>
          ) : (
            <PainelAlimentadores
              data={ranking?.data ?? []}
              total={ranking?.total ?? 0}
              page={page}
              onPageChange={setPage}
              loading={rankingLoading}
            />
          )}
        </section>

      </div>
    </main>
  )
}
