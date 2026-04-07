'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

import { MAP_PROVIDER_CONFIG } from '@/lib/mapProvider'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

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
  tendencia: 'piorando' | 'melhorando' | 'estavel'
  historico?: HistoricoItem[]
  rede?: {
    comprimento_mt_km?: number | null
    comprimento_bt_km?: number | null
    n_transformadores?: number | null
    transformadores_criticos?: number | null
    potencia_total_kva?: number | null
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
}

function scoreClass(score: number | null): string {
  if (score == null) return 'text-gray-400'
  if (score >= 80) return 'text-red-400 font-bold'
  if (score >= 60) return 'text-orange-400 font-bold'
  if (score >= 40) return 'text-yellow-400 font-bold'
  return 'text-green-400 font-bold'
}

function removeLayer(map: maplibregl.Map, id: string) {
  if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(id)) map.removeSource(id)
}

function sparklineSvg(data: number[], width = 120, height = 28): string {
  if (!data.length) return ''
  const min = Math.min(...data, 0)
  const max = Math.max(...data, 100)
  const range = max - min || 1
  const padX = 2
  const padY = 2
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const lastVal = data[data.length - 1]
  const color =
    lastVal >= 80 ? '#f87171'
    : lastVal >= 60 ? '#fb923c'
    : lastVal >= 40 ? '#facc15'
    : '#4ade80'

  const points = data
    .map((value, index) => {
      const x = padX + (index / Math.max(data.length - 1, 1)) * innerW
      const y = padY + innerH - ((value - min) / range) * innerH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function popupScoreColor(score: number | null): string {
  if (score == null) return '#94a3b8'
  if (score >= 80) return '#f87171'
  if (score >= 60) return '#fb923c'
  if (score >= 40) return '#facc15'
  return '#4ade80'
}

export default function MapaRisco() {
  const mapContainer = useRef<HTMLDivElement | null>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)

  const [mapLoaded, setMapLoaded] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [redeMtActive, setRedeMtActive] = useState(false)
  const [transActive, setTransActive] = useState(false)
  const [gapsActive, setGapsActive] = useState(false)
  const [selectedMunicipio, setSelectedMunicipio] = useState<MunicipioProps | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [ranking, setRanking] = useState<RankingItem[]>([])
  const [rankingLoading, setRankingLoading] = useState(true)

  useEffect(() => {
    fetch(`${API_URL}/api/ranking-municipios?limit=10&page=1`)
      .then((response) => response.json())
      .then((data) => setRanking(data.data ?? []))
      .catch(console.error)
      .finally(() => setRankingLoading(false))
  }, [])

  useEffect(() => {
    if (map.current || !mapContainer.current) return

    let mapDidLoad = false
    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_PROVIDER_CONFIG.styleUrl,
      center: MAP_PROVIDER_CONFIG.initialView.center,
      zoom: MAP_PROVIDER_CONFIG.initialView.zoom,
      attributionControl: false,
    })
    map.current = mapInstance

    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-left')
    mapInstance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')

    const handleMapError = (event: { error?: Error }) => {
      const error = event.error ?? new Error('Failed to load the configured basemap style.')
      console.error('[MapaRisco] basemap load failed:', error)

      if (!mapDidLoad) {
        setMapLoaded(false)
        setMapError(MAP_PROVIDER_CONFIG.fallback.description)
      }
    }

    const handleMapLoad = () => {
      mapDidLoad = true
      setMapLoaded(true)
      setMapError(null)

      fetch(`${API_URL}/api/mapa-risco`)
        .then((response) => response.json())
        .then((geojson: GeoJSON.FeatureCollection) => {
          const valid: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: geojson.features.filter((feature) => feature.geometry !== null),
          }

          if (!valid.features.length) return

          mapInstance.addSource('municipios-risco', { type: 'geojson', data: valid })

          mapInstance.addLayer({
            id: 'municipios-fill',
            type: 'fill',
            source: 'municipios-risco',
            paint: {
              'fill-color': [
                'interpolate', ['linear'],
                ['to-number', ['coalesce', ['get', 'score_risco'], 0]],
                0, '#00ff00',
                50, '#ffff00',
                80, '#ff4400',
                100, '#ff0000',
              ],
              'fill-opacity': 0.65,
            },
          })

          mapInstance.addLayer({
            id: 'municipios-border',
            type: 'line',
            source: 'municipios-risco',
            paint: { 'line-color': '#ffffff', 'line-width': 0.5, 'line-opacity': 0.35 },
          })

          mapInstance.addLayer({
            id: 'municipios-selected',
            type: 'line',
            source: 'municipios-risco',
            paint: { 'line-color': '#38bdf8', 'line-width': 2.5 },
            filter: ['==', ['get', 'municipio'], ''],
          })

          const coords = valid.features.flatMap((feature) => {
            if (!feature.geometry) return []
            const geometry = feature.geometry as GeoJSON.MultiPolygon | GeoJSON.Polygon
            if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2)
            if (geometry.type === 'Polygon') return geometry.coordinates.flat(1)
            return []
          }) as [number, number][]

          if (coords.length) {
            const lngs = coords.map((coord) => coord[0])
            const lats = coords.map((coord) => coord[1])
            mapInstance.fitBounds(
              [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
              { padding: 40, duration: 800 },
            )
          }

          mapInstance.on('click', 'municipios-fill', async (event) => {
            if (!event.features?.length) return

            const props = event.features[0].properties as MunicipioProps
            setSelectedMunicipio(props)
            mapInstance.setFilter('municipios-selected', ['==', ['get', 'municipio'], props.municipio])

            popupRef.current?.remove()
            const scoreColor = popupScoreColor(props.score_risco)
            popupRef.current = new maplibregl.Popup({
              closeButton: true,
              className: 'gridrisk-popup',
              maxWidth: '340px',
            })
              .setLngLat(event.lngLat)
              .setHTML(`
                <div style="font-family:system-ui,sans-serif;min-width:280px;padding:2px">
                  <div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:2px">${props.municipio}</div>
                  <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${props.distribuidora} · ${props.uf}</div>
                  <div style="text-align:center;padding:16px 0;color:#64748b;font-size:12px">Carregando detalhes...</div>
                </div>
              `)
              .addTo(mapInstance)

            try {
              const response = await fetch(
                `${API_URL}/api/municipio/${encodeURIComponent(props.municipio)}/detalhe`
              )
              if (!response.ok) throw new Error(`Failed to load detail: ${response.status}`)

              const detail = await response.json() as MunicipioDetalhe
              const trendLabel =
                detail.tendencia === 'piorando' ? 'Piorando'
                : detail.tendencia === 'melhorando' ? 'Melhorando'
                : 'Estavel'
              const trendColor =
                detail.tendencia === 'piorando' ? '#f87171'
                : detail.tendencia === 'melhorando' ? '#4ade80'
                : '#94a3b8'

              const sparkSvg = detail.historico?.length
                ? sparklineSvg(detail.historico.map((item) => item.score_risco))
                : ''

              popupRef.current?.setHTML(`
                <div style="font-family:system-ui,sans-serif;min-width:280px;padding:2px">
                  <div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:2px">${detail.municipio}</div>
                  <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${detail.distribuidora} · ${detail.uf}</div>

                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                    <span style="font-size:28px;font-weight:900;color:${scoreColor};line-height:1">
                      ${detail.score_risco?.toFixed(0) ?? '—'}<span style="font-size:14px;color:#64748b">/100</span>
                    </span>
                    <span style="font-size:11px;color:${trendColor};font-weight:600">${trendLabel}</span>
                  </div>

                  <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px">
                    <div style="font-size:9px;color:#60a5fa;font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:.05em">DEC/FEC</div>
                    <div style="font-size:11px;color:#cbd5e1">
                      DEC: <b style="color:#f1f5f9">${detail.dec_medio_12m?.toFixed(1) ?? '—'}h</b>
                      / limite ${detail.dec_limite ?? 12.0}h
                      (ratio <b style="color:${scoreColor}">${detail.ratio_dec?.toFixed(2) ?? '—'}x</b>)
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:2px">
                      Violacoes: <b style="color:#f1f5f9">${detail.meses_violacao ?? '—'}</b>/12 meses
                    </div>
                  </div>

                  <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px">
                    <div style="font-size:9px;color:#60a5fa;font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:.05em">Infraestrutura</div>
                    <div style="font-size:11px;color:#cbd5e1">
                      Rede MT: <b style="color:#f1f5f9">${detail.rede?.comprimento_mt_km ?? '—'}km</b>
                      · BT: <b style="color:#f1f5f9">${detail.rede?.comprimento_bt_km ?? '—'}km</b>
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:2px">
                      Trafo: <b style="color:#f1f5f9">${detail.rede?.n_transformadores ?? '—'}</b> total
                      · <b style="color:#ef4444">${detail.rede?.transformadores_criticos ?? 0}</b> criticos (>25a)
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:2px">
                      Potencia: <b style="color:#f1f5f9">${detail.rede?.potencia_total_kva ? `${(detail.rede.potencia_total_kva / 1000).toFixed(1)} MVA` : '—'}</b>
                    </div>
                  </div>

                  <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px">
                    <div style="font-size:9px;color:#60a5fa;font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:.05em">Protecao</div>
                    <div style="font-size:11px;color:#cbd5e1">
                      Religadores: <b style="color:#f1f5f9">${detail.protecao?.n_religadores ?? 0}</b>
                      · Chaves: <b style="color:#f1f5f9">${detail.protecao?.n_chaves ?? 0}</b>
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:2px">
                      Cobertura: <b style="color:${(detail.protecao?.cobertura_pct ?? 100) < 50 ? '#f87171' : '#4ade80'}">${detail.protecao?.cobertura_pct ?? '—'}%</b>
                      · Exposto: <b style="color:#f1f5f9">${detail.protecao?.km_sem_protecao ?? '—'}km</b>
                    </div>
                  </div>

                  ${detail.social?.populacao ? `
                  <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px">
                    <div style="font-size:9px;color:#60a5fa;font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:.05em">Contexto</div>
                    <div style="font-size:11px;color:#cbd5e1">
                      Pop: <b style="color:#f1f5f9">${formatCompactNumber(detail.social.populacao)}</b>
                      · Dom: <b style="color:#f1f5f9">${formatCompactNumber(detail.social.domicilios)}</b>
                    </div>
                    ${detail.social.pib_per_capita ? `<div style="font-size:11px;color:#cbd5e1;margin-top:2px">PIB per capita: <b style="color:#f1f5f9">R$ ${detail.social.pib_per_capita.toLocaleString('pt-BR')}</b></div>` : ''}
                  </div>` : ''}

                  ${sparkSvg ? `
                  <div style="margin-bottom:8px">
                    <div style="font-size:9px;color:#64748b;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">Historico de Score</div>
                    ${sparkSvg}
                  </div>` : ''}

                  <a href="/municipio/${encodeURIComponent(detail.municipio)}"
                     style="display:block;text-align:center;font-size:11px;color:#60a5fa;text-decoration:none;padding:5px;border:1px solid #1e40af;border-radius:4px;margin-top:4px">
                    Ver detalhe completo →
                  </a>
                </div>
              `)
            } catch (error) {
              console.error('[MapaRisco] detalhe load failed:', error)
              popupRef.current?.setHTML(`
                <div style="font-family:system-ui,sans-serif;min-width:200px;padding:2px">
                  <div style="font-size:13px;font-weight:700;color:#f1f5f9">${props.municipio}</div>
                  <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${props.distribuidora} · ${props.uf}</div>
                  <div style="font-size:20px;font-weight:900;color:${scoreColor}">
                    ${props.score_risco?.toFixed(1) ?? '—'}<span style="font-size:12px;color:#64748b">/100</span>
                  </div>
                  <div style="font-size:11px;color:#64748b;margin-top:4px">
                    DEC ${props.dec_medio_12m?.toFixed(1) ?? '—'}h · ${props.meses_violacao ?? '—'}/12 violacoes
                  </div>
                </div>
              `)
            }
          })

          mapInstance.on('mouseenter', 'municipios-fill', () => {
            mapInstance.getCanvas().style.cursor = 'pointer'
          })
          mapInstance.on('mouseleave', 'municipios-fill', () => {
            mapInstance.getCanvas().style.cursor = ''
          })
        })
        .catch((error) => console.error('[MapaRisco] mapa-risco load failed:', error))
    }

    mapInstance.on('error', handleMapError)
    mapInstance.on('load', handleMapLoad)

    return () => {
      mapDidLoad = false
      popupRef.current?.remove()
      mapInstance.off('error', handleMapError)
      mapInstance.off('load', handleMapLoad)
      mapInstance.remove()
      map.current = null
    }
  }, [])

  const toggleRedeMt = useCallback(async () => {
    if (!map.current || !mapLoaded) return
    if (redeMtActive) {
      removeLayer(map.current, 'rede_mt-layer')
      setRedeMtActive(false)
      return
    }
    try {
      const response = await fetch(`${API_URL}/api/trechos-criticos?score_min=0&limit=500`)
      const geojson: GeoJSON.FeatureCollection = await response.json()
      if (map.current.getSource('rede_mt-layer')) return
      map.current.addSource('rede_mt-layer', { type: 'geojson', data: geojson })
      map.current.addLayer({
        id: 'rede_mt-layer',
        type: 'line',
        source: 'rede_mt-layer',
        paint: {
          'line-color': [
            'interpolate', ['linear'], ['to-number', ['coalesce', ['get', 'score_risco'], 0]],
            0, '#60a5fa', 70, '#f97316', 100, '#ef4444',
          ],
          'line-width': 1.5,
          'line-opacity': 0.9,
        },
      })
      setRedeMtActive(true)
    } catch (error) {
      console.error('[MapaRisco] rede_mt load failed:', error)
    }
  }, [mapLoaded, redeMtActive])

  const toggleTransformadores = useCallback(async () => {
    if (!map.current || !mapLoaded) return

    if (transActive) {
      removeLayer(map.current, 'transformadores-layer')
      setTransActive(false)
      setHint(null)
      return
    }

    if (!selectedMunicipio) {
      setHint('Clique em um municipio no mapa para ver os transformadores')
      setTimeout(() => setHint(null), 3500)
      return
    }

    try {
      const url = `${API_URL}/api/transformadores-criticos?municipio=${encodeURIComponent(selectedMunicipio.municipio)}`
      const response = await fetch(url)
      const geojson: GeoJSON.FeatureCollection = await response.json()

      if (map.current.getSource('transformadores-layer')) {
        const source = map.current.getSource('transformadores-layer') as maplibregl.GeoJSONSource
        source.setData(geojson)
      } else {
        map.current.addSource('transformadores-layer', { type: 'geojson', data: geojson })
        map.current.addLayer({
          id: 'transformadores-layer',
          type: 'circle',
          source: 'transformadores-layer',
          paint: {
            'circle-radius': 4,
            'circle-color': [
              'interpolate', ['linear'], ['to-number', ['coalesce', ['get', 'score_risco'], 0]],
              0, '#34d399', 70, '#fb923c', 100, '#ef4444',
            ],
            'circle-stroke-width': 1,
            'circle-stroke-color': '#1e293b',
            'circle-opacity': 0.9,
          },
        })
      }

      setTransActive(true)
      setHint(null)
    } catch (error) {
      console.error('[MapaRisco] transformadores load failed:', error)
    }
  }, [mapLoaded, transActive, selectedMunicipio])

  const toggleGaps = useCallback(async () => {
    if (!map.current || !mapLoaded) return

    if (gapsActive) {
      removeLayer(map.current, 'gaps-layer')
      setGapsActive(false)
      return
    }

    try {
      const response = await fetch(`${API_URL}/api/gaps-protecao?score_min=20&limit=500`)
      const geojson: GeoJSON.FeatureCollection = await response.json()

      if (map.current.getSource('gaps-layer')) {
        const source = map.current.getSource('gaps-layer') as maplibregl.GeoJSONSource
        source.setData(geojson)
      } else {
        map.current.addSource('gaps-layer', { type: 'geojson', data: geojson })
        map.current.addLayer({
          id: 'gaps-layer',
          type: 'line',
          source: 'gaps-layer',
          paint: {
            'line-color': '#ef4444',
            'line-width': 2,
            'line-opacity': 0.85,
            'line-dasharray': [2, 2],
          },
        })
      }

      setGapsActive(true)
    } catch (error) {
      console.error('[MapaRisco] gaps load failed:', error)
    }
  }, [gapsActive, mapLoaded])

  useEffect(() => {
    if (!transActive || !selectedMunicipio || !map.current) return

    fetch(`${API_URL}/api/transformadores-criticos?municipio=${encodeURIComponent(selectedMunicipio.municipio)}`)
      .then((response) => response.json())
      .then((geojson: GeoJSON.FeatureCollection) => {
        const source = map.current?.getSource('transformadores-layer') as maplibregl.GeoJSONSource | undefined
        source?.setData(geojson)
      })
      .catch(console.error)
  }, [selectedMunicipio, transActive])

  return (
    <div className="relative w-full h-screen">
      <div ref={mapContainer} className="w-full h-full" />

      {mapError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950">
          <div className="max-w-md rounded-xl border border-amber-700 bg-amber-950/80 px-6 py-5 text-center shadow-2xl">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">
              {MAP_PROVIDER_CONFIG.fallback.title}
            </h2>
            <p className="mt-3 text-sm leading-6 text-amber-100">{mapError}</p>
            <p className="mt-2 text-xs text-amber-200/80">{MAP_PROVIDER_CONFIG.fallback.help}</p>
            <p className="mt-2 text-xs text-amber-200/60 break-all">
              Style atual: `{MAP_PROVIDER_CONFIG.styleUrl}`
            </p>
          </div>
        </div>
      )}

      {hint && (
        <div className="absolute top-20 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-yellow-700 bg-yellow-900/90 px-4 py-2 text-xs text-yellow-200 shadow-lg backdrop-blur-sm">
          {hint}
        </div>
      )}

      <div className="absolute bottom-10 left-3 z-10 flex flex-col gap-1.5">
        <button
          onClick={toggleRedeMt}
          className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors backdrop-blur-sm ${
            redeMtActive
              ? 'border-blue-500 bg-blue-600 text-white'
              : 'border-gray-700 bg-gray-900/80 text-gray-300 hover:bg-gray-800 hover:text-white'
          }`}
        >
          Rede MT
        </button>

        <button
          onClick={toggleTransformadores}
          title={!selectedMunicipio ? 'Clique em um municipio primeiro' : undefined}
          className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors backdrop-blur-sm ${
            transActive
              ? 'border-blue-500 bg-blue-600 text-white'
              : selectedMunicipio
              ? 'border-gray-700 bg-gray-900/80 text-gray-300 hover:bg-gray-800 hover:text-white'
              : 'cursor-help border-gray-800 bg-gray-900/60 text-gray-500'
          }`}
        >
          Transformadores
          {!selectedMunicipio && <span className="ml-1 text-gray-600">*</span>}
        </button>

        <button
          onClick={toggleGaps}
          className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors backdrop-blur-sm ${
            gapsActive
              ? 'border-red-600 bg-red-700 text-white'
              : 'border-gray-700 bg-gray-900/80 text-gray-300 hover:bg-gray-800 hover:text-white'
          }`}
        >
          <span className="inline-flex items-center gap-1">
            <span className="w-4 border-b-2 border-dashed border-current" />
            Gaps MT
          </span>
        </button>

        {selectedMunicipio && (
          <div className="mt-1 max-w-[160px] truncate rounded border border-gray-700 bg-gray-900/80 px-2 py-1 text-xs text-gray-400 backdrop-blur-sm">
            {selectedMunicipio.municipio}
          </div>
        )}
      </div>

      <div className="absolute top-14 right-3 z-10 w-64 overflow-hidden rounded-lg border border-gray-700 bg-gray-900/90 backdrop-blur-sm">
        <div className="border-b border-gray-700 px-3 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-300">
            Top 10 Municípios Críticos
          </h3>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {rankingLoading ? (
            <div className="space-y-2 px-3 py-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-3 animate-pulse rounded bg-gray-800" />
              ))}
            </div>
          ) : ranking.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-gray-500">Sem dados disponíveis</div>
          ) : (
            <ul>
              {ranking.map((item, index) => (
                <li
                  key={`${item.municipio}-${item.uf}`}
                  className="flex items-center gap-2 border-b border-gray-800/60 px-3 py-2 transition-colors hover:bg-gray-800/50"
                >
                  <span className="w-5 shrink-0 font-mono text-xs text-gray-500">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-white">{item.municipio}</div>
                    <div className="truncate text-xs text-gray-500">{item.uf}</div>
                  </div>
                  <span className={`shrink-0 text-xs tabular-nums ${scoreClass(item.score_risco)}`}>
                    {item.score_risco?.toFixed(1) ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <style>{`
        .gridrisk-popup .maplibregl-popup-content {
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 8px;
          padding: 12px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.6);
        }
        .gridrisk-popup .maplibregl-popup-tip { border-top-color: #0f172a; }
        .gridrisk-popup .maplibregl-popup-close-button { color: #94a3b8; font-size: 16px; padding: 4px 8px; }
        .gridrisk-popup .maplibregl-popup-close-button:hover { color: #f1f5f9; background: transparent; }
      `}</style>
    </div>
  )
}
