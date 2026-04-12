'use client'

interface AlimentadorItem {
  cod_id: string
  distribuidora: string
  uf: string
  subestacao_id: string | null
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

interface PainelAlimentadoresProps {
  data: AlimentadorItem[]
  total: number
  page: number
  onPageChange: (page: number) => void
  loading?: boolean
}

const PAGE_SIZE = 20

function formatCompact(value: number | null | undefined, digits = 1): string {
  if (value == null) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return digits === 0 ? value.toFixed(0) : value.toFixed(digits)
}

function distTone(value: number | null | undefined): string {
  if (value == null || value <= 0) return 'text-gray-500'
  if (value >= 30) return 'text-red-400'
  if (value >= 10) return 'text-orange-400'
  return 'text-yellow-300'
}

function kmAutoTone(value: number | null | undefined): string {
  if (value == null) return 'text-gray-500'
  if (value >= 50) return 'text-red-400'
  if (value >= 15) return 'text-orange-400'
  return 'text-gray-300'
}

const rankStyle: Record<number, { badge: string; text: string }> = {
  1: { badge: 'bg-yellow-500/20 text-yellow-300 border border-yellow-600/40', text: 'text-yellow-300' },
  2: { badge: 'bg-gray-400/20 text-gray-300 border border-gray-500/40',       text: 'text-gray-300'  },
  3: { badge: 'bg-orange-700/20 text-orange-400 border border-orange-700/40', text: 'text-orange-400' },
}

function RankBadge({ rank }: { rank: number }) {
  const style = rankStyle[rank]
  if (!style) {
    return <span className="font-mono text-xs text-gray-600">{rank}</span>
  }
  return (
    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${style.badge}`}>
      {rank}
    </span>
  )
}

function SkeletonRow() {
  return (
    <tr className="border-b border-gray-800/60 animate-pulse">
      {Array.from({ length: 13 }).map((_, i) => (
        <td key={i} className="px-3 py-3">
          <div className={`h-3.5 rounded bg-gray-800/80 ${i % 3 === 0 ? 'w-3/4' : i % 3 === 1 ? 'w-1/2' : 'w-2/3'}`} />
        </td>
      ))}
    </tr>
  )
}

export default function PainelAlimentadores({
  data,
  total,
  page,
  onPageChange,
  loading = false,
}: PainelAlimentadoresProps) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const startRank = (page - 1) * PAGE_SIZE + 1

  return (
    <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700/80 bg-gray-800/60 text-xs uppercase tracking-wider text-gray-400">
              <th className="w-12 px-3 py-3 text-center">#</th>
              <th className="px-3 py-3 text-left">Alimentador</th>
              <th className="px-3 py-3 text-left">Subestação</th>
              <th className="px-3 py-3 text-left">UF</th>
              <th className="px-3 py-3 text-right">Municípios</th>
              <th className="px-3 py-3 text-right">MT (km)</th>
              <th className="px-3 py-3 text-right">km/auto</th>
              <th className="px-3 py-3 text-right">Dist. máx. auto</th>
              <th className="px-3 py-3 text-right">Dist. manobra</th>
              <th className="px-3 py-3 text-right">Dist. transf.</th>
              <th className="px-3 py-3 text-right">Transform.</th>
              <th className="px-3 py-3 text-right">Clientes</th>
              <th className="px-3 py-3 text-right">Expostos</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} />)
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={13} className="px-6 py-14 text-center">
                  <div className="text-gray-600 text-2xl mb-2">—</div>
                  <div className="text-sm text-gray-500">Nenhum alimentador encontrado com os filtros aplicados.</div>
                </td>
              </tr>
            ) : (
              data.map((item, index) => {
                const rank = startRank + index
                const isTop3 = rank <= 3
                return (
                  <tr
                    key={`${item.uf}-${item.distribuidora}-${item.cod_id}`}
                    className={`border-b border-gray-800/50 transition-colors duration-150 hover:bg-gray-800/50 cursor-pointer ${isTop3 ? 'bg-gray-900/80' : ''}`}
                  >
                    <td className="px-3 py-3 text-center">
                      <RankBadge rank={rank} />
                    </td>
                    <td className="px-3 py-3">
                      <a
                        href={`/alimentador/${encodeURIComponent(item.cod_id)}?uf=${encodeURIComponent(item.uf)}&distribuidora=${encodeURIComponent(item.distribuidora)}`}
                        className="font-semibold text-white transition-colors hover:text-blue-400 cursor-pointer"
                      >
                        {item.cod_id}
                      </a>
                      <div className="mt-0.5 text-[11px] text-gray-500">{item.distribuidora}</div>
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-400">
                      {item.subestacao_id ? (
                        <a
                          href={`/subestacao/${encodeURIComponent(item.subestacao_id)}?uf=${encodeURIComponent(item.uf)}&distribuidora=${encodeURIComponent(item.distribuidora)}`}
                          className="transition-colors hover:text-blue-400 cursor-pointer"
                        >
                          {item.subestacao_id}
                        </a>
                      ) : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-mono text-xs font-medium text-gray-400 bg-gray-800 rounded px-1.5 py-0.5">
                        {item.uf}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-gray-400">
                      {item.municipios_count ?? item.municipios_atendidos?.length ?? 0}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-gray-200">
                      {formatCompact(item.km_mt, 1)}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono text-xs tabular-nums ${kmAutoTone(item.km_por_equipamento_auto)}`}>
                      {item.km_por_equipamento_auto != null ? `${item.km_por_equipamento_auto.toFixed(1)}` : '—'}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono text-xs tabular-nums font-medium ${distTone(item.max_dist_equipamento_auto_km ?? item.max_dist_religador_km)}`}>
                      {item.max_dist_equipamento_auto_km != null
                        ? `${item.max_dist_equipamento_auto_km.toFixed(1)} km`
                        : item.max_dist_religador_km != null
                          ? `${item.max_dist_religador_km.toFixed(1)} km`
                          : <span className="text-gray-700">—</span>}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono text-xs tabular-nums ${distTone(item.max_dist_manobra_km)}`}>
                      {item.max_dist_manobra_km != null ? `${item.max_dist_manobra_km.toFixed(1)} km` : <span className="text-gray-700">—</span>}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono text-xs tabular-nums ${distTone(item.max_dist_transferencia_km)}`}>
                      {item.max_dist_transferencia_km != null ? `${item.max_dist_transferencia_km.toFixed(1)} km` : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-gray-400">
                      {formatCompact(item.n_transformadores, 0)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-gray-300">
                      {formatCompact(item.clientes_total, 0)}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono text-xs tabular-nums ${item.clientes_gap_severo_total != null && item.clientes_gap_severo_total > 0 ? 'text-orange-400' : 'text-gray-700'}`}>
                      {item.clientes_gap_severo_total == null ? '—' : formatCompact(item.clientes_gap_severo_total, 0)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-gray-800 bg-gray-900/80 px-4 py-3">
        <div className="text-xs text-gray-500">
          {loading ? (
            <span className="animate-pulse text-gray-600">Carregando...</span>
          ) : (
            <>
              Página{' '}
              <span className="font-semibold text-gray-300">{page}</span>
              {' '}de{' '}
              <span className="font-semibold text-gray-300">{totalPages}</span>
              {total > 0 && (
                <> — <span className="text-gray-400">{total.toLocaleString('pt-BR')}</span> alimentadores</>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || loading}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition-all duration-150 hover:bg-gray-700 hover:text-white hover:border-gray-600 disabled:cursor-not-allowed disabled:opacity-25 cursor-pointer"
          >
            ← Anterior
          </button>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || loading}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition-all duration-150 hover:bg-gray-700 hover:text-white hover:border-gray-600 disabled:cursor-not-allowed disabled:opacity-25 cursor-pointer"
          >
            Próximo →
          </button>
        </div>
      </div>
    </div>
  )
}
