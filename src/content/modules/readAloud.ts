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
// Which real (Intl.Segmenter) sentence each `sentences[i]` clause belongs to
// — parallel array to `sentences`, only meaningful when the plan was built
// with splitAtShadowStops (shadowing on). Threaded through to the background
// so "repeat whole sentence" mode can find every clause belonging to the
// sentence currently being repeated.
let sentenceGroupIds: number[] = []
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
// Only meaningful when shadowingOn is true — see the field doc on
// ReadAloudSettings.repeatWholeSentence. Mirrors shadowingOn's lifecycle.
let repeatWholeSentenceOn = false
// Multiplier on the estimated shadowing gap length — see the field doc on
// ReadAloudSettings.shadowingRatio. Only meaningful when shadowingOn is true;
// mirrors shadowingOn's lifecycle. Default 1 = old behaviour.
let shadowingRatioOn = 1
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

export function getShadowInfo(): { shadowing: boolean; repetition: number; inGap: boolean; repeatWholeSentence: boolean; shadowingRatio: number } {
  return { shadowing: shadowingOn, repetition: currentRepetition, inGap: inShadowGap, repeatWholeSentence: repeatWholeSentenceOn, shadowingRatio: shadowingRatioOn }
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
  sentenceGroupIds = []
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

// Wraps a single not-yet-wrapped sentence and fills in its IPA, at the given
// priority — shared by both the zone actually being spoken (`'high'`, must
// win any contention for the background's dictionary fetch queue) and the
// look-ahead window (`'low'`, fine to sit behind it). Leaves
// `sentenceRanges[i]` rebuilt from the wrapper elements' own boundaries,
// since wrapping splits/moves the range's underlying text nodes.
function wrapPhoneticsForSentence(i: number, priority: 'high' | 'low'): Promise<void> {
  if (phoneticsWrappedIndices.has(i)) return Promise.resolve()
  phoneticsWrappedIndices.add(i)
  const zoneRange = sentenceRanges[i]
  if (!zoneRange) return Promise.resolve()

  prepareWordIndex(zoneRange, sentences[i] ?? '')
  const { wrappers, ready } = wrapAndShowPhoneticsForWords(resolveSentenceWordRanges(sentences[i] ?? ''), priority)
  if (wrappers.length > 0) {
    const rebuilt = document.createRange()
    rebuilt.setStartBefore(wrappers[0])
    rebuilt.setEndAfter(wrappers[wrappers.length - 1])
    sentenceRanges[i] = rebuilt
  }
  return ready
}

// Wraps every not-yet-wrapped sentence in `index`'s zone, at high priority.
// Leaves `sentenceRanges`/the karaoke word index correct for whichever
// sentence is actually being spoken (`index`) even when the zone spans
// several — `wrapPhoneticsForSentence` repoints the global word index at
// whichever sentence it just processed, so the last thing this does is
// point it back at `index` for a real chrome.tts 'word' event to resolve
// against.
function wrapPhoneticsForZone(index: number): void {
  for (const i of zoneIndicesFor(index)) wrapPhoneticsForSentence(i, 'high')
  prepareWordIndex(sentenceRanges[index] ?? new Range(), sentences[index] ?? '')
}

// Wrapping (and therefore showing) a sentence's IPA only once it's actually
// on screen is exactly the latency the user notices as "IPA takes a while to
// show up" — and only doing the network lookup ahead of time without also
// showing it just moves that wait to "it's fetched, but still invisible
// until I get there". So this wraps the next few sentences too, same as the
// zone above just at low priority (never contends with the sentence actually
// being read for the background's fetch queue) — `wrapPhoneticsForSentence`'s
// own already-wrapped check means this costs nothing for whatever the zone
// above just wrapped.
// One look-ahead sentence's *network fetch* fully finishes (and reveals)
// before the next one's even starts — sequential, not 4 sentences' worth of
// words all racing each other through the low-priority queue at once, so
// each sentence settles as one clean unit in the order the reader will
// actually reach them, soonest first.
//
// The *wrap* (span creation) is synchronous DOM work, over instantly either
// way — what actually takes time is `ready` (the network side), so that's
// the only thing this awaits between sentences. Re-pointing the global word
// index back at `index` right after each sentence's wrap (not just once at
// the very end) matters here specifically because this now spans real async
// gaps — without it, a genuine chrome.tts 'word' event for the sentence
// actually being read could arrive *while* this is still awaiting a
// look-ahead sentence's fetch, and resolve against the wrong sentence's word
// index for however long that await lasts.
async function wrapPhoneticsAhead(index: number, count = 4): Promise<void> {
  if (!phoneticsOn || !currentLang.toLowerCase().startsWith('en')) return
  for (let i = index; i < Math.min(index + count, sentences.length); i++) {
    const ready = wrapPhoneticsForSentence(i, 'low')
    prepareWordIndex(sentenceRanges[index] ?? new Range(), sentences[index] ?? '')
    await ready
  }
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
  void wrapPhoneticsAhead(index)
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
  repeatWholeSentenceOn = settings.repeatWholeSentence === true
  shadowingRatioOn = settings.shadowingRatio ?? 1
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
    payload: { sentences, startIndex, settings: sessionSettings, lang, sentenceGroupIds },
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
  sentenceGroupIds = plan.map(p => p.sentenceGroupId)
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
// `onFailure` lets a specific action recover instead of just dropping to
// idle — see resume()'s use of it below for why that matters.
function sendControl(action: string, extra?: Record<string, unknown>, onFailure?: () => void) {
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action, ...extra } })
    .then((res: { ok?: boolean } | undefined) => {
      if (res?.ok === false && state !== 'idle') {
        if (onFailure) onFailure()
        else {
          clearLocalSession()
          notifyState('idle')
        }
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
  // The background holds the active session purely in memory (`activeSession`
  // in background/index.ts) — no persistence, nothing survives its service
  // worker being recycled. A tab left paused and backgrounded long enough
  // (switching to another app for a while) is exactly what triggers MV3's
  // idle teardown, so by the time the user comes back and hits Resume, the
  // background may have nothing left to resume. This content script's own
  // module state (`sentences`, `sessionSettings`, `currentIndex`...) isn't
  // affected by the tab losing focus, though — only by the *page* unloading —
  // so on that specific failure, rebuild the session from here instead of
  // just dropping to idle (which was also tearing down the floating widget
  // with no explanation, since idle unconditionally hides it).
  sendControl('resume', undefined, () => {
    if (sessionSettings) void beginSession(sessionSettings, currentIndex, currentLang, translationMode)
    else {
      clearLocalSession()
      notifyState('idle')
    }
  })
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
    // setRepeatWholeSentence()'s own persistence to storage (via a separate
    // CONTROL_READ_ALOUD message, fire-and-forget from the caller) can still be
    // in flight when this runs right after it (see selectShadowMode in
    // floatingWidget.ts) — the GET_SETTINGS fetch above may race ahead of that
    // write and return a stale `readAloud.repeatWholeSentence`. Override from
    // the current runtime value here (same pattern as `shadowing: on` above) so
    // the rebuilt session never regresses to a stale persisted value.
    repeatWholeSentence: repeatWholeSentenceOn,
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

  unwrapAllPhoneticsWords()
  phoneticsWrappedIndices.clear()
  const lang = loadArticlePlan(on)
  if (sentences.length === 0) {
    clearLocalSession()
    notifyState('idle')
    return
  }

  const startIndex = findSentenceIndex(sentences, sentenceRanges, previousText, previousRange)
  await beginSession(settings, startIndex, lang, translationMode)
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

// Toggle "repeat whole sentence" mode live — only meaningful while shadowing
// is also on. Unlike setShadowing(), this never rebuilds the session: the
// plan's clause structure (sentenceGroupIds) already covers both modes, so
// only the background's interpretation of currentRep/where it repeats needs
// to change.
export function setRepeatWholeSentence(on: boolean) {
  repeatWholeSentenceOn = on
  if (sessionSettings) sessionSettings = { ...sessionSettings, repeatWholeSentence: on }
  onShadowInfoChange?.()
  if (state === 'idle') return
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'setRepeatWholeSentence', on } }).catch(() => {})
}

// Set the shadowing gap ratio live — only meaningful while shadowing is also
// on. Mirrors setRepetition()/setRepeatWholeSentence(): takes effect from the
// next gap (no re-arm of a gap timer already in flight).
export function setShadowingRatio(ratio: number) {
  const clamped = Math.max(0.5, Math.min(3, ratio))
  shadowingRatioOn = clamped
  if (sessionSettings) sessionSettings = { ...sessionSettings, shadowingRatio: clamped }
  onShadowInfoChange?.()
  if (state === 'idle') return
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'setShadowingRatio', ratio: clamped } }).catch(() => {})
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
  repeatWholeSentence?: boolean,
  shadowingRatio?: number,
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
  if (typeof repeatWholeSentence === 'boolean' && repeatWholeSentence !== repeatWholeSentenceOn) {
    repeatWholeSentenceOn = repeatWholeSentence
    shadowInfoChanged = true
  }
  if (typeof shadowingRatio === 'number' && Number.isFinite(shadowingRatio) && shadowingRatio !== shadowingRatioOn) {
    shadowingRatioOn = shadowingRatio
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
