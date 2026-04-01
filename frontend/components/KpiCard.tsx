interface KpiCardProps {
  title: string
  value: string | number
  subtitle?: string
  color?: 'green' | 'yellow' | 'orange' | 'red' | 'blue'
}

const colorMap: Record<NonNullable<KpiCardProps['color']>, string> = {
  green: 'border-green-500',
  yellow: 'border-yellow-400',
  orange: 'border-orange-500',
  red: 'border-red-500',
  blue: 'border-blue-500',
}

const valuColorMap: Record<NonNullable<KpiCardProps['color']>, string> = {
  green: 'text-green-400',
  yellow: 'text-yellow-300',
  orange: 'text-orange-400',
  red: 'text-red-400',
  blue: 'text-blue-400',
}

export default function KpiCard({
  title,
  value,
  subtitle,
  color = 'blue',
}: KpiCardProps) {
  const borderColor = colorMap[color]
  const valueColor = valuColorMap[color]

  return (
    <div
      className={`bg-gray-900 border border-gray-800 border-l-4 ${borderColor} rounded-lg px-5 py-4 flex flex-col gap-1 hover:bg-gray-800/60 transition-colors`}
    >
      <span className="text-gray-400 text-xs font-medium uppercase tracking-wider">
        {title}
      </span>
      <span className={`text-3xl font-bold tabular-nums ${valueColor}`}>
        {value}
      </span>
      {subtitle && (
        <span className="text-gray-500 text-xs leading-snug">{subtitle}</span>
      )}
    </div>
  )
}
