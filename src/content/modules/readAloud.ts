import { Readability } from '@mozilla/readability'
import { ReadAloudSettings } from '../../shared/types'
import { highlightSentence, clearSentenceHighlight } from './anchor'
import { prefetchAhead } from './translation'

type State = 'idle' | 'playing' | 'paused'

let state: State = 'idle'
let sentences: string[] = []
let currentIndex = 0
let currentRep = 0
let onStateChange: ((s: State) => void) | null = null

export function setOnStateChange(cb: (s: State) => void) {
  onStateChange = cb
}

function notifyState(s: State) {
  state = s
  onStateChange?.(s)
}

export function extractSentences(): string[] {
  const doc = document.cloneNode(true) as Document
  const article = new Readability(doc).parse()
  if (!article) return []

  const tmp = document.createElement('div')
  tmp.innerHTML = article.content
  const text = tmp.innerText.trim()
  if (!text) return []

  const lang = document.documentElement.lang || article.lang || 'en'

  try {
    const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' })
    return [...segmenter.segment(text)]
      .map(s => s.segment.trim())
      .filter(s => s.length > 0)
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
    return `Reading with ${voice.lang} voice — page appears to be ${pageLang.toUpperCase()}.`
  }
  return null
}

function speakSentence(index: number, s: ReadAloudSettings) {
  if (index >= sentences.length) {
    stop()
    return
  }

  prefetchAhead(index, sentences, 3)

  const text = sentences[index]
  const utter = new SpeechSynthesisUtterance(text)
  utter.rate = s.speed
  utter.pitch = s.pitch
  utter.volume = s.volume
  const voice = getVoice(s.voice)
  if (voice) utter.voice = voice

  utter.onstart = () => {
    // window.find()-based highlight: advances from current selection position,
    // so naturally follows the article order sentence by sentence.
    highlightSentence(text)
  }

  utter.onend = () => {
    if (state !== 'playing') return
    currentRep++
    if (currentRep < s.repetition) {
      speakSentence(index, s)
    } else {
      currentRep = 0
      currentIndex++
      speakSentence(currentIndex, s)
    }
  }

  utter.onerror = () => {
    currentIndex++
    speakSentence(currentIndex, s)
  }

  speechSynthesis.speak(utter)
}

export function start(s: ReadAloudSettings, warning?: (msg: string) => void) {
  if (state !== 'idle') return

  sentences = extractSentences()
  if (sentences.length === 0) return

  currentIndex = 0
  currentRep = 0

  // Clear selection so window.find() starts from the top of the document
  window.getSelection()?.removeAllRanges()

  const mismatch = checkLanguageMismatch(s.voice)
  if (mismatch && warning) warning(mismatch)

  notifyState('playing')
  speakSentence(currentIndex, s)
}

export function pause() {
  if (state !== 'playing') return
  speechSynthesis.pause()
  notifyState('paused')
}

export function resume() {
  if (state !== 'paused') return
  speechSynthesis.resume()
  notifyState('playing')
}

export function stop() {
  speechSynthesis.cancel()
  clearSentenceHighlight()
  sentences = []
  currentIndex = 0
  currentRep = 0
  notifyState('idle')
}

export function getState(): State {
  return state
}
