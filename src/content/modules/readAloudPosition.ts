/**
 * F24 — remember read-aloud position per URL and offer Resume.
 *
 * Persists the current sentence index keyed by the (normalized) page URL to
 * `chrome.storage.local` under a single small map, so the user can pick up
 * where they left off. The map is capped and pruned (oldest-first) so it never
 * grows unbounded.
 *
 * The position is saved on pause and on stop/teardown (and periodically as the
 * reader advances), and cleared for a URL when its article finishes naturally
 * (F22) so a completed article never offers a stale resume.
 */

const STORAGE_KEY = 'cxt_read_positions'
// Keep the map small; prune the oldest entries once we exceed this.
const MAX_ENTRIES = 100

export interface SavedPosition {
  index: number
  total: number
  updatedAt: number
}

type PositionMap = Record<string, SavedPosition>

// Normalize a URL so trivially different variants (hash, trailing slash) map to
// the same saved position. We keep the query string since it often selects the
// actual article, but drop the fragment (in-page anchors) and any trailing "/".
export function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    u.hash = ''
    let path = u.pathname
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
    return `${u.origin}${path}${u.search}`
  } catch {
    // Fall back to a best-effort strip of the fragment.
    return rawUrl.split('#')[0]
  }
}

// The URL the *current reading session* was started on. Captured at session
// start so that a save triggered by an SPA navigation (which has already
// mutated location.href) still keys the position to the article that was being
// read, not the page the user just navigated to. Falls back to location.href
// for reads (the idle Resume check) when no session is active.
let sessionUrl: string | null = null

export function setSessionUrl(rawUrl: string): void {
  sessionUrl = normalizeUrl(rawUrl)
}

export function clearSessionUrl(): void {
  sessionUrl = null
}

// Key for *writes* during a session: prefer the session URL so SPA navs save to
// the right article.
function writeKey(): string {
  return sessionUrl ?? normalizeUrl(location.href)
}

// Key for *reads* (idle Resume check): always the live URL.
function currentKey(): string {
  return normalizeUrl(location.href)
}

async function readMap(): Promise<PositionMap> {
  try {
    const res = await chrome.storage.local.get(STORAGE_KEY)
    return (res[STORAGE_KEY] as PositionMap) || {}
  } catch {
    return {}
  }
}

async function writeMap(map: PositionMap): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: map })
  } catch {
    // Best-effort; a failed write just means no resume next time.
  }
}

function prune(map: PositionMap): PositionMap {
  const keys = Object.keys(map)
  if (keys.length <= MAX_ENTRIES) return map
  // Drop the oldest entries first, keeping the most recently touched ones.
  const sorted = keys.sort((a, b) => (map[b].updatedAt || 0) - (map[a].updatedAt || 0))
  const kept: PositionMap = {}
  for (const k of sorted.slice(0, MAX_ENTRIES)) kept[k] = map[k]
  return kept
}

/**
 * Persist the current position for this page. Index 0 (or a missing total) is
 * treated as "nothing worth resuming" and clears any prior entry instead.
 */
export async function savePosition(index: number, total: number): Promise<void> {
  if (location.protocol === 'chrome-extension:') return
  const key = writeKey()
  const map = await readMap()

  if (!Number.isFinite(index) || index <= 0 || !Number.isFinite(total) || total <= 0) {
    if (map[key]) {
      delete map[key]
      await writeMap(map)
    }
    return
  }

  map[key] = { index: Math.round(index), total: Math.round(total), updatedAt: Date.now() }
  await writeMap(prune(map))
}

/** Read the saved position for this page (undefined if none / index 0). */
export async function getSavedPosition(): Promise<SavedPosition | undefined> {
  if (location.protocol === 'chrome-extension:') return undefined
  const key = currentKey()
  const map = await readMap()
  const entry = map[key]
  if (!entry || entry.index <= 0) return undefined
  return entry
}

/** Forget the saved position for this page (called when it finishes). */
export async function clearPosition(): Promise<void> {
  const key = writeKey()
  const map = await readMap()
  if (map[key]) {
    delete map[key]
    await writeMap(map)
  }
}
