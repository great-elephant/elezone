import { ReadAloudSettings, ReadAloudState, Settings } from '../../shared/types'
import {
  buildSentencePlan,
  highlightSentenceRange,
  clearSentenceHighlight,
  prepareWordIndex,
  highlightSpokenWord,
  clearWordHighlight,
  resolveSentenceWordRanges,
} from './anchor'
import { extractReadableArticle, getContentElements } from './contentDiscovery'
import { prefetchAhead } from './translation'
import { savePosition, clearPosition, setSessionUrl, clearSessionUrl } from './readAloudPosition'
import { wrapAndShowPhoneticsForWords, unwrapAllPhoneticsWords } from './readAloudPhonetics'

let state: ReadAloudState = 'idle'
let sentences: string[] = []
let sentenceRanges: Range[] = []
let sentencePlanUsesShadowStops = false
let sessionSettings: ReadAloudSettings | null = null
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
// IPA under every word of the sentence being spoken. Unlike shadowing this
// never needs a session rebuild — it's purely local DOM rendering, so
// toggling it just flips the flag and the next applySentenceIndex() call
// (or an immediate one if toggled mid-sentence, see setPhonetics) picks it up.
let phoneticsOn = false
// 'paragraph' wraps a whole content block's worth of sentences the first
// time any of them is reached; 'sentence' wraps one sentence at a time —
// matches translation.ts's own paragraph/sentence overlay granularity (H33),
// so "the zone with phonetics" lines up with whatever's already the reading
// focus/translation unit rather than introducing a third, unrelated notion
// of "zone". Threaded in from settings.translation.mode at session start.
let translationMode: 'paragraph' | 'sentence' = 'paragraph'
// Sentence indices already wrapped with phonetics this session — a zone
// (see translationMode above) is wrapped once; leaving it, in either
// direction, doesn't undo it (H33).
const phoneticsWrappedIndices = new Set<number>()
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
// Fired when the phonetics on/off flag changes so the mini-player toggle refreshes.
let onPhoneticsInfoChange: (() => void) | null = null
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

// The mini-player registers here so its phonetics toggle can refresh.
export function setOnPhoneticsInfoChange(cb: () => void) {
  onPhoneticsInfoChange = cb
}

export function getPhoneticsOn(): boolean {
  return phoneticsOn
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
  unwrapAllPhoneticsWords()
  phoneticsWrappedIndices.clear()
  sentences = []
  sentenceRanges = []
  sentenceElements = []
  sentencePlanUsesShadowStops = false
  sessionSettings = null
  currentIndex = 0
  wordIndexSentence = -1
}

// Sentences sharing the same paragraph/content-block element as `index`, when
// reading in paragraph mode — otherwise just `[index]` alone. Read Aloud
// always speaks one sentence at a time regardless of this; it only controls
// how wide a stretch phonetics wraps in one go (H33).
function zoneIndicesFor(index: number): number[] {
  if (translationMode !== 'paragraph') return [index]
  const el = sentenceElements[index]
  if (!el) return [index]
  let start = index
  let end = index
  while (start > 0 && sentenceElements[start - 1] === el) start--
  while (end < sentenceElements.length - 1 && sentenceElements[end + 1] === el) end++
  return Array.from({ length: end - start + 1 }, (_, i) => start + i)
}

