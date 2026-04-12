interface KpiCardProps {
  title: string
  value: string | number
  subtitle?: string
  color?: 'green' | 'yellow' | 'orange' | 'red' | 'blue' | 'purple'
  loading?: boolean
}

const colorConfig: Record<NonNullable<KpiCardProps['color']>, {
  border: string
  value: string
  glow: string
  accent: string
}> = {
  green:  { border: 'border-l-emerald-500',  value: 'text-emerald-400',  glow: 'glow-green',  accent: 'bg-emerald-500/10' },
  yellow: { border: 'border-l-yellow-400',   value: 'text-yellow-300',   glow: 'glow-amber',  accent: 'bg-yellow-500/10' },
  orange: { border: 'border-l-orange-500',   value: 'text-orange-400',   glow: 'glow-amber',  accent: 'bg-orange-500/10' },
  red:    { border: 'border-l-red-500',      value: 'text-red-400',      glow: 'glow-red',    accent: 'bg-red-500/10' },
  blue:   { border: 'border-l-blue-500',     value: 'text-blue-400',     glow: 'glow-blue',   accent: 'bg-blue-500/10' },
  purple: { border: 'border-l-violet-500',   value: 'text-violet-300',   glow: 'glow-purple', accent: 'bg-violet-500/10' },
}

function SkeletonKpi() {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 border-l-4 border-l-gray-700 px-5 py-4 flex flex-col gap-2 animate-pulse">
      <div className="h-3 w-2/3 rounded bg-gray-800" />
      <div className="h-8 w-1/2 rounded bg-gray-800" />
      <div className="h-3 w-3/4 rounded bg-gray-800" />
    </div>
  )
}

export default function KpiCard({
  title,
  value,
  subtitle,
  color = 'blue',
  loading = false,
}: KpiCardProps) {
  if (loading) return <SkeletonKpi />

  const cfg = colorConfig[color]

  return (
    <div
      className={`rounded-xl border border-gray-800 bg-gray-900 border-l-4 ${cfg.border} px-5 py-4 flex flex-col gap-1 cursor-default transition-all duration-200 hover:bg-gray-800/60 hover:border-gray-700`}
    >
      <span className="text-gray-400 text-xs font-medium uppercase tracking-wider leading-tight">
        {title}
      </span>
      <span className={`text-3xl font-bold tabular-nums leading-none mt-1 ${cfg.value}`}>
        {value}
      </span>
      {subtitle && (
        <span className="text-gray-500 text-xs leading-snug mt-0.5">{subtitle}</span>
      )}
    </div>
  )
}
