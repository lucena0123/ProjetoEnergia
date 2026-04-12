'use client'

import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { MAP_PROVIDER_CONFIG } from '@/lib/mapProvider'
import {
  CHAVE_AT_SUBTYPE_ICON_IMAGE_EXPRESSION,
  CHAVE_SUBTYPE_ICON_IMAGE_EXPRESSION,
  RELIGADOR_ICON_ID,
  RELIGADOR_AT_ICON_ID,
  REGULACAO_REATIVOS_COLOR_EXPRESSION,
  SUBESTACAO_COMPONENT_COLOR_EXPRESSION,
  SUBESTACAO_ICON_ID,
  TRANSFORMADOR_AT_ICON_ID,
  TRANSFORMER_ICON_IMAGE_EXPRESSION,
  ensureEquipmentSymbols,
  getEquipmentSubtypeStyle,
} from '@/lib/mapSymbols'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
const EMPTY_GEOJSON: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
const LAYER_COLORS = {
  baixo: '#22c55e',
  medio: '#facc15',
  alto: '#f97316',
  critico: '#ef4444',
}

const GAP_BOTH_EXPRESSION: maplibregl.ExpressionSpecification = [
  'all',
  ['==', ['get', 'gap_religamento_auto'], true],
  ['==', ['get', 'gap_recomposicao'], true],
]

const GAP_AUTO_EXPRESSION: maplibregl.ExpressionSpecification = ['==', ['get', 'gap_religamento_auto'], true]
const GAP_RECOMPOSITION_EXPRESSION: maplibregl.ExpressionSpecification = ['==', ['get', 'gap_recomposicao'], true]
const GAP_TRANSFER_EXPRESSION: maplibregl.ExpressionSpecification = ['==', ['get', 'gap_transferencia'], true]

const GAP_LINE_COLOR_EXPRESSION: maplibregl.ExpressionSpecification = [
  'case',
  GAP_BOTH_EXPRESSION,
  '#991b1b',
  GAP_AUTO_EXPRESSION,
  '#ef4444',
  GAP_RECOMPOSITION_EXPRESSION,
  '#f97316',
  GAP_TRANSFER_EXPRESSION,
  '#38bdf8',
  '#64748b',
]

const GAP_LINE_WIDTH_EXPRESSION: maplibregl.ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10,
  ['case', GAP_BOTH_EXPRESSION, 2.8, GAP_AUTO_EXPRESSION, 2.1, GAP_RECOMPOSITION_EXPRESSION, 1.9, GAP_TRANSFER_EXPRESSION, 1.9, 1.2],
  14,
  ['case', GAP_BOTH_EXPRESSION, 5.8, GAP_AUTO_EXPRESSION, 4.3, GAP_RECOMPOSITION_EXPRESSION, 3.9, GAP_TRANSFER_EXPRESSION, 3.9, 2.4],
]

const GAP_LEGEND_ITEMS = [
  {
    key: 'both',
    color: '#991b1b',
    label: 'Proteção automática e recomposição distantes',
    detail: 'gap_religamento_auto + gap_recomposicao',
    width: 'w-9',
  },
  {
    key: 'auto',
    color: '#ef4444',
    label: 'Proteção automática distante',
    detail: 'manobra próxima ou sem gap severo de recomposição',
    width: 'w-7',
  },
  {
    key: 'recomposicao',
    color: '#f97316',
    label: 'Recomposição/manobra distante',
    detail: 'ponto de manobra a 2 km ou mais',
    width: 'w-7',
  },
  {
    key: 'transferencia',
    color: '#38bdf8',
    label: 'Transferência candidata distante',
    detail: 'chave normalmente aberta a 2 km ou mais',
    width: 'w-7',
  },
]

type LayerKey =
  | 'alimentadores'
  | 'alimentadoresAt'
  | 'redeMt'
  | 'redeBt'
  | 'redeAt'
  | 'transformadores'
  | 'transformadoresAt'
  | 'subestacoes'
  | 'religadores'
  | 'religadoresAt'
  | 'chaves'
  | 'chavesBt'
  | 'chavesAt'
  | 'regulacaoReativos'
  | 'bar'
  | 'base'
  | 'bay'
  | 'be'
  | 'gaps'

const MIN_ZOOM: Record<LayerKey, number> = {
  alimentadores: 7,
  alimentadoresAt: 7,
  redeMt: 8,
  redeBt: 10,
  redeAt: 8,
  transformadores: 11,
  transformadoresAt: 10,
  subestacoes: 7,
  religadores: 10,
  religadoresAt: 10,
  chaves: 12,
  chavesBt: 13,
  chavesAt: 11,
  regulacaoReativos: 11,
  bar: 11,
  base: 11,
  bay: 11,
  be: 11,
  gaps: 11,
}

interface MunicipioProps {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
  dec_medio_12m: number | null
  meses_violacao: number | null
  idade_media_anos: number | null
}

interface RankingItem {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number
}

interface HistoricoItem {
  score_risco: number
}

interface MunicipioDetalhe {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
  dec_medio_12m: number | null
  dec_limite: number | null
  ratio_dec: number | null
  meses_violacao: number | null
  meses_violacao_dec: number | null
  fec_medio_12m: number | null
  fec_limite: number | null
  ratio_fec: number | null
  meses_violacao_fec: number | null
  tendencia: 'piorando' | 'melhorando' | 'estavel'
  historico?: HistoricoItem[]
  rede?: {
    comprimento_mt_km?: number | null
    comprimento_bt_km?: number | null
    n_transformadores?: number | null
    transformadores_criticos?: number | null
    potencia_total_kva?: number | null
    idade_media_anos?: number | null
  }
  protecao?: {
    n_religadores?: number | null
    n_chaves?: number | null
    cobertura_pct?: number | null
    km_sem_protecao?: number | null
  }
  social?: {
    populacao?: number | null
    domicilios?: number | null
    pib_per_capita?: number | null
  } | null
  qualidade_dados?: {
    infraestrutura_status?: 'real' | 'parcial' | 'indisponivel'
    historico_meses_disponiveis?: number
    historico_status?: 'completo' | 'parcial' | 'insuficiente'
    lacunas?: string[]
  }
  metricas_metadata?: {
    score_risco?: {
      metric_origin?: string
      confidence_status?: string
    }
    continuidade?: {
      metric_origin?: string
      confidence_status?: string
    }
    protecao?: {
      metric_origin?: string
      confidence_status?: string
    }
  }
}

interface UfSupportConfig {
  adaptiveScale: boolean
  viewportLayers: boolean
}

interface LayerAvailability {
  enabled: boolean
  count: number
  reason: string | null
}

interface UfAvailability {
  uf: string
  nome: string
  distribuidora: string
  status: 'real' | 'parcial' | 'indisponivel'
  municipios_com_score: number
  historico_meses_max: number
  possui_data_implant_mt: boolean
  camadas: {
    alimentadores: LayerAvailability
    subestacoes: LayerAvailability
    rede_mt: LayerAvailability
    rede_bt: LayerAvailability
    transformadores: LayerAvailability
    religadores: LayerAvailability
    chaves: LayerAvailability
    gaps_severos_mt: LayerAvailability
    alimentadores_at: LayerAvailability
    rede_at: LayerAvailability
    transformadores_at: LayerAvailability
    religadores_at: LayerAvailability
    chaves_at: LayerAvailability
    chaves_bt: LayerAvailability
    regulacao_reativos: LayerAvailability
    bar: LayerAvailability
    base: LayerAvailability
    bay: LayerAvailability
    be: LayerAvailability
  }
}

interface BdgdCatalogLayer {
  layer_name: string
  surfaced_mode: 'curated' | 'raw'
  target_table: string | null
  has_geometry: boolean
  geometry_type: string | null
  feature_count: number
  column_names: string[] | null
  imported_at: string
}

interface LegendBucket {
  label: string
  color: string
}

interface LegendConfig {
  title: string
  subtitle: string
  fillExpression: maplibregl.ExpressionSpecification
  buckets: LegendBucket[]
}

interface SubtypeLegendItem {
  key: string
  label: string
  color: string
  status: 'disponivel' | 'unico' | 'indisponivel'
}

interface PopupProperties {
  [key: string]: unknown
}

interface LayerDefinition {
  key: LayerKey
  label: string
  group: 'Circuitos' | 'Rede' | 'Equipamentos' | 'Proteção' | 'AT' | 'BT e Reativos' | 'Estrutura de Subestação'
  endpoint: string
  sourceId: string
  layerId: string
  minZoom: number
  focusZoom?: number
  limit: number
  queryParams?: Record<string, string>
  emptyHint?: string
  activateColorClass: string
  renderLayer: (map: maplibregl.Map, sourceId: string, layerId: string) => void
}

const SUPPORTED_REAL_UFS = ['AL', 'CE'] as const

const REAL_UF_CONFIG: Record<string, UfSupportConfig> = {
  CE: { adaptiveScale: true, viewportLayers: true },
  AL: { adaptiveScale: true, viewportLayers: true },
}

const LAYER_AVAILABILITY_KEYS: Record<LayerKey, keyof UfAvailability['camadas']> = {
  alimentadores: 'alimentadores',
  alimentadoresAt: 'alimentadores_at',
  redeMt: 'rede_mt',
  redeBt: 'rede_bt',
  redeAt: 'rede_at',
  transformadores: 'transformadores',
  transformadoresAt: 'transformadores_at',
  subestacoes: 'subestacoes',
  religadores: 'religadores',
  religadoresAt: 'religadores_at',
  chaves: 'chaves',
  chavesBt: 'chaves_bt',
  chavesAt: 'chaves_at',
  regulacaoReativos: 'regulacao_reativos',
  bar: 'bar',
  base: 'base',
  bay: 'bay',
  be: 'be',
  gaps: 'gaps_severos_mt',
}

const INITIAL_ACTIVE_LAYERS: Record<LayerKey, boolean> = {
  alimentadores: false,
  alimentadoresAt: false,
  redeMt: false,
  redeBt: false,
  redeAt: false,
  transformadores: false,
  transformadoresAt: false,
  subestacoes: false,
  religadores: false,
  religadoresAt: false,
  chaves: false,
  chavesBt: false,
  chavesAt: false,
  regulacaoReativos: false,
  bar: false,
  base: false,
  bay: false,
  be: false,
  gaps: false,
}

