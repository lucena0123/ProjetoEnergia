'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || ''

mapboxgl.accessToken = MAPBOX_TOKEN

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

function scoreClass(score: number | null): string {
  if (score == null) return 'text-gray-400'
  if (score >= 80) return 'text-red-400 font-bold'
  if (score >= 60) return 'text-orange-400 font-bold'
  if (score >= 40) return 'text-yellow-400 font-bold'
  return 'text-green-400 font-bold'
}

function removeLayer(m: mapboxgl.Map, id: string) {
  if (m.getLayer(id)) m.removeLayer(id)
  if (m.getSource(id)) m.removeSource(id)
}

/** Generate an inline SVG sparkline string for use inside Mapbox popup HTML */
function sparklineSvg(data: number[], width = 120, height = 28): string {
  if (!data || data.length === 0) return ''
  const min = Math.min(...data, 0)
  const max = Math.max(...data, 100)
  const range = max - min || 1
  const padX = 2
  const padY = 2
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const lastVal = data[data.length - 1]
  const color = lastVal >= 80 ? '#f87171' : lastVal >= 60 ? '#fb923c' : lastVal >= 40 ? '#facc15' : '#4ade80'
  const points = data
    .map((v, i) => {
      const x = padX + (i / Math.max(data.length - 1, 1)) * innerW
      const y = padY + innerH - ((v - min) / range) * innerH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
}

export default function MapaRisco() {
  const mapContainer = useRef<HTMLDivElement | null>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popupRef = useRef<mapboxgl.Popup | null>(null)

  const [mapLoaded, setMapLoaded] = useState(false)
  const [redeMtActive, setRedeMtActive] = useState(false)
  const [transActive, setTransActive] = useState(false)
  const [gapsActive, setGapsActive] = useState(false)
  const [selectedMunicipio, setSelectedMunicipio] = useState<MunicipioProps | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [ranking, setRanking] = useState<RankingItem[]>([])
  const [rankingLoading, setRankingLoading] = useState(true)
  const mapEnabled = Boolean(MAPBOX_TOKEN)

  // ── Sidebar ranking ────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API_URL}/api/ranking-municipios?limit=10&page=1`)
      .then((r) => r.json())
      .then((d) => setRanking(d.data ?? []))
      .catch(console.error)
      .finally(() => setRankingLoading(false))
  }, [])

  // ── Map init ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapEnabled) return
    if (map.current || !mapContainer.current) return

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-35.7, -9.6],
      zoom: 8,
      attributionControl: false,
    })

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-left')
    map.current.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left')

    map.current.on('load', () => {
      setMapLoaded(true)

      fetch(`${API_URL}/api/mapa-risco`)
        .then((r) => r.json())
        .then((geojson: GeoJSON.FeatureCollection) => {
          if (!map.current) return

          const valid: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: geojson.features.filter((f) => f.geometry !== null),
          }

          if (valid.features.length === 0) return

          map.current.addSource('municipios-risco', { type: 'geojson', data: valid })

          map.current.addLayer({
            id: 'municipios-fill',
            type: 'fill',
            source: 'municipios-risco',
            paint: {
              'fill-color': [
                'interpolate', ['linear'],
                ['coalesce', ['get', 'score_risco'], 0],
                0,   '#00ff00',
                50,  '#ffff00',
                80,  '#ff4400',
                100, '#ff0000',
              ],
              'fill-opacity': 0.65,
            },
          })

          map.current.addLayer({
            id: 'municipios-border',
            type: 'line',
            source: 'municipios-risco',
            paint: { 'line-color': '#ffffff', 'line-width': 0.5, 'line-opacity': 0.35 },
          })

          map.current.addLayer({
            id: 'municipios-selected',
            type: 'line',
            source: 'municipios-risco',
            paint: { 'line-color': '#38bdf8', 'line-width': 2.5 },
            filter: ['==', ['get', 'municipio'], ''],
          })

          // Fit bounds to data
          const coords = valid.features.flatMap((f) => {
            if (!f.geometry) return []
            const g = f.geometry as GeoJSON.MultiPolygon | GeoJSON.Polygon
            if (g.type === 'MultiPolygon') return g.coordinates.flat(2)
            if (g.type === 'Polygon') return g.coordinates.flat(1)
            return []
          }) as [number, number][]

          if (coords.length > 0) {
            const lngs = coords.map((c) => c[0])
            const lats = coords.map((c) => c[1])
            map.current.fitBounds(
              [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
              { padding: 40, duration: 800 },
            )
          }

          // ── Click handler ────────────────────────────────────────────────
          map.current.on('click', 'municipios-fill', async (e) => {
            if (!e.features?.length || !map.current) return
            const props = e.features[0].properties as MunicipioProps
            setSelectedMunicipio(props)

            map.current.setFilter('municipios-selected', ['==', ['get', 'municipio'], props.municipio])

            if (popupRef.current) popupRef.current.remove()

            const score = props.score_risco
            const scoreColor =
              score == null ? '#94a3b8'
              : score >= 80 ? '#f87171'
              : score >= 60 ? '#fb923c'
              : score >= 40 ? '#facc15'
              : '#4ade80'

            // Show loading popup immediately
            popupRef.current = new mapboxgl.Popup({
              closeButton: true,
              className: 'gridrisk-popup',
              maxWidth: '340px',
            })
              .setLngLat(e.lngLat)
              .setHTML(`
                <div style="font-family:system-ui,sans-serif;min-width:280px;padding:2px">
                  <div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:2px">
                    ${props.municipio}
                  </div>
                  <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">
                    ${props.distribuidora} · ${props.uf}
                  </div>
                  <div style="text-align:center;padding:16px 0;color:#64748b;font-size:12px">
                    Carregando detalhes...
                  </div>
                </div>`)
              .addTo(map.current)

            // Fetch rich detail
            try {
              const res = await fetch(
                `${API_URL}/api/municipio/${encodeURIComponent(props.municipio)}/detalhe`
              )
              if (!res.ok) throw new Error(`${res.status}`)
              const d = await res.json()

              const tendIcon =
                d.tendencia === 'piorando' ? '📈' : d.tendencia === 'melhorando' ? '📉' : '➡️'
              const tendColor =
                d.tendencia === 'piorando' ? '#f87171' : d.tendencia === 'melhorando' ? '#4ade80' : '#94a3b8'

              const sparkSvg = d.historico?.length
                ? sparklineSvg(d.historico.map((h: { score_risco: number }) => h.score_risco))
                : ''

              const formatNum = (n: number | null) =>
                n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

              popupRef.current?.setHTML(`
                <div style="font-family:system-ui,sans-serif;min-width:280px;padding:2px">
                  <div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:2px">
                    ${d.municipio}
                  </div>
                  <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">
                    ${d.distribuidora} · ${d.uf}
                  </div>

                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                    <span style="font-size:28px;font-weight:900;color:${scoreColor};line-height:1">
                      ${d.score_risco?.toFixed(0) ?? '—'}<span style="font-size:14px;color:#64748b">/100</span>
                    </span>
                    <span style="font-size:11px;color:${tendColor};font-weight:600">
                      ${tendIcon} ${d.tendencia}
                    </span>
                  </div>

                  <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px">
                    <div style="font-size:9px;color:#60a5fa;font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:.05em">DEC/FEC</div>
                    <div style="font-size:11px;color:#cbd5e1">
                      DEC: <b style="color:#f1f5f9">${d.dec_medio_12m?.toFixed(1) ?? '—'}h</b>
                      / limite ${d.dec_limite ?? 12.0}h
                      (ratio <b style="color:${scoreColor}">${d.ratio_dec?.toFixed(2) ?? '—'}×</b>)
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:2px">
                      Violações: <b style="color:#f1f5f9">${d.meses_violacao ?? '—'}</b>/12 meses
                    </div>
                  </div>

                  <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px">
                    <div style="font-size:9px;color:#60a5fa;font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:.05em">Infraestrutura</div>
                    <div style="font-size:11px;color:#cbd5e1">
                      Rede MT: <b style="color:#f1f5f9">${d.rede?.comprimento_mt_km ?? '—'}km</b>
                      · BT: <b style="color:#f1f5f9">${d.rede?.comprimento_bt_km ?? '—'}km</b>
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:2px">
                      Trafo: <b style="color:#f1f5f9">${d.rede?.n_transformadores ?? '—'}</b> total
                      · <b style="color:#ef4444">${d.rede?.transformadores_criticos ?? 0}</b> críticos (&gt;25a)
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:2px">
                      Potência: <b style="color:#f1f5f9">${d.rede?.potencia_total_kva ? (d.rede.potencia_total_kva / 1000).toFixed(1) + ' MVA' : '—'}</b>
                    </div>
                  </div>

                  <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px">
                    <div style="font-size:9px;color:#60a5fa;font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:.05em">Proteção</div>
                    <div style="font-size:11px;color:#cbd5e1">
                      Religadores: <b style="color:#f1f5f9">${d.protecao?.n_religadores ?? 0}</b>
                      · Chaves: <b style="color:#f1f5f9">${d.protecao?.n_chaves ?? 0}</b>
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:2px">
                      Cobertura: <b style="color:${(d.protecao?.cobertura_pct ?? 100) < 50 ? '#f87171' : '#4ade80'}">${d.protecao?.cobertura_pct ?? '—'}%</b>
                      · Exposto: <b style="color:#f1f5f9">${d.protecao?.km_sem_protecao ?? '—'}km</b>
                    </div>
                  </div>

                  ${d.social?.populacao ? `
                  <div style="background:#1e3a5f;border-radius:6px;padding:7px 9px;margin-bottom:6px">
                    <div style="font-size:9px;color:#60a5fa;font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:.05em">Contexto</div>
                    <div style="font-size:11px;color:#cbd5e1">
                      Pop: <b style="color:#f1f5f9">${formatNum(d.social.populacao)}</b>
                      · Dom: <b style="color:#f1f5f9">${formatNum(d.social.domicilios)}</b>
                    </div>
                    ${d.social.pib_per_capita ? `<div style="font-size:11px;color:#cbd5e1;margin-top:2px">PIB per capita: <b style="color:#f1f5f9">R$&nbsp;${d.social.pib_per_capita.toLocaleString('pt-BR')}</b></div>` : ''}
                  </div>` : ''}

                  ${sparkSvg ? `
                  <div style="margin-bottom:8px">
                    <div style="font-size:9px;color:#64748b;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">Histórico de Score</div>
                    ${sparkSvg}
                  </div>` : ''}

                  <a href="/municipio/${encodeURIComponent(d.municipio)}"
                     style="display:block;text-align:center;font-size:11px;color:#60a5fa;text-decoration:none;
                            padding:5px;border:1px solid #1e40af;border-radius:4px;margin-top:4px">
                    Ver detalhe completo →
                  </a>
                </div>`)
            } catch {
              // Keep simple popup on error
              popupRef.current?.setHTML(`
                <div style="font-family:system-ui,sans-serif;min-width:200px;padding:2px">
                  <div style="font-size:13px;font-weight:700;color:#f1f5f9">${props.municipio}</div>
                  <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${props.distribuidora} — ${props.uf}</div>
                  <div style="font-size:20px;font-weight:900;color:${scoreColor}">
                    ${score?.toFixed(1) ?? '—'}<span style="font-size:12px;color:#64748b">/100</span>
                  </div>
                  <div style="font-size:11px;color:#64748b;margin-top:4px">DEC ${props.dec_medio_12m?.toFixed(1) ?? '—'}h · ${props.meses_violacao ?? '—'}/12 violações</div>
                </div>`)
            }
          })

          map.current.on('mouseenter', 'municipios-fill', () => {
            if (map.current) map.current.getCanvas().style.cursor = 'pointer'
          })
          map.current.on('mouseleave', 'municipios-fill', () => {
            if (map.current) map.current.getCanvas().style.cursor = ''
          })
        })
        .catch((err) => console.error('[MapaRisco] mapa-risco load failed:', err))
    })

    return () => {
      popupRef.current?.remove()
      map.current?.remove()
      map.current = null
    }
  }, [mapEnabled])

  // ── Rede MT toggle ─────────────────────────────────────────────────────────
  const toggleRedeMt = useCallback(async () => {
    if (!map.current || !mapLoaded) return
    if (redeMtActive) {
      removeLayer(map.current, 'rede_mt-layer')
      setRedeMtActive(false)
      return
    }
    try {
      const res = await fetch(`${API_URL}/api/trechos-criticos?score_min=0&limit=500`)
      const geojson: GeoJSON.FeatureCollection = await res.json()
      if (map.current.getSource('rede_mt-layer')) return
      map.current.addSource('rede_mt-layer', { type: 'geojson', data: geojson })
      map.current.addLayer({
        id: 'rede_mt-layer',
        type: 'line',
        source: 'rede_mt-layer',
        paint: {
          'line-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'score_risco'], 0],
            0, '#60a5fa', 70, '#f97316', 100, '#ef4444',
          ],
          'line-width': 1.5,
          'line-opacity': 0.9,
        },
      })
      setRedeMtActive(true)
    } catch (err) {
      console.error('[MapaRisco] rede_mt load failed:', err)
    }
  }, [mapLoaded, redeMtActive])

  // ── Transformadores toggle ─────────────────────────────────────────────────
  const toggleTransformadores = useCallback(async () => {
    if (!map.current || !mapLoaded) return

    if (transActive) {
      removeLayer(map.current, 'transformadores-layer')
      setTransActive(false)
      setHint(null)
      return
    }

    if (!selectedMunicipio) {
      setHint('Clique em um município no mapa para ver os transformadores')
      setTimeout(() => setHint(null), 3500)
      return
    }

    try {
      const url = `${API_URL}/api/transformadores-criticos?municipio=${encodeURIComponent(selectedMunicipio.municipio)}`
      const res = await fetch(url)
      const geojson: GeoJSON.FeatureCollection = await res.json()

      if (map.current.getSource('transformadores-layer')) {
        const src = map.current.getSource('transformadores-layer') as mapboxgl.GeoJSONSource
        src.setData(geojson)
      } else {
        map.current.addSource('transformadores-layer', { type: 'geojson', data: geojson })
        map.current.addLayer({
          id: 'transformadores-layer',
          type: 'circle',
          source: 'transformadores-layer',
          paint: {
            'circle-radius': 4,
            'circle-color': [
              'interpolate', ['linear'], ['coalesce', ['get', 'score_risco'], 0],
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
    } catch (err) {
      console.error('[MapaRisco] transformadores load failed:', err)
    }
  }, [mapLoaded, transActive, selectedMunicipio])

  // ── Gaps de proteção toggle ────────────────────────────────────────────────
  const toggleGaps = useCallback(async () => {
    if (!map.current || !mapLoaded) return

    if (gapsActive) {
      removeLayer(map.current, 'gaps-layer')
      setGapsActive(false)
      return
    }

    try {
      const res = await fetch(`${API_URL}/api/gaps-protecao?score_min=20&limit=500`)
      const geojson: GeoJSON.FeatureCollection = await res.json()

      if (map.current.getSource('gaps-layer')) {
        const src = map.current.getSource('gaps-layer') as mapboxgl.GeoJSONSource
        src.setData(geojson)
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
    } catch (err) {
      console.error('[MapaRisco] gaps load failed:', err)
    }
  }, [mapLoaded, gapsActive])

  // Re-load transformadores when selected municipality changes while layer is active
  useEffect(() => {
    if (!transActive || !selectedMunicipio || !map.current) return
    fetch(`${API_URL}/api/transformadores-criticos?municipio=${encodeURIComponent(selectedMunicipio.municipio)}`)
      .then((r) => r.json())
      .then((geojson: GeoJSON.FeatureCollection) => {
        const src = map.current?.getSource('transformadores-layer') as mapboxgl.GeoJSONSource | undefined
        src?.setData(geojson)
      })
      .catch(console.error)
  }, [selectedMunicipio, transActive])

  return (
    <div className="relative w-full h-screen">
      <div ref={mapContainer} className="w-full h-full" />

      {!mapEnabled && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950">
          <div className="max-w-md rounded-xl border border-amber-700 bg-amber-950/80 px-6 py-5 text-center shadow-2xl">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">
              Mapa indisponivel
            </h2>
            <p className="mt-3 text-sm leading-6 text-amber-100">
              Configure `MAPBOX_TOKEN` no arquivo `.env` e recrie o frontend para habilitar o mapa.
            </p>
            <p className="mt-2 text-xs text-amber-200/80">
              O dashboard e a API continuam funcionando normalmente em `http://localhost:3000`.
            </p>
          </div>
        </div>
      )}

      {/* Hint toast */}
      {hint && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 bg-yellow-900/90 border border-yellow-700 text-yellow-200 text-xs px-4 py-2 rounded-lg shadow-lg backdrop-blur-sm">
          {hint}
        </div>
      )}

      {/* Layer toggles */}
      <div className="absolute bottom-10 left-3 z-10 flex flex-col gap-1.5">
        <button
          onClick={toggleRedeMt}
          className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors backdrop-blur-sm ${
            redeMtActive
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-gray-900/80 border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white'
          }`}
        >
          Rede MT
        </button>

        <button
          onClick={toggleTransformadores}
          title={!selectedMunicipio ? 'Clique em um município primeiro' : undefined}
          className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors backdrop-blur-sm ${
            transActive
              ? 'bg-blue-600 border-blue-500 text-white'
              : selectedMunicipio
              ? 'bg-gray-900/80 border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white'
              : 'bg-gray-900/60 border-gray-800 text-gray-500 cursor-help'
          }`}
        >
          Transformadores
          {!selectedMunicipio && (
            <span className="ml-1 text-gray-600">*</span>
          )}
        </button>

        <button
          onClick={toggleGaps}
          className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors backdrop-blur-sm ${
            gapsActive
              ? 'bg-red-700 border-red-600 text-white'
              : 'bg-gray-900/80 border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white'
          }`}
        >
          <span className="inline-flex items-center gap-1">
            <span className="w-4 border-b-2 border-dashed border-current" />
            Gaps MT
          </span>
        </button>

        {selectedMunicipio && (
          <div className="mt-1 px-2 py-1 text-xs text-gray-400 bg-gray-900/80 border border-gray-700 rounded backdrop-blur-sm max-w-[160px] truncate">
            {selectedMunicipio.municipio}
          </div>
        )}
      </div>

      {/* Ranking sidebar */}
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
            <div className="px-3 py-4 text-xs text-gray-500 text-center">Sem dados disponíveis</div>
          ) : (
            <ul>
              {ranking.map((item, idx) => (
                <li
                  key={`${item.municipio}-${item.uf}`}
                  className="flex items-center gap-2 px-3 py-2 border-b border-gray-800/60 hover:bg-gray-800/50 transition-colors"
                >
                  <span className="text-xs text-gray-500 font-mono w-5 shrink-0">{idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white truncate">{item.municipio}</div>
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

      <style>{`
        .gridrisk-popup .mapboxgl-popup-content {
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 8px;
          padding: 12px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.6);
        }
        .gridrisk-popup .mapboxgl-popup-tip { border-top-color: #0f172a; }
        .gridrisk-popup .mapboxgl-popup-close-button { color: #94a3b8; font-size: 16px; padding: 4px 8px; }
        .gridrisk-popup .mapboxgl-popup-close-button:hover { color: #f1f5f9; background: transparent; }
      `}</style>
    </div>
  )
}
