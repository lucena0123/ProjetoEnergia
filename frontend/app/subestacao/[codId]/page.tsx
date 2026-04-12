'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

const MapaLocalSubestacao = dynamic(() => import('@/components/MapaLocalSubestacao'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center rounded-xl border border-gray-800 bg-gray-950 text-sm text-gray-400">
      Carregando mapa local...
    </div>
  ),
})

interface SubestacaoDetalhe {
  data_mode: 'public' | 'partner'
  cod_id: string
  distribuidora: string
  uf: string
  municipio: string | null
  tensao_nom: number | null
  data_implant: string | null
  alimentadores_mt: Array<{
    cod_id: string
    tensao_nom: number | null
    km_mt: number | null
    clientes_total: number | null
    n_religadores: number | null
    n_chaves: number | null
  }>
  circuitos_at: Array<{
    cod_id: string
    nome: string | null
    tensao_nom: number | null
    comprimento_km: number | null
  }>
  equipamentos_at: {
    n_transformadores_at: number
    n_religadores_at: number
    n_chaves_at: number
  }
  clientes_geracao: {
    clientes_at_total: number
    geracao_at_total: number
    geracao_mt_total: number
    geracao_bt_total: number
  }
  estrutura_subestacao: {
    total: number
    componentes: Array<{
      cod_id: string | null
      component_type: string
      sub_grupo: string | null
      descricao: string | null
      tensao_nom: number | null
      data_inicio: string | null
      data_fim: string | null
    }>
    por_tipo: Array<{ component_type: string; total: number }>
  }
  qualidade_dados: {
    lacunas: string[]
  }
}

function formatCompact(value: number | null | undefined, digits = 1): string {
  if (value == null) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toFixed(digits)
}

