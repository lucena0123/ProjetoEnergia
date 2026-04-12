import maplibregl from 'maplibre-gl'

const ICON_CANVAS_SIZE = 64
const ICON_PIXEL_RATIO = 2

type SubtypeStatus = 'disponivel' | 'unico' | 'indisponivel'
type MarkerKind = 'none' | 'dot' | 'slash' | 'single-bar' | 'triple-bar' | 'diamond' | 'blade'

type ColorPair = {
  fill: string
  stroke: string
}

export interface EquipmentSubtypeStyle {
  key: string
  label: string
  color: string
  status: SubtypeStatus
}

const SYMBOL_IDS = {
  transformerLow: 'equipment-transformer-low',
  transformerMedium: 'equipment-transformer-medium',
  transformerHigh: 'equipment-transformer-high',
  transformerCritical: 'equipment-transformer-critical',
  transformerAt: 'equipment-transformer-at',
  religador: 'equipment-religador',
  religadorAt: 'equipment-religador-at',
  subestacao: 'equipment-subestacao',
} as const

const CHAVE_SUBTYPE_KEYS = [
  'chave_fusivel',
  'chave_seccionadora',
  'chave_telecomandada',
  'chave_fusivel_religadora',
  'chave_seccionadora_monopolar',
  'chave_seccionadora_tripolar',
  'disjuntor',
  'seccionalizador',
  'chave_lamina',
  'outro',
  'sem_subtipo',
] as const

const SUBTYPE_STYLES: Record<string, EquipmentSubtypeStyle & { colors: ColorPair; marker: MarkerKind }> = {
  chave_fusivel: {
    key: 'chave_fusivel',
    label: 'Chave Fusível',
    color: '#facc15',
    status: 'disponivel',
    colors: { fill: '#facc15', stroke: '#713f12' },
    marker: 'none',
  },
  chave_seccionadora: {
    key: 'chave_seccionadora',
    label: 'Chave Seccionadora',
    color: '#fb923c',
    status: 'disponivel',
    colors: { fill: '#fb923c', stroke: '#7c2d12' },
    marker: 'single-bar',
  },
  chave_telecomandada: {
    key: 'chave_telecomandada',
    label: 'Chave Telecomandada',
    color: '#22d3ee',
    status: 'disponivel',
    colors: { fill: '#22d3ee', stroke: '#083344' },
    marker: 'dot',
  },
  chave_fusivel_religadora: {
    key: 'chave_fusivel_religadora',
    label: 'Chave Fusível Religadora',
    color: '#fde047',
    status: 'disponivel',
    colors: { fill: '#fde047', stroke: '#854d0e' },
    marker: 'diamond',
  },
  chave_seccionadora_monopolar: {
    key: 'chave_seccionadora_monopolar',
    label: 'Chave Seccionadora Monopolar',
    color: '#fdba74',
    status: 'disponivel',
    colors: { fill: '#fdba74', stroke: '#7c2d12' },
    marker: 'single-bar',
  },
  chave_seccionadora_tripolar: {
    key: 'chave_seccionadora_tripolar',
    label: 'Chave Seccionadora Tripolar',
    color: '#f97316',
    status: 'disponivel',
    colors: { fill: '#f97316', stroke: '#7c2d12' },
    marker: 'triple-bar',
  },
  disjuntor: {
    key: 'disjuntor',
    label: 'Disjuntor',
    color: '#ef4444',
    status: 'disponivel',
    colors: { fill: '#ef4444', stroke: '#7f1d1d' },
    marker: 'slash',
  },
  seccionalizador: {
    key: 'seccionalizador',
    label: 'Seccionalizador',
    color: '#2dd4bf',
    status: 'disponivel',
    colors: { fill: '#2dd4bf', stroke: '#134e4a' },
    marker: 'triple-bar',
  },
  chave_lamina: {
    key: 'chave_lamina',
    label: 'Chave Lâmina',
    color: '#fbbf24',
    status: 'disponivel',
    colors: { fill: '#fbbf24', stroke: '#78350f' },
    marker: 'blade',
  },
  outro: {
    key: 'outro',
    label: 'Outro subtipo informado',
    color: '#c084fc',
    status: 'disponivel',
    colors: { fill: '#c084fc', stroke: '#581c87' },
    marker: 'none',
  },
  sem_subtipo: {
    key: 'sem_subtipo',
    label: 'Subtipo indisponível',
    color: '#94a3b8',
    status: 'indisponivel',
    colors: { fill: '#94a3b8', stroke: '#334155' },
    marker: 'none',
  },
  transformador_at: {
    key: 'transformador_at',
    label: 'Transformador AT',
    color: '#a78bfa',
    status: 'unico',
    colors: { fill: '#a78bfa', stroke: '#312e81' },
    marker: 'none',
  },
  religador_at: {
    key: 'religador_at',
    label: 'Religador AT',
    color: '#f472b6',
    status: 'unico',
    colors: { fill: '#f472b6', stroke: '#831843' },
    marker: 'none',
  },
  regulacao_at: {
    key: 'regulacao_at',
    label: 'Regulação/Reativos AT',
    color: '#a855f7',
    status: 'unico',
    colors: { fill: '#a855f7', stroke: '#4c1d95' },
    marker: 'none',
  },
  regulacao_mt: {
    key: 'regulacao_mt',
    label: 'Regulação/Reativos MT',
    color: '#84cc16',
    status: 'unico',
    colors: { fill: '#84cc16', stroke: '#14532d' },
    marker: 'none',
  },
  regulacao_bt: {
    key: 'regulacao_bt',
    label: 'Regulação/Reativos BT',
    color: '#facc15',
    status: 'unico',
    colors: { fill: '#facc15', stroke: '#713f12' },
    marker: 'none',
  },
  bar: {
    key: 'bar',
    label: 'Barra (BAR)',
    color: '#ec4899',
    status: 'disponivel',
    colors: { fill: '#ec4899', stroke: '#831843' },
    marker: 'none',
  },
  base: {
    key: 'base',
    label: 'Base de subestação (BASE)',
    color: '#8b5cf6',
    status: 'disponivel',
    colors: { fill: '#8b5cf6', stroke: '#4c1d95' },
    marker: 'none',
  },
  bay: {
    key: 'bay',
    label: 'Bay de subestação (BAY)',
    color: '#14b8a6',
    status: 'disponivel',
    colors: { fill: '#14b8a6', stroke: '#134e4a' },
    marker: 'none',
  },
  be: {
    key: 'be',
    label: 'Elemento BE',
    color: '#eab308',
    status: 'disponivel',
    colors: { fill: '#eab308', stroke: '#854d0e' },
    marker: 'none',
  },
}

function createCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_CANVAS_SIZE
  canvas.height = ICON_CANVAS_SIZE

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas 2D context unavailable for map symbol generation')
  }

  return { canvas, context }
}

function drawCircle(context: CanvasRenderingContext2D, colors: ColorPair) {
  const center = ICON_CANVAS_SIZE / 2
  const radius = 15

  context.beginPath()
  context.arc(center, center, radius, 0, Math.PI * 2)
  context.fillStyle = colors.fill
  context.fill()
  context.lineWidth = 4
  context.strokeStyle = colors.stroke
  context.stroke()
}

function drawDiamond(context: CanvasRenderingContext2D, colors: ColorPair) {
  const center = ICON_CANVAS_SIZE / 2
  const radius = 16

  context.beginPath()
  context.moveTo(center, center - radius)
  context.lineTo(center + radius, center)
  context.lineTo(center, center + radius)
  context.lineTo(center - radius, center)
  context.closePath()
  context.fillStyle = colors.fill
  context.fill()
  context.lineWidth = 4
  context.strokeStyle = colors.stroke
  context.stroke()
}

function drawSquare(context: CanvasRenderingContext2D, colors: ColorPair) {
  const size = 28
  const offset = (ICON_CANVAS_SIZE - size) / 2

  context.beginPath()
  context.rect(offset, offset, size, size)
  context.fillStyle = colors.fill
  context.fill()
  context.lineWidth = 4
  context.strokeStyle = colors.stroke
  context.stroke()
}

function drawSubtypeMarker(context: CanvasRenderingContext2D, marker: MarkerKind, stroke: string) {
  const center = ICON_CANVAS_SIZE / 2
  context.strokeStyle = stroke
  context.fillStyle = stroke
  context.lineWidth = 4
  context.lineCap = 'round'

  if (marker === 'dot') {
    context.beginPath()
    context.arc(center, center, 4.5, 0, Math.PI * 2)
    context.fill()
    return
  }

  if (marker === 'slash') {
    context.beginPath()
    context.moveTo(23, 41)
    context.lineTo(41, 23)
    context.stroke()
    return
  }

  if (marker === 'single-bar') {
    context.beginPath()
    context.moveTo(center, 23)
    context.lineTo(center, 41)
    context.stroke()
    return
  }

  if (marker === 'triple-bar') {
    for (const x of [25, 32, 39]) {
      context.beginPath()
      context.moveTo(x, 24)
      context.lineTo(x, 40)
      context.stroke()
    }
    return
  }

  if (marker === 'diamond') {
    context.beginPath()
    context.moveTo(center, 24)
    context.lineTo(40, center)
    context.lineTo(center, 40)
    context.lineTo(24, center)
    context.closePath()
    context.stroke()
    return
  }

  if (marker === 'blade') {
    context.beginPath()
    context.moveTo(23, 39)
    context.lineTo(42, 25)
    context.stroke()
  }
}