const LAYER_DEFINITIONS: Record<LayerKey, LayerDefinition> = {
  alimentadores: {
    key: 'alimentadores',
    label: 'Alimentadores',
    group: 'Circuitos',
    endpoint: '/api/alimentadores',
    sourceId: 'alimentadores-source',
    layerId: 'alimentadores-layer',
    minZoom: MIN_ZOOM.alimentadores,
    focusZoom: 8,
    limit: 5000,
    emptyHint: 'Nenhum alimentador visível na área atual.',
    activateColorClass: 'border-indigo-500 bg-indigo-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#a78bfa',
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.6, 11, 2.6, 14, 3.4],
          'line-opacity': 0.92,
          'line-dasharray': [3, 2],
        },
      })
    },
  },
  alimentadoresAt: {
    key: 'alimentadoresAt',
    label: 'Alimentadores AT',
    group: 'AT',
    endpoint: '/api/alimentadores-at',
    sourceId: 'alimentadores-at-source',
    layerId: 'alimentadores-at-layer',
    minZoom: MIN_ZOOM.alimentadoresAt,
    focusZoom: 8,
    limit: 5000,
    emptyHint: 'Nenhum alimentador AT visível na área atual.',
    activateColorClass: 'border-violet-500 bg-violet-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#8b5cf6',
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.8, 11, 3, 14, 4],
          'line-opacity': 0.92,
          'line-dasharray': [4, 2],
        },
      })
    },
  },
  redeMt: {
    key: 'redeMt',
    label: 'Rede MT',
    group: 'Rede',
    endpoint: '/api/trechos-criticos',
    sourceId: 'rede-mt-source',
    layerId: 'rede-mt-layer',
    minZoom: MIN_ZOOM.redeMt,
    focusZoom: 9,
    limit: 20000,
    emptyHint: 'Nenhum trecho de Rede MT visível na área atual.',
    activateColorClass: 'border-blue-500 bg-blue-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#60a5fa',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 11, 1.6, 14, 2.4],
          'line-opacity': 0.88,
        },
      })
    },
  },
  redeBt: {
    key: 'redeBt',
    label: 'Rede BT',
    group: 'Rede',
    endpoint: '/api/rede-bt',
    sourceId: 'rede-bt-source',
    layerId: 'rede-bt-layer',
    minZoom: MIN_ZOOM.redeBt,
    focusZoom: 12,
    limit: 25000,
    emptyHint: 'Nenhum trecho de Rede BT visível na área atual.',
    activateColorClass: 'border-sky-500 bg-sky-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#f0f9ff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.1, 13, 1.8, 15, 2.4],
          'line-opacity': 0.95,
        },
      })
    },
  },
  redeAt: {
    key: 'redeAt',
    label: 'Rede AT',
    group: 'AT',
    endpoint: '/api/rede-at',
    sourceId: 'rede-at-source',
    layerId: 'rede-at-layer',
    minZoom: MIN_ZOOM.redeAt,
    focusZoom: 9,
    limit: 25000,
    emptyHint: 'Nenhum trecho de Rede AT visível na área atual.',
    activateColorClass: 'border-rose-600 bg-rose-700 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#991b1b',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.1, 11, 2.1, 14, 3.1],
          'line-opacity': 0.9,
        },
      })
    },
  },
  transformadores: {
    key: 'transformadores',
    label: 'Transformadores',
    group: 'Equipamentos',
    endpoint: '/api/transformadores-criticos',
    sourceId: 'transformadores-source',
    layerId: 'transformadores-layer',
    minZoom: MIN_ZOOM.transformadores,
    focusZoom: 12,
    limit: 10000,
    emptyHint: 'Nenhum transformador visível na área atual.',
    activateColorClass: 'border-emerald-500 bg-emerald-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      ensureEquipmentSymbols(map)
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': TRANSFORMER_ICON_IMAGE_EXPRESSION,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.42, 14, 0.64],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': 0.95,
        },
      })
    },
  },
  transformadoresAt: {
    key: 'transformadoresAt',
    label: 'Transformadores AT',
    group: 'AT',
    endpoint: '/api/transformadores-at',
    sourceId: 'transformadores-at-source',
    layerId: 'transformadores-at-layer',
    minZoom: MIN_ZOOM.transformadoresAt,
    focusZoom: 11,
    limit: 5000,
    emptyHint: 'Nenhum transformador AT visível na área atual.',
    activateColorClass: 'border-fuchsia-500 bg-fuchsia-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      ensureEquipmentSymbols(map)
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': TRANSFORMADOR_AT_ICON_ID,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.48, 14, 0.7],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': 0.96,
        },
      })
    },
  },
  subestacoes: {
    key: 'subestacoes',
    label: 'Subestações',
    group: 'Equipamentos',
    endpoint: '/api/subestacoes',
    sourceId: 'subestacoes-source',
    layerId: 'subestacoes-layer',
    minZoom: MIN_ZOOM.subestacoes,
    focusZoom: 8,
    limit: 2000,
    emptyHint: 'Nenhuma subestação visível na área atual.',
    activateColorClass: 'border-fuchsia-500 bg-fuchsia-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      ensureEquipmentSymbols(map)
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': SUBESTACAO_ICON_ID,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.56, 12, 0.84],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': 0.96,
        },
      })
    },
  },
  religadores: {
    key: 'religadores',
    label: 'Religadores',
    group: 'Proteção',
    endpoint: '/api/religadores',
    sourceId: 'religadores-source',
    layerId: 'religadores-layer',
    minZoom: MIN_ZOOM.religadores,
    focusZoom: 11,
    limit: 5000,
    emptyHint: 'Nenhum religador visível na área atual.',
    activateColorClass: 'border-cyan-500 bg-cyan-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      ensureEquipmentSymbols(map)
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': RELIGADOR_ICON_ID,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.48, 14, 0.7],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': 0.94,
        },
      })
    },
  },
  religadoresAt: {
    key: 'religadoresAt',
    label: 'Religadores AT',
    group: 'AT',
    endpoint: '/api/religadores-at',
    sourceId: 'religadores-at-source',
    layerId: 'religadores-at-layer',
    minZoom: MIN_ZOOM.religadoresAt,
    focusZoom: 11,
    limit: 5000,
    emptyHint: 'Nenhum religador AT visível na área atual.',
    activateColorClass: 'border-pink-500 bg-pink-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      ensureEquipmentSymbols(map)
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': RELIGADOR_AT_ICON_ID,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.46, 14, 0.68],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': 0.95,
        },
      })
    },
  },
  chaves: {
    key: 'chaves',
    label: 'Chaves',
    group: 'Proteção',
    endpoint: '/api/chaves',
    sourceId: 'chaves-source',
    layerId: 'chaves-layer',
    minZoom: MIN_ZOOM.chaves,
    focusZoom: 13,
    limit: 10000,
    emptyHint: 'Nenhuma chave visível na área atual.',
    activateColorClass: 'border-amber-500 bg-amber-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      ensureEquipmentSymbols(map)
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': CHAVE_SUBTYPE_ICON_IMAGE_EXPRESSION,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.46, 15, 0.68],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': 0.94,
        },
      })
    },
  },
  chavesAt: {
    key: 'chavesAt',
    label: 'Chaves AT',
    group: 'AT',
    endpoint: '/api/chaves-at',
    sourceId: 'chaves-at-source',
    layerId: 'chaves-at-layer',
    minZoom: MIN_ZOOM.chavesAt,
    focusZoom: 12,
    limit: 10000,
    emptyHint: 'Nenhuma chave AT visível na área atual.',
    activateColorClass: 'border-orange-500 bg-orange-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      ensureEquipmentSymbols(map)
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': CHAVE_AT_SUBTYPE_ICON_IMAGE_EXPRESSION,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.46, 15, 0.68],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': 0.95,
        },
      })
    },
  },
  chavesBt: {
    key: 'chavesBt',
    label: 'Chaves BT',
    group: 'BT e Reativos',
    endpoint: '/api/chaves-bt',
    sourceId: 'chaves-bt-source',
    layerId: 'chaves-bt-layer',
    minZoom: MIN_ZOOM.chavesBt,
    focusZoom: 14,
    limit: 10000,
    emptyHint: 'Nenhuma chave BT visível na área atual.',
    activateColorClass: 'border-yellow-400 bg-yellow-600 text-white',
    renderLayer: (map, sourceId, layerId) => {
      ensureEquipmentSymbols(map)
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: sourceId,
        layout: {
          'icon-image': CHAVE_SUBTYPE_ICON_IMAGE_EXPRESSION,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.38, 16, 0.56],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': 0.9,
        },
      })
    },
  },
  regulacaoReativos: {
    key: 'regulacaoReativos',
    label: 'Regulação / Reativos',
    group: 'BT e Reativos',
    endpoint: '/api/regulacao-reativos',
    sourceId: 'regulacao-reativos-source',
    layerId: 'regulacao-reativos-layer',
    minZoom: MIN_ZOOM.regulacaoReativos,
    focusZoom: 12,
    limit: 8000,
    emptyHint: 'Nenhum ativo de regulação ou reativos visível na área atual.',
    activateColorClass: 'border-lime-500 bg-lime-700 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-color': REGULACAO_REATIVOS_COLOR_EXPRESSION,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 15, 6.5],
          'circle-opacity': 0.92,
          'circle-stroke-color': '#14532d',
          'circle-stroke-width': 1.3,
        },
      })
    },
  },
  bar: {
    key: 'bar',
    label: 'BAR',
    group: 'Estrutura de Subestação',
    endpoint: '/api/subestacao-componentes',
    sourceId: 'bar-source',
    layerId: 'bar-layer',
    minZoom: MIN_ZOOM.bar,
    focusZoom: 12,
    limit: 5000,
    queryParams: { component_type: 'BAR' },
    emptyHint: 'Nenhuma barra de subestação visível na área atual.',
    activateColorClass: 'border-pink-500 bg-pink-700 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-color': SUBESTACAO_COMPONENT_COLOR_EXPRESSION,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 7],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#831843',
          'circle-stroke-width': 1.4,
        },
      })
    },
  },
  base: {
    key: 'base',
    label: 'BASE',
    group: 'Estrutura de Subestação',
    endpoint: '/api/subestacao-componentes',
    sourceId: 'base-source',
    layerId: 'base-layer',
    minZoom: MIN_ZOOM.base,
    focusZoom: 12,
    limit: 5000,
    queryParams: { component_type: 'BASE' },
    emptyHint: 'Nenhuma base de subestação visível na área atual.',
    activateColorClass: 'border-violet-500 bg-violet-700 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-color': SUBESTACAO_COMPONENT_COLOR_EXPRESSION,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 7],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#4c1d95',
          'circle-stroke-width': 1.4,
        },
      })
    },
  },
  bay: {
    key: 'bay',
    label: 'BAY',
    group: 'Estrutura de Subestação',
    endpoint: '/api/subestacao-componentes',
    sourceId: 'bay-source',
    layerId: 'bay-layer',
    minZoom: MIN_ZOOM.bay,
    focusZoom: 12,
    limit: 5000,
    queryParams: { component_type: 'BAY' },
    emptyHint: 'Nenhum bay de subestação visível na área atual.',
    activateColorClass: 'border-teal-500 bg-teal-700 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-color': SUBESTACAO_COMPONENT_COLOR_EXPRESSION,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 7],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#134e4a',
          'circle-stroke-width': 1.4,
        },
      })
    },
  },
  be: {
    key: 'be',
    label: 'BE',
    group: 'Estrutura de Subestação',
    endpoint: '/api/subestacao-componentes',
    sourceId: 'be-source',
    layerId: 'be-layer',
    minZoom: MIN_ZOOM.be,
    focusZoom: 12,
    limit: 5000,
    queryParams: { component_type: 'BE' },
    emptyHint: 'Nenhum componente BE visível na área atual.',
    activateColorClass: 'border-yellow-500 bg-yellow-700 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-color': SUBESTACAO_COMPONENT_COLOR_EXPRESSION,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 7],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#854d0e',
          'circle-stroke-width': 1.4,
        },
      })
    },
  },
  gaps: {
    key: 'gaps',
    label: 'Gaps MT (proteção e manobra pública)',
    group: 'Proteção',
    endpoint: '/api/gaps-protecao',
    sourceId: 'gaps-source',
    layerId: 'gaps-layer',
    minZoom: MIN_ZOOM.gaps,
    focusZoom: 12,
    limit: 3000,
    emptyHint: 'Nenhum gap severo visível na área atual.',
    activateColorClass: 'border-red-600 bg-red-700 text-white',
    renderLayer: (map, sourceId, layerId) => {
      map.addLayer({
        id: `${layerId}-both-halo`,
        type: 'line',
        source: sourceId,
        filter: GAP_BOTH_EXPRESSION,
        paint: {
          'line-color': '#450a0a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4.2, 14, 8.4],
          'line-opacity': 0.62,
        },
      })
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': GAP_LINE_COLOR_EXPRESSION,
          'line-width': GAP_LINE_WIDTH_EXPRESSION,
          'line-opacity': 0.9,
          'line-dasharray': [2, 2],
        },
      })
    },
  },
}

const LAYER_GROUPS: Array<{ title: LayerDefinition['group'], layers: LayerKey[] }> = [
  { title: 'Circuitos', layers: ['alimentadores'] },
  { title: 'Rede', layers: ['redeMt', 'redeBt'] },
  { title: 'Equipamentos', layers: ['transformadores', 'subestacoes'] },
  { title: 'Proteção', layers: ['religadores', 'chaves', 'gaps'] },
  { title: 'AT', layers: ['alimentadoresAt', 'redeAt', 'transformadoresAt', 'religadoresAt', 'chavesAt'] },
  { title: 'BT e Reativos', layers: ['chavesBt', 'regulacaoReativos'] },
  { title: 'Estrutura de Subestação', layers: ['bar', 'base', 'bay', 'be'] },
]

