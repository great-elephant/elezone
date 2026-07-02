import { ReadAloudSettings, ReadAloudState } from '../../shared/types'
import { buildSentencePlan, highlightSentenceRange, clearSentenceHighlight } from './anchor'
import { extractReadableArticle, getContentElements } from './contentDiscovery'
import { prefetchAhead } from './translation'

let state: ReadAloudState = 'idle'
let sentences: string[] = []
let sentenceRanges: Range[] = []
let currentIndex = 0
let currentSpeed = 1
let onStateChange: ((s: ReadAloudState) => void) | null = null

export function setOnStateChange(cb: (s: ReadAloudState) => void) {
  onStateChange = cb
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

function getVoice(name: string): SpeechSynthesisVoice | null {
  if (!name) return null
  return speechSynthesis.getVoices().find(v => v.name === name) ?? null
}

function checkLanguageMismatch(settings: ReadAloudSettings, pageLang: string): string | null {
  if (!pageLang || pageLang === 'en') return null // Ignore warning for 'en' if no specific voice to avoid spamming
  const shortLang = pageLang.split('-')[0]
  
  const specificVoiceName = settings.languageVoices?.[pageLang] || settings.languageVoices?.[shortLang]
  
  if (specificVoiceName) {
    const voice = getVoice(specificVoiceName)
    if (voice && voice.lang.split('-')[0] !== shortLang) {
       return `Warning: Your configured voice for ${pageLang.toUpperCase()} is actually a ${voice.lang} voice.`
    }
    return null
  }

  // If no specific voice, check fallback voice
  if (settings.voice) {
    const fallbackVoice = getVoice(settings.voice)
    if (fallbackVoice) {
      const fallbackLang = fallbackVoice.lang.split('-')[0]
      if (fallbackLang !== shortLang) {
         return `Page is ${pageLang.toUpperCase()}, but your fallback voice is ${fallbackVoice.lang}. Consider adding a specific voice in Settings!`
      }
      return null // Fallback voice matches page language!
    }
  }

  return `No specific voice configured for ${pageLang.toUpperCase()}. The system will try to auto-detect, but you should add one in Settings for the best experience!`
}

function clearLocalSession() {
  clearSentenceHighlight()
  sentences = []
  sentenceRanges = []
  currentIndex = 0
}

function applySentenceIndex(index: number) {
  if (index < 0 || index >= sentenceRanges.length) return
  currentIndex = index
  highlightSentenceRange(sentenceRanges[index] ?? new Range())
  prefetchAhead(index, sentences, 3)
}

async function beginSession(
  settings: ReadAloudSettings,
  startIndex: number,
  lang: string,
  warning?: (msg: string) => void,
) {
  const mismatch = checkLanguageMismatch(settings, lang)
  if (mismatch && warning) warning(mismatch)

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

export async function start(settings: ReadAloudSettings, warning?: (msg: string) => void) {
  if (state !== 'idle') return

  const lang = document.documentElement.lang || 'en'
  const readableText = extractReadableArticle()?.textContent ?? ''
  const plan = buildSentencePlan(getContentElements(readableText), lang)
  sentences = plan.map(p => p.text)
  sentenceRanges = plan.map(p => p.range)
  if (sentences.length === 0) return

  currentIndex = 0
  await beginSession(settings, 0, lang, warning)
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
  warning?: (msg: string) => void,
) {
  const lang = document.documentElement.lang || 'en'
  const readableText = extractReadableArticle()?.textContent ?? ''
  const plan = buildSentencePlan(getContentElements(readableText), lang)
  sentences = plan.map(p => p.text)
  sentenceRanges = plan.map(p => p.range)
  if (sentences.length === 0) return

  currentIndex = findSentenceIndex(sentences, sentenceRanges, selectedText, selRange)
  await beginSession(settings, currentIndex, lang, warning)
}

export function pause() {
  if (state !== 'playing') return
  notifyState('paused')
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'pause' } }).catch(() => {})
}

export function resume() {
  if (state !== 'paused') return
  notifyState('playing')
  chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'resume' } }).catch(() => {})
}

export function stop() {
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

export function getSpeed(): number {
  return currentSpeed
}

export function getProgress(): { index: number; total: number } {
  return { index: currentIndex, total: sentences.length }
}

export function syncRemoteState(nextState: ReadAloudState, index?: number, speed?: number) {
  if (typeof index === 'number') {
    applySentenceIndex(index)
  }

  if (typeof speed === 'number' && Number.isFinite(speed)) {
    currentSpeed = speed
  }

  if (nextState === 'idle') {
    clearLocalSession()
  }

  notifyState(nextState)
}

export function getState(): ReadAloudState {
  return state
}
