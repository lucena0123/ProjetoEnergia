'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || ''

interface MunicipioRiscoProperties {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number | null
  dec_medio_12m: number | null
  meses_violacao: number | null
  idade_media_anos: number | null
}

interface MunicipioRiscoFeature extends GeoJSON.Feature {
  properties: MunicipioRiscoProperties
}

interface RankingItem {
  municipio: string
  distribuidora: string
  uf: string
  score_risco: number
}

type LayerToggle = 'rede_mt' | 'transformadores' | 'religadores'

function scoreLabel(score: number | null): string {
  if (score == null) return '—'
  if (score >= 80) return 'Crítico'
  if (score >= 60) return 'Alto'
  if (score >= 40) return 'Médio'
  return 'Baixo'
}

function scoreClass(score: number | null): string {
  if (score == null) return 'text-gray-400'
  if (score >= 80) return 'text-red-400 font-bold'
  if (score >= 60) return 'text-orange-400 font-bold'
  if (score >= 40) return 'text-yellow-400 font-bold'
  return 'text-green-400 font-bold'
}

export default function MapaRisco() {
  const mapContainer = useRef<HTMLDivElement | null>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popupRef = useRef<mapboxgl.Popup | null>(null)

  const [activeLayers, setActiveLayers] = useState<Set<LayerToggle>>(new Set())
  const [ranking, setRanking] = useState<RankingItem[]>([])
  const [rankingLoading, setRankingLoading] = useState(true)
  const [mapLoaded, setMapLoaded] = useState(false)

  // Fetch top-10 ranking for sidebar
  useEffect(() => {
    fetch(`${API_URL}/api/ranking-municipios?limit=10&page=1`)
      .then((r) => r.json())
      .then((d) => {
        setRanking(d.data ?? [])
      })
      .catch(console.error)
      .finally(() => setRankingLoading(false))
  }, [])

  // Initialize map
  useEffect(() => {
    if (map.current || !mapContainer.current) return

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-35.7, -9.6],
      zoom: 8,
      attributionControl: false,
    })

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-left')
    map.current.addControl(
      new mapboxgl.AttributionControl({ compact: true }),
      'bottom-left',
    )

    map.current.on('load', () => {
      setMapLoaded(true)

      // Fetch and add mapa-risco GeoJSON
      fetch(`${API_URL}/api/mapa-risco`)
        .then((r) => r.json())
        .then((geojson: GeoJSON.FeatureCollection) => {
          if (!map.current) return

          // Filter out features with null geometry
          const validFeatures = geojson.features.filter((f) => f.geometry !== null)
          const validGeojson: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: validFeatures,
          }

          map.current.addSource('municipios-risco', {
            type: 'geojson',
            data: validGeojson,
          })

          // Fill layer with score-based color interpolation
          map.current.addLayer({
            id: 'municipios-fill',
            type: 'fill',
            source: 'municipios-risco',
            paint: {
              'fill-color': [
                'interpolate',
                ['linear'],
                ['coalesce', ['get', 'score_risco'], 0],
                0, '#00ff00',
                50, '#ffff00',
                80, '#ff4400',
                100, '#ff0000',
              ],
              'fill-opacity': 0.7,
            },
          })

          // Border layer
          map.current.addLayer({
            id: 'municipios-border',
            type: 'line',
            source: 'municipios-risco',
            paint: {
              'line-color': '#ffffff',
              'line-width': 0.5,
              'line-opacity': 0.4,
            },
          })

          // Click handler for municipality popup
          map.current.on('click', 'municipios-fill', (e) => {
            if (!e.features || e.features.length === 0 || !map.current) return

            const feature = e.features[0] as MunicipioRiscoFeature
            const props = feature.properties

            if (popupRef.current) popupRef.current.remove()

            const score = props.score_risco
            const html = `
              <div style="font-family: system-ui, sans-serif; min-width: 200px;">
                <div style="font-size: 14px; font-weight: 700; margin-bottom: 8px; color: #f1f5f9;">
                  ${props.municipio}
                </div>
                <div style="font-size: 11px; color: #94a3b8; margin-bottom: 8px;">${props.distribuidora} — ${props.uf}</div>
                <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                  <tr>
                    <td style="padding: 3px 0; color: #94a3b8;">Score de Risco</td>
                    <td style="padding: 3px 0; text-align: right; font-weight: 700; color: ${
                      score == null ? '#94a3b8'
                      : score >= 80 ? '#f87171'
                      : score >= 60 ? '#fb923c'
                      : score >= 40 ? '#facc15'
                      : '#4ade80'
                    };">${score?.toFixed(1) ?? '—'} / 100</td>
                  </tr>
                  <tr>
                    <td style="padding: 3px 0; color: #94a3b8;">DEC Médio 12m</td>
                    <td style="padding: 3px 0; text-align: right; color: #e2e8f0;">${props.dec_medio_12m?.toFixed(2) ?? '—'} h</td>
                  </tr>
                  <tr>
                    <td style="padding: 3px 0; color: #94a3b8;">Meses c/ Violação</td>
                    <td style="padding: 3px 0; text-align: right; color: #e2e8f0;">${props.meses_violacao ?? '—'} / 12</td>
                  </tr>
                  <tr>
                    <td style="padding: 3px 0; color: #94a3b8;">Idade Média Rede</td>
                    <td style="padding: 3px 0; text-align: right; color: #e2e8f0;">${props.idade_media_anos?.toFixed(1) ?? '—'} anos</td>
                  </tr>
                </table>
              </div>
            `

            popupRef.current = new mapboxgl.Popup({
              closeButton: true,
              className: 'gridrisk-popup',
            })
              .setLngLat(e.lngLat)
              .setHTML(html)
              .addTo(map.current)
          })

          map.current.on('mouseenter', 'municipios-fill', () => {
            if (map.current) map.current.getCanvas().style.cursor = 'pointer'
          })
          map.current.on('mouseleave', 'municipios-fill', () => {
            if (map.current) map.current.getCanvas().style.cursor = ''
          })
        })
        .catch((err) => console.error('[MapaRisco] Failed to load mapa-risco:', err))
    })

    return () => {
      if (popupRef.current) popupRef.current.remove()
      map.current?.remove()
      map.current = null
    }
  }, [])

  const toggleLayer = useCallback(
    async (layerName: LayerToggle) => {
      if (!map.current || !mapLoaded) return

      const isActive = activeLayers.has(layerName)

      if (isActive) {
        // Remove layer and source
        if (map.current.getLayer(`${layerName}-layer`)) {
          map.current.removeLayer(`${layerName}-layer`)
        }
        if (map.current.getSource(layerName)) {
          map.current.removeSource(layerName)
        }
        setActiveLayers((prev) => {
          const next = new Set(prev)
          next.delete(layerName)
          return next
        })
      } else {
        // Fetch and add layer
        try {
          let url: string
          if (layerName === 'rede_mt') {
            url = `${API_URL}/api/trechos-criticos?score_min=0&limit=500`
          } else if (layerName === 'transformadores') {
            // Load transformadores for all (no municipio filter — may be heavy)
            url = `${API_URL}/api/transformadores-criticos?municipio=`
            // Skip if no municipio — show a tip
            console.warn('[MapaRisco] transformadores layer requires a municipio filter')
            return
          } else {
            // religadores not exposed yet — skip gracefully
            console.warn('[MapaRisco] religadores layer endpoint not yet available')
            return
          }

          const res = await fetch(url)
          const geojson: GeoJSON.FeatureCollection = await res.json()

          if (map.current.getSource(layerName)) return // already added

          map.current.addSource(layerName, { type: 'geojson', data: geojson })

          if (layerName === 'rede_mt') {
            map.current.addLayer({
              id: `${layerName}-layer`,
              type: 'line',
              source: layerName,
              paint: {
                'line-color': [
                  'interpolate',
                  ['linear'],
                  ['coalesce', ['get', 'score_risco'], 0],
                  0, '#60a5fa',
                  70, '#f97316',
                  100, '#ef4444',
                ],
                'line-width': 1.5,
                'line-opacity': 0.9,
              },
            })
          }

          setActiveLayers((prev) => new Set([...prev, layerName]))
        } catch (err) {
          console.error(`[MapaRisco] Failed to load layer ${layerName}:`, err)
        }
      }
    },
    [mapLoaded, activeLayers],
  )

  const layerButtons: { key: LayerToggle; label: string }[] = [
    { key: 'rede_mt', label: 'Rede MT' },
    { key: 'transformadores', label: 'Transformadores' },
    { key: 'religadores', label: 'Religadores' },
  ]

  return (
    <div className="relative w-full h-screen">
      {/* Map container */}
      <div ref={mapContainer} className="w-full h-full" />

      {/* Layer toggles — bottom left above attribution */}
      <div className="absolute bottom-10 left-3 z-10 flex flex-col gap-1.5">
        {layerButtons.map(({ key, label }) => {
          const active = activeLayers.has(key)
          return (
            <button
              key={key}
              onClick={() => toggleLayer(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors backdrop-blur-sm ${
                active
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-900/80 border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* Ranking sidebar — right side */}
      <div className="absolute top-14 right-3 z-10 w-64 bg-gray-900/90 backdrop-blur-sm border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-3 py-2.5 border-b border-gray-700">
          <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
            Top 10 Municípios Críticos
          </h3>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {rankingLoading ? (
            <div className="px-3 py-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-3 bg-gray-800 rounded animate-pulse" />
              ))}
            </div>
          ) : ranking.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-500 text-center">
              Sem dados disponíveis
            </div>
          ) : (
            <ul>
              {ranking.map((item, idx) => (
                <li
                  key={`${item.municipio}-${item.uf}`}
                  className="flex items-center gap-2 px-3 py-2 border-b border-gray-800/60 hover:bg-gray-800/50 transition-colors"
                >
                  <span className="text-xs text-gray-500 font-mono w-5 shrink-0">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white truncate">
                      {item.municipio}
                    </div>
                    <div className="text-xs text-gray-500 truncate">{item.uf}</div>
                  </div>
                  <span className={`text-xs tabular-nums shrink-0 ${scoreClass(item.score_risco)}`}>
                    {item.score_risco?.toFixed(1) ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Global popup styles injected inline */}
      <style>{`
        .gridrisk-popup .mapboxgl-popup-content {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 8px;
          padding: 12px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        }
        .gridrisk-popup .mapboxgl-popup-tip {
          border-top-color: #1e293b;
        }
        .gridrisk-popup .mapboxgl-popup-close-button {
          color: #94a3b8;
          font-size: 16px;
          padding: 4px 8px;
        }
        .gridrisk-popup .mapboxgl-popup-close-button:hover {
          color: #f1f5f9;
          background: transparent;
        }
      `}</style>
    </div>
  )
}