function getUfConfig(uf: string): UfSupportConfig {
  return REAL_UF_CONFIG[uf] ?? REAL_UF_CONFIG.CE
}

function getAvailabilityBadge(status: UfAvailability['status'] | undefined): { label: string; className: string } {
  if (status === 'parcial') {
    return {
      label: 'Cobertura parcial',
      className: 'border border-amber-800 bg-amber-950 text-amber-300',
    }
  }
  if (status === 'indisponivel') {
    return {
      label: 'Indisponível',
      className: 'border border-red-800 bg-red-950 text-red-300',
    }
  }
  return {
    label: 'Base real',
    className: 'border border-emerald-800 bg-emerald-950 text-emerald-300',
  }
}

function getLayerAvailability(availability: UfAvailability | null, layerKey: LayerKey): LayerAvailability {
  if (!availability) {
    return { enabled: true, count: 0, reason: null }
  }

  return availability.camadas[LAYER_AVAILABILITY_KEYS[layerKey]]
}

function sanitizeLayerToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function getBdgdSourceId(layerName: string): string {
  return `bdgd-${sanitizeLayerToken(layerName)}-source`
}

function getBdgdLayerId(layerName: string): string {
  return `bdgd-${sanitizeLayerToken(layerName)}-layer`
}

function isBdgdPointLayer(layer: BdgdCatalogLayer): boolean {
  return (layer.geometry_type ?? '').toLowerCase().includes('point')
}

function isBdgdLineLayer(layer: BdgdCatalogLayer): boolean {
  return (layer.geometry_type ?? '').toLowerCase().includes('line')
}

function isBdgdPolygonLayer(layer: BdgdCatalogLayer): boolean {
  return (layer.geometry_type ?? '').toLowerCase().includes('polygon')
}

function getBdgdLayerMinZoom(layer: BdgdCatalogLayer): number {
  if (isBdgdPolygonLayer(layer)) return 7
  if (isBdgdLineLayer(layer)) return 9
  if (isBdgdPointLayer(layer)) return 11
  return 9
}

function getBdgdLayerLimit(layer: BdgdCatalogLayer): number {
  if (isBdgdPolygonLayer(layer)) return 4000
  if (isBdgdLineLayer(layer)) return 20000
  if (isBdgdPointLayer(layer)) return 8000
  return 5000
}

function colorForBdgdLayer(layerName: string): string {
  let hash = 0
  for (let index = 0; index < layerName.length; index += 1) {
    hash = (hash * 31 + layerName.charCodeAt(index)) >>> 0
  }

  const hue = hash % 360
  return `hsl(${hue} 78% 58%)`
}

function scoreClass(score: number | null): string {
  if (score == null) return 'text-gray-400'
  if (score >= 80) return 'text-red-400 font-bold'
  if (score >= 60) return 'text-orange-400 font-bold'
  if (score >= 40) return 'text-yellow-400 font-bold'
  return 'text-green-400 font-bold'
}

function popupScoreColor(score: number | null): string {
  if (score == null) return '#94a3b8'
  if (score >= 80) return '#f87171'
  if (score >= 60) return '#fb923c'
  if (score >= 40) return '#facc15'
  return '#4ade80'
}

function popupOriginLabel(origin?: string | null): string {
  switch (origin) {
    case 'observed_public':
      return 'observado público'
    case 'derived_public':
      return 'derivado público'
    case 'regulatory_context':
      return 'contexto regulatório'
    case 'partner_observed':
      return 'observado parceiro'
    case 'partner_derived':
      return 'derivado parceiro'
    default:
      return 'indisponível'
  }
}

function removeGeoJsonLayer(map: maplibregl.Map, layerId: string, sourceId: string) {
  const layerIds = (map.getStyle().layers ?? [])
    .map((layer) => layer.id)
    .filter((id) => id === layerId || id.startsWith(`${layerId}-`))
    .reverse()

  if (layerIds.length > 0) {
    layerIds.forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id)
    })
  } else if (map.getLayer(layerId)) {
    map.removeLayer(layerId)
  }

  if (map.getSource(sourceId)) map.removeSource(sourceId)
}

function setSourceData(map: maplibregl.Map, id: string, data: GeoJSON.FeatureCollection) {
  const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined
  source?.setData(data)
}

function upsertGeoJsonLayer(
  map: maplibregl.Map,
  id: string,
  data: GeoJSON.FeatureCollection,
  addLayer: () => void,
) {
  const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined
  if (source) {
    source.setData(data)
    return
  }

  map.addSource(id, { type: 'geojson', data })
  addLayer()
}

function normalizeMunicipiosGeojson(geojson: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: geojson.features.filter((feature) => feature.geometry != null),
  }
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function formatNumber(value: unknown, digits = 1): string {
  if (value == null || value === '') return '—'
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return String(value)
  return num.toFixed(digits)
}

