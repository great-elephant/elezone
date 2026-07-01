import { buildSentencePlan } from './anchor'
import {
  extractReadableArticle,
  getArticleLeadElements,
  getContentParagraphs,
  getElementContentText,
  getPrimaryTitleElement,
  getTitleContextElements,
} from './contentDiscovery'

let enabled = false
let targetLang = 'en'
let onDeviceTranslator: TranslatorInstance | null = null
let observer: IntersectionObserver | null = null
let articleText = '' // normalized Readability text content for filtering

// ── On-device API (Chrome 138+ global `Translator`, not the removed window.ai) ──

export async function isTranslatorAvailable(): Promise<boolean> {
  const api = globalThis.Translator
  if (!api) return false
  try {
    const src = document.documentElement.lang?.split('-')[0] || 'en'
    const status = await api.availability({ sourceLanguage: src, targetLanguage: targetLang })
    return status !== 'unavailable'
  } catch {
    return false
  }
}

// Coarse status for surfacing which engine will handle translation in the UI.
// 'available'    → on-device model ready (🔒)
// 'downloading'  → on-device model downloadable/downloading (⏳)
// 'unavailable'  → no on-device support, will fall back to Google (🌐)
export type TranslatorStatus = 'available' | 'downloading' | 'unavailable'

export async function getTranslatorStatus(): Promise<TranslatorStatus> {
  const api = globalThis.Translator
  if (!api) return 'unavailable'
  try {
    const src = document.documentElement.lang?.split('-')[0] || 'en'
    const status = await api.availability({ sourceLanguage: src, targetLanguage: targetLang })
    if (status === 'available') return 'available'
    if (status === 'downloadable' || status === 'downloading') return 'downloading'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

async function initOnDevice(src: string, tgt: string): Promise<TranslatorInstance | null> {
  const api = globalThis.Translator
  if (!api) return null
  try {
    if ((await api.availability({ sourceLanguage: src, targetLanguage: tgt })) !== 'available') {
      return null
    }
    return await api.create({ sourceLanguage: src, targetLanguage: tgt })
  } catch {
    return null
  }
}

// ── Google Translate fallback ─────────────────────────────────────────────────

async function googleTranslate(text: string, tgt: string): Promise<string> {
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(tgt)}&dt=t&q=${encodeURIComponent(text)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as [Array<[string, string, ...unknown[]]>]
  return json[0].map(chunk => chunk[0]).join('')
}

// ── Unified translate ─────────────────────────────────────────────────────────

type Source = 'on-device' | 'google'
type TranslationMode = 'paragraph' | 'sentence'

export async function translate(text: string, tgtLang = targetLang): Promise<{ text: string; source: Source }> {
  if (onDeviceTranslator) {
    return { text: await onDeviceTranslator.translate(text), source: 'on-device' }
  }
  return { text: await googleTranslate(text, tgtLang), source: 'google' }
}


// ── Overlay injection ─────────────────────────────────────────────────────────

function sourceLabel(source: Source) {
  return source === 'on-device' ? '🔒 on-device' : '🌐 Google'
}

async function injectOverlay(el: HTMLElement) {
  if (el.dataset.cxtDone) return
  el.dataset.cxtDone = '1'

  const text = getElementContentText(el)
  if (!text) return

  const overlay = document.createElement('div')
  overlay.setAttribute('data-cxt-translation', '1')
  overlay.style.cssText = `
    font-family: system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif;
    font-size: 0.875em;
    color: #6688bb;
    padding: 3px 0 5px 10px;
    border-left: 2px solid #2a3a5a;
    margin: 3px 0 6px 0;
    font-style: normal;
    line-height: 1.6;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  `

  const textSpan = document.createElement('span')
  textSpan.style.flex = '1'
  textSpan.textContent = '…'

  const badge = document.createElement('span')
  badge.style.cssText = `
    font-size: 0.72em; font-style: normal; color: #8888aa; background: #111820;
    border-radius: 3px; padding: 2px 5px; flex-shrink: 0; margin-top: 3px;
  `
  badge.textContent = '…'

  overlay.append(textSpan, badge)
  el.after(overlay)

  try {
    const { text: translated, source } = await translate(text)
    textSpan.textContent = translated
    badge.textContent = sourceLabel(source)
  } catch {
    textSpan.textContent = '⚠ Translation failed'
    textSpan.style.color = '#886655'
    textSpan.style.fontStyle = 'normal'
    badge.remove()
  }
}

async function injectSentenceOverlay(el: HTMLElement) {
  if (el.dataset.cxtDone) return

  const lang = document.documentElement.lang || 'en'
  const plan = buildSentencePlan([el], lang)
    .filter(item => item.text.trim().length > 0 && item.range.toString().trim().length > 0)

  if (plan.length <= 1) {
    await injectOverlay(el)
    return
  }

  el.dataset.cxtDone = '1'
  const overlays: Array<{ sentence: string; textSpan: HTMLSpanElement; badge: HTMLSpanElement | null }> = []

  for (let i = plan.length - 1; i >= 0; i--) {
    const overlay = document.createElement('span')
    overlay.setAttribute('data-cxt-translation', '1')
    overlay.style.cssText = `
      display: block;
      font-family: system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif;
      font-size: 0.875em;
      color: #6688bb;
      padding: 2px 0 4px 10px;
      border-left: 2px solid #2a3a5a;
      margin: 3px 0 5px 10px;
      font-style: normal;
      line-height: 1.6;
    `

    const textSpan = document.createElement('span')
    textSpan.textContent = '…'

    let badge: HTMLSpanElement | null = null
    if (i === 0) {
      badge = document.createElement('span')
      badge.style.cssText = `
        display:inline-block;
        margin-left:8px;
        font-size: 0.72em;
        font-style: normal;
        color: #8888aa;
        background: #111820;
        border-radius: 3px;
        padding: 2px 5px;
        vertical-align: middle;
      `
      badge.textContent = '…'
    }

    overlay.append(textSpan)
    if (badge) overlay.append(badge)

    const insertRange = plan[i].range.cloneRange()
    insertRange.collapse(false)
    insertRange.insertNode(overlay)

    overlays.unshift({ sentence: plan[i].text, textSpan, badge })
  }

  try {
    const results = await Promise.all(overlays.map(item => translate(item.sentence)))
    for (let i = 0; i < overlays.length; i++) {
      overlays[i].textSpan.textContent = results[i].text
    }
    if (overlays[0]?.badge) {
      overlays[0].badge.textContent = sourceLabel(results[0]?.source ?? 'google')
    }
  } catch {
    for (const overlay of overlays) {
      overlay.textSpan.textContent = '⚠ Translation failed'
      overlay.textSpan.style.color = '#886655'
      overlay.badge?.remove()
    }
  }
}

// ── Title translation ─────────────────────────────────────────────────────────

async function injectTitleOverlay() {
  const h1 = getPrimaryTitleElement()
  if (!h1) return
  await injectOverlay(h1)
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function enable(tgt: string, mode: TranslationMode = 'paragraph', forceGoogle = false) {
  if (enabled) {
    disable()
  }
  enabled = true
  targetLang = tgt

  const srcLang = document.documentElement.lang?.split('-')[0] || 'en'
  onDeviceTranslator = forceGoogle ? null : await initOnDevice(srcLang, tgt)

  const article = extractReadableArticle()
  if (article) articleText = article.textContent

  // Translate the page title immediately (not lazy)
  await injectTitleOverlay()

  for (const el of getTitleContextElements()) {
    ;(mode === 'sentence' ? injectSentenceOverlay(el) : injectOverlay(el)).catch(() => {})
  }

  // Translate lead/subtitle elements immediately (above the fold, any element type)
  for (const el of getArticleLeadElements()) {
    ;(mode === 'sentence' ? injectSentenceOverlay(el) : injectOverlay(el)).catch(() => {})
  }

  const paragraphs = getContentParagraphs(articleText)
  if (paragraphs.length === 0) return

  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const inject = mode === 'sentence' ? injectSentenceOverlay : injectOverlay
      inject(entry.target as HTMLElement).catch(() => {})
      observer?.unobserve(entry.target)
    }
  }, { rootMargin: '200px' })

  for (const el of paragraphs) {
    observer.observe(el)
  }
}

export function disable() {
  enabled = false
  articleText = ''
  observer?.disconnect()
  observer = null
  onDeviceTranslator?.destroy()
  onDeviceTranslator = null
  document.querySelectorAll('[data-cxt-translation]').forEach(el => el.remove())
  document.querySelectorAll<HTMLElement>('[data-cxt-done]').forEach(el => {
    delete el.dataset.cxtDone
  })
}

export function isEnabled() {
  return enabled
}

export function prefetchAhead(currentIndex: number, sentences: string[], count = 3) {
  if (!enabled) return
  for (let i = currentIndex; i < Math.min(currentIndex + count, sentences.length); i++) {
    if (sentences[i]) translate(sentences[i]).catch(() => {})
  }
}
