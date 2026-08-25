// Controls what happens when a subtitle line finishes: replaying it, holding a
// silent gap so the learner can repeat it aloud, or waiting for a keypress.
//
// The repeat × shadowing semantics deliberately mirror Read Aloud
// (`src/background/index.ts`), so the two features behave the same way:
//
//                    endOfLinePause 'off'   'manual'          'shadowing'
//   repeat = 1       line → next            line → wait       line → gap → next
//   repeat = 3       line×3 → next          line×3 → wait     line → gap → line
//                                                             → gap → line
//                                                             → gap → next
//
// i.e. a shadowing gap goes between every repetition *and* before moving on;
// without shadowing the repetitions run back to back.

import type { SubtitleCue } from './subtitleInterceptor'
import type { EndOfLinePause } from '../../../shared/types'
import { seekToSeconds, pauseVideo, playVideo } from './videoControl'

export interface PacingCallbacks {
  /** A timed gap started; `ms` is how long the film stays frozen. */
  onGapStart: (cue: SubtitleCue, ms: number) => void
  onGapEnd: () => void
  /** Paused indefinitely, waiting for the learner to resume. */
  onWaitStart: (cue: SubtitleCue) => void
  onWaitEnd: () => void
}

interface PacingConfig {
  repeat: number
  endOfLinePause: EndOfLinePause
  shadowGapFactor: number
}

let _config: PacingConfig = { repeat: 1, endOfLinePause: 'off', shadowGapFactor: 1 }
let _callbacks: PacingCallbacks | null = null

// Repetitions already played for the current line, excluding the first pass.
let _repeatsDone = 0
// The cue the engine is currently working through. Cue-end events for anything
// else are stale — a seek can momentarily report a neighbouring cue.
let _activeCue: SubtitleCue | null = null
let _waitingCue: SubtitleCue | null = null
let _gapTimer: ReturnType<typeof setTimeout> | null = null
// Bumped on every cancel so a gap that is already in flight can tell it is
// stale — the learner may have seeked away while it was pending.
let _token = 0

const MIN_GAP_MS = 400
const MAX_GAP_MS = 15_000

export function configurePacing(config: PacingConfig, callbacks: PacingCallbacks): void {
  _config = config
  _callbacks = callbacks
}

export function updatePacingConfig(config: Partial<PacingConfig>): void {
  const wasHolding = _gapTimer !== null || _waitingCue !== null
  _config = { ..._config, ...config }

  // Turning the pause off has to undo one that is already in effect, gap timer
  // included — otherwise the film sits frozen until a countdown the learner
  // just switched off happens to elapse.
  if (_config.endOfLinePause === 'off' && wasHolding) {
    cancelPacing()
    playVideo()
  }
}

/** Whether playback is parked at the end of a line waiting for the learner. */
export function isWaitingForLearner(): boolean {
  return _waitingCue !== null
}

/**
 * Whether the engine just froze playback on the line that ended — a shadowing
 * gap, a manual wait, or the pause between repeats. The syncer uses this to
 * keep the strip on that line instead of racing ahead to the next one; see
 * `subtitleSyncer.ts`.
 */
export function isHoldingLine(): boolean {
  return _waitingCue !== null || _gapTimer !== null
}

/** Resume after a `manual` end-of-line pause. No-op when not waiting. */
export function resumeFromWait(): void {
  if (!_waitingCue) return
  _waitingCue = null
  _callbacks?.onWaitEnd()
  playVideo()
}

/** Drop any pending gap/wait — call on seek, disable, or episode change. */
export function cancelPacing(): void {
  _token++
  _repeatsDone = 0
  _activeCue = null
  if (_gapTimer !== null) {
    clearTimeout(_gapTimer)
    _gapTimer = null
    _callbacks?.onGapEnd()
  }
  if (_waitingCue) {
    _waitingCue = null
    _callbacks?.onWaitEnd()
  }
}

function gapMsFor(cue: SubtitleCue): number {
  // The cue's own duration is exactly how long the line took to say, which is a
  // better estimate of how long the learner needs than counting words.
  const spoken = (cue.endTime - cue.startTime) * 1000
  return Math.round(Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, spoken * _config.shadowGapFactor)))
}

function holdGap(cue: SubtitleCue, then: () => void): void {
  const token = ++_token
  pauseVideo()
  const ms = gapMsFor(cue)
  _callbacks?.onGapStart(cue, ms)

  _gapTimer = setTimeout(() => {
    _gapTimer = null
    if (token !== _token) return  // seeked away mid-gap
    _callbacks?.onGapEnd()
    then()
  }, ms)
}

function replayLine(cue: SubtitleCue): void {
  seekToSeconds(cue.startTime)
}

/** Called by the syncer the moment playback passes a line's end time. */
export function handleCueEnd(cue: SubtitleCue): void {
  if (_waitingCue || _gapTimer !== null) return

  // Mid-repeat, ignore any cue but the one being repeated.
  if (_repeatsDone > 0 && _activeCue && _activeCue.index !== cue.index) return
  if (_repeatsDone === 0) _activeCue = cue

  const shadowing = _config.endOfLinePause === 'shadowing'
  const repeat = Math.max(1, Math.round(_config.repeat))

  if (_repeatsDone < repeat - 1) {
    _repeatsDone++
    if (shadowing) holdGap(cue, () => replayLine(cue))
    else replayLine(cue)
    return
  }

  _repeatsDone = 0
  _activeCue = null

  switch (_config.endOfLinePause) {
    case 'shadowing':
      holdGap(cue, () => playVideo())
      break
    case 'manual':
      pauseVideo()
      _waitingCue = cue
      _callbacks?.onWaitStart(cue)
      break
    case 'off':
      break
  }
}

/**
 * The learner moved the playhead themselves (a click in the sidebar, prev/next,
 * a scrub). Any repeat tally belongs to the line they left behind.
 */
export function notifyManualSeek(): void {
  cancelPacing()
}
