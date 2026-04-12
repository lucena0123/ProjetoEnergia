export interface ParsedBbox {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

export function parseBbox(raw?: string): ParsedBbox | null {
  if (!raw) return null

  const parts = raw.split(',').map((value) => Number.parseFloat(value.trim()))
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error('bbox must be formatted as minLng,minLat,maxLng,maxLat')
  }

  const [minLng, minLat, maxLng, maxLat] = parts
  if (minLng >= maxLng || minLat >= maxLat) {
    throw new Error('bbox coordinates are invalid')
  }

  return { minLng, minLat, maxLng, maxLat }
}

export function buildBboxIntersectSql(column: string, startIndex: number): string {
  return `
    ST_Intersects(
      ${column},
      ST_Transform(
        ST_MakeEnvelope($${startIndex}, $${startIndex + 1}, $${startIndex + 2}, $${startIndex + 3}, 4326),
        4674
      )
    )
  `
}
