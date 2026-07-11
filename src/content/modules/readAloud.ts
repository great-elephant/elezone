import { ReadAloudSettings, ReadAloudState } from '../../shared/types'
import {
  buildSentencePlan,
  highlightSentenceRange,
  clearSentenceHighlight,
  prepareWordIndex,
  highlightSpokenWord,
  clearWordHighlight,
} from './anchor'
import { extractReadableArticle, getContentElements } from './contentDiscovery'
import { prefetchAhead } from './translation'
import { savePosition, clearPosition, setSessionUrl, clearSessionUrl } from './readAloudPosition'

let state: ReadAloudState = 'idle'
let sentences: string[] = []
let sentenceRanges: Range[] = []
// The exact content block (paragraph/heading) each sentence came from — lets
// the focus-mode spotlight find the sentence's translation deterministically
// instead of guessing via DOM-climbing (a paragraph mode overlay sits after the
// whole paragraph, not after each individual sentence within it).
let sentenceElements: HTMLElement[] = []
let currentIndex = 0
let currentSpeed = 1
// H31 — how many times each sentence is spoken (mirrors settings.repetition).
// Kept in sync with the background so the mini-player Repeat control shows the
// live value.
let currentRepetition = 1
// H29 — whether shadowing mode (inter-sentence gap) is on for this session.
let shadowingOn = false
// True only while the background is sitting in the intentional inter-sentence
// gap, so the mini-player can show a subtle "shadowing…" hint.
let inShadowGap = false
// Which sentence the anchor word index was last built for (-1 = none).
let wordIndexSentence = -1
// The voice + language the background is actually using for this session,
// reported back via READ_ALOUD_UPDATE. Shown in the mini-player voice chip.
let currentVoice = ''
let currentLang = ''
let onStateChange: ((s: ReadAloudState) => void) | null = null
let onVoiceInfoChange: (() => void) | null = null
// Fires when the shadowing on/off flag, the repetition count, or the
// intentional-gap flag changes so the mini-player controls/indicator refresh.
let onShadowInfoChange: (() => void) | null = null
// True only for the single idle transition that represents a *natural* finish
// (reached the end, page repetitions exhausted — not a user stop). Read by the
// state-change handler to decide between the Finished card and a plain hide (F22).
let lastFinishedNaturally = false

export function setOnStateChange(cb: (s: ReadAloudState) => void) {
  onStateChange = cb
}

// The mini-player registers here so its voice chip can refresh when the
// background reports the resolved voice/language.
export function setOnVoiceInfoChange(cb: () => void) {
  onVoiceInfoChange = cb
}

export function getVoiceInfo(): { voice: string; lang: string } {
  return { voice: currentVoice, lang: currentLang }
}

// The mini-player registers here so its shadowing toggle, Repeat control, and
// "shadowing…" indicator can refresh when the background reports new values.
export function setOnShadowInfoChange(cb: () => void) {
  onShadowInfoChange = cb
}

export function getShadowInfo(): { shadowing: boolean; repetition: number; inGap: boolean } {
  return { shadowing: shadowingOn, repetition: currentRepetition, inGap: inShadowGap }
}

// Whether the most recent idle transition was a natural finish (F22). Only
// meaningful when read from within the `onStateChange('idle')` callback.
export function didFinishNaturally(): boolean {
  return lastFinishedNaturally
}

function notifyState(nextState: ReadAloudState) {
  state = nextState
  onStateChange?.(nextState)
}

export function extractSentences(): string[] {
  const article = extractReadableArticle()
  if (!article?.textContent) return []

  const text = [article.title, article.textContent].filter(Boolean).join('\n')
  const lang = document.documentElement.lang || 'en'

  try {
    const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' })
    return [...segmenter.segment(text)]
      .map(s => s.segment.trim())
      .filter(Boolean)
  } catch {
    return text.split(/(?<=[.!?。！？])\s*/).filter(Boolean)
  }
}