function formatDate(value: unknown): string {
  if (!value) return '—'
  const asString = String(value)
  return asString.length >= 10 ? asString.slice(0, 10) : asString
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatText(value: unknown): string {
  if (value == null || value === '') return '—'
  return escapeHtml(String(value))
}

function formatBoolean(value: unknown): string {
  if (value === true) return 'sim'
  if (value === false) return 'não'
  return '—'
}

function formatTextList(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '—'
  return escapeHtml(value.map((item) => String(item)).join(', '))
}

function formatSubtypeStatus(value: unknown): string {
  if (value === 'disponivel') return 'disponível'
  if (value === 'unico') return 'subtipo único'
  if (value === 'indisponivel') return 'indisponível'
  return 'indisponível'
}

function buildSubtypeRows(properties: PopupProperties): string[] {
  if (!('subtipo_status' in properties)) return []

  const status = properties.subtipo_status
  const label = formatText(properties.subtipo_label)
  const raw = formatText(properties.subtipo_raw)
  const normalized = formatText(properties.subtipo_normalizado)
  const source = formatText(properties.subtipo_source)
  const statusLabel = formatSubtypeStatus(status)

  const rows = [
    `Subtipo <b style="color:#f1f5f9">${label}</b> <span style="color:#94a3b8">(${statusLabel})</span>`,
    `Normalizado <b style="color:#f1f5f9">${normalized}</b>`,
  ]

  if (raw !== '—') {
    rows.push(`Valor BDGD <b style="color:#f1f5f9">${raw}</b>`)
  }

  rows.push(`Fonte subtipo <b style="color:#f1f5f9">${source}</b>`)

  if (properties.eq_descricao || properties.eq_tipo_inst || properties.eq_data_imobilizado) {
    const parts = [
      properties.eq_descricao ? `descrição <b style="color:#f1f5f9">${formatText(properties.eq_descricao)}</b>` : '',
      properties.eq_tipo_inst ? `tipo instalação <b style="color:#f1f5f9">${formatText(properties.eq_tipo_inst)}</b>` : '',
      properties.eq_data_imobilizado ? `imobilizado <b style="color:#f1f5f9">${formatDate(properties.eq_data_imobilizado)}</b>` : '',
    ].filter(Boolean)
    if (parts.length > 0) {
      rows.push(`Dicionário EQ* · ${parts.join(' · ')}`)
    }
  }

  return rows
}

function buildSubtypeLegendItems(geojson: GeoJSON.FeatureCollection): SubtypeLegendItem[] {
  const items = new Map<string, SubtypeLegendItem>()

  for (const feature of geojson.features) {
    const properties = feature.properties as PopupProperties | null
    if (!properties || !('subtipo_status' in properties)) continue

    const style = getEquipmentSubtypeStyle(
      properties.subtipo_normalizado,
      properties.subtipo_status,
      properties.subtipo_label,
    )
    const key = `${style.key}:${style.status}:${style.label}`
    items.set(key, style)
  }

  const statusOrder = { disponivel: 0, unico: 1, indisponivel: 2 }
  return Array.from(items.values()).sort((a, b) => {
    const statusDiff = statusOrder[a.status] - statusOrder[b.status]
    if (statusDiff !== 0) return statusDiff
    return a.label.localeCompare(b.label, 'pt-BR')
  })
}

function buildGapLegendItems(geojson: GeoJSON.FeatureCollection): typeof GAP_LEGEND_ITEMS {
  const keys = new Set<string>()

  for (const feature of geojson.features) {
    const properties = feature.properties as PopupProperties | null
    if (!properties) continue

    const hasAutoGap = properties.gap_religamento_auto === true
    const hasRecompositionGap = properties.gap_recomposicao === true
    const hasTransferGap = properties.gap_transferencia === true

    if (hasAutoGap && hasRecompositionGap) {
      keys.add('both')
      continue
    }

    if (hasAutoGap) keys.add('auto')
    if (hasRecompositionGap) keys.add('recomposicao')
    if (hasTransferGap) keys.add('transferencia')
  }

  return GAP_LEGEND_ITEMS.filter((item) => keys.has(item.key))
}

function sparklineSvg(data: number[], width = 120, height = 28): string {
  if (!data.length) return ''
  const min = Math.min(...data, 0)
  const max = Math.max(...data, 100)
  const range = max - min || 1
  const points = data
    .map((value, index) => {
      const x = 2 + (index / Math.max(data.length - 1, 1)) * (width - 4)
      const y = 2 + (height - 4) - ((value - min) / range) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block"><polyline points="${points}" fill="none" stroke="${popupScoreColor(data[data.length - 1])}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

function percentile(sortedValues: number[], ratio: number): number {
  if (!sortedValues.length) return 0
  const position = (sortedValues.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sortedValues[lower]
  const weight = position - lower
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight
}

function formatLegendRange(min: number, max?: number): string {
  if (max == null) return `≥ ${min.toFixed(1)}`
  return `${min.toFixed(1)}–${max.toFixed(1)}`
}

function buildAbsoluteLegendConfig(): LegendConfig {
  return {
    title: 'Escala fixa',
    subtitle: 'Faixas absolutas do score',
    fillExpression: ['step', ['to-number', ['coalesce', ['get', 'score_risco'], 0]], LAYER_COLORS.baixo, 40, LAYER_COLORS.medio, 60, LAYER_COLORS.alto, 80, LAYER_COLORS.critico],
    buckets: [
      { label: formatLegendRange(0, 39.9), color: LAYER_COLORS.baixo },
      { label: formatLegendRange(40, 59.9), color: LAYER_COLORS.medio },
      { label: formatLegendRange(60, 79.9), color: LAYER_COLORS.alto },
      { label: formatLegendRange(80), color: LAYER_COLORS.critico },
    ],
  }
}

function buildAdaptiveLegendConfig(geojson: GeoJSON.FeatureCollection): LegendConfig {
  const scores = geojson.features
    .map((feature) => Number((feature.properties as MunicipioProps | undefined)?.score_risco))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)

  if (!scores.length) return buildAbsoluteLegendConfig()

  const min = scores[0]
  const q1 = percentile(scores, 0.25)
  const q2 = percentile(scores, 0.5)
  const q3 = percentile(scores, 0.75)
  const max = scores[scores.length - 1]

  return {
    title: 'Escala adaptativa da UF',
    subtitle: 'Quartis do score real carregado',
    fillExpression: ['step', ['to-number', ['coalesce', ['get', 'score_risco'], 0]], LAYER_COLORS.baixo, q1, LAYER_COLORS.medio, q2, LAYER_COLORS.alto, q3, LAYER_COLORS.critico],
    buckets: [
      { label: formatLegendRange(min, q1), color: LAYER_COLORS.baixo },
      { label: formatLegendRange(q1, q2), color: LAYER_COLORS.medio },
      { label: formatLegendRange(q2, q3), color: LAYER_COLORS.alto },
      { label: formatLegendRange(q3, max), color: LAYER_COLORS.critico },
    ],
  }
}

function buildLegendConfig(geojson: GeoJSON.FeatureCollection, config: UfSupportConfig): LegendConfig {
  return config.adaptiveScale ? buildAdaptiveLegendConfig(geojson) : buildAbsoluteLegendConfig()
}

function getBoundsBboxString(map: maplibregl.Map): string {
  const bounds = map.getBounds()
  return [bounds.getWest().toFixed(6), bounds.getSouth().toFixed(6), bounds.getEast().toFixed(6), bounds.getNorth().toFixed(6)].join(',')
}

function fitFeatureBounds(map: maplibregl.Map, geojson: GeoJSON.FeatureCollection) {
  const coords = geojson.features.flatMap((feature) => {
    if (!feature.geometry) return []
    if (feature.geometry.type === 'MultiPolygon') return feature.geometry.coordinates.flat(2)
    if (feature.geometry.type === 'Polygon') return feature.geometry.coordinates.flat(1)
    return []
  }) as [number, number][]

  if (!coords.length) return

  const lngs = coords.map((coord) => coord[0])
  const lats = coords.map((coord) => coord[1])
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 42, duration: 700 })
}

function getActivationZoom(definition: LayerDefinition): number {
  return Math.max(definition.minZoom, definition.focusZoom ?? definition.minZoom)
}

function buildEmptyLayerHint(definition: LayerDefinition): string {
  return definition.emptyHint ?? `Nenhum dado de ${definition.label.toLowerCase()} na área atual.`
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return response.json() as Promise<T>
}

function buildBdgdPopup(layer: BdgdCatalogLayer, properties: PopupProperties): string {
  const visibleEntries = Object.entries(properties)
    .filter(([key, value]) => key !== 'source_row_id' && value != null && value !== '')
    .slice(0, 8)

  const rows = visibleEntries.map(([key, value]) => {
    const label = key.replaceAll('_', ' ')
    return `<div style="background:#1e293b;border-radius:6px;padding:7px 9px;font-size:11px;color:#cbd5e1"><span style="color:#94a3b8">${label}</span><br/><b style="color:#f1f5f9">${formatText(value)}</b></div>`
  })

  return `
    <div style="font-family:system-ui,sans-serif;min-width:260px;padding:2px">
      <div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:2px">${layer.layer_name}</div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${layer.geometry_type ?? 'sem geometria'} · ${layer.feature_count.toLocaleString('pt-BR')} registro(s)</div>
      <div style="display:grid;gap:6px">
        ${rows.length > 0 ? rows.join('') : '<div style="font-size:11px;color:#94a3b8">Sem atributos visíveis para este elemento.</div>'}
      </div>
    </div>
  `
}

function firstAvailableText(properties: PopupProperties, keys: string[]): string {
  for (const key of keys) {
    const value = properties[key]
    if (value != null && value !== '') return formatText(value)
  }
  return '—'
}

function getSwitchOperationalRole(properties: PopupProperties): string {
  const type = String(properties.tipo_chave ?? properties.subtipo_label ?? '').toLowerCase()
  const operation = String(properties.operacao ?? '').trim().toUpperCase()

  if (type.includes('telecomandada') && operation === 'A') return 'Candidata a transferência'
  if (type.includes('telecomandada') && operation === 'F') return 'Seccionamento remoto em serviço'
  if (
    type.includes('fusível religadora') ||
    type.includes('fusivel religadora') ||
    type.includes('seccionalizador') ||
    type.includes('disjuntor')
  ) {
    return 'Proteção/seccionamento'
  }
  if (operation === 'A') return 'Normalmente aberta'
  if (operation === 'F') return 'Normalmente fechada'
  return 'Papel não classificado na base pública'
}

function buildTooltipHtml(title: string, rows: Array<[string, string]>, subtitle?: string): string {
  const renderedRows = rows
    .filter(([, value]) => value !== '')
    .slice(0, 5)
    .map(([label, value]) => `
      <div style="display:flex;gap:8px;justify-content:space-between;align-items:flex-start">
        <span style="color:#94a3b8">${label}</span>
        <b style="max-width:150px;text-align:right;color:#f8fafc;font-weight:700">${value}</b>
      </div>
    `)
    .join('')

  return `
    <div style="font-family:system-ui,sans-serif;min-width:210px;max-width:280px">
      <div style="font-size:12px;font-weight:800;color:#f8fafc;line-height:1.25">${title}</div>
      ${subtitle ? `<div style="margin-top:2px;margin-bottom:7px;font-size:10px;color:#94a3b8;line-height:1.25">${subtitle}</div>` : '<div style="margin-bottom:7px"></div>'}
      <div style="display:grid;gap:5px;font-size:10.5px;line-height:1.25;color:#cbd5e1">${renderedRows}</div>
    </div>
  `
}

function buildGapTypeLabel(properties: PopupProperties): string {
  const gapTypes: string[] = []
  if (properties.gap_religamento_auto === true) gapTypes.push('automático')
  if (properties.gap_recomposicao === true) gapTypes.push('recomposição')
  if (properties.gap_transferencia === true) gapTypes.push('transferência')
  return gapTypes.length > 0 ? gapTypes.join(' + ') : 'sem classificação ativa'
}

function buildGapTooltip(properties: PopupProperties): string {
  return buildTooltipHtml('Gap MT', [
    ['Tipo', formatText(buildGapTypeLabel(properties))],
    ['Dist. auto', `${formatNumber(properties.dist_equipamento_auto_km ?? properties.dist_religador_km, 2)} km`],
    ['Dist. manobra', `${formatNumber(properties.dist_manobra_km ?? properties.dist_chave_km, 2)} km`],
    ['Dist. transf.', `${formatNumber(properties.dist_transferencia_km, 2)} km`],
    ['Clientes', formatText(properties.clientes_total)],
    ['Metodologia', formatText(properties.metodologia)],
  ], 'Distância topológica pública sobre a rede MT')
}

function buildInfraTooltip(layerKey: LayerKey, properties: PopupProperties): string {
  const codId = formatText(properties.cod_id)
  const municipio = formatText(properties.municipio)
  const alimentador = formatText(properties.alimentador_id)
  const subestacao = formatText(properties.subestacao_id)
  const subtitle = municipio !== '—' ? municipio : undefined

  switch (layerKey) {
    case 'chaves':
    case 'chavesAt':
    case 'chavesBt':
      return buildTooltipHtml(layerKey === 'chavesAt' ? 'Chave AT' : layerKey === 'chavesBt' ? 'Chave BT' : 'Chave MT', [
        ['Código', codId],
        ['Subtipo', formatText(properties.subtipo_label ?? properties.tipo_chave)],
        ['Operação', formatText(properties.operacao)],
        ['Papel', formatText(getSwitchOperationalRole(properties))],
        [layerKey === 'chavesAt' ? 'Subestação' : 'Alimentador', layerKey === 'chavesAt' ? subestacao : alimentador],
      ], subtitle)
    case 'religadores':
    case 'religadoresAt':
      return buildTooltipHtml(layerKey === 'religadoresAt' ? 'Religador AT' : 'Religador MT', [
        ['Código', codId],
        ['Papel', 'Proteção automática / religamento'],
        [layerKey === 'religadoresAt' ? 'Subestação' : 'Alimentador', layerKey === 'religadoresAt' ? subestacao : alimentador],
        ['Município', municipio],
        ['Implantação', formatDate(properties.data_implant)],
      ])
    case 'transformadores':
    case 'transformadoresAt':
      return buildTooltipHtml(layerKey === 'transformadoresAt' ? 'Transformador AT' : 'Transformador MT', [
        ['Código', codId],
        ['Potência', `${formatText(properties.potencia_nom)} kVA`],
        [layerKey === 'transformadoresAt' ? 'Subestação' : 'Alimentador', layerKey === 'transformadoresAt' ? subestacao : alimentador],
        ['Município', municipio],
        ['Status', formatText(properties.status)],
      ])
    case 'subestacoes':
      return buildTooltipHtml('Subestação', [
        ['Código', codId],
        ['Município', municipio],
        ['Tensão', formatText(properties.tensao_nom)],
        ['Implantação', formatDate(properties.data_implant)],
      ])
    case 'bar':
    case 'base':
    case 'bay':
    case 'be':
      return buildTooltipHtml(String(properties.component_type ?? layerKey).toUpperCase(), [
        ['Código', codId],
        ['Subestação', subestacao],
        ['Tensão', formatText(properties.tensao_nom)],
        ['Subgrupo', formatText(properties.sub_grupo)],
        ['Descrição', formatText(properties.descricao)],
      ], 'Estrutura de subestação')
    case 'regulacaoReativos':
      return buildTooltipHtml('Regulação / Reativos', [
        ['Código', codId],
        ['Nível', formatText(properties.nivel_tensao)],
        ['Tipo', formatText(properties.tipo_unidade)],
        ['Banco', formatText(properties.banco)],
        ['Vínculo', alimentador !== '—' ? alimentador : subestacao],
      ])
    case 'gaps':
      return buildGapTooltip(properties)
    case 'alimentadores':
    case 'alimentadoresAt':
      return buildTooltipHtml(layerKey === 'alimentadoresAt' ? 'Circuito AT' : 'Alimentador MT', [
        ['Código', codId],
        ['Subestação', subestacao],
        ['Município', municipio],
        ['Tensão', formatText(properties.tensao_nom)],
        ['Comprimento', `${formatNumber(properties.comprimento_km, 1)} km`],
      ])
    case 'redeMt':
    case 'redeBt':
    case 'redeAt': {
      const lengthKm = layerKey === 'redeAt' && properties.comprimento_km == null
        ? Number(properties.comprimento ?? 0) / 1000
        : properties.comprimento_km ?? properties.comprimento
      return buildTooltipHtml(layerKey === 'redeAt' ? 'Trecho AT' : layerKey === 'redeBt' ? 'Trecho BT' : 'Trecho MT', [
        ['Código', codId],
        ['Município', municipio],
        ['Alimentador', formatText(properties.alimentador_id ?? properties.alimentador_at_id)],
        ['Condutor', formatText(properties.condutor)],
        ['Comprimento', `${formatNumber(lengthKm, 2)} km`],
      ])
    }
  }
}

function buildBdgdTooltip(layer: BdgdCatalogLayer, properties: PopupProperties): string {
  return buildTooltipHtml(`BDGD · ${formatText(layer.layer_name)}`, [
    ['Código', firstAvailableText(properties, ['cod_id', 'COD_ID', 'id', 'ID'])],
    ['Município', firstAvailableText(properties, ['municipio', 'MUN', 'município'])],
    ['Geometria', formatText(layer.geometry_type)],
    ['Registros', formatText(layer.feature_count.toLocaleString('pt-BR'))],
  ], 'Camada técnica do BDGD completo')
}

function renderBdgdLayer(map: maplibregl.Map, layer: BdgdCatalogLayer) {
  const sourceId = getBdgdSourceId(layer.layer_name)
  const layerId = getBdgdLayerId(layer.layer_name)
  const color = colorForBdgdLayer(layer.layer_name)

  if (isBdgdPolygonLayer(layer)) {
    map.addLayer({
      id: layerId,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': color,
        'fill-opacity': 0.28,
        'fill-outline-color': color,
      },
    })
    return
  }

  if (isBdgdLineLayer(layer)) {
    map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': color,
        'line-width': ['interpolate', ['linear'], ['zoom'], getBdgdLayerMinZoom(layer), 1.2, 14, 3.2],
        'line-opacity': 0.88,
      },
    })
    return
  }

  map.addLayer({
    id: layerId,
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-color': color,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], getBdgdLayerMinZoom(layer), 3.2, 14, 6.4],
      'circle-opacity': 0.92,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#e2e8f0',
    },
  })
}