function drawSquareSubtype(context: CanvasRenderingContext2D, colors: ColorPair, marker: MarkerKind) {
  drawSquare(context, colors)
  drawSubtypeMarker(context, marker, colors.stroke)
}

function drawHexagon(context: CanvasRenderingContext2D, colors: ColorPair) {
  const center = ICON_CANVAS_SIZE / 2
  const radius = 18

  context.beginPath()
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI / 3) * index - Math.PI / 6
    const x = center + radius * Math.cos(angle)
    const y = center + radius * Math.sin(angle)
    if (index === 0) {
      context.moveTo(x, y)
    } else {
      context.lineTo(x, y)
    }
  }
  context.closePath()
  context.fillStyle = colors.fill
  context.fill()
  context.lineWidth = 4
  context.strokeStyle = colors.stroke
  context.stroke()

  context.beginPath()
  context.arc(center, center, 5, 0, Math.PI * 2)
  context.fillStyle = colors.stroke
  context.fill()
}

function drawTriangle(context: CanvasRenderingContext2D, colors: ColorPair) {
  const center = ICON_CANVAS_SIZE / 2
  const radius = 18

  context.beginPath()
  context.moveTo(center, center - radius)
  context.lineTo(center + radius, center + radius * 0.85)
  context.lineTo(center - radius, center + radius * 0.85)
  context.closePath()
  context.fillStyle = colors.fill
  context.fill()
  context.lineWidth = 4
  context.strokeStyle = colors.stroke
  context.stroke()
}

function drawPentagon(context: CanvasRenderingContext2D, colors: ColorPair) {
  const center = ICON_CANVAS_SIZE / 2
  const radius = 17

  context.beginPath()
  for (let index = 0; index < 5; index += 1) {
    const angle = (Math.PI * 2 * index) / 5 - Math.PI / 2
    const x = center + radius * Math.cos(angle)
    const y = center + radius * Math.sin(angle)
    if (index === 0) {
      context.moveTo(x, y)
    } else {
      context.lineTo(x, y)
    }
  }
  context.closePath()
  context.fillStyle = colors.fill
  context.fill()
  context.lineWidth = 4
  context.strokeStyle = colors.stroke
  context.stroke()
}

function drawCrossSquareSubtype(context: CanvasRenderingContext2D, colors: ColorPair, marker: MarkerKind) {
  drawSquare(context, colors)
  context.beginPath()
  context.moveTo(22, 22)
  context.lineTo(42, 42)
  context.moveTo(42, 22)
  context.lineTo(22, 42)
  context.lineWidth = 3.5
  context.strokeStyle = colors.stroke
  context.stroke()

  if (marker !== 'none') {
    drawSubtypeMarker(context, marker, colors.stroke)
  }
}

function buildIcon(
  id: string,
  draw: (context: CanvasRenderingContext2D, colors: ColorPair) => void,
  colors: ColorPair,
) {
  const { context } = createCanvas()
  draw(context, colors)
  return {
    id,
    image: context.getImageData(0, 0, ICON_CANVAS_SIZE, ICON_CANVAS_SIZE),
  }
}

function buildSubtypeIconExpression(prefix: 'equipment-chave' | 'equipment-chave-at') {
  return [
    'match',
    ['coalesce', ['get', 'subtipo_normalizado'], 'sem_subtipo'],
    ...CHAVE_SUBTYPE_KEYS.flatMap((key) => [key, `${prefix}-${key}`]),
    `${prefix}-sem_subtipo`,
  ] as unknown as maplibregl.ExpressionSpecification
}