function clearLocalSession() {
  clearSentenceHighlight()
  clearWordHighlight()
  sentences = []
  sentenceRanges = []
  sentenceElements = []
  currentIndex = 0
  wordIndexSentence = -1
}

function applySentenceIndex(index: number) {
  if (index < 0 || index >= sentenceRanges.length) return
  const changed = index !== currentIndex
  currentIndex = index
  const range = sentenceRanges[index] ?? new Range()
  highlightSentenceRange(range, sentenceElements[index] ?? null)
  // Only reset karaoke state when the sentence actually changes. The background
  // re-broadcasts the same index on start/pause/resume, and rebuilding here on
  // every broadcast would wipe the in-progress word highlight mid-sentence.
  if (changed || wordIndexSentence !== index) {
    clearWordHighlight()
    prepareWordIndex(range, sentences[index] ?? '')
    wordIndexSentence = index
    // Periodically persist progress as we advance so an unexpected teardown
    // (tab close, crash, SPA nav) still leaves a resumable position (F24).
    if (changed) void savePosition(index, sentences.length)
  }
  prefetchAhead(index, sentences, 3)
}

// Called when the background reports a spoken-word position (karaoke). Guarded
// by `index` so a late word event from a sentence we've already left can't
// mis-highlight the current one. No-op unless we're actively playing.
export function handleWordEvent(index: number, charIndex: number, length?: number) {
  if (state !== 'playing') return
  if (index !== currentIndex) return
  highlightSpokenWord(charIndex, length)
}

async function beginSession(
  settings: ReadAloudSettings,
  startIndex: number,
  lang: string,
) {
  // Pin the position key to the URL we're starting on, so a later SPA nav (which
  // mutates location.href before our save runs) still saves to this article (F24/F25).
  setSessionUrl(location.href)
  // No scary language-mismatch banner here anymore: the background auto-picks a
  // matching voice (D14) and reports it back for the calm voice chip (D16).
  currentSpeed = settings.speed
  // Seed the shadowing/repetition controls from settings so the mini-player
  // renders the right initial values before the first background broadcast.
  currentRepetition = Math.max(1, Math.round(settings.repetition || 1))
  shadowingOn = settings.shadowing === true
  inShadowGap = false

  const response = await chrome.runtime.sendMessage({
    type: 'START_READ_ALOUD_SESSION',
    payload: { sentences, startIndex, settings: { ...settings, speed: currentSpeed }, lang },
  }) as { ok?: boolean }

  if (!response?.ok) {
    clearLocalSession()
    notifyState('idle')
    return
  }

  applySentenceIndex(startIndex)
  notifyState('playing')
}

// Build the sentence plan for the whole readable article and load it into the
// module-level session buffers. Returns the language used. Shared by every
// start path (top / from-selection / from-element).
function loadArticlePlan(): string {
  const lang = document.documentElement.lang || 'en'
  const plan = buildSentencePlan(getContentElements(), lang)
  sentences = plan.map(p => p.text)
  sentenceRanges = plan.map(p => p.range)
  sentenceElements = plan.map(p => p.el)
  return lang
}

export async function start(settings: ReadAloudSettings) {
  if (state !== 'idle') return

  const lang = loadArticlePlan()
  if (sentences.length === 0) return

  currentIndex = 0
  await beginSession(settings, 0, lang)
}

function normTextFallback(s: string): string {
  return s
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ')
}

