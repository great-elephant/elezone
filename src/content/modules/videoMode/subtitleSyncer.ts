// Syncs the current subtitle cue with the video's currentTime using
// requestAnimationFrame. Emits onCueChange callbacks whenever the active
// cue changes.

import type { SubtitleCue } from './subtitleInterceptor'
import type { SavedItem } from '../../../shared/types'
import { pauseVideo } from './videoControl'
import { isHoldingLine } from './linePacing'

export interface SubtitleSyncState {
  currentCueIndex: number
  currentCue: SubtitleCue | null
  prevCue: SubtitleCue | null
  nextCue: SubtitleCue | null
}

type CueChangeCallback = (state: SubtitleSyncState) => void
type SavedWordHitCallback = (word: string, cue: SubtitleCue) => void
type CueEndCallback = (cue: SubtitleCue) => void

let _rafId: number | null = null
let _cues: SubtitleCue[] = []
let _savedWords: string[] = []
let _lastCueIndex = -1
let _onCueChange: CueChangeCallback | null = null
let _onSavedWordHit: SavedWordHitCallback | null = null
let _onCueEnd: CueEndCallback | null = null
// Cue whose end we have already announced. Cleared as soon as playback is back
// inside the cue, so replaying a line fires its end again — that is what drives
// repeat and the shadowing gap.
let _endFiredIndex = -1
let _autoPause = false
let _hitWords = new Set<number>() // cue indices that already triggered auto-pause
let _suspended = false

function getVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video')
}

/**
 * Index of the last cue that has started by time `t`, or -1 before the first.
 *
 * Deliberately *not* "the cue whose span contains t": dialogue has gaps, and
 * returning -1 in them blanked the subtitle strip and dropped the sidebar
 * highlight the instant a line finished. Holding the last line until the next
 * one starts keeps it readable — you usually want to re-read or save a word
 * right after hearing it.
 */
function findCueAt(cues: SubtitleCue[], t: number): number {
  let lo = 0
  let hi = cues.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].startTime <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

// Check if the cue contains a saved word. Matching is per-token, not substring:
// a saved item like "a" or "in" would otherwise match nearly every line and
// auto-pause on every cue.
function checkSavedWords(cue: SubtitleCue): string | null {
  const tokens = new Set(
    (cue.text.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? [])
  )
  for (const w of _savedWords) {
    const lower = w.toLowerCase()
    // Multi-word saved phrases still fall back to a substring test.
    if (lower.includes(' ')) {
      if (cue.text.toLowerCase().includes(lower)) return w
    } else if (tokens.has(lower)) {
      return w
    }
  }
  return null
}

// Announce a line's end exactly once, however it was reached.
function announceCueEnd(index: number) {
  if (index < 0 || index >= _cues.length || _endFiredIndex === index) return
  _endFiredIndex = index
  _onCueEnd?.(_cues[index])
}

function loop() {
  const video = getVideo()
  // During an ad the same element keeps playing but `currentTime` belongs to the
  // advert, so every reading is meaningless: the strip would show minute-one
  // dialogue and the pacing engine would pause or seek inside the ad break.
  // Freeze on the line we were on and wait it out.
  if (!video || _suspended) {
    _rafId = requestAnimationFrame(loop)
    return
  }

  const t = video.currentTime
  const idx = findCueAt(_cues, t)

  if (idx !== _lastCueIndex) {
    // Most cues run back to back, so time never passes beyond a cue's end while
    // it is still the current one — the moment it ends, the next has already
    // started. Advancing by exactly one is therefore the usual way a line ends;
    // a bigger jump is a seek, not a finished line.
    const cueJustEnded = _lastCueIndex >= 0 && idx === _lastCueIndex + 1
    if (cueJustEnded) announceCueEnd(_lastCueIndex)

    // announceCueEnd may have just told pacing to freeze here (a shadowing gap,
    // a manual wait, the pause between repeats). When cues run back to back —
    // the norm for YouTube's caption tracks, which time each line to start
    // exactly where the last one ended, unlike Netflix's authored tracks which
    // leave silence between lines — `idx` has *already* moved on to the next
    // cue by the time we notice the current one ended. Advancing the strip here
    // would show that next line the same instant we tell the video to stop, so
    // the learner sees "the wrong sentence" frozen on screen. Hold the display
    // on the line that just ended until pacing lets go of it.
    if (cueJustEnded && isHoldingLine()) {
      _rafId = requestAnimationFrame(loop)
      return
    }

    _lastCueIndex = idx
    if (_onCueChange) {
      _onCueChange({
        currentCueIndex: idx,
        currentCue: idx >= 0 ? _cues[idx] : null,
        prevCue: idx > 0 ? _cues[idx - 1] : null,
        nextCue: idx >= 0 && idx < _cues.length - 1 ? _cues[idx + 1] : null,
      })
    }

    // Auto-pause on saved word
    if (_autoPause && idx >= 0 && !_hitWords.has(idx)) {
      const cue = _cues[idx]
      const hit = checkSavedWords(cue)
      if (hit) {
        _hitWords.add(idx)
        pauseVideo()
        _onSavedWordHit?.(hit, cue)
      }
    }
  }

  // The other way a line ends: a silent gap follows it, so the cue stays current
  // while playback runs past its end time.
  if (idx >= 0) {
    if (t < _cues[idx].endTime) {
      // Back inside the cue (a replay) — let it be announced again.
      if (_endFiredIndex === idx) _endFiredIndex = -1
    } else {
      announceCueEnd(idx)
    }
  }

  _rafId = requestAnimationFrame(loop)
}

export function startSubtitleSyncer(
  cues: SubtitleCue[],
  savedItems: SavedItem[],
  opts: {
    autoPause?: boolean
    onCueChange: CueChangeCallback
    onSavedWordHit?: SavedWordHitCallback
    onCueEnd?: CueEndCallback
  }
): void {
  _cues = cues
  _savedWords = savedItems.map(i => i.text).filter(Boolean)
  _autoPause = opts.autoPause ?? false
  _onCueChange = opts.onCueChange
  _onSavedWordHit = opts.onSavedWordHit ?? null
  _onCueEnd = opts.onCueEnd ?? null
  _lastCueIndex = -1
  _endFiredIndex = -1
  _hitWords = new Set()

  if (_rafId !== null) cancelAnimationFrame(_rafId)
  _rafId = requestAnimationFrame(loop)
}

export function stopSubtitleSyncer(): void {
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId)
    _rafId = null
  }
  _cues = []
  _savedWords = []
  _onCueChange = null
  _onSavedWordHit = null
  _onCueEnd = null
  _lastCueIndex = -1
  _endFiredIndex = -1
}

export function updateSyncerSavedItems(savedItems: SavedItem[]): void {
  _savedWords = savedItems.map(i => i.text).filter(Boolean)
  _hitWords = new Set() // reset so new saves can still trigger
}

export function setSyncerAutoPause(enabled: boolean): void {
  _autoPause = enabled
  if (!enabled) _hitWords = new Set()
}

export function updateSyncerCues(cues: SubtitleCue[]): void {
  _cues = cues
  _lastCueIndex = -1
  _endFiredIndex = -1
  _hitWords = new Set()
}

export function getCues(): SubtitleCue[] {
  return _cues
}

/**
 * Stop reading the video clock without tearing anything down — used while an ad
 * plays. On resume the cue tally is cleared, because the timeline the counters
 * referred to was never the content's.
 */
export function setSyncerSuspended(suspended: boolean): void {
  if (_suspended === suspended) return
  _suspended = suspended
  if (!suspended) {
    _lastCueIndex = -1
    _endFiredIndex = -1
  }
}
