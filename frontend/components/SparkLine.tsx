'use client'

interface SparkLineProps {
  data: number[]
  width?: number
  height?: number
  color?: string
}

export default function SparkLine({
  data,
  width = 120,
  height = 32,
  color,
}: SparkLineProps) {
  if (!data || data.length === 0) return null

  const lastVal = data[data.length - 1]
  const lineColor =
    color ??
    (lastVal >= 80
      ? '#f87171'
      : lastVal >= 60
      ? '#fb923c'
      : lastVal >= 40
      ? '#facc15'
      : '#4ade80')

  const min = Math.min(...data, 0)
  const max = Math.max(...data, 100)
  const range = max - min || 1

  const padX = 2
  const padY = 2
  const innerW = width - padX * 2
  const innerH = height - padY * 2

  const points = data.map((v, i) => {
    const x = padX + (i / Math.max(data.length - 1, 1)) * innerW
    const y = padY + innerH - ((v - min) / range) * innerH
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      {/* Last data point dot */}
      {points.length > 0 && (
        <circle
          cx={parseFloat(points[points.length - 1].split(',')[0])}
          cy={parseFloat(points[points.length - 1].split(',')[1])}
          r="2"
          fill={lineColor}
        />
      )}
    </svg>
  )
}
