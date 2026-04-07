'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'

// Dynamic import to avoid SSR issues with the map runtime
const MapaRisco = dynamic(() => import('@/components/MapaRisco'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-gray-400 text-sm">Carregando mapa...</p>
      </div>
    </div>
  ),
})

export default function MapaPage() {
  return (
    <div className="relative w-full h-screen overflow-hidden bg-gray-950">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between bg-gray-900/90 backdrop-blur-sm border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 text-gray-300 hover:text-white transition-colors text-sm"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Voltar ao Dashboard
          </Link>
          <span className="text-gray-700">|</span>
          <h1 className="text-white font-semibold text-sm">
            <span className="text-red-500">Grid</span>Risk — Mapa de Risco
          </h1>
        </div>

        <div className="hidden sm:flex items-center gap-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-green-500 inline-block" />
            Baixo
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-yellow-400 inline-block" />
            Médio
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-orange-500 inline-block" />
            Alto
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-red-600 inline-block" />
            Crítico
          </span>
        </div>
      </div>

      {/* Map fills entire viewport */}
      <MapaRisco />
    </div>
  )
}