function buildInfraPopup(layerKey: LayerKey, properties: PopupProperties): string {
  const codId = formatText(properties.cod_id)
  const municipio = formatText(properties.municipio)
  const uf = formatText(properties.uf)
  const distribuidora = formatText(properties.distribuidora)
  let title = codId
  let subtitle = `${municipio} · ${uf}`
  const rows: string[] = []
  let footerLink = ''

  if (distribuidora !== '—') subtitle = `${subtitle} · ${distribuidora}`

  switch (layerKey) {
    case 'alimentadores':
      title = `Alimentador ${codId}`
      rows.push(`Subestação <b style="color:#f1f5f9">${formatText(properties.subestacao_id)}</b>`)
      rows.push(`Tensão <b style="color:#f1f5f9">${formatText(properties.tensao_nom)}</b>`)
      rows.push(`Comprimento <b style="color:#f1f5f9">${formatNumber(properties.comprimento_km, 1)} km</b>`)
      footerLink = `/alimentador/${encodeURIComponent(String(properties.cod_id ?? ''))}?uf=${encodeURIComponent(String(properties.uf ?? ''))}&distribuidora=${encodeURIComponent(String(properties.distribuidora ?? ''))}`
      break
    case 'alimentadoresAt':
      title = `Circuito AT ${codId}`
      rows.push(`Subestação <b style="color:#f1f5f9">${formatText(properties.subestacao_id)}</b>`)
      rows.push(`Nome <b style="color:#f1f5f9">${formatText(properties.nome)}</b>`)
      rows.push(`Tensão <b style="color:#f1f5f9">${formatText(properties.tensao_nom)}</b>`)
      rows.push(`Comprimento <b style="color:#f1f5f9">${formatNumber(properties.comprimento_km, 1)} km</b>`)
      break
    case 'redeMt':
      title = `Trecho MT ${codId}`
      rows.push(`Condutor <b style="color:#f1f5f9">${formatText(properties.condutor)}</b>`)
      rows.push(`Comprimento <b style="color:#f1f5f9">${formatNumber(properties.comprimento, 1)} km</b>`)
      break
    case 'redeBt':
      title = `Trecho BT ${codId}`
      rows.push(`Condutor <b style="color:#f1f5f9">${formatText(properties.condutor)}</b>`)
      rows.push(`Comprimento <b style="color:#f1f5f9">${formatNumber(properties.comprimento, 1)} km</b>`)
      break
    case 'redeAt':
      title = `Trecho AT ${codId}`
      rows.push(`Subestação <b style="color:#f1f5f9">${formatText(properties.subestacao_id)}</b>`)
      rows.push(`Circuito AT <b style="color:#f1f5f9">${formatText(properties.alimentador_at_id)}</b>`)
      rows.push(`Condutor <b style="color:#f1f5f9">${formatText(properties.condutor)}</b>`)
      rows.push(`Comprimento <b style="color:#f1f5f9">${formatNumber(Number(properties.comprimento ?? 0) / 1000, 2)} km</b>`)
      break
    case 'transformadores':
      title = `Transformador ${codId}`
      rows.push(`Potência <b style="color:#f1f5f9">${formatText(properties.potencia_nom)} kVA</b>`)
      rows.push(`Status <b style="color:#f1f5f9">${formatText(properties.status)}</b>`)
      rows.push(`Score <b style="color:#f1f5f9">${formatNumber(properties.score_equipamento, 1)}</b>`)
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      break
    case 'transformadoresAt':
      title = `Transformador AT ${codId}`
      rows.push(`Subestação <b style="color:#f1f5f9">${formatText(properties.subestacao_id)}</b>`)
      rows.push(`Potência <b style="color:#f1f5f9">${formatText(properties.potencia_nom)} kVA</b>`)
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      break
    case 'subestacoes':
      title = `Subestação ${codId}`
      rows.push(`Tensão nominal <b style="color:#f1f5f9">${formatText(properties.tensao_nom)}</b>`)
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      footerLink = `/subestacao/${encodeURIComponent(String(properties.cod_id ?? ''))}?uf=${encodeURIComponent(String(properties.uf ?? ''))}&distribuidora=${encodeURIComponent(String(properties.distribuidora ?? ''))}`
      break
    case 'religadores':
      title = `Religador ${codId}`
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      break
    case 'religadoresAt':
      title = `Religador AT ${codId}`
      rows.push(`Subestação <b style="color:#f1f5f9">${formatText(properties.subestacao_id)}</b>`)
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      break
    case 'chaves':
      title = `Chave ${codId}`
      rows.push(`Operação <b style="color:#f1f5f9">${formatText(properties.operacao)}</b>`)
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      break
    case 'chavesBt':
      title = `Chave BT ${codId}`
      rows.push(`Operação <b style="color:#f1f5f9">${formatText(properties.operacao)}</b>`)
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      break
    case 'chavesAt':
      title = `Chave AT ${codId}`
      rows.push(`Subestação <b style="color:#f1f5f9">${formatText(properties.subestacao_id)}</b>`)
      rows.push(`Operação <b style="color:#f1f5f9">${formatText(properties.operacao)}</b>`)
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      break
    case 'regulacaoReativos':
      title = `Regulação / Reativos ${codId}`
      rows.push(`Nível <b style="color:#f1f5f9">${formatText(properties.nivel_tensao)}</b>`)
      rows.push(`Subestação <b style="color:#f1f5f9">${formatText(properties.subestacao_id)}</b>`)
      rows.push(`Alimentador <b style="color:#f1f5f9">${formatText(properties.alimentador_id)}</b>`)
      rows.push(`Banco <b style="color:#f1f5f9">${formatText(properties.banco)}</b>`)
      rows.push(`Potência <b style="color:#f1f5f9">${formatText(properties.potencia_nom)}</b>`)
      rows.push(`Data <b style="color:#f1f5f9">${formatDate(properties.data_implant)}</b>`)
      break
    case 'bar':
    case 'base':
    case 'bay':
    case 'be':
      title = `${String(properties.component_type ?? layerKey).toUpperCase()} ${codId}`
      rows.push(`Subestação <b style="color:#f1f5f9">${formatText(properties.subestacao_id)}</b>`)
      rows.push(`Subgrupo <b style="color:#f1f5f9">${formatText(properties.sub_grupo)}</b>`)
      rows.push(`Descrição <b style="color:#f1f5f9">${formatText(properties.descricao)}</b>`)
      rows.push(`Tensão <b style="color:#f1f5f9">${formatText(properties.tensao_nom)}</b>`)
      rows.push(`Início <b style="color:#f1f5f9">${formatDate(properties.data_inicio)}</b>`)
      rows.push(`Fim <b style="color:#f1f5f9">${formatDate(properties.data_fim)}</b>`)
      break
    case 'gaps':
      title = 'Gap operacional MT'
      rows.push(`Município <b style="color:#f1f5f9">${municipio}</b>`)
      rows.push(`Comprimento <b style="color:#f1f5f9">${formatNumber(properties.comprimento_km, 2)} km</b>`)
      rows.push(`Dist. equip. auto <b style="color:#f1f5f9">${formatNumber(properties.dist_equipamento_auto_km ?? properties.dist_religador_km, 2)} km</b>`)
      rows.push(`Dist. manobra <b style="color:#f1f5f9">${formatNumber(properties.dist_manobra_km ?? properties.dist_chave_km, 2)} km</b>`)
      rows.push(`Dist. transferência <b style="color:#f1f5f9">${formatNumber(properties.dist_transferencia_km, 2)} km</b>`)
      rows.push(`Gap religamento auto <b style="color:#f1f5f9">${formatBoolean(properties.gap_religamento_auto)}</b>`)
      rows.push(`Gap recomposição <b style="color:#f1f5f9">${formatBoolean(properties.gap_recomposicao)}</b>`)
      rows.push(`Gap transferência <b style="color:#f1f5f9">${formatBoolean(properties.gap_transferencia)}</b>`)
      rows.push(`Equip. auto considerados <b style="color:#f1f5f9">${formatTextList(properties.equipamentos_auto_considerados)}</b>`)
      rows.push(`Pontos de manobra considerados <b style="color:#f1f5f9">${formatTextList(properties.equipamentos_manobra_considerados)}</b>`)
      rows.push(`Transferência candidata <b style="color:#f1f5f9">${formatTextList(properties.equipamentos_transferencia_considerados)}</b>`)
      rows.push(`Lacunas/confiança <b style="color:#f1f5f9">${formatTextList(properties.lacunas)}</b>`)
      rows.push(`Clientes <b style="color:#f1f5f9">${formatText(properties.clientes_total)}</b>`)
      rows.push(`Score <b style="color:#f1f5f9">${formatNumber(properties.score_vulnerabilidade, 1)}</b>`)
      rows.push(`Metodologia <b style="color:#f1f5f9">${formatText(properties.metodologia)}</b>`)
      break
  }

  const footerLabel = layerKey === 'subestacoes' ? 'Ver detalhe da subestação →' : 'Ver detalhe do alimentador →'
  const renderedRows = [...buildSubtypeRows(properties), ...rows]
  return `<div style="font-family:system-ui,sans-serif;min-width:240px;padding:2px"><div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:2px">${title}</div><div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${subtitle}</div><div style="display:grid;gap:6px">${renderedRows.map((row) => `<div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;font-size:11px;color:#cbd5e1">${row}</div>`).join('')}</div>${footerLink ? `<a href="${footerLink}" style="display:block;text-align:center;font-size:11px;color:#60a5fa;text-decoration:none;padding:6px;border:1px solid #1e40af;border-radius:4px;margin-top:8px">${footerLabel}</a>` : ''}</div>`
}