function findSentenceIndex(items: string[], ranges: Range[], selectedText: string, selRange: Range | null): number {
  if (selRange) {
    try {
      const selStart = document.createRange()
      selStart.setStart(selRange.startContainer, selRange.startOffset)
      selStart.collapse(true)
      
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i]
        if (!r.startContainer || r.startContainer.nodeType === Node.DOCUMENT_NODE) continue
        
        const rEnd = document.createRange()
        rEnd.setStart(r.endContainer, r.endOffset)
        rEnd.collapse(true)
        
        if (rEnd.compareBoundaryPoints(Range.START_TO_START, selStart) > 0) {
          return i
        }
      }
    } catch (err) {
      console.warn('Range comparison failed in findSentenceIndex', err)
    }
  }

  const selText = normTextFallback(selectedText).replace(/\s+/g, ' ').trim().toLowerCase()
  if (!selText) return 0

  for (let i = 0; i < items.length; i++) {
    if (items[i].toLowerCase().includes(selText)) return i
  }

  const snippet = selText.slice(0, 15)
  for (let i = 0; i < items.length; i++) {
    if (items[i].toLowerCase().includes(snippet)) return i
  }

  for (let i = 0; i < items.length; i++) {
    const itemText = items[i].toLowerCase()
    for (let len = Math.min(itemText.length, selText.length); len > 5; len--) {
      if (selText.startsWith(itemText.slice(-len))) return i
    }
  }

  return 0
}

export async function startFrom(
  settings: ReadAloudSettings,
  selectedText: string,
  selRange: Range | null,
) {
  const lang = loadArticlePlan()
  if (sentences.length === 0) return

  currentIndex = findSentenceIndex(sentences, sentenceRanges, selectedText, selRange)
  await beginSession(settings, currentIndex, lang)
}

// Sends a CONTROL_READ_ALOUD action and, if the background reports no matching
// session (torn down by a race — e.g. a spurious TTS 'interrupted' event racing
// a manual pause/resume — or a tabId mismatch), resyncs local state back to
// idle. Without this, the optimistic notifyState() calls below leave `state`
// stuck on 'playing'/'paused' with no live session behind it, and start()'s
// `if (state !== 'idle') return` guard turns every later Play click into a
// silent no-op.
function sendControl(action: string, extra?: Record<string, unknown>) {
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action, ...extra } })
    .then((res: { ok?: boolean } | undefined) => {
      if (res?.ok === false && state !== 'idle') {
        clearLocalSession()
        notifyState('idle')
      }
    })
    .catch(() => {})
}

export function pause() {
  if (state !== 'playing') return
  // Persist where we paused so the user can resume later (F24).
  void savePosition(currentIndex, sentences.length)
  notifyState('paused')
  sendControl('pause')
}

export function resume() {
  if (state !== 'paused') return
  notifyState('playing')
  sendControl('resume')
}

export function stop() {
  // An explicit user stop is never a "natural finish".
  lastFinishedNaturally = false
  // Save the position on an explicit user stop/teardown so Resume works (F24).
  // Capture before clearLocalSession() resets currentIndex; clear the session
  // URL only after the save promise has captured its key.
  void savePosition(currentIndex, sentences.length).finally(() => clearSessionUrl())
  clearLocalSession()
  notifyState('idle')
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'stop' } }).catch(() => {})
}

export function next() {
  if (state === 'idle') return
  notifyState('playing')
  sendControl('next')
}

export function prev() {
  if (state === 'idle') return
  notifyState('playing')
  sendControl('prev')
}

export function seekTo(index: number) {
  if (state === 'idle') return
  const total = sentences.length
  if (total === 0) return
  const clamped = Math.max(0, Math.min(Math.round(index), total - 1))
  // A seek restarts the utterance from the sentence start, so any prior word
  // highlight (incl. a replay of the same sentence) is stale — drop it now.
  clearWordHighlight()
  // Highlight immediately for responsiveness; background confirms via broadcast.
  applySentenceIndex(clamped)
  notifyState('playing')
  sendControl('seek', { index: clamped })
}

export function setSpeed(rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) return
  currentSpeed = rate
  if (state === 'idle') return
  notifyState('playing')
  sendControl('setSpeed', { speed: rate })
}

