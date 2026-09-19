// Single choke point for every request to Google's free `gtx` endpoint.
//
// That endpoint has no key and no quota guarantee, and answers 302 →
// google.com/sorry once an IP looks automated. So every caller goes through:
//   - an LRU cache, persisted to chrome.storage.local (survives reloads/tabs),
//   - batching (several texts joined by "\n" into one request),
//   - a small queue (max 2 in flight, spaced apart),
//   - a circuit breaker (stop calling for a while once Google pushes back).

import { PersistentLru } from './persistentLru'

const GT_BASE = 'https://translate.googleapis.com/translate_a/single?client=gtx'
const STORAGE_KEY = 'gtCache'
const MAX_ENTRIES = 2000
const CONCURRENCY = 2
const REQUEST_GAP_MS = 200
const BREAKER_MS = 10 * 60 * 1000
const MAX_BATCH_ITEMS = 20
const MAX_BATCH_ENCODED = 1500 // keeps the GET URL comfortably under ~2000 chars

// ── LRU cache ─────────────────────────────────────────────────────────────────

const cache = new PersistentLru<string>(STORAGE_KEY, MAX_ENTRIES)
const ensureLoaded = () => cache.ready()
const cacheGet = (key: string) => cache.get(key)
const cacheSet = (key: string, value: string) => cache.set(key, value)

// Whitespace-normalised: the same sentence reaches us with different spacing
// (Read Aloud's segmenter trims, the save popup rebuilds it from prefix + word +
// suffix), and those must share one entry.
const cacheKey = (text: string, tgt: string) => `${tgt}::${text.replace(/\s+/g, ' ').trim()}`

// ── Circuit breaker ───────────────────────────────────────────────────────────

let blockedUntil = 0

export function isGoogleBlocked(): boolean {
  return Date.now() < blockedUntil
}

// ── Request queue ─────────────────────────────────────────────────────────────

let inFlight = 0
let lastStart = 0
const waiting: Array<() => void> = []

async function schedule<T>(task: () => Promise<T>): Promise<T> {
  while (inFlight >= CONCURRENCY) await new Promise<void>(r => waiting.push(r))
  inFlight++
  try {
    const wait = lastStart + REQUEST_GAP_MS - Date.now()
    lastStart = Math.max(Date.now(), lastStart + REQUEST_GAP_MS)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    return await task()
  } finally {
    inFlight--
    waiting.shift()?.()
  }
}

// One HTTP round trip. Returns the translated chunks; throws (and trips the
// breaker) when Google redirects to its "sorry" page or rate-limits.
async function fetchChunks(q: string, tgt: string): Promise<string> {
  if (isGoogleBlocked()) throw new Error('google-blocked')
  const url = `${GT_BASE}&sl=auto&tl=${encodeURIComponent(tgt)}&dt=t&q=${encodeURIComponent(q)}`
  const res = await schedule(() => fetch(url, { redirect: 'manual' }))
  if (res.type === 'opaqueredirect' || res.status === 429 || res.status === 302) {
    blockedUntil = Date.now() + BREAKER_MS
    throw new Error('google-blocked')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as [Array<[string, ...unknown[]]>, ...unknown[]]
  return json[0].map(chunk => chunk[0]).join('')
}

async function translateOne(text: string, tgt: string): Promise<string | null> {
  try {
    return await fetchChunks(text, tgt)
  } catch {
    return null
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Translate many texts with as few requests as possible. Null = failed. */
export async function googleTranslateBatch(texts: string[], tgt: string): Promise<Array<string | null>> {
  await ensureLoaded()
  const results: Array<string | null> = texts.map(() => null)
  const misses = new Map<string, number[]>() // text → indexes wanting it

  texts.forEach((text, i) => {
    const hit = cacheGet(cacheKey(text, tgt))
    if (hit !== undefined) results[i] = hit
    else if (text.trim()) misses.set(text, [...(misses.get(text) ?? []), i])
  })

  const store = (text: string, tr: string | null) => {
    if (tr === null) return
    cacheSet(cacheKey(text, tgt), tr)
    for (const i of misses.get(text) ?? []) results[i] = tr
  }

  // Group misses into batches bounded by count and encoded length.
  const batches: string[][] = []
  let cur: string[] = []
  let curLen = 0
  for (const text of misses.keys()) {
    const len = encodeURIComponent(text).length + 3
    if (cur.length && (cur.length >= MAX_BATCH_ITEMS || curLen + len > MAX_BATCH_ENCODED)) {
      batches.push(cur)
      cur = []
      curLen = 0
    }
    cur.push(text)
    curLen += len
  }
  if (cur.length) batches.push(cur)

  await Promise.all(batches.map(async batch => {
    if (batch.length === 1) return store(batch[0], await translateOne(batch[0], tgt))

    // Newlines are the separator, so flatten any inside the texts themselves.
    const flat = batch.map(t => t.replace(/\s*\n\s*/g, ' '))
    let parts: string[] | null = null
    try {
      const joined = await fetchChunks(flat.join('\n'), tgt)
      const split = joined.split('\n')
      if (split.at(-1) === '') split.pop()
      if (split.length === batch.length && split.every(s => s.trim())) parts = split
    } catch {
      return // blocked or network error: leave these as null
    }
    if (parts) return batch.forEach((t, i) => store(t, parts![i]))

    // Google merged/split lines so they no longer line up — do them one by one.
    for (const t of batch) store(t, await translateOne(t, tgt))
  }))

  return results
}

export async function googleTranslate(text: string, tgt: string): Promise<string | null> {
  return (await googleTranslateBatch([text], tgt))[0]
}

/** Raw gtx call with extra params (dictionary senses, romanization). Cached (as JSON),
 *  queued and breaker-guarded like the rest. Null on failure/block. */
export async function googleFetchJson(text: string, tgt: string, extraParams: string): Promise<unknown | null> {
  await ensureLoaded()
  const key = `${extraParams}::${cacheKey(text, tgt)}`
  const hit = cacheGet(key)
  if (hit !== undefined) return JSON.parse(hit)
  if (isGoogleBlocked()) return null
  const url = `${GT_BASE}&sl=auto&tl=${encodeURIComponent(tgt)}&${extraParams}&q=${encodeURIComponent(text)}`
  try {
    const res = await schedule(() => fetch(url, { redirect: 'manual' }))
    if (res.type === 'opaqueredirect' || res.status === 429 || res.status === 302) {
      blockedUntil = Date.now() + BREAKER_MS
      return null
    }
    if (!res.ok) return null
    const json = await res.json()
    cacheSet(key, JSON.stringify(json))
    return json
  } catch {
    return null
  }
}
