// Shared IPA phonetics lookup + cache, used by both Video Mode (phonetics
// under each subtitle word) and Read Aloud (phonetics badge for the word
// currently being spoken). English only — see the language gate in
// aiTranslate.ts.
//
// Both features repeat the same words constantly ("the", "you", "is"...), so
// this keeps one memory cache shared between them and checks it before ever
// messaging the background: a cache hit costs nothing, not even an IPC round
// trip — a word already looked up in one feature is free in the other.
// Unlike the background's own phoneticsCache (capped, defensive against a
// long-lived service worker) this one is deliberately uncapped — a whole
// article or movie's unique vocabulary is a few thousand words at most,
// trivial to hold for the length of a page/tab's life, and dropping entries
// here would mean re-fetching a word already seen once this session.

const _cache = new Map<string, string | null>()
// De-dupes concurrent requests for the same word — a feature's own fetch and
// a look-ahead prefetch (or the other feature entirely) can otherwise both go
// out for the same word at once.
const _pending = new Map<string, Promise<void>>()

function normalise(word: string): string {
  return word.toLowerCase()
}

async function fetchMissing(words: string[]): Promise<void> {
  const toFetch = words.filter(w => !_pending.has(w))
  if (toFetch.length === 0) {
    await Promise.all(words.map(w => _pending.get(w)))
    return
  }

  const request = (async () => {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'FETCH_PHONETICS',
        payload: { words: toFetch },
      }) as Record<string, string | null> | undefined
      // A word missing from `result` means the background lookup for it
      // failed (network error, timeout, rate limit) rather than definitively
      // finding no phonetics — leave it uncached so it's tried again next
      // time this word comes up, instead of being remembered forever as
      // "this word has no phonetics".
      for (const w of toFetch) {
        if (result && Object.prototype.hasOwnProperty.call(result, w)) _cache.set(w, result[w])
      }
    } catch {
      // Extension reloaded / no background — leave uncached, same reasoning.
    } finally {
      for (const w of toFetch) _pending.delete(w)
    }
  })()

  for (const w of toFetch) _pending.set(w, request)
  await Promise.all(words.map(w => _pending.get(w) ?? request))
}

/**
 * Phonetics for a batch of words — the cue currently on screen (Video Mode)
 * or the sentence being spoken (Read Aloud). Resolves once every word is
 * either cached or has come back from the background.
 */
export async function phoneticsForWords(words: string[]): Promise<Map<string, string | null>> {
  const clean = [...new Set(words.map(normalise).filter(Boolean))]
  const missing = clean.filter(w => !_cache.has(w))
  if (missing.length > 0) await fetchMissing(missing)

  const out = new Map<string, string | null>()
  for (const w of clean) out.set(w, _cache.get(w) ?? null)
  return out
}

/**
 * Fire-and-forget look-ahead: populate the cache for words not on screen/
 * spoken yet, so by the time they are the words are already known. Callers
 * don't await this — it only ever writes to the cache, never to the DOM, so
 * there is nothing to race against a cue/sentence change.
 */
export function prefetchPhonetics(words: string[]): void {
  const clean = [...new Set(words.map(normalise).filter(Boolean))]
  const missing = clean.filter(w => !_cache.has(w))
  if (missing.length > 0) void fetchMissing(missing)
}

export function clearPhoneticsCache(): void {
  _cache.clear()
  _pending.clear()
}