// Switch the active voice live for the current language (D15). Mirrors setSpeed:
// the background updates + persists the choice and re-speaks the current
// sentence, then reports the resolved voice back via READ_ALOUD_UPDATE.
export function setVoice(name: string) {
  if (!name || state === 'idle') return
  currentVoice = name
  onVoiceInfoChange?.()
  notifyState('playing')
  sendControl('setVoice', { voiceName: name })
}

export function getSpeed(): number {
  return currentSpeed
}

// H29 — toggle shadowing (inter-sentence gap) live. Optimistically flips the
// local flag so the button responds instantly; the background persists the
// choice and re-broadcasts to confirm. Allowed even when idle so it can be set
// before the very first sentence (the background seeds from settings anyway).
export function setShadowing(on: boolean) {
  shadowingOn = on
  onShadowInfoChange?.()
  if (state === 'idle') return
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'setShadowing', enabled: on } }).catch(() => {})
}

// H31 — set per-sentence repetition live (1..5). Takes effect from the next
// sentence; the background persists it and re-broadcasts to confirm.
export function setRepetition(count: number) {
  const clamped = Math.max(1, Math.min(5, Math.round(count)))
  currentRepetition = clamped
  onShadowInfoChange?.()
  if (state === 'idle') return
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'setRepetition', count: clamped } }).catch(() => {})
}

export function getProgress(): { index: number; total: number } {
  return { index: currentIndex, total: sentences.length }
}

export function syncRemoteState(
  nextState: ReadAloudState,
  index?: number,
  speed?: number,
  voice?: string,
  lang?: string,
  finished?: boolean,
  gap?: boolean,
  shadowing?: boolean,
  repetition?: number,
) {
  // Only meaningful on an idle transition; reset otherwise so a later plain stop
  // can't inherit a stale "finished" flag.
  lastFinishedNaturally = nextState === 'idle' ? finished === true : false

  if (typeof index === 'number') {
    applySentenceIndex(index)
  }

  if (typeof speed === 'number' && Number.isFinite(speed)) {
    currentSpeed = speed
  }

  // H29/H31: keep the mini-player's shadowing toggle, Repeat control, and the
  // "shadowing…" gap indicator in sync with the background's authoritative state.
  let shadowInfoChanged = false
  const nextGap = nextState === 'idle' ? false : gap === true
  if (nextGap !== inShadowGap) { inShadowGap = nextGap; shadowInfoChanged = true }
  if (typeof shadowing === 'boolean' && shadowing !== shadowingOn) {
    shadowingOn = shadowing
    shadowInfoChanged = true
  }
  if (typeof repetition === 'number' && Number.isFinite(repetition) && repetition !== currentRepetition) {
    currentRepetition = Math.max(1, Math.round(repetition))
    shadowInfoChanged = true
  }

  // The background reports the voice/language it actually resolved (incl. an
  // auto-picked one) so the mini-player chip can show it.
  let voiceInfoChanged = false
  if (typeof voice === 'string' && voice !== currentVoice) {
    currentVoice = voice
    voiceInfoChanged = true
  }
  if (typeof lang === 'string' && lang !== currentLang) {
    currentLang = lang
    voiceInfoChanged = true
  }

  if (nextState === 'idle') {
    if (lastFinishedNaturally) {
      // Completed article — drop any saved position so it doesn't offer a stale
      // resume next visit (F24). clearPosition() reads the session URL, so clear
      // it only after the promise has captured the key.
      void clearPosition().finally(() => clearSessionUrl())
    } else if (sentences.length > 0) {
      // Background-initiated stop (e.g. another tab took over, the keyboard
      // toggle, or an SPA nav) — persist where we were so Resume still works.
      void savePosition(currentIndex, sentences.length).finally(() => clearSessionUrl())
    } else {
      clearSessionUrl()
    }
    clearLocalSession()
  }

  notifyState(nextState)
  if (voiceInfoChanged) onVoiceInfoChange?.()
  if (shadowInfoChanged) onShadowInfoChange?.()
}

export function getState(): ReadAloudState {
  return state
}
