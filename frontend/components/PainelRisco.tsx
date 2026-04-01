'use client'

interface MunicipioRisco {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number
  dec_medio_12m: number
  meses_violacao: number
  idade_media_anos: number
}

interface PainelRiscoProps {
  data: MunicipioRisco[]
  total: number
  page: number
  onPageChange: (page: number) => void
  loading?: boolean
}

function scoreColor(score: number): string {
  if (score >= 80) return 'bg-red-900/60 text-red-300 border border-red-700'
  if (score >= 60) return 'bg-orange-900/60 text-orange-300 border border-orange-700'
  if (score >= 40) return 'bg-yellow-900/60 text-yellow-300 border border-yellow-700'
  return 'bg-green-900/60 text-green-300 border border-green-700'
}

const PAGE_SIZE = 20

function SkeletonRow() {
  return (
    <tr className="border-b border-gray-800 animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <td key={i} className="px-3 py-3">
          <div className="h-3.5 bg-gray-800 rounded w-full" />
        </td>
      ))}
    </tr>
  )
}

export default function PainelRisco({
  data,
  total,
  page,
  onPageChange,
  loading = false,
}: PainelRiscoProps) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const startRank = (page - 1) * PAGE_SIZE + 1

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/80 text-gray-400 text-xs uppercase tracking-wider">
              <th className="px-3 py-3 text-left w-12">#</th>
              <th className="px-3 py-3 text-left">Município</th>
              <th className="px-3 py-3 text-left w-12">UF</th>
              <th className="px-3 py-3 text-left">Distribuidora</th>
              <th className="px-3 py-3 text-center">Score</th>
              <th className="px-3 py-3 text-right">DEC Médio (h)</th>
              <th className="px-3 py-3 text-right">Meses Violação</th>
              <th className="px-3 py-3 text-right">Idade Rede (a)</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} />)
            ) : data.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-6 py-12 text-center text-gray-500 text-sm"
                >
                  Nenhum município encontrado com os filtros aplicados.
                </td>
              </tr>
            ) : (
              data.map((item, idx) => {
                const rank = startRank + idx
                return (
                  <tr
                    key={`${item.municipio}-${item.uf}-${idx}`}
                    className="border-b border-gray-800/60 hover:bg-gray-800/40 transition-colors"
                  >
                    <td className="px-3 py-3 text-gray-500 tabular-nums font-mono text-xs">
                      {rank}
                    </td>
                    <td className="px-3 py-3 font-medium text-white">
                      {item.municipio}
                    </td>
                    <td className="px-3 py-3 text-gray-400 font-mono text-xs">
                      {item.uf}
                    </td>
                    <td className="px-3 py-3 text-gray-300 text-xs">
                      {item.distribuidora}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-bold tabular-nums ${scoreColor(item.score_risco)}`}
                      >
                        {item.score_risco?.toFixed(1)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right text-gray-300 tabular-nums text-xs">
                      {item.dec_medio_12m?.toFixed(2)}
                    </td>
                    <td className="px-3 py-3 text-right text-gray-300 tabular-nums text-xs">
                      {item.meses_violacao}
                    </td>
                    <td className="px-3 py-3 text-right text-gray-300 tabular-nums text-xs">
                      {item.idade_media_anos?.toFixed(1)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800 bg-gray-900/60">
        <div className="text-xs text-gray-500">
          {loading ? (
            <span className="animate-pulse">Carregando...</span>
          ) : (
            <>
              Página <span className="text-gray-300 font-medium">{page}</span> de{' '}
              <span className="text-gray-300 font-medium">{totalPages}</span>
              {total > 0 && (
                <>
                  {' '}— {total.toLocaleString('pt-BR')} resultado
                  {total !== 1 ? 's' : ''}
                </>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || loading}
            className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Anterior
          </button>

          {/* Page number buttons (show up to 5 around current page) */}
          <div className="hidden sm:flex items-center gap-1">
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const halfWindow = 2
              let startPage = Math.max(1, page - halfWindow)
              const endPage = Math.min(totalPages, startPage + 4)
              startPage = Math.max(1, endPage - 4)
              return startPage + i
            })
              .filter((p) => p >= 1 && p <= totalPages)
              .map((p) => (
                <button
                  key={p}
                  onClick={() => onPageChange(p)}
                  disabled={loading}
                  className={`w-7 h-7 text-xs rounded border transition-colors ${
                    p === page
                      ? 'bg-blue-600 border-blue-600 text-white font-medium'
                      : 'border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-white'
                  } disabled:cursor-not-allowed`}
                >
                  {p}
                </button>
              ))}
          </div>

          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || loading}
            className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Próximo
          </button>
        </div>
      </div>
    </div>
  )
}
