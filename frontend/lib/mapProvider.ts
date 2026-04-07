const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'

export interface MapProviderConfig {
  engine: 'maplibre'
  provider: 'openfreemap'
  styleUrl: string
  initialView: {
    center: [number, number]
    zoom: number
  }
  fallback: {
    title: string
    description: string
    help: string
  }
}

export const MAP_PROVIDER_CONFIG: MapProviderConfig = {
  engine: 'maplibre',
  provider: 'openfreemap',
  styleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL,
  initialView: {
    center: [-35.7, -9.6],
    zoom: 8,
  },
  fallback: {
    title: 'Basemap indisponivel',
    description: 'Nao foi possivel carregar o mapa base open source nesta sessao.',
    help: 'Revise `NEXT_PUBLIC_MAP_STYLE_URL` ou tente novamente mais tarde.',
  },
}

export { DEFAULT_MAP_STYLE_URL }