// Wraps every not-yet-wrapped sentence in `index`'s zone. Leaves
// `sentenceRanges`/the karaoke word index correct for whichever sentence is
// actually being spoken (`index`) even when the zone spans several.
function wrapPhoneticsForZone(index: number): void {
  for (const i of zoneIndicesFor(index)) {
    if (phoneticsWrappedIndices.has(i)) continue
    phoneticsWrappedIndices.add(i)
    const zoneRange = sentenceRanges[i]
    if (!zoneRange) continue

    prepareWordIndex(zoneRange, sentences[i] ?? '')
    const wrappers = wrapAndShowPhoneticsForWords(resolveSentenceWordRanges(sentences[i] ?? ''))
    if (wrappers.length > 0) {
      // Wrapping split/moved the range's underlying text nodes — rebuild it
      // from the wrapper elements' own boundaries (see applySentenceIndex's
      // matching comment for why the old boundary offsets can't be trusted).
      const rebuilt = document.createRange()
      rebuilt.setStartBefore(wrappers[0])
      rebuilt.setEndAfter(wrappers[wrappers.length - 1])
      sentenceRanges[i] = rebuilt
    }
  }
  // The loop above leaves the global word index pointed at whichever zone
  // sentence was processed last — reset it to the one actually being spoken
  // so a real chrome.tts 'word' event still resolves against the right one.
  prepareWordIndex(sentenceRanges[index] ?? new Range(), sentences[index] ?? '')
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

    if (phoneticsOn && currentLang.toLowerCase().startsWith('en')) {
      wrapPhoneticsForZone(index)
      // wrapPhoneticsForZone rebuilds sentenceRanges[index] in place (a new
      // Range object) only when this sentence was actually wrapped just now
      // — re-apply the highlight against it. On a sentence already wrapped
      // in an earlier visit, sentenceRanges[index] is unchanged from the
      // (already-correct) one the highlight call above already used.
      const rebuilt = sentenceRanges[index]
      if (rebuilt && rebuilt !== range) {
        highlightSentenceRange(rebuilt, sentenceElements[index] ?? null)
      }
    }
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
  translationModeIn: 'paragraph' | 'sentence',
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
  phoneticsOn = settings.showPhonetics === true
  translationMode = translationModeIn
  // Best guess until the background's own detectLanguage broadcast corrects
  // it — without this the very first sentence's applySentenceIndex() call
  // (below, before any broadcast has arrived) always sees currentLang as
  // whatever the *previous* session left it as (or '' on the very first
  // session ever), and the phonetics gate reads that same field.
  currentLang = lang
  inShadowGap = false
  sessionSettings = { ...settings, speed: currentSpeed, repetition: currentRepetition, shadowing: shadowingOn }

  const response = await chrome.runtime.sendMessage({
    type: 'START_READ_ALOUD_SESSION',
    payload: { sentences, startIndex, settings: sessionSettings, lang },
  }) as { ok?: boolean }

  if (!response?.ok) {
    clearLocalSession()
    notifyState('idle')
    return
  }

  // Order matters: the phonetics walker kicked off inside applySentenceIndex
  // checks `state === 'playing'` on its very first (synchronous) tick — call
  // notifyState first so that check doesn't see the still-'idle' state and
  // permanently bail before a single word is shown for this session.
  notifyState('playing')
  applySentenceIndex(startIndex)
}

// Build the sentence plan for the whole readable article and load it into the
// module-level session buffers. Returns the language used. Shared by every
// start path (top / from-selection / from-element).
function loadArticlePlan(splitAtShadowStops?: boolean): string {
  const lang = document.documentElement.lang || 'en'
  const plan = buildSentencePlan(getContentElements(), lang, splitAtShadowStops)
  sentences = plan.map(p => p.text)
  sentenceRanges = plan.map(p => p.range)
  sentenceElements = plan.map(p => p.el)
  sentencePlanUsesShadowStops = splitAtShadowStops === true
  return lang
}

export async function start(settings: ReadAloudSettings, translationMode: 'paragraph' | 'sentence' = 'paragraph') {
  if (state !== 'idle') return

  const lang = loadArticlePlan(settings.shadowing)
  if (sentences.length === 0) return

  currentIndex = 0
  await beginSession(settings, 0, lang, translationMode)
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
  translationMode: 'paragraph' | 'sentence' = 'paragraph',
) {
  const lang = loadArticlePlan(settings.shadowing)
  if (sentences.length === 0) return

  currentIndex = findSentenceIndex(sentences, sentenceRanges, selectedText, selRange)
  await beginSession(settings, currentIndex, lang, translationMode)
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
  // The phonetics badges are static per sentence now (not tied to playback
  // progress), so pausing leaves them exactly as they are — nothing to do.
  notifyState('paused')
  sendControl('pause')
}

export function resume() {
  if (state !== 'paused') return
  notifyState('playing')
  if (sentencePlanUsesShadowStops !== shadowingOn) {
    void rebuildSessionForShadowing(shadowingOn)
    return
  }
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
  // notifyState before applySentenceIndex: a seek while paused would otherwise
  // have the phonetics walker's first (synchronous) tick see the still-'paused'
  // state, bail, and permanently latch as "already walking" this sentence —
  // see the identical fix in beginSession() above.
  notifyState('playing')
  // Highlight immediately for responsiveness; background confirms via broadcast.
  applySentenceIndex(clamped)
  sendControl('seek', { index: clamped })
}

export function setSpeed(rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) return
  currentSpeed = rate
  if (sessionSettings) sessionSettings = { ...sessionSettings, speed: rate }
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
  if (sessionSettings) sessionSettings = { ...sessionSettings, voice: name }
  onVoiceInfoChange?.()
  notifyState('playing')
  sendControl('setVoice', { voiceName: name })
}

export function getSpeed(): number {
  return currentSpeed
}

