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
let currentIndex = 0
let currentSpeed = 1
// Which sentence the anchor word index was last built for (-1 = none).
let wordIndexSentence = -1
// The voice + language the background is actually using for this session,
// reported back via READ_ALOUD_UPDATE. Shown in the mini-player voice chip.
let currentVoice = ''
let currentLang = ''
let onStateChange: ((s: ReadAloudState) => void) | null = null
let onVoiceInfoChange: (() => void) | null = null
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
  currentIndex = 0
  wordIndexSentence = -1
}

function applySentenceIndex(index: number) {
  if (index < 0 || index >= sentenceRanges.length) return
  const changed = index !== currentIndex
  currentIndex = index
  const range = sentenceRanges[index] ?? new Range()
  highlightSentenceRange(range)
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
  const readableText = extractReadableArticle()?.textContent ?? ''
  const plan = buildSentencePlan(getContentElements(readableText), lang)
  sentences = plan.map(p => p.text)
  sentenceRanges = plan.map(p => p.range)
  return lang
}

export async function start(settings: ReadAloudSettings) {
  if (state !== 'idle') return

  const lang = loadArticlePlan()
  if (sentences.length === 0) return

  currentIndex = 0
  await beginSession(settings, 0, lang)
}

/**
 * Resume reading at a saved sentence index (F24). Mirrors start() but begins at
 * `index`, clamped to the freshly-built plan (which may differ slightly if the
 * page changed). Falls back to the top when the index is out of range.
 */
export async function startFromIndex(settings: ReadAloudSettings, index: number) {
  if (state !== 'idle') return

  const lang = loadArticlePlan()
  if (sentences.length === 0) return

  const clamped = Math.max(0, Math.min(Math.round(index), sentences.length - 1))
  currentIndex = clamped
  await beginSession(settings, clamped, lang)
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

// Find the first planned sentence whose range starts inside `el`. Used by the
// paragraph "▶ Read from here" affordance so we start exactly at the paragraph
// the user pointed at, regardless of where its text falls in the plan.
function findElementSentenceIndex(el: HTMLElement): number {
  for (let i = 0; i < sentenceRanges.length; i++) {
    const r = sentenceRanges[i]
    const container = r?.startContainer
    if (!container || container.nodeType === Node.DOCUMENT_NODE) continue
    const node = container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element)
    if (node && el.contains(node)) return i
  }
  return -1
}

/**
 * Start reading from a specific content element (paragraph/heading). Builds the
 * article plan, locates the sentence that begins inside `el`, and starts there.
 * Falls back to the article top when the element can't be matched to a sentence.
 */
export async function startFromElement(
  settings: ReadAloudSettings,
  el: HTMLElement,
) {
  if (state !== 'idle') return

  const lang = loadArticlePlan()
  if (sentences.length === 0) return

  const matched = findElementSentenceIndex(el)
  currentIndex = matched >= 0 ? matched : 0
  await beginSession(settings, currentIndex, lang)
}

export function pause() {
  if (state !== 'playing') return
  // Persist where we paused so the user can resume later (F24).
  void savePosition(currentIndex, sentences.length)
  notifyState('paused')
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'pause' } }).catch(() => {})
}

export function resume() {
  if (state !== 'paused') return
  notifyState('playing')
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'resume' } }).catch(() => {})
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
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'next' } }).catch(() => {})
}

export function prev() {
  if (state === 'idle') return
  notifyState('playing')
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'prev' } }).catch(() => {})
}

export function replay() {
  if (state === 'idle') return
  seekTo(currentIndex)
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
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'seek', index: clamped } }).catch(() => {})
}

export function setSpeed(rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) return
  currentSpeed = rate
  if (state === 'idle') return
  notifyState('playing')
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'setSpeed', speed: rate } }).catch(() => {})
}

// Switch the active voice live for the current language (D15). Mirrors setSpeed:
// the background updates + persists the choice and re-speaks the current
// sentence, then reports the resolved voice back via READ_ALOUD_UPDATE.
export function setVoice(name: string) {
  if (!name || state === 'idle') return
  currentVoice = name
  onVoiceInfoChange?.()
  notifyState('playing')
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'setVoice', voiceName: name } }).catch(() => {})
}

export function getSpeed(): number {
  return currentSpeed
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
}

export function getState(): ReadAloudState {
  return state
}