const BASE_SYMBOL_SPECS = [
  { id: SYMBOL_IDS.transformerLow, draw: drawCircle, colors: { fill: '#34d399', stroke: '#0f172a' } },
  { id: SYMBOL_IDS.transformerMedium, draw: drawCircle, colors: { fill: '#facc15', stroke: '#0f172a' } },
  { id: SYMBOL_IDS.transformerHigh, draw: drawCircle, colors: { fill: '#fb923c', stroke: '#0f172a' } },
  { id: SYMBOL_IDS.transformerCritical, draw: drawCircle, colors: { fill: '#ef4444', stroke: '#0f172a' } },
  { id: SYMBOL_IDS.transformerAt, draw: drawTriangle, colors: { fill: '#a78bfa', stroke: '#312e81' } },
  { id: SYMBOL_IDS.religador, draw: drawDiamond, colors: { fill: '#22d3ee', stroke: '#083344' } },
  { id: SYMBOL_IDS.religadorAt, draw: drawPentagon, colors: { fill: '#f472b6', stroke: '#831843' } },
  { id: SYMBOL_IDS.subestacao, draw: drawHexagon, colors: { fill: '#f8fafc', stroke: '#d946ef' } },
]

const CHAVE_SYMBOL_SPECS = CHAVE_SUBTYPE_KEYS.flatMap((key) => {
  const style = SUBTYPE_STYLES[key]
  return [
    {
      id: `equipment-chave-${key}`,
      draw: (context: CanvasRenderingContext2D, colors: ColorPair) => drawSquareSubtype(context, colors, style.marker),
      colors: style.colors,
    },
    {
      id: `equipment-chave-at-${key}`,
      draw: (context: CanvasRenderingContext2D, colors: ColorPair) => drawCrossSquareSubtype(context, colors, style.marker),
      colors: style.colors,
    },
  ]
})

const SYMBOL_SPECS = [...BASE_SYMBOL_SPECS, ...CHAVE_SYMBOL_SPECS]

export const TRANSFORMER_ICON_IMAGE_EXPRESSION: maplibregl.ExpressionSpecification = [
  'step',
  ['to-number', ['coalesce', ['get', 'score_equipamento'], 0]],
  SYMBOL_IDS.transformerLow,
  60,
  SYMBOL_IDS.transformerMedium,
  80,
  SYMBOL_IDS.transformerHigh,
  90,
  SYMBOL_IDS.transformerCritical,
]

export const CHAVE_SUBTYPE_ICON_IMAGE_EXPRESSION = buildSubtypeIconExpression('equipment-chave')
export const CHAVE_AT_SUBTYPE_ICON_IMAGE_EXPRESSION = buildSubtypeIconExpression('equipment-chave-at')

export const REGULACAO_REATIVOS_COLOR_EXPRESSION: maplibregl.ExpressionSpecification = [
  'match',
  ['coalesce', ['get', 'subtipo_normalizado'], 'regulacao_mt'],
  'regulacao_at',
  SUBTYPE_STYLES.regulacao_at.color,
  'regulacao_bt',
  SUBTYPE_STYLES.regulacao_bt.color,
  SUBTYPE_STYLES.regulacao_mt.color,
]

export const SUBESTACAO_COMPONENT_COLOR_EXPRESSION: maplibregl.ExpressionSpecification = [
  'match',
  ['coalesce', ['get', 'subtipo_normalizado'], 'sem_subtipo'],
  'bar',
  SUBTYPE_STYLES.bar.color,
  'base',
  SUBTYPE_STYLES.base.color,
  'bay',
  SUBTYPE_STYLES.bay.color,
  'be',
  SUBTYPE_STYLES.be.color,
  SUBTYPE_STYLES.sem_subtipo.color,
]

export const RELIGADOR_ICON_ID = SYMBOL_IDS.religador
export const SUBESTACAO_ICON_ID = SYMBOL_IDS.subestacao
export const TRANSFORMADOR_AT_ICON_ID = SYMBOL_IDS.transformerAt
export const RELIGADOR_AT_ICON_ID = SYMBOL_IDS.religadorAt

export function getEquipmentSubtypeStyle(
  normalized: unknown,
  status?: unknown,
  label?: unknown,
): EquipmentSubtypeStyle {
  const key = typeof normalized === 'string' && normalized ? normalized : 'sem_subtipo'
  const known = SUBTYPE_STYLES[key] ?? SUBTYPE_STYLES.sem_subtipo
  const resolvedStatus = status === 'disponivel' || status === 'unico' || status === 'indisponivel'
    ? status
    : known.status

  return {
    key,
    label: typeof label === 'string' && label ? label : known.label,
    color: known.color,
    status: resolvedStatus,
  }
}

export function ensureEquipmentSymbols(map: maplibregl.Map) {
  for (const spec of SYMBOL_SPECS) {
    if (!map.hasImage(spec.id)) {
      const symbol = buildIcon(spec.id, spec.draw, spec.colors)
      map.addImage(symbol.id, symbol.image, { pixelRatio: ICON_PIXEL_RATIO })
    }
  }
}
