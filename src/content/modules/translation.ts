type TranslatorAPI = {
  translate: (text: string) => Promise<string>
  destroy: () => void
}

type AITranslator = {
  capabilities: () => Promise<{
    available: string
    languagePairAvailable: (s: string, t: string) => string
  }>
  create: (opts: { sourceLanguage: string; targetLanguage: string }) => Promise<TranslatorAPI>
}

let enabled = false
let targetLang = 'en'
let onDeviceTranslator: TranslatorAPI | null = null
let observer: IntersectionObserver | null = null

// ── On-device API ────────────────────────────────────────────────────────────

function getAITranslator(): AITranslator | null {
  return (window as unknown as { ai?: { translator?: AITranslator } }).ai?.translator ?? null
}

export async function isTranslatorAvailable(): Promise<boolean> {
  const api = getAITranslator()
  if (!api) return false
  try {
    const cap = await api.capabilities()
    return cap.available !== 'no'
  } catch {
    return false
  }
}

async function initOnDevice(src: string, tgt: string): Promise<TranslatorAPI | null> {
  const api = getAITranslator()
  if (!api) return null
  try {
    const cap = await api.capabilities()
    if (cap.available === 'no') return null
    if (cap.languagePairAvailable(src, tgt) === 'no') return null
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
  const json = await res.json() as [[[string][]][]]
  return json[0].map(chunk => chunk[0][0]).join('')
}

// ── Unified translate ─────────────────────────────────────────────────────────

type Source = 'on-device' | 'google'

async function translate(text: string): Promise<{ text: string; source: Source }> {
  if (onDeviceTranslator) {
    return { text: await onDeviceTranslator.translate(text), source: 'on-device' }
  }
  return { text: await googleTranslate(text, targetLang), source: 'google' }
}

// ── DOM paragraph discovery ───────────────────────────────────────────────────

/**
 * Find content paragraphs directly in the DOM — no Readability matching.
 * Tries to scope to an article/main element first, falls back to body.
 */
function getContentParagraphs(): HTMLElement[] {
  const root: HTMLElement =
    document.querySelector('article, [role="main"], main, .post-content, .article-body, .entry-content, #content, #main') ??
    document.body

  return [...root.querySelectorAll<HTMLElement>('p, blockquote, h1, h2, h3, h4, li')]
    .filter(el => {
      const text = el.innerText?.trim() ?? ''
      if (text.length < 20) return false                          // skip trivially short
      if (el.closest('[data-cxt-translation]')) return false      // skip our own overlays
      if (el.querySelector('[data-cxt-translation]')) return false // skip if already has overlay child
      const s = getComputedStyle(el)
      return s.display !== 'none' && s.visibility !== 'hidden'
    })
}

// ── Overlay injection ─────────────────────────────────────────────────────────

function sourceLabel(source: Source) {
  return source === 'on-device' ? '🔒 on-device' : '🌐 Google'
}

async function injectOverlay(el: HTMLElement) {
  // Guard: don't inject twice
  if (el.dataset.cxtDone) return
  el.dataset.cxtDone = '1'

  const text = el.innerText.trim()
  if (!text) return

  const overlay = document.createElement('div')
  overlay.setAttribute('data-cxt-translation', '1')
  overlay.style.cssText = `
    font-size: 0.875em;
    color: #6688bb;
    padding: 3px 0 5px 10px;
    border-left: 2px solid #2a3a5a;
    margin: 3px 0 6px 0;
    font-style: italic;
    line-height: 1.5;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  `

  const textSpan = document.createElement('span')
  textSpan.style.flex = '1'
  textSpan.textContent = '…'

  const badge = document.createElement('span')
  badge.style.cssText = `
    font-size: 0.72em; font-style: normal; color: #556; background: #111820;
    border-radius: 3px; padding: 2px 5px; flex-shrink: 0; margin-top: 3px;
  `
  badge.textContent = '…'

  overlay.append(textSpan, badge)
  el.after(overlay)

  try {
    const { text: translated, source } = await translate(text)
    textSpan.textContent = translated
    badge.textContent = sourceLabel(source)
  } catch (err) {
    textSpan.textContent = '⚠ Translation failed'
    textSpan.style.color = '#886655'
    textSpan.style.fontStyle = 'normal'
    badge.remove()
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function enable(tgt: string) {
  if (enabled) return
  enabled = true
  targetLang = tgt

  const srcLang = document.documentElement.lang?.split('-')[0] || 'en'
  onDeviceTranslator = await initOnDevice(srcLang, tgt)

  const paragraphs = getContentParagraphs()
  if (paragraphs.length === 0) return

  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      injectOverlay(entry.target as HTMLElement)
      observer?.unobserve(entry.target)
    }
  }, { rootMargin: '200px' })

  for (const el of paragraphs) {
    observer.observe(el)
  }
}

export function disable() {
  enabled = false
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
