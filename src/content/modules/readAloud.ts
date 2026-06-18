import { ReadAloudSettings, ReadAloudState } from '../../shared/types'
import { buildSentencePlan, highlightSentenceRange, clearSentenceHighlight } from './anchor'
import { extractReadableArticle, getContentElements } from './contentDiscovery'
import { prefetchAhead } from './translation'

let state: ReadAloudState = 'idle'
let sentences: string[] = []
let sentenceRanges: Range[] = []
let currentIndex = 0
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
    return text.split(/(?<=[.!?])\s+/).filter(Boolean)
  }
}

function getVoice(name: string): SpeechSynthesisVoice | null {
  if (!name) return null
  return speechSynthesis.getVoices().find(v => v.name === name) ?? null
}

function checkLanguageMismatch(voiceName: string): string | null {
  const pageLang = document.documentElement.lang?.split('-')[0]
  const voice = getVoice(voiceName)
  if (!pageLang || !voice) return null
  const voiceLang = voice.lang.split('-')[0]
  if (voiceLang !== pageLang) {
    return `Reading with ${voice.lang} voice; page appears to be ${pageLang.toUpperCase()}.`
  }
  return null
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
  warning?: (msg: string) => void,
) {
  const mismatch = checkLanguageMismatch(settings.voice)
  if (mismatch && warning) warning(mismatch)

  const response = await chrome.runtime.sendMessage({
    type: 'START_READ_ALOUD_SESSION',
    payload: { sentences, startIndex, settings },
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
  await beginSession(settings, 0, warning)
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
  await beginSession(settings, currentIndex, warning)
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

export function syncRemoteState(nextState: ReadAloudState, index?: number) {
  if (typeof index === 'number') {
    applySentenceIndex(index)
  }

  if (nextState === 'idle') {
    clearLocalSession()
  }

  notifyState(nextState)
}

export function getState(): ReadAloudState {
  return state
}