async function saveShadowingPreference(on: boolean): Promise<ReadAloudSettings | null> {
  let stored: Settings | undefined
  try {
    stored = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }) as Settings | undefined
  } catch {
    stored = undefined
  }

  const base = stored?.readAloud ?? sessionSettings
  if (!base) return null

  const nextReadAloud: ReadAloudSettings = {
    ...base,
    speed: currentSpeed,
    repetition: currentRepetition,
    shadowing: on,
  }
  sessionSettings = nextReadAloud

  if (stored?.readAloud) {
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      payload: { ...stored, updatedAt: Date.now(), readAloud: nextReadAloud },
    }).catch(() => {})
  }

  return nextReadAloud
}

async function rebuildSessionForShadowing(on: boolean) {
  const previousState = state
  const previousText = sentences[currentIndex] ?? ''
  const previousRange = sentenceRanges[currentIndex]?.cloneRange() ?? null
  const settings = await saveShadowingPreference(on)

  if (!settings || previousState === 'idle' || state === 'idle' || shadowingOn !== on) return
  if (previousState === 'paused') return
  if (sentencePlanUsesShadowStops === on) return

  const lang = loadArticlePlan(on)
  if (sentences.length === 0) {
    clearLocalSession()
    notifyState('idle')
    return
  }

  const startIndex = findSentenceIndex(sentences, sentenceRanges, previousText, previousRange)
  await beginSession(settings, startIndex, lang)
}

// H29 — toggle shadowing (inter-sentence gap) live. Optimistically flips the
// local flag so the button responds instantly; the background persists the
// choice and re-broadcasts to confirm. Allowed even when idle so it can be set
// before the very first sentence (the background seeds from settings anyway).
export function setShadowing(on: boolean) {
  shadowingOn = on
  onShadowInfoChange?.()
  void rebuildSessionForShadowing(on)
}

// Toggle the phonetics wraps live and persist the choice. Unlike shadowing
// this never touches the background/chrome.tts session — it's pure content-
// script DOM rendering, so there's nothing to rebuild on that side.
export async function setPhonetics(on: boolean): Promise<void> {
  phoneticsOn = on
  onPhoneticsInfoChange?.()
  if (on) {
    // Show the current zone already on screen instead of waiting for the
    // next sentence — flipping the toggle mid-sentence should show
    // something right away.
    if (state !== 'idle' && currentLang.toLowerCase().startsWith('en')) {
      wrapPhoneticsForZone(currentIndex)
      const rebuilt = sentenceRanges[currentIndex]
      if (rebuilt) highlightSentenceRange(rebuilt, sentenceElements[currentIndex] ?? null)
    }
  } else {
    unwrapAllPhoneticsWords()
    phoneticsWrappedIndices.clear()
    const range = sentenceRanges[currentIndex]
    if (range) prepareWordIndex(range, sentences[currentIndex] ?? '')
  }
  if (sessionSettings) sessionSettings = { ...sessionSettings, showPhonetics: on }

  let stored: Settings | undefined
  try {
    stored = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }) as Settings | undefined
  } catch {
    stored = undefined
  }
  if (!stored?.readAloud) return
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    payload: { ...stored, updatedAt: Date.now(), readAloud: { ...stored.readAloud, showPhonetics: on } },
  }).catch(() => {})
}

// H31 — set per-sentence repetition live (1..5). Takes effect from the next
// sentence; the background persists it and re-broadcasts to confirm.
export function setRepetition(count: number) {
  const clamped = Math.max(1, Math.min(5, Math.round(count)))
  currentRepetition = clamped
  if (sessionSettings) sessionSettings = { ...sessionSettings, repetition: clamped }
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
  // auto-picked one) so the mini-player chip can show it. Set BEFORE
  // applySentenceIndex below — that's where the phonetics gate reads
  // `currentLang`, and it needs this call's fresh value, not last call's.
  let voiceInfoChanged = false
  if (typeof voice === 'string' && voice !== currentVoice) {
    currentVoice = voice
    voiceInfoChanged = true
  }
  if (typeof lang === 'string' && lang !== currentLang) {
    currentLang = lang
    voiceInfoChanged = true
  }

  if (typeof index === 'number') {
    // Set the raw flag before applySentenceIndex, not after — the phonetics
    // walker it can kick off checks `state === 'playing'` synchronously on
    // its first tick. The full notifyState(nextState) call further down
    // (unchanged) still fires the onStateChange callback at its original
    // point in this function; this just makes the plain state value correct
    // early enough for that synchronous check to see it.
    state = nextState
    applySentenceIndex(index)
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
