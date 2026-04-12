'use client'

import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MAP_PROVIDER_CONFIG } from '@/lib/mapProvider'
import {
  CHAVE_AT_SUBTYPE_ICON_IMAGE_EXPRESSION,
  SUBESTACAO_COMPONENT_COLOR_EXPRESSION,
  SUBESTACAO_ICON_ID,
  TRANSFORMADOR_AT_ICON_ID,
  ensureEquipmentSymbols,
} from '@/lib/mapSymbols'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
const EMPTY_GEOJSON: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

interface MapaLocalSubestacaoProps {
  codId: string
  uf: string
  distribuidora: string
}

function addGeoJsonSource(map: maplibregl.Map, id: string, data: GeoJSON.FeatureCollection) {
  if (map.getSource(id)) {
    ;(map.getSource(id) as maplibregl.GeoJSONSource).setData(data)
    return
  }
  map.addSource(id, { type: 'geojson', data })
}

function fitToFeatures(map: maplibregl.Map, ...collections: GeoJSON.FeatureCollection[]) {
  const coords = collections.flatMap((collection) =>
    collection.features.flatMap((feature) => {
      if (!feature.geometry) return []
      if (feature.geometry.type === 'Point') return [feature.geometry.coordinates]
      if (feature.geometry.type === 'LineString') return feature.geometry.coordinates
      if (feature.geometry.type === 'MultiLineString') return feature.geometry.coordinates.flat(1)
      return []
    }),
  ) as [number, number][]

  if (!coords.length) return
  const lngs = coords.map((coord) => coord[0])
  const lats = coords.map((coord) => coord[1])
  const minLng = Math.min(...lngs)
  const minLat = Math.min(...lats)
  const maxLng = Math.max(...lngs)
  const maxLat = Math.max(...lats)

  if (coords.length === 1 || (minLng === maxLng && minLat === maxLat)) {
    map.easeTo({ center: [minLng, minLat], zoom: 15, duration: 0 })
    return
  }

  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: 40, duration: 0 },
  )
}

function countFeatures(...collections: GeoJSON.FeatureCollection[]) {
  return collections.reduce((total, collection) => total + collection.features.length, 0)
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return response.json() as Promise<T>
}

async function fetchGeoJson(url: string, label: string): Promise<GeoJSON.FeatureCollection> {
  try {
    return await fetchJson<GeoJSON.FeatureCollection>(url)
  } catch (error) {
    console.warn(`[MapaLocalSubestacao] ${label} failed:`, error)
    return EMPTY_GEOJSON
  }
}

export default function MapaLocalSubestacao({ codId, uf, distribuidora }: MapaLocalSubestacaoProps) {
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
        const makeParams = (limit: string) => new URLSearchParams({ uf, distribuidora, subestacao: codId, limit }).toString()

        const [subestacoes, alimentadoresMt, alimentadoresAt, redeAt, transformadoresAt, chavesAt, componentes] = await Promise.all([
          fetchGeoJson(`${API_URL}/api/subestacoes?${makeParams('100')}`, 'subestacoes'),
          fetchGeoJson(`${API_URL}/api/alimentadores?${makeParams('10000')}`, 'alimentadores-mt'),
          fetchGeoJson(`${API_URL}/api/alimentadores-at?${makeParams('10000')}`, 'alimentadores-at'),
          fetchGeoJson(`${API_URL}/api/rede-at?${makeParams('10000')}`, 'rede-at'),
          fetchGeoJson(`${API_URL}/api/transformadores-at?${makeParams('10000')}`, 'transformadores-at'),
          fetchGeoJson(`${API_URL}/api/chaves-at?${makeParams('10000')}`, 'chaves-at'),
          fetchGeoJson(`${API_URL}/api/subestacao-componentes?${makeParams('10000')}`, 'subestacao-componentes'),
        ])

        addGeoJsonSource(map, 'subestacao-local', subestacoes)
        addGeoJsonSource(map, 'alimentadores-mt-local', alimentadoresMt)
        addGeoJsonSource(map, 'alimentadores-at-local', alimentadoresAt)
        addGeoJsonSource(map, 'rede-at-local', redeAt)
        addGeoJsonSource(map, 'transformadores-at-local', transformadoresAt)
        addGeoJsonSource(map, 'chaves-at-local', chavesAt)
        addGeoJsonSource(map, 'componentes-local', componentes)

        map.addLayer({
          id: 'rede-at-local-layer',
          type: 'line',
          source: 'rede-at-local',
          paint: {
            'line-color': '#991b1b',
            'line-width': 1.8,
            'line-opacity': 0.85,
          },
        })

        map.addLayer({
          id: 'alimentadores-at-local-layer',
          type: 'line',
          source: 'alimentadores-at-local',
          paint: {
            'line-color': '#8b5cf6',
            'line-width': 3,
            'line-opacity': 0.92,
            'line-dasharray': [4, 2],
          },
        })

        map.addLayer({
          id: 'alimentadores-mt-local-layer',
          type: 'line',
          source: 'alimentadores-mt-local',
          paint: {
            'line-color': '#60a5fa',
            'line-width': 2.2,
            'line-opacity': 0.8,
          },
        })

        map.addLayer({
          id: 'transformadores-at-local-layer',
          type: 'symbol',
          source: 'transformadores-at-local',
          layout: {
            'icon-image': TRANSFORMADOR_AT_ICON_ID,
            'icon-size': 0.58,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        })

        map.addLayer({
          id: 'chaves-at-local-layer',
          type: 'symbol',
          source: 'chaves-at-local',
          layout: {
            'icon-image': CHAVE_AT_SUBTYPE_ICON_IMAGE_EXPRESSION,
            'icon-size': 0.62,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        })

        map.addLayer({
          id: 'componentes-local-layer',
          type: 'circle',
          source: 'componentes-local',
          paint: {
            'circle-color': SUBESTACAO_COMPONENT_COLOR_EXPRESSION,
            'circle-radius': 5,
            'circle-stroke-color': '#fce7f3',
            'circle-stroke-width': 1.2,
          },
        })

        map.addLayer({
          id: 'subestacao-local-layer',
          type: 'symbol',
          source: 'subestacao-local',
          layout: {
            'icon-image': SUBESTACAO_ICON_ID,
            'icon-size': 0.78,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        })

        fitToFeatures(map, subestacoes, alimentadoresMt, alimentadoresAt, redeAt, transformadoresAt, chavesAt, componentes)

        if (countFeatures(subestacoes, alimentadoresMt, alimentadoresAt, redeAt, transformadoresAt, chavesAt, componentes) === 0) {
          setError('A base pública não trouxe geometrias para o mapa local desta subestação.')
        }
      } catch (loadError) {
        console.error('[MapaLocalSubestacao] load failed:', loadError)
        setError('Não foi possível carregar o mapa local desta subestação.')
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
