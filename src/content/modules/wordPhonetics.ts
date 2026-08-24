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

// `approximate: true` means this reading isn't the word's own dictionary
// entry — it was borrowed from a fallback (aiTranslate.ts's word-formation
// fallback chain: singular of a plural, one half of a hyphenated compound,
// etc.). Still worth showing, just not with the same confidence as an exact
// match — callers dim it accordingly.
export type PhoneticsResult = { text: string; approximate: boolean } | null

const _cache = new Map<string, PhoneticsResult>()
// De-dupes concurrent requests for the same word — a feature's own fetch and
// a look-ahead prefetch (or the other feature entirely) can otherwise both go
// out for the same word at once.
const _pending = new Map<string, Promise<void>>()

function normalise(word: string): string {
  return word.toLowerCase()
}

// One `sendMessage` per word rather than batching a sentence (or a whole
// paragraph's 50-150+ words) into one — a batched message only resolves once
// its *slowest* word does (a word needing a fallback's own recursive
// sub-lookups can hold up a dozen others that already had their answer
// ready), so the DOM only ever got to update all-at-once, long after most of
// the sentence's words were individually long since known. One message per
// word means each shows up the moment *it's* ready, independent of its
// slower siblings — and, as a bonus, it also means an MV3 service worker
// recycled mid-flight only drops the one word in flight, not a whole batch.
// The background's own pacing/concurrency queue (aiTranslate.ts) is what
// actually protects the rate-limited API here, not the size of a
// content-script message — so this doesn't cost anything there.
async function fetchOne(word: string, priority: 'high' | 'low'): Promise<void> {
  const pending = _pending.get(word)
  if (pending) return pending

  const request = (async () => {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'FETCH_PHONETICS',
        payload: { words: [word], priority },
      }) as Record<string, { text: string | null; approximate: boolean }> | undefined
      // Missing from `result` means the background lookup failed (network
      // error, timeout, rate limit) rather than definitively finding no
      // phonetics — leave it uncached so it's tried again next time this
      // word comes up, instead of being remembered forever as "no phonetics".
      if (result && Object.prototype.hasOwnProperty.call(result, word)) {
        const entry = result[word]
        _cache.set(word, entry.text ? { text: entry.text, approximate: entry.approximate } : null)
      }
    } catch {
      // Message channel died (service worker recycled mid-flight, extension
      // reloaded...) — leave uncached; every other word's own message is
      // unaffected by this one's failure.
    } finally {
      _pending.delete(word)
    }
  })()

  _pending.set(word, request)
  return request
}

/**
 * Phonetics for a batch of words — the cue currently on screen (Video Mode)
 * or the sentence being spoken (Read Aloud). `onWord`, if given, fires as
 * *each* word resolves (cache hits fire synchronously-ish, on the next
 * microtask) rather than waiting for the slowest word in the batch — the
 * returned Promise still only resolves once every word has settled, for
 * callers that need to know when the whole batch is done (e.g. to decide
 * whether a retry pass is worth scheduling).
 */
export async function phoneticsForWords(
  words: string[],
  priority: 'high' | 'low' = 'high',
  onWord?: (word: string, result: PhoneticsResult) => void,
): Promise<Map<string, PhoneticsResult>> {
  const clean = [...new Set(words.map(normalise).filter(Boolean))]
  await Promise.all(clean.map(async w => {
    if (!_cache.has(w)) await fetchOne(w, priority)
    onWord?.(w, _cache.get(w) ?? null)
  }))

  const out = new Map<string, PhoneticsResult>()
  for (const w of clean) out.set(w, _cache.get(w) ?? null)
  return out
}

/**
 * Fire-and-forget look-ahead: populate the cache for words not on screen/
 * spoken yet, so by the time they are the words are already known. Callers
 * don't await this — it only ever writes to the cache, never to the DOM, so
 * there is nothing to race against a cue/sentence change. Dispatched at
 * `'low'` priority — the background always drains a `phoneticsForWords` (the
 * word on screen *right now*) request ahead of these, so a big look-ahead
 * batch can never delay the sentence actually being read.
 */
export function prefetchPhonetics(words: string[]): void {
  const clean = [...new Set(words.map(normalise).filter(Boolean))]
  for (const w of clean) if (!_cache.has(w)) void fetchOne(w, 'low')
}

export function clearPhoneticsCache(): void {
  _cache.clear()
  _pending.clear()
}