export default function SubestacaoPage() {
  const params = useParams<{ codId: string }>()
  const searchParams = useSearchParams()
  const codId = decodeURIComponent(params.codId)
  const uf = searchParams.get('uf') ?? ''
  const distribuidora = searchParams.get('distribuidora') ?? ''

  const [detalhe, setDetalhe] = useState<SubestacaoDetalhe | null>(null)
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
        const response = await fetch(`${API_URL}/api/subestacao/${encodeURIComponent(codId)}/detalhe?${qs.toString()}`)
        if (!response.ok) {
          setError('Subestação não encontrada.')
          return
        }
        setDetalhe(await response.json())
      } catch (loadError) {
        console.error(loadError)
        setError('Erro ao carregar o detalhe da subestação.')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [codId, distribuidora, uf])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="space-y-3 text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <p className="text-sm text-gray-400">Carregando subestação {codId}...</p>
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
              <span className="text-red-500">Grid</span>Risk — Subestação {detalhe.cod_id}
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
                  <p className="text-xs uppercase tracking-wide text-gray-500">Município</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detalhe.municipio ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Tensão</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detalhe.tensao_nom ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Alimentadores MT</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detalhe.alimentadores_mt.length}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Circuitos AT</p>
                  <p className="mt-1 text-lg font-semibold text-white">{detalhe.circuitos_at.length}</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3 text-sm text-gray-300">
              <div className="font-semibold text-gray-200">Leitura pública</div>
              <div className="mt-2 space-y-1 text-xs leading-5 text-gray-400">
                <p>Esta página usa apenas cadastro público real da BDGD e separa lacunas estruturais da própria base.</p>
                <p>UNREAT, BASE e BE continuam explícitos como lacunas quando a publicação pública não traz geometria útil.</p>
              </div>
            </div>
          </div>
        </section>

        {detalhe.qualidade_dados.lacunas.length > 0 && (
          <section className="rounded-xl border border-amber-700/60 bg-amber-950/40 px-5 py-4 text-sm text-amber-100">
            <div className="font-semibold tracking-wide text-amber-300">Lacunas da base pública</div>
            <ul className="mt-2 space-y-1 text-amber-50/90">
              {detalhe.qualidade_dados.lacunas.map((lacuna) => (
                <li key={lacuna}>{lacuna}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500">Transformadores AT</div>
            <div className="mt-2 text-3xl font-black text-violet-300">{detalhe.equipamentos_at.n_transformadores_at}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500">Religadores AT</div>
            <div className="mt-2 text-3xl font-black text-cyan-300">{detalhe.equipamentos_at.n_religadores_at}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500">Chaves AT</div>
            <div className="mt-2 text-3xl font-black text-amber-300">{detalhe.equipamentos_at.n_chaves_at}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500">Estrutura tipada</div>
            <div className="mt-2 text-3xl font-black text-fuchsia-300">{detalhe.estrutura_subestacao.total}</div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500">Clientes AT</div>
            <div className="mt-2 text-3xl font-black text-blue-300">{detalhe.clientes_geracao.clientes_at_total}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500">Geração AT</div>
            <div className="mt-2 text-3xl font-black text-emerald-300">{detalhe.clientes_geracao.geracao_at_total}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500">Geração MT</div>
            <div className="mt-2 text-3xl font-black text-emerald-300">{detalhe.clientes_geracao.geracao_mt_total}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500">Geração BT</div>
            <div className="mt-2 text-3xl font-black text-emerald-300">{detalhe.clientes_geracao.geracao_bt_total}</div>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="overflow-x-auto rounded-xl border border-gray-800 bg-gray-900 p-5">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-300">Alimentadores MT relacionados</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-400">
                  <th className="px-3 py-3">Alimentador</th>
                  <th className="px-3 py-3 text-right">Tensão</th>
                  <th className="px-3 py-3 text-right">MT</th>
                  <th className="px-3 py-3 text-right">Clientes</th>
                </tr>
              </thead>
              <tbody>
                {detalhe.alimentadores_mt.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-xs text-gray-500">Sem alimentadores MT relacionados.</td></tr>
                ) : (
                  detalhe.alimentadores_mt.map((item) => (
                    <tr key={item.cod_id} className="border-b border-gray-800/60">
                      <td className="px-3 py-3">
                        <Link
                          href={`/alimentador/${encodeURIComponent(item.cod_id)}?uf=${encodeURIComponent(detalhe.uf)}&distribuidora=${encodeURIComponent(detalhe.distribuidora)}`}
                          className="font-medium text-white transition-colors hover:text-blue-400"
                        >
                          {item.cod_id}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.tensao_nom ?? '—'}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.km_mt?.toFixed(1) ?? '—'} km</td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-300">{formatCompact(item.clientes_total, 0)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          <section className="overflow-x-auto rounded-xl border border-gray-800 bg-gray-900 p-5">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-300">Circuitos AT relacionados</h3>
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
                {detalhe.circuitos_at.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-xs text-gray-500">Sem circuitos AT relacionados.</td></tr>
                ) : (
                  detalhe.circuitos_at.map((item) => (
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
          </section>
        </div>

        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-300">Estrutura da subestação</h3>
          <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            {detalhe.estrutura_subestacao.por_tipo.map((item) => (
              <div key={item.component_type} className="rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">{item.component_type}</div>
                <div className="mt-2 text-2xl font-bold text-white">{item.total}</div>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-400">
                  <th className="px-3 py-3">Tipo</th>
                  <th className="px-3 py-3">Código</th>
                  <th className="px-3 py-3">Subgrupo</th>
                  <th className="px-3 py-3">Descrição</th>
                  <th className="px-3 py-3 text-right">Tensão</th>
                </tr>
              </thead>
              <tbody>
                {detalhe.estrutura_subestacao.componentes.length === 0 ? (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-gray-500">Sem componentes tipados para esta subestação.</td></tr>
                ) : (
                  detalhe.estrutura_subestacao.componentes.slice(0, 120).map((item, index) => (
                    <tr key={`${item.component_type}-${item.cod_id ?? index}`} className="border-b border-gray-800/60">
                      <td className="px-3 py-3 text-gray-300">{item.component_type}</td>
                      <td className="px-3 py-3 font-medium text-white">{item.cod_id ?? '—'}</td>
                      <td className="px-3 py-3 text-gray-300">{item.sub_grupo ?? '—'}</td>
                      <td className="px-3 py-3 text-gray-300">{item.descricao ?? '—'}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-300">{item.tensao_nom ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Mapa local</h3>
            <p className="mt-1 text-xs text-gray-500">Contexto AT, alimentadores MT relacionados e componentes georreferenciados da subestação.</p>
          </div>
          <MapaLocalSubestacao codId={detalhe.cod_id} uf={detalhe.uf} distribuidora={detalhe.distribuidora} />
        </section>
      </div>
    </main>
  )
}
