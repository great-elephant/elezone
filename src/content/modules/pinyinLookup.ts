// Pinyin lookup + cache for Chinese content, used by Read Aloud (reading under
// each word) and Video Mode (reading under each subtitle word).
//
// The Chinese-side twin of wordPhonetics.ts, deliberately kept as a separate
// module with the same exported shape rather than a `lang` parameter threaded
// through that one: the two speak to different background messages backed by
// entirely different sources (dictionaryapi.dev's IPA vs Google's `dt=rm`
// romanization), and callers pick a module once rather than passing a language
// into every call.
//
// The cache is uncapped for the same reason as its English twin — a whole
// article or film's distinct vocabulary is small enough to hold for the life
// of the tab, and evicting would only mean fetching a word twice.

import type { PhoneticsResult } from './wordPhonetics'

export type { PhoneticsResult }

const _cache = new Map<string, PhoneticsResult>()
// De-dupes concurrent requests for the same word — a live lookup and a
// look-ahead prefetch can otherwise both go out for it at once.
const _pending = new Map<string, Promise<void>>()

// Chinese has no letter case, so unlike the English side there is nothing to
// fold — only the surrounding whitespace the segmenter may leave behind. The
// key must match what the background returns, which keys by the exact word.
function normalise(word: string): string {
  return word.trim()
}

async function fetchOne(word: string): Promise<void> {
  const pending = _pending.get(word)
  if (pending) return pending

  const request = (async () => {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'FETCH_PINYIN',
        payload: { words: [word] },
      }) as Record<string, { text: string | null; approximate: boolean }> | undefined
      // Absent from `result` means the lookup failed rather than the word
      // definitively having no reading — left uncached so it is tried again,
      // instead of being remembered forever as "no Pinyin".
      if (result && Object.prototype.hasOwnProperty.call(result, word)) {
        const entry = result[word]
        _cache.set(word, entry.text ? { text: entry.text, approximate: entry.approximate } : null)
      }
    } catch {
      // Message channel died (service worker recycled, extension reloaded) —
      // leave uncached; no other word's lookup is affected.
    } finally {
      _pending.delete(word)
    }
  })()

  _pending.set(word, request)
  return request
}

/**
 * Pinyin for a batch of words — the cue on screen or the sentence being read.
 * `onWord` fires as each word resolves rather than waiting for the slowest in
 * the batch; the returned Promise still settles only once all of them have.
 *
 * `priority` is accepted so this module is drop-in interchangeable with
 * wordPhonetics.ts at call sites, but it is not forwarded: there is no pacing
 * queue on this path to prioritise into (the Google endpoint measured clean
 * under bursts), so every request simply goes out at once.
 */
export async function phoneticsForWords(
  words: string[],
  _priority: 'high' | 'low' = 'high',
  onWord?: (word: string, result: PhoneticsResult) => void,
): Promise<Map<string, PhoneticsResult>> {
  const clean = [...new Set(words.map(normalise).filter(Boolean))]
  await Promise.all(clean.map(async w => {
    if (!_cache.has(w)) await fetchOne(w)
    onWord?.(w, _cache.get(w) ?? null)
  }))

  const out = new Map<string, PhoneticsResult>()
  for (const w of clean) out.set(w, _cache.get(w) ?? null)
  return out
}

/**
 * Fire-and-forget look-ahead for words not on screen yet. Only ever writes to
 * the cache, never the DOM, so there is nothing to race against a cue or
 * sentence change.
 */
export function prefetchPhonetics(words: string[]): void {
  const clean = [...new Set(words.map(normalise).filter(Boolean))]
  for (const w of clean) if (!_cache.has(w)) void fetchOne(w)
}

export function clearPhoneticsCache(): void {
  _cache.clear()
  _pending.clear()
}
