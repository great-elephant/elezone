// Supplies the translation line for a subtitle cue.
//
// When Netflix ships a subtitle track in the learner's target language we use
// it verbatim: it's a human translation, correctly localised, and free. Machine
// translation is the fallback for titles that have no such track.
//
// The two tracks are segmented independently — one line of English can span two
// Vietnamese lines and vice versa — so cues are matched by time overlap rather
// than by index.

import type { SubtitleCue } from './subtitleInterceptor'
import { translate, clearTranslationCache as clearSharedTranslationCache } from '../translation'

let _native: SubtitleCue[] = []
// 'machine' makes the learner's choice explicit: Netflix's own translation
// reads better, but a literal rendering is sometimes what you want to study.
let _source: 'auto' | 'machine' = 'auto'

export function setNativeTranslationCues(cues: SubtitleCue[]): void {
  // Overlap matching relies on the list being ordered by start time.
  _native = [...cues].sort((a, b) => a.startTime - b.startTime)
  console.info(`[EleZone] using ${_native.length} native subtitle cues for the translation line`)
}

export function hasNativeTranslations(): boolean {
  return _source === 'auto' && _native.length > 0
}

export function setTranslationSource(source: 'auto' | 'machine'): void {
  _source = source
}

export function clearNativeTranslationCues(): void {
  _native = []
}

/** Every native cue overlapping `cue`, joined. Null when the track has none. */
export function nativeTranslationFor(cue: SubtitleCue): string | null {
  if (_source === 'machine' || _native.length === 0) return null

  // First native cue that could still overlap (endTime >= cue.startTime).
  let lo = 0
  let hi = _native.length - 1
  let start = _native.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (_native[mid].endTime >= cue.startTime) {
      start = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }

  const parts: string[] = []
  for (let i = start; i < _native.length && _native[i].startTime < cue.endTime; i++) {
    const overlap =
      Math.min(cue.endTime, _native[i].endTime) - Math.max(cue.startTime, _native[i].startTime)
    // Ignore cues that merely touch at the boundary.
    if (overlap > 0.15) parts.push(_native[i].text)
  }

  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * Native subtitle if available, otherwise a machine translation. Machine
 * translations are cached/deduped by the shared cache in `translation.ts` —
 * `subtitleCard.ts` and `dialogueSidebar.ts` racing to translate the same cue
 * end up sharing a single in-flight request instead of each firing their own.
 */
export async function translationFor(cue: SubtitleCue, targetLang: string): Promise<string> {
  const native = nativeTranslationFor(cue)
  if (native) return native

  try {
    const { text } = await translate(cue.text, targetLang)
    return text
  } catch {
    return ''
  }
}

/** Clears the shared machine-translation cache — see `translation.ts`. */
export function clearTranslationCache(): void {
  clearSharedTranslationCache()
}
