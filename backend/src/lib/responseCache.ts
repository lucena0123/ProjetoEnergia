type CacheEntry<T> = {
  expiresAt: number
  value: T
}

const responseCache = new Map<string, CacheEntry<unknown>>()

export async function withResponseCache<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs = 5 * 60 * 1000,
): Promise<T> {
  const now = Date.now()
  const cached = responseCache.get(key) as CacheEntry<T> | undefined
  if (cached && cached.expiresAt > now) return cached.value

  const value = await loader()
  responseCache.set(key, { value, expiresAt: now + ttlMs })
  return value
}