export default function MapaRisco() {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const searchString = searchParams.toString()
  const mapContainer = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null)
  const hintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const moveendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ufRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interactiveLayersRef = useRef<Set<string>>(new Set())
  const activeLayersRef = useRef<Record<LayerKey, boolean>>(INITIAL_ACTIVE_LAYERS)
  const activeBdgdLayersRef = useRef<Record<string, boolean>>({})

  const initialUf = (searchParams.get('uf') ?? 'CE').toUpperCase()
  const initialDistribuidora = searchParams.get('distribuidora')
  const selectedUfRef = useRef(initialUf)
  const scopedDistribuidoraRef = useRef<string | null>(initialDistribuidora)
  const [selectedUf, setSelectedUf] = useState(initialUf)
  const [activeDistribuidora, setActiveDistribuidora] = useState<string | null>(initialDistribuidora)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [activeLayers, setActiveLayers] = useState<Record<LayerKey, boolean>>(INITIAL_ACTIVE_LAYERS)
  const [bdgdCatalog, setBdgdCatalog] = useState<BdgdCatalogLayer[]>([])
  const [activeBdgdLayers, setActiveBdgdLayers] = useState<Record<string, boolean>>({})
  const [selectedMunicipio, setSelectedMunicipio] = useState<MunicipioProps | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [ranking, setRanking] = useState<RankingItem[]>([])
  const [rankingLoading, setRankingLoading] = useState(true)
  const [legendConfig, setLegendConfig] = useState<LegendConfig>(buildAbsoluteLegendConfig())
  const [subtypeLegendByLayer, setSubtypeLegendByLayer] = useState<Partial<Record<LayerKey, SubtypeLegendItem[]>>>({})
  const [gapLegendItems, setGapLegendItems] = useState<typeof GAP_LEGEND_ITEMS>([])
  const [availabilityByUf, setAvailabilityByUf] = useState<Record<string, UfAvailability>>({})
  const [availabilityLoading, setAvailabilityLoading] = useState(true)

  const profile = getUfConfig(selectedUf)
  const selectedAvailability = availabilityByUf[selectedUf] ?? null
  const scopedDistribuidora =
    activeDistribuidora && activeDistribuidora === selectedAvailability?.distribuidora
      ? activeDistribuidora
      : null
  const supportedUfs = Object.keys(availabilityByUf).length > 0
    ? Object.keys(availabilityByUf)
    : [...SUPPORTED_REAL_UFS]

  useEffect(() => {
    const params = new URLSearchParams(searchString)
    const nextUf = (params.get('uf') ?? 'CE').toUpperCase()
    if (SUPPORTED_REAL_UFS.includes(nextUf as (typeof SUPPORTED_REAL_UFS)[number])) {
      setSelectedUf((current) => (current === nextUf ? current : nextUf))
    }

    const nextDistribuidoraRaw = params.get('distribuidora')
    const nextAvailability = availabilityByUf[nextUf]
    const nextDistribuidora =
      nextAvailability && nextDistribuidoraRaw && nextDistribuidoraRaw !== nextAvailability.distribuidora
        ? null
        : nextDistribuidoraRaw

    setActiveDistribuidora((current) => (current === nextDistribuidora ? current : nextDistribuidora))
  }, [availabilityByUf, searchString])

  useEffect(() => {
    const params = new URLSearchParams(searchString)
    params.set('uf', selectedUf)
    if (scopedDistribuidora) params.set('distribuidora', scopedDistribuidora)
    else params.delete('distribuidora')
    const nextUrl = `${pathname}?${params.toString()}`
    const currentUrl = `${pathname}${searchString ? `?${searchString}` : ''}`
    if (nextUrl !== currentUrl) {
      router.replace(nextUrl, { scroll: false })
    }
  }, [pathname, router, scopedDistribuidora, searchString, selectedUf])
  const bdgdSpatialLayers = bdgdCatalog.filter((layer) => layer.surfaced_mode === 'raw' && layer.has_geometry)
  const bdgdTabularLayersCount = bdgdCatalog.filter((layer) => layer.surfaced_mode === 'raw' && !layer.has_geometry).length
  const availabilityBadge = getAvailabilityBadge(selectedAvailability?.status)
  const activeSubtypeLegendGroups = (Object.entries(subtypeLegendByLayer) as Array<[LayerKey, SubtypeLegendItem[]]>)
    .filter(([layerKey, items]) => activeLayers[layerKey] && items.length > 0)
    .map(([layerKey, items]) => ({
      layerKey,
      label: LAYER_DEFINITIONS[layerKey].label,
      items,
    }))

  useEffect(() => {
    activeLayersRef.current = activeLayers
  }, [activeLayers])

  useEffect(() => {
    selectedUfRef.current = selectedUf
  }, [selectedUf])

  useEffect(() => {
    scopedDistribuidoraRef.current = scopedDistribuidora
  }, [scopedDistribuidora])

  useEffect(() => {
    activeBdgdLayersRef.current = activeBdgdLayers
  }, [activeBdgdLayers])

  useEffect(() => {
    if (!mapRef.current || !selectedAvailability) return
    const map = mapRef.current
    let changed = false
    const nextLayers = { ...activeLayersRef.current }

    for (const [layerKey, isActive] of Object.entries(activeLayersRef.current) as Array<[LayerKey, boolean]>) {
      if (!isActive) continue
      if (getLayerAvailability(selectedAvailability, layerKey).enabled) continue

      const definition = LAYER_DEFINITIONS[layerKey]
      clearHoverTooltip()
      popupRef.current?.remove()
      removeGeoJsonLayer(map, definition.layerId, definition.sourceId)
      if (layerKey === 'gaps') setGapLegendItems([])
      nextLayers[layerKey] = false
      changed = true
    }

    if (changed) {
      setActiveLayers(nextLayers)
      setSubtypeLegendByLayer((current) => {
        const next = { ...current }
        for (const [layerKey, isActive] of Object.entries(nextLayers) as Array<[LayerKey, boolean]>) {
          if (!isActive) next[layerKey] = []
        }
        return next
      })
    }
  }, [selectedAvailability])

  useEffect(() => {
    setAvailabilityLoading(true)
    fetchJson<{ data: UfAvailability[] }>(`${API_URL}/api/disponibilidade-uf`)
      .then((response) => {
        const nextAvailability = Object.fromEntries(
          (response.data ?? []).map((item) => [item.uf, item]),
        )
        setAvailabilityByUf(nextAvailability)

        if (!nextAvailability[selectedUf]) {
          const [firstUf] = Object.keys(nextAvailability)
          if (firstUf) setSelectedUf(firstUf)
        }
      })
      .catch((error) => {
        console.error('[MapaRisco] disponibilidade load failed:', error)
      })
      .finally(() => setAvailabilityLoading(false))
  }, [])

  useEffect(() => {
    fetchJson<{ data: BdgdCatalogLayer[] }>(`${API_URL}/api/bdgd/layers?uf=${selectedUf}`)
      .then((response) => {
        const nextCatalog = response.data ?? []
        setBdgdCatalog(nextCatalog)

        const nextSpatialNames = new Set(
          nextCatalog
            .filter((layer) => layer.surfaced_mode === 'raw' && layer.has_geometry)
            .map((layer) => layer.layer_name),
        )

        setActiveBdgdLayers((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([layerName, isActive]) => isActive && nextSpatialNames.has(layerName)),
          ),
        )
      })
      .catch((error) => {
        console.error('[MapaRisco] BDGD catalog load failed:', error)
        setBdgdCatalog([])
      })
  }, [selectedUf])

  const showHint = (message: string) => {
    if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current)
    setHint(message)
    hintTimeoutRef.current = setTimeout(() => setHint(null), 3200)
  }

  const clearHoverTooltip = () => {
    hoverPopupRef.current?.remove()
    hoverPopupRef.current = null
  }

  const showHoverTooltip = (map: maplibregl.Map, lngLat: maplibregl.LngLatLike, html: string) => {
    if (!html) return
    if (!hoverPopupRef.current) {
      hoverPopupRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'gridrisk-tooltip',
        maxWidth: '280px',
      })
    }
    hoverPopupRef.current.setLngLat(lngLat).setHTML(html).addTo(map)
  }

  const bindInteractiveLayer = (layerKey: LayerKey) => {
    if (!mapRef.current) return
    const map = mapRef.current
    const definition = LAYER_DEFINITIONS[layerKey]
    if (interactiveLayersRef.current.has(definition.layerId)) return

    map.on('click', definition.layerId, (event) => {
      const properties = (event.features?.[0]?.properties ?? {}) as PopupProperties
      clearHoverTooltip()
      popupRef.current?.remove()
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        className: 'gridrisk-popup',
        maxWidth: '320px',
      })
        .setLngLat(event.lngLat)
        .setHTML(buildInfraPopup(layerKey, properties))
        .addTo(map)
    })

    map.on('mousemove', definition.layerId, (event) => {
      const properties = (event.features?.[0]?.properties ?? {}) as PopupProperties
      showHoverTooltip(map, event.lngLat, buildInfraTooltip(layerKey, properties))
    })

    map.on('mouseenter', definition.layerId, () => {
      map.getCanvas().style.cursor = 'pointer'
    })

    map.on('mouseleave', definition.layerId, () => {
      map.getCanvas().style.cursor = ''
      clearHoverTooltip()
    })

    interactiveLayersRef.current.add(definition.layerId)
  }

  const bindBdgdInteractiveLayer = (layer: BdgdCatalogLayer) => {
    if (!mapRef.current) return
    const map = mapRef.current
    const layerId = getBdgdLayerId(layer.layer_name)
    if (interactiveLayersRef.current.has(layerId)) return

    map.on('click', layerId, (event) => {
      const properties = (event.features?.[0]?.properties ?? {}) as PopupProperties
      clearHoverTooltip()
      popupRef.current?.remove()
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        className: 'gridrisk-popup',
        maxWidth: '340px',
      })
        .setLngLat(event.lngLat)
        .setHTML(buildBdgdPopup(layer, properties))
        .addTo(map)
    })

    map.on('mousemove', layerId, (event) => {
      const properties = (event.features?.[0]?.properties ?? {}) as PopupProperties
      showHoverTooltip(map, event.lngLat, buildBdgdTooltip(layer, properties))
    })

    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer'
    })

    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = ''
      clearHoverTooltip()
    })

    interactiveLayersRef.current.add(layerId)
  }

  const refreshLayer = async (layerKey: LayerKey, shouldHint = true) => {
    if (!mapLoaded || !mapRef.current) return
    const map = mapRef.current
    const definition = LAYER_DEFINITIONS[layerKey]
    const layerAvailability = getLayerAvailability(selectedAvailability, layerKey)

    if (selectedAvailability && !layerAvailability.enabled) {
      setSourceData(map, definition.sourceId, EMPTY_GEOJSON)
      setSubtypeLegendByLayer((current) => ({ ...current, [layerKey]: [] }))
      if (layerKey === 'gaps') setGapLegendItems([])
      if (shouldHint) {
        showHint(layerAvailability.reason ?? `${definition.label} indisponível para ${selectedUf}.`)
      }
      return
    }

    if (profile.viewportLayers && map.getZoom() < definition.minZoom) {
      setSourceData(map, definition.sourceId, EMPTY_GEOJSON)
      setSubtypeLegendByLayer((current) => ({ ...current, [layerKey]: [] }))
      if (layerKey === 'gaps') setGapLegendItems([])
      if (shouldHint) {
        const activationZoom = getActivationZoom(definition)
        showHint(`Aproximando para zoom ${activationZoom}+ para ver ${definition.label}.`)
        map.easeTo({ zoom: activationZoom, duration: 700 })
      }
      return
    }

    const params = new URLSearchParams({
      uf: selectedUf,
      limit: String(definition.limit),
    })
    const requestUf = selectedUf
    const requestDistribuidora = scopedDistribuidora

    if (scopedDistribuidora) params.set('distribuidora', scopedDistribuidora)
    if (profile.viewportLayers) params.set('bbox', getBoundsBboxString(map))
    if (layerKey === 'gaps') {
      params.set('score_min', '20')
      params.set('gap_tipo', 'operacional')
    }
    if (definition.queryParams) {
      Object.entries(definition.queryParams).forEach(([key, value]) => params.set(key, value))
    }

    const geojson = await fetchJson<GeoJSON.FeatureCollection>(`${API_URL}${definition.endpoint}?${params.toString()}`)
    if (requestUf !== selectedUfRef.current || requestDistribuidora !== scopedDistribuidoraRef.current) return

    setSubtypeLegendByLayer((current) => ({ ...current, [layerKey]: buildSubtypeLegendItems(geojson) }))
    if (layerKey === 'gaps') setGapLegendItems(buildGapLegendItems(geojson))
    upsertGeoJsonLayer(map, definition.sourceId, geojson, () => {
      definition.renderLayer(map, definition.sourceId, definition.layerId)
      bindInteractiveLayer(layerKey)
    })

    if (shouldHint) {
      if (geojson.features.length === 0) {
        showHint(buildEmptyLayerHint(definition))
      } else {
        setHint(null)
      }
    }
  }

  const refreshBdgdLayer = async (layer: BdgdCatalogLayer, shouldHint = true) => {
    if (!mapLoaded || !mapRef.current) return
    const map = mapRef.current
    const sourceId = getBdgdSourceId(layer.layer_name)
    const layerId = getBdgdLayerId(layer.layer_name)
    const minZoom = getBdgdLayerMinZoom(layer)

    if (map.getZoom() < minZoom) {
      setSourceData(map, sourceId, EMPTY_GEOJSON)
      if (shouldHint) {
        showHint(`Aproximando para zoom ${minZoom}+ para ver ${layer.layer_name}.`)
        map.easeTo({ zoom: minZoom, duration: 700 })
      }
      return
    }

    const params = new URLSearchParams({
      uf: selectedUf,
      limit: String(getBdgdLayerLimit(layer)),
      bbox: getBoundsBboxString(map),
    })
    const requestUf = selectedUf

    if (selectedAvailability?.distribuidora) {
      params.set('distribuidora', selectedAvailability.distribuidora)
    }

    const geojson = await fetchJson<GeoJSON.FeatureCollection>(
      `${API_URL}/api/bdgd/layers/${encodeURIComponent(layer.layer_name)}/features?${params.toString()}`,
    )
    if (requestUf !== selectedUfRef.current) return

    upsertGeoJsonLayer(map, sourceId, geojson, () => {
      renderBdgdLayer(map, layer)
      bindBdgdInteractiveLayer(layer)
    })

    if (shouldHint) {
      if (geojson.features.length === 0) {
        showHint(`Nenhum elemento visível da layer ${layer.layer_name} na área atual.`)
      } else {
        setHint(null)
      }
    }
  }

  const refreshActiveLayers = (shouldHint = false) => {
    for (const [layerKey, isActive] of Object.entries(activeLayersRef.current) as Array<[LayerKey, boolean]>) {
      if (!isActive) continue
      refreshLayer(layerKey, shouldHint).catch((error) => console.error(`[MapaRisco] ${layerKey} refresh failed:`, error))
    }

    for (const layer of bdgdSpatialLayers) {
      if (!activeBdgdLayersRef.current[layer.layer_name]) continue
      refreshBdgdLayer(layer, shouldHint).catch((error) => console.error(`[MapaRisco] ${layer.layer_name} refresh failed:`, error))
    }
  }

  const clearOperationalLayers = () => {
    if (!mapRef.current) return
    const map = mapRef.current
    setSubtypeLegendByLayer({})
    setGapLegendItems([])
    clearHoverTooltip()
    for (const definition of Object.values(LAYER_DEFINITIONS)) {
      setSourceData(map, definition.sourceId, EMPTY_GEOJSON)
    }
    for (const layerName of Object.keys(activeBdgdLayersRef.current)) {
      setSourceData(map, getBdgdSourceId(layerName), EMPTY_GEOJSON)
    }
  }

  const toggleLayer = (layerKey: LayerKey) => {
    if (!mapRef.current) return
    const map = mapRef.current
    const definition = LAYER_DEFINITIONS[layerKey]
    const layerAvailability = getLayerAvailability(selectedAvailability, layerKey)

    if (activeLayers[layerKey]) {
      clearHoverTooltip()
      popupRef.current?.remove()
      removeGeoJsonLayer(map, definition.layerId, definition.sourceId)
      setSubtypeLegendByLayer((current) => ({ ...current, [layerKey]: [] }))
      if (layerKey === 'gaps') setGapLegendItems([])
      setActiveLayers((current) => ({ ...current, [layerKey]: false }))
      return
    }

    if (selectedAvailability && !layerAvailability.enabled) {
      showHint(layerAvailability.reason ?? `${definition.label} indisponível para ${selectedUf}.`)
      return
    }

    setActiveLayers((current) => ({ ...current, [layerKey]: true }))
    refreshLayer(layerKey, true).catch((error) => console.error(`[MapaRisco] ${layerKey} load failed:`, error))
  }

  const toggleBdgdLayer = (layer: BdgdCatalogLayer) => {
    if (!mapRef.current) return
    const map = mapRef.current
    const layerId = getBdgdLayerId(layer.layer_name)
    const sourceId = getBdgdSourceId(layer.layer_name)
    const isActive = !!activeBdgdLayers[layer.layer_name]

    if (isActive) {
      clearHoverTooltip()
      popupRef.current?.remove()
      removeGeoJsonLayer(map, layerId, sourceId)
      setActiveBdgdLayers((current) => ({ ...current, [layer.layer_name]: false }))
      return
    }

    setActiveBdgdLayers((current) => ({ ...current, [layer.layer_name]: true }))
    refreshBdgdLayer(layer, true).catch((error) => console.error(`[MapaRisco] ${layer.layer_name} load failed:`, error))
  }

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return

    let didLoad = false
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_PROVIDER_CONFIG.styleUrl,
      center: MAP_PROVIDER_CONFIG.initialView.center,
      zoom: MAP_PROVIDER_CONFIG.initialView.zoom,
      attributionControl: false,
    })

    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl(), 'top-left')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')

    const handleLoad = () => {
      didLoad = true
      map.addSource('municipios-risco', { type: 'geojson', data: EMPTY_GEOJSON })
      map.addLayer({ id: 'municipios-fill', type: 'fill', source: 'municipios-risco', paint: { 'fill-color': buildAbsoluteLegendConfig().fillExpression, 'fill-opacity': 0.7 } })
      map.addLayer({ id: 'municipios-border', type: 'line', source: 'municipios-risco', paint: { 'line-color': '#ffffff', 'line-width': 0.5, 'line-opacity': 0.35 } })
      map.addLayer({ id: 'municipios-selected', type: 'line', source: 'municipios-risco', paint: { 'line-color': '#38bdf8', 'line-width': 2.3 }, filter: ['==', ['get', 'municipio'], ''] })

      map.on('click', 'municipios-fill', async (event) => {
        if (!event.features?.length) return
        const props = event.features[0].properties as MunicipioProps
        clearHoverTooltip()
        setSelectedMunicipio(props)
        map.setFilter('municipios-selected', ['all', ['==', ['get', 'municipio'], props.municipio], ['==', ['get', 'distribuidora'], props.distribuidora]])

        popupRef.current?.remove()
        popupRef.current = new maplibregl.Popup({ closeButton: true, className: 'gridrisk-popup', maxWidth: '360px' })
          .setLngLat(event.lngLat)
          .setHTML(`<div style="font-family:system-ui,sans-serif;min-width:280px;padding:2px"><div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:2px">${props.municipio}</div><div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${props.distribuidora} · ${props.uf}</div><div style="text-align:center;padding:16px 0;color:#64748b;font-size:12px">Carregando detalhes...</div></div>`)
          .addTo(map)

        try {
          const detail = await fetchJson<MunicipioDetalhe>(`${API_URL}/api/municipio/${encodeURIComponent(props.municipio)}/detalhe?distribuidora=${encodeURIComponent(props.distribuidora)}`)
          const trendColor = detail.tendencia === 'piorando' ? '#f87171' : detail.tendencia === 'melhorando' ? '#4ade80' : '#94a3b8'
          const sparkSvg = detail.historico && detail.historico.length > 1 ? sparklineSvg(detail.historico.map((item) => item.score_risco)) : ''
          const lacunas = detail.qualidade_dados?.lacunas ?? []
          const ageUnavailable = lacunas.includes('idade_rede_mt_indisponivel')
          const historyIncomplete = detail.qualidade_dados?.historico_status !== 'completo'
          const scoreOrigin = popupOriginLabel(detail.metricas_metadata?.score_risco?.metric_origin)
          const continuityOrigin = popupOriginLabel(detail.metricas_metadata?.continuidade?.metric_origin)
          const protectionOrigin = popupOriginLabel(detail.metricas_metadata?.protecao?.metric_origin)
          popupRef.current?.setHTML(`
            <div style="font-family:system-ui,sans-serif;min-width:280px;padding:2px">
              <div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:2px">${detail.municipio}</div>
              <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${detail.distribuidora} · ${detail.uf}</div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span style="font-size:28px;font-weight:900;color:${popupScoreColor(detail.score_risco)};line-height:1">${detail.score_risco?.toFixed(1) ?? '—'}<span style="font-size:13px;color:#64748b">/100</span></span>
                <span style="font-size:11px;color:${trendColor};font-weight:600">${detail.tendencia}</span>
              </div>
              <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px;font-size:11px;color:#cbd5e1">DEC <b style="color:#f1f5f9">${detail.dec_medio_12m?.toFixed(2) ?? '—'}h</b> / limite <b style="color:#f1f5f9">${detail.dec_limite?.toFixed(2) ?? '—'}h</b> · violações <b style="color:#f1f5f9">${detail.meses_violacao_dec ?? detail.meses_violacao ?? '—'}</b>/12</div>
              <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px;font-size:11px;color:#cbd5e1">FEC <b style="color:#f1f5f9">${detail.fec_medio_12m?.toFixed(2) ?? '—'}</b> / limite <b style="color:#f1f5f9">${detail.fec_limite?.toFixed(2) ?? '—'}</b> · violações <b style="color:#f1f5f9">${detail.meses_violacao_fec ?? '—'}</b>/12</div>
              <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px;font-size:11px;color:#cbd5e1">Rede MT <b style="color:#f1f5f9">${detail.rede?.comprimento_mt_km ?? '—'} km</b> · BT <b style="color:#f1f5f9">${detail.rede?.comprimento_bt_km ?? '—'} km</b><br/>Transformadores <b style="color:#f1f5f9">${detail.rede?.n_transformadores ?? '—'}</b> · críticos <b style="color:#ef4444">${detail.rede?.transformadores_criticos ?? 0}</b></div>
              <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px;font-size:11px;color:#cbd5e1">Cobertura <b style="color:${(detail.protecao?.cobertura_pct ?? 100) < 50 ? '#f87171' : '#4ade80'}">${detail.protecao?.cobertura_pct ?? '—'}%</b> · exposto <b style="color:#f1f5f9">${detail.protecao?.km_sem_protecao ?? '—'} km</b></div>
              ${detail.social?.populacao ? `<div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px;font-size:11px;color:#cbd5e1">População <b style="color:#f1f5f9">${formatCompactNumber(detail.social.populacao)}</b> · domicílios <b style="color:#f1f5f9">${formatCompactNumber(detail.social.domicilios)}</b></div>` : ''}
              ${detail.qualidade_dados?.infraestrutura_status === 'parcial' ? `<div style="font-size:10px;color:#fbbf24;background:#451a03;border:1px solid #b45309;border-radius:6px;padding:6px 8px;margin-bottom:6px">Cobertura real parcial nesta base pública.</div>` : ''}
              ${detail.qualidade_dados?.infraestrutura_status === 'indisponivel' ? `<div style="font-size:10px;color:#fecaca;background:#450a0a;border:1px solid #b91c1c;border-radius:6px;padding:6px 8px;margin-bottom:6px">Infraestrutura indisponível para este município no recorte atual.</div>` : ''}
              ${ageUnavailable ? `<div style="font-size:10px;color:#bfdbfe;background:#172554;border:1px solid #1d4ed8;border-radius:6px;padding:6px 8px;margin-bottom:6px">Idade da rede MT indisponível nesta base pública. O score usa apenas componentes reais disponíveis.</div>` : ''}
              ${historyIncomplete ? `<div style="font-size:10px;color:#fde68a;background:#422006;border:1px solid #b45309;border-radius:6px;padding:6px 8px;margin-bottom:6px">Histórico disponível: ${detail.qualidade_dados?.historico_meses_disponiveis ?? detail.historico?.length ?? 0} mês(es).</div>` : ''}
              <div style="font-size:10px;color:#cbd5e1;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:6px 8px;margin-bottom:6px">
                Score <b style="color:#f1f5f9">${scoreOrigin}</b> · Continuidade <b style="color:#f1f5f9">${continuityOrigin}</b> · Proteção <b style="color:#f1f5f9">${protectionOrigin}</b>
              </div>
              ${sparkSvg ? `<div style="margin-bottom:8px"><div style="font-size:9px;color:#64748b;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">Histórico (${detail.qualidade_dados?.historico_meses_disponiveis ?? detail.historico?.length ?? 0} meses)</div>${sparkSvg}</div>` : ''}
              <a href="/municipio/${encodeURIComponent(detail.municipio)}" style="display:block;text-align:center;font-size:11px;color:#60a5fa;text-decoration:none;padding:5px;border:1px solid #1e40af;border-radius:4px;margin-top:4px">Ver detalhe completo →</a>
            </div>
          `)
        } catch (error) {
          console.error('[MapaRisco] detalhe load failed:', error)
        }
      })

      map.on('mouseenter', 'municipios-fill', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'municipios-fill', () => { map.getCanvas().style.cursor = '' })
      setMapLoaded(true)
      setMapError(null)
    }

    const handleError = (event: { error?: Error }) => {
      if (didLoad) return
      console.error('[MapaRisco] basemap load failed:', event.error)
      setMapLoaded(false)
      setMapError(MAP_PROVIDER_CONFIG.fallback.description)
    }

    map.on('load', handleLoad)
    map.on('error', handleError)

    return () => {
      if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current)
      if (moveendTimeoutRef.current) clearTimeout(moveendTimeoutRef.current)
      if (ufRefreshTimeoutRef.current) clearTimeout(ufRefreshTimeoutRef.current)
      clearHoverTooltip()
      popupRef.current?.remove()
      map.off('load', handleLoad)
      map.off('error', handleError)
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    setRankingLoading(true)
    fetchJson<{ data: RankingItem[] }>(`${API_URL}/api/ranking-municipios?uf=${selectedUf}&limit=10&page=1`)
      .then((data) => setRanking(data.data ?? []))
      .catch((error) => {
        console.error('[MapaRisco] ranking load failed:', error)
        setRanking([])
      })
      .finally(() => setRankingLoading(false))
  }, [selectedUf])

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return
    const map = mapRef.current

    clearHoverTooltip()
    popupRef.current?.remove()
    setSelectedMunicipio(null)
    setActiveDistribuidora(null)
    activeLayersRef.current = INITIAL_ACTIVE_LAYERS
    activeBdgdLayersRef.current = {}
    setActiveLayers(INITIAL_ACTIVE_LAYERS)
    setActiveBdgdLayers({})
    map.setFilter('municipios-selected', ['==', ['get', 'municipio'], ''])
    clearOperationalLayers()

    const requestUf = selectedUf
    fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/mapa-risco?uf=${selectedUf}`)
      .then((geojson) => {
        if (requestUf !== selectedUfRef.current) return
        const normalized = normalizeMunicipiosGeojson(geojson)
        const nextLegend = buildLegendConfig(normalized, profile)
        const firstFeature = normalized.features.find((feature) => feature.properties != null)
        const firstProperties = firstFeature?.properties
        const distribuidora = firstProperties && typeof firstProperties === 'object'
          ? String((firstProperties as Record<string, unknown>).distribuidora ?? '')
          : ''

        setLegendConfig(nextLegend)
        setActiveDistribuidora(distribuidora || null)
        setSourceData(map, 'municipios-risco', normalized)
        map.setPaintProperty('municipios-fill', 'fill-color', nextLegend.fillExpression)
        fitFeatureBounds(map, normalized)

        if (ufRefreshTimeoutRef.current) clearTimeout(ufRefreshTimeoutRef.current)
      })
      .catch((error) => console.error('[MapaRisco] mapa-risco load failed:', error))
  }, [mapLoaded, profile, selectedUf])

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return
    const map = mapRef.current

    const handleMoveEnd = () => {
      if (moveendTimeoutRef.current) clearTimeout(moveendTimeoutRef.current)
      moveendTimeoutRef.current = setTimeout(() => {
        refreshActiveLayers(false)
      }, 250)
    }

    map.on('moveend', handleMoveEnd)
    return () => { map.off('moveend', handleMoveEnd) }
  }, [activeBdgdLayers, activeLayers, bdgdSpatialLayers, mapLoaded, selectedUf, activeDistribuidora])

  return (
    <div className="relative h-screen w-full">
      <div ref={mapContainer} className="h-full w-full" />

      {mapError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950">
          <div className="max-w-md rounded-xl border border-amber-700 bg-amber-950/80 px-6 py-5 text-center shadow-2xl">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">{MAP_PROVIDER_CONFIG.fallback.title}</h2>
            <p className="mt-3 text-sm leading-6 text-amber-100">{mapError}</p>
            <p className="mt-2 text-xs text-amber-200/80">{MAP_PROVIDER_CONFIG.fallback.help}</p>
          </div>
        </div>
      )}

      {hint && (
        <div className="absolute left-1/2 top-20 z-20 -translate-x-1/2 rounded-lg border border-yellow-700 bg-yellow-900/90 px-4 py-2 text-xs text-yellow-200 shadow-lg backdrop-blur-sm">{hint}</div>
      )}

      <div className="absolute left-3 top-14 z-10 max-h-[calc(100vh-4.5rem)] w-[22rem] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900/90 p-3 text-white shadow-lg backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">Estado</div>
            <select
              value={selectedUf}
              onChange={(event) => {
                const nextUf = event.target.value
                if (nextUf === selectedUf) return
                if (ufRefreshTimeoutRef.current) clearTimeout(ufRefreshTimeoutRef.current)
                popupRef.current?.remove()
                selectedUfRef.current = nextUf
                scopedDistribuidoraRef.current = null
                activeLayersRef.current = INITIAL_ACTIVE_LAYERS
                activeBdgdLayersRef.current = {}
                setSelectedUf(nextUf)
                setActiveDistribuidora(null)
                setSelectedMunicipio(null)
                setActiveLayers(INITIAL_ACTIVE_LAYERS)
                setActiveBdgdLayers({})
                clearOperationalLayers()
              }}
              className="mt-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {supportedUfs.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
            </select>
          </div>
          <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${availabilityBadge.className}`}>{availabilityLoading ? 'Verificando...' : availabilityBadge.label}</span>
        </div>

        <div className="mt-3 rounded border border-gray-800 bg-gray-950/80 p-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-300">{legendConfig.title}</div>
          <div className="mt-1 text-[11px] text-gray-500">{legendConfig.subtitle}</div>
          <div className="mt-3 space-y-2">
            {legendConfig.buckets.map((bucket) => (
              <div key={`${bucket.color}-${bucket.label}`} className="flex items-center justify-between gap-3 text-[11px] text-gray-300">
                <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: bucket.color }} />{bucket.label}</span>
              </div>
            ))}
          </div>
        </div>

        {gapLegendItems.length > 0 && (
          <div className="mt-3 rounded border border-red-950 bg-gray-950/80 p-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-300">Gaps operacionais MT</div>
            <div className="mt-1 text-[11px] text-gray-500">Cores separam proteção automática de manobra/recomposição. Limiar visual: 2 km.</div>
            <div className="mt-3 space-y-2">
              {gapLegendItems.map((item) => (
                <div key={item.label} className="flex items-start gap-2 text-[11px] text-gray-300">
                  <span className={`mt-1 h-1 shrink-0 rounded-full ${item.width}`} style={{ backgroundColor: item.color }} />
                  <span className="min-w-0">
                    <span className="block text-gray-200">{item.label}</span>
                    <span className="block text-[10px] text-gray-500">{item.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeSubtypeLegendGroups.length > 0 && (
          <div className="mt-3 rounded border border-gray-800 bg-gray-950/80 p-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-300">Subtipos de equipamentos</div>
            <div className="mt-1 text-[11px] text-gray-500">Legenda gerada a partir das camadas ativas na viewport.</div>
            <div className="mt-3 space-y-3">
              {activeSubtypeLegendGroups.map((group) => (
                <div key={group.layerKey}>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">{group.label}</div>
                  <div className="space-y-1.5">
                    {group.items.map((item) => (
                      <div key={`${group.layerKey}-${item.key}-${item.status}-${item.label}`} className="flex items-center justify-between gap-3 text-[11px] text-gray-300">
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
                          <span className="truncate">{item.label}</span>
                        </span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${item.status === 'disponivel' ? 'bg-emerald-950 text-emerald-300' : item.status === 'unico' ? 'bg-blue-950 text-blue-300' : 'bg-gray-800 text-gray-400'}`}>
                          {formatSubtypeStatus(item.status)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedAvailability && (
          <div className="mt-3 rounded border border-blue-900 bg-blue-950/70 px-2.5 py-2 text-[11px] leading-5 text-blue-100">
            {selectedUf} usa continuidade oficial, BDGD real e IBGE. Campos sem cobertura pública aparecem como indisponíveis.
            {!selectedAvailability.possui_data_implant_mt ? ' A idade da rede MT não está disponível nesta base pública.' : ''}
          </div>
        )}

        <div className="mt-3 rounded border border-gray-800 bg-gray-950/80 p-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-300">Camadas operacionais</div>
          <div className="mt-1 text-[11px] text-gray-500">Carregamento por viewport e zoom progressivo.</div>
          <div className="mt-3 space-y-3">
            {LAYER_GROUPS.map((group) => (
              <div key={group.title}>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">{group.title}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {group.layers.map((layerKey) => {
                    const definition = LAYER_DEFINITIONS[layerKey]
                    const isActive = activeLayers[layerKey]
                    const layerAvailability = getLayerAvailability(selectedAvailability, layerKey)
                    const isDisabled = selectedAvailability != null && !layerAvailability.enabled
                    return (
                      <button
                        key={layerKey}
                        type="button"
                        disabled={isDisabled}
                        onClick={() => toggleLayer(layerKey)}
                        className={`rounded border px-2.5 py-2 text-left text-xs font-medium transition-colors backdrop-blur-sm ${isDisabled ? 'cursor-not-allowed border-gray-800 bg-gray-950 text-gray-600 opacity-70' : isActive ? definition.activateColorClass : 'border-gray-700 bg-gray-900/80 text-gray-300 hover:bg-gray-800 hover:text-white'}`}
                      >
                        <div>{definition.label}</div>
                        <div className={`mt-1 text-[10px] ${isDisabled ? 'text-gray-500' : isActive ? 'text-white/80' : 'text-gray-500'}`}>
                          {isDisabled ? 'indisponível' : `zoom ${definition.minZoom}+`}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 rounded border border-gray-800 bg-gray-950/80 p-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-300">BDGD completo</div>
          <div className="mt-1 text-[11px] leading-5 text-gray-500">
            {bdgdCatalog.length > 0
              ? `${bdgdCatalog.length} layers catalogadas. ${bdgdSpatialLayers.length} com geometria no mapa e ${bdgdTabularLayersCount} tabulares disponíveis via API.`
              : 'Catálogo BDGD ainda não carregado para esta UF.'}
          </div>
          {bdgdSpatialLayers.length > 0 ? (
            <div className="mt-3 grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
              {bdgdSpatialLayers.map((layer) => {
                const isActive = !!activeBdgdLayers[layer.layer_name]
                const minZoom = getBdgdLayerMinZoom(layer)
                const color = colorForBdgdLayer(layer.layer_name)
                return (
                  <button
                    key={layer.layer_name}
                    type="button"
                    onClick={() => toggleBdgdLayer(layer)}
                    className={`rounded border px-2.5 py-2 text-left text-xs font-medium transition-colors backdrop-blur-sm ${isActive ? 'border-gray-100 text-white' : 'border-gray-700 bg-gray-900/80 text-gray-300 hover:bg-gray-800 hover:text-white'}`}
                    style={isActive ? { backgroundColor: color, borderColor: color } : undefined}
                  >
                    <div className="truncate">{layer.layer_name}</div>
                    <div className={`mt-1 text-[10px] ${isActive ? 'text-white/85' : 'text-gray-500'}`}>
                      {layer.feature_count.toLocaleString('pt-BR')} · zoom {minZoom}+
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="mt-3 rounded border border-gray-800 bg-gray-900/70 px-2.5 py-2 text-[11px] text-gray-500">
              Não há layers BDGD extras com geometria disponíveis nesta UF.
            </div>
          )}
        </div>

        {selectedMunicipio && (
          <div className="mt-3 max-w-full truncate rounded border border-gray-700 bg-gray-900/80 px-2 py-1 text-xs text-gray-400 backdrop-blur-sm">{selectedMunicipio.municipio}</div>
        )}
      </div>

      <div className="absolute right-3 top-14 z-10 w-64 overflow-hidden rounded-lg border border-gray-700 bg-gray-900/90 backdrop-blur-sm">
        <div className="border-b border-gray-700 px-3 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-300">Top 10 Municípios Críticos · {selectedUf}</h3>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {rankingLoading ? (
            <div className="space-y-2 px-3 py-4">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-3 animate-pulse rounded bg-gray-800" />)}</div>
          ) : ranking.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-gray-500">Sem dados disponíveis</div>
          ) : (
            <ul>
              {ranking.map((item, index) => (
                <li key={`${item.municipio}-${item.uf}`} className="flex items-center gap-2 border-b border-gray-800/60 px-3 py-2 transition-colors hover:bg-gray-800/50">
                  <span className="w-5 shrink-0 font-mono text-xs text-gray-500">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-white">{item.municipio}</div>
                    <div className="truncate text-xs text-gray-500">{item.uf}</div>
                  </div>
                  <span className={`shrink-0 text-xs tabular-nums ${scoreClass(item.score_risco)}`}>{item.score_risco?.toFixed(1) ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <style>{`
        .gridrisk-popup .maplibregl-popup-content { background:#0f172a; border:1px solid #334155; border-radius:8px; padding:12px; box-shadow:0 10px 25px rgba(0,0,0,0.6); }
        .gridrisk-popup .maplibregl-popup-tip { border-top-color:#0f172a; }
        .gridrisk-popup .maplibregl-popup-close-button { color:#94a3b8; font-size:16px; padding:4px 8px; }
        .gridrisk-popup .maplibregl-popup-close-button:hover { color:#f1f5f9; background:transparent; }
        .gridrisk-tooltip { pointer-events:none; }
        .gridrisk-tooltip .maplibregl-popup-content { background:rgba(15,23,42,0.96); border:1px solid rgba(148,163,184,0.35); border-radius:9px; padding:9px 10px; box-shadow:0 12px 28px rgba(0,0,0,0.45); backdrop-filter:blur(8px); }
        .gridrisk-tooltip .maplibregl-popup-tip { border-top-color:rgba(15,23,42,0.96); }
      `}</style>
    </div>
  )
}
