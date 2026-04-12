'use client'

import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MAP_PROVIDER_CONFIG } from '@/lib/mapProvider'
import {
  CHAVE_SUBTYPE_ICON_IMAGE_EXPRESSION,
  RELIGADOR_ICON_ID,
  SUBESTACAO_ICON_ID,
  TRANSFORMER_ICON_IMAGE_EXPRESSION,
  ensureEquipmentSymbols,
} from '@/lib/mapSymbols'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

interface MapaLocalAlimentadorProps {
  codId: string
  uf: string
  distribuidora: string
}

function fitBounds(map: maplibregl.Map, geojson: GeoJSON.FeatureCollection) {
  const coords = geojson.features.flatMap((feature) => {
    if (!feature.geometry) return []
    if (feature.geometry.type === 'MultiLineString') return feature.geometry.coordinates.flat(1)
    if (feature.geometry.type === 'LineString') return feature.geometry.coordinates
    return []
  }) as [number, number][]

  if (!coords.length) return
  const lngs = coords.map((coord) => coord[0])
  const lats = coords.map((coord) => coord[1])
  map.fitBounds(
    [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ],
    { padding: 36, duration: 0 },
  )
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return response.json() as Promise<T>
}

function addGeoJsonSource(map: maplibregl.Map, id: string, data: GeoJSON.FeatureCollection) {
  if (map.getSource(id)) {
    const source = map.getSource(id) as maplibregl.GeoJSONSource
    source.setData(data)
    return
  }

  map.addSource(id, {
    type: 'geojson',
    data,
  })
}

export default function MapaLocalAlimentador({ codId, uf, distribuidora }: MapaLocalAlimentadorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_PROVIDER_CONFIG.styleUrl,
      center: MAP_PROVIDER_CONFIG.initialView.center,
      zoom: 10,
      attributionControl: false,
    })

    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

    map.on('load', async () => {
      try {
        ensureEquipmentSymbols(map)

        const params = new URLSearchParams({
          alimentador: codId,
          uf,
          distribuidora,
        })

        const [alimentador, subestacoes, redeMt, redeBt, transformadores, religadores, chaves, gaps] = await Promise.all([
          fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/alimentadores?${params.toString()}&limit=1`),
          fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/subestacoes?${params.toString()}&limit=10`),
          fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/trechos-criticos?${params.toString()}&limit=20000`),
          fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/rede-bt?${params.toString()}&limit=25000`),
          fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/transformadores-criticos?${params.toString()}&limit=5000`),
          fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/religadores?${params.toString()}&limit=5000`),
          fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/chaves?${params.toString()}&limit=10000`),
          fetchJson<GeoJSON.FeatureCollection>(`${API_URL}/api/gaps-protecao?${params.toString()}&score_min=20&limit=10000`),
        ])

        addGeoJsonSource(map, 'alimentador', alimentador)
        addGeoJsonSource(map, 'subestacoes', subestacoes)
        addGeoJsonSource(map, 'rede-mt', redeMt)
        addGeoJsonSource(map, 'rede-bt', redeBt)
        addGeoJsonSource(map, 'transformadores', transformadores)
        addGeoJsonSource(map, 'religadores', religadores)
        addGeoJsonSource(map, 'chaves', chaves)
        addGeoJsonSource(map, 'gaps', gaps)

        if (!map.getLayer('rede-bt-layer')) {
          map.addLayer({
            id: 'rede-bt-layer',
            type: 'line',
            source: 'rede-bt',
            paint: {
              'line-color': '#dbeafe',
              'line-width': 1.1,
              'line-opacity': 0.7,
            },
          })
        }

        if (!map.getLayer('rede-mt-layer')) {
          map.addLayer({
            id: 'rede-mt-layer',
            type: 'line',
            source: 'rede-mt',
            paint: {
              'line-color': '#60a5fa',
              'line-width': 1.6,
              'line-opacity': 0.82,
            },
          })
        }

        if (!map.getLayer('gaps-layer')) {
          map.addLayer({
            id: 'gaps-layer',
            type: 'line',
            source: 'gaps',
            paint: {
              'line-color': '#ef4444',
              'line-width': 2.4,
              'line-opacity': 0.9,
              'line-dasharray': [2, 2],
            },
          })
        }

        if (!map.getLayer('alimentador-layer')) {
          map.addLayer({
            id: 'alimentador-layer',
            type: 'line',
            source: 'alimentador',
            paint: {
              'line-color': '#a78bfa',
              'line-width': 3.2,
              'line-opacity': 0.95,
              'line-dasharray': [3, 2],
            },
          })
        }

        if (!map.getLayer('transformadores-layer')) {
          map.addLayer({
            id: 'transformadores-layer',
            type: 'symbol',
            source: 'transformadores',
            layout: {
              'icon-image': TRANSFORMER_ICON_IMAGE_EXPRESSION,
              'icon-size': 0.5,
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
            paint: {
              'icon-opacity': 0.95,
            },
          })
        }

        if (!map.getLayer('religadores-layer')) {
          map.addLayer({
            id: 'religadores-layer',
            type: 'symbol',
            source: 'religadores',
            layout: {
              'icon-image': RELIGADOR_ICON_ID,
              'icon-size': 0.54,
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
            paint: {
              'icon-opacity': 0.95,
            },
          })
        }

        if (!map.getLayer('chaves-layer')) {
          map.addLayer({
            id: 'chaves-layer',
            type: 'symbol',
            source: 'chaves',
            layout: {
              'icon-image': CHAVE_SUBTYPE_ICON_IMAGE_EXPRESSION,
              'icon-size': 0.58,
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
            paint: {
              'icon-opacity': 0.95,
            },
          })
        }

        if (!map.getLayer('subestacoes-layer')) {
          map.addLayer({
            id: 'subestacoes-layer',
            type: 'symbol',
            source: 'subestacoes',
            layout: {
              'icon-image': SUBESTACAO_ICON_ID,
              'icon-size': 0.68,
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
            paint: {
              'icon-opacity': 0.97,
            },
          })
        }

        fitBounds(map, alimentador.features.length > 0 ? alimentador : redeMt)
      } catch (loadError) {
        console.error('[MapaLocalAlimentador] load failed:', loadError)
        setError('Não foi possível carregar o mapa local deste alimentador.')
      }
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [codId, distribuidora, uf])

  return (
    <div className="relative h-[420px] overflow-hidden rounded-xl border border-gray-800 bg-gray-950">
      <div ref={containerRef} className="h-full w-full" />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950/90 px-6 text-center text-sm text-red-300">
          {error}
        </div>
      )}
    </div>
  )
}
