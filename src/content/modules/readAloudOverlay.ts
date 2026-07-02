/**
 * Read Aloud visual overlays that can't be expressed via the CSS Custom
 * Highlight API (which paints text ranges only, no pseudo-elements or box
 * decorations):
 *
 *  1. A thin left "reading" accent bar tracking the current sentence's left
 *     edge + vertical span (E19).
 *  2. An optional focus/spotlight mode that dims the rest of the page and keeps
 *     the current sentence bright, using the CropOverlay box-shadow technique
 *     (E20).
 *
 * Both live in their own shadow-DOM hosts so page CSS can't touch them. Both are
 * driven off a single `Rect | null` that is updated whenever the current
 * sentence changes (via updateReadingOverlays) and cleared when read-aloud stops
 * or the range has no geometry (never throws on an empty/detached range).
 *
 * z-index: kept BELOW the mini-player (2147483647) so the player stays clickable
 * and on top.
 */

type Rect = { left: number; top: number; width: number; height: number }

const OVERLAY_Z = 2147483646

// ── Shared host management ────────────────────────────────────────────────────

let markerHost: HTMLElement | null = null
let markerBar: HTMLElement | null = null

let focusHost: HTMLElement | null = null
let focusBox: HTMLElement | null = null

// Whether focus/spotlight mode is toggled on (in-session; not persisted).
let focusEnabled = false
// The current sentence's Range, kept so we can recompute its (viewport-relative,
// fixed-positioned) rect after the page scrolls/resizes while the same sentence
// is showing. Null when no sentence is active.
let currentRange: Range | null = null
// The inline translation overlay ([data-cxt-translation]) belonging to the
// current sentence's block, so focus mode can light it together with the
// sentence. Null when translation is off / none is adjacent.
let currentTranslationEl: HTMLElement | null = null
// rAF handle to coalesce scroll/resize repositioning.
let repositionRaf = 0
// Whether our scroll/resize listeners are currently attached.
let trackingActive = false

// Paragraph-mode translation overlays are injected lazily (IntersectionObserver
// + an async translate() call in translation.ts), so the overlay may not exist
// in the DOM yet at the exact moment a sentence starts — the earlier one-shot
// lookup made the spotlight-covers-translation behavior flaky ("sometimes
// lights, sometimes doesn't"). `translationGeneration` invalidates retries/watch
// from a previous sentence once the current one changes.
let translationGeneration = 0
let translationRetryTimers: ReturnType<typeof setTimeout>[] = []
let translationObserver: MutationObserver | null = null
const TRANSLATION_RETRY_DELAYS_MS = [120, 300, 600, 1200, 2000]

function clearTranslationWatch() {
  for (const id of translationRetryTimers) clearTimeout(id)
  translationRetryTimers = []
  translationObserver?.disconnect()
  translationObserver = null
}

// Repaint whenever the found overlay's content changes size (e.g. its "…"
// loading placeholder is replaced by the real translated text), so the focus
// box grows/shrinks to match instead of freezing at the placeholder's size.
function watchTranslationEl(el: HTMLElement, gen: number) {
  translationObserver?.disconnect()
  translationObserver = new MutationObserver(() => {
    if (gen !== translationGeneration) return
    repaint()
  })
  translationObserver.observe(el, { childList: true, characterData: true, subtree: true })
}

// The overlay may not exist yet when the sentence starts (see above). Retry a
// few times over the sentence's likely speaking window; bail out once a newer
// sentence has superseded this one (`gen` mismatch).
function scheduleTranslationRetries(range: Range, contentEl: HTMLElement | null, gen: number) {
  for (const delay of TRANSLATION_RETRY_DELAYS_MS) {
    const id = setTimeout(() => {
      if (gen !== translationGeneration) return
      const el = findTranslationForContentEl(range, contentEl) ?? findTranslationForRange(range)
      if (!el) return
      currentTranslationEl = el
      watchTranslationEl(el, gen)
      repaint()
    }, delay)
    translationRetryTimers.push(id)
  }
}

function ensureMarker(): HTMLElement {
  if (markerBar) return markerBar

  markerHost = document.createElement('div')
  markerHost.className = 'cxt-reading-marker-host'
  const shadow = markerHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .bar {
      position: fixed;
      z-index: ${OVERLAY_Z};
      pointer-events: none;
      border-radius: 2px;
      background: #4f6ef7;
      box-shadow: 0 0 6px rgba(79, 110, 247, 0.6);
      display: none;
      transition: top 0.15s ease, height 0.15s ease, left 0.15s ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .bar { transition: none; }
    }
  `

  markerBar = document.createElement('div')
  markerBar.className = 'bar'
  shadow.append(style, markerBar)
  document.body.appendChild(markerHost)
  return markerBar
}

function ensureFocus(): HTMLElement {
  if (focusBox) return focusBox

  focusHost = document.createElement('div')
  focusHost.className = 'cxt-reading-focus-host'
  const shadow = focusHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .box {
      position: fixed;
      z-index: ${OVERLAY_Z};
      pointer-events: none;
      border-radius: 6px;
      /* Everything outside this box is dimmed by the huge spread shadow. */
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
      display: none;
      transition: top 0.15s ease, left 0.15s ease, width 0.15s ease, height 0.15s ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .box { transition: none; }
    }
  `

  focusBox = document.createElement('div')
  focusBox.className = 'box'
  shadow.append(style, focusBox)
  document.body.appendChild(focusHost)
  return focusBox
}

// ── Rect extraction ───────────────────────────────────────────────────────────

// Get the current sentence's viewport rect, or null if the range has no
// geometry (empty/detached/zero-size). Never throws.
function rectFromRange(range: Range): Rect | null {
  try {
    const r = range.getBoundingClientRect()
    if (!r || (r.width === 0 && r.height === 0)) return null
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  } catch {
    return null
  }
}

// Viewport rect of an element, or null if it has no geometry. Never throws.
function rectFromEl(el: Element): Rect | null {
  try {
    const r = el.getBoundingClientRect()
    if (!r || (r.width === 0 && r.height === 0)) return null
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  } catch {
    return null
  }
}

// Bounding union of two rects (either may be null).
function unionRects(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const left = Math.min(a.left, b.left)
  const top = Math.min(a.top, b.top)
  const right = Math.max(a.left + a.width, b.left + b.width)
  const bottom = Math.max(a.top + a.height, b.top + b.height)
  return { left, top, width: right - left, height: bottom - top }
}

// Find the translation overlay belonging to a known content block (the exact
// element buildSentencePlan built this sentence from — passed in from
// readAloud.ts, not guessed). Handles both translation modes:
//  - paragraph mode: ONE overlay sits right after the whole block (el.after()
//    in translation.ts) — checked first, cheap.
//  - sentence mode: EACH sentence gets its own overlay, inserted INSIDE the
//    block at that sentence's own end position (Range.insertNode). These
//    overlays come from an independently-built Range plan in translation.ts,
//    injected lazily and possibly after read-aloud already captured its own
//    sentence ranges — so we can't assume exact sibling/ancestor identity with
//    THIS sentence's range. Instead, scan the block's overlays in document
//    order and return the first one that lands at/after this sentence's end —
//    i.e. its own translation.
function findTranslationForContentEl(range: Range, contentEl: HTMLElement | null): HTMLElement | null {
  if (!contentEl) return null
  // translation.ts sets data-cxt-done directly on the block it's translating
  // (contentEl normally IS that block already; closest() is a defensive
  // fallback in case a future caller passes something nested inside it).
  const block = contentEl.matches('[data-cxt-done]') ? contentEl : (contentEl.closest('[data-cxt-done]') ?? contentEl)

  const directSib = block.nextElementSibling
  if (directSib?.matches?.('[data-cxt-translation]')) return directSib as HTMLElement

  const overlays = block.querySelectorAll<HTMLElement>('[data-cxt-translation]')
  for (const overlay of overlays) {
    const pos = range.endContainer.compareDocumentPosition(overlay)
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return overlay
  }
  return null
}

// Find the inline translation overlay for the current sentence's block by
// guessing from the sentence's own Range. Fallback for when the caller doesn't
// have the content element handy (findTranslationForContentEl is preferred).
// Translations are inserted as a [data-cxt-translation] element right after the
// content block (paragraph mode) or after the sentence (sentence mode).
function findTranslationForRange(range: Range): HTMLElement | null {
  const startEl: Element | null = range.endContainer.nodeType === Node.ELEMENT_NODE
    ? (range.endContainer as Element)
    : range.endContainer.parentElement
  if (!startEl) return null

  // 1) Shallow climb: catches sentence-mode overlays, which are inserted right
  // where each individual sentence ends (typically a shallow number of levels
  // up from the sentence's own text).
  let el: Element | null = startEl
  for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
    if (el.matches?.('[data-cxt-translation]')) return el as HTMLElement
    const sib = el.nextElementSibling
    if (sib?.matches?.('[data-cxt-translation]')) return sib as HTMLElement
  }

  // 2) Paragraph-mode fallback: translation.ts marks the EXACT content block it
  // is translating with `data-cxt-done`, set synchronously right before the
  // overlay is inserted as that block's next sibling. `closest()` climbs the
  // ancestor chain unboundedly, so this finds the right block regardless of how
  // deeply the sentence's text is nested inside it (unlike the depth-capped
  // climb above, which can miss it on sites with lots of wrapper markup).
  const block = startEl.closest('[data-cxt-done]')
  const sib = block?.nextElementSibling
  if (sib?.matches?.('[data-cxt-translation]')) return sib as HTMLElement

  return null
}

// ── Painting ──────────────────────────────────────────────────────────────────

function paintMarker(rect: Rect | null) {
  if (!markerBar && !rect) return
  const bar = ensureMarker()
  if (!rect) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'block'
  bar.style.left = `${rect.left - 6}px`
  bar.style.top = `${rect.top}px`
  bar.style.width = `3px`
  bar.style.height = `${rect.height}px`
}

function paintFocus(rect: Rect | null) {
  if (!focusEnabled || !rect) {
    if (focusBox) focusBox.style.display = 'none'
    return
  }
  const box = ensureFocus()
  // Pad slightly so glyph ascenders/descenders aren't clipped by the bright box.
  const pad = 6
  box.style.display = 'block'
  box.style.left = `${rect.left - pad}px`
  box.style.top = `${rect.top - pad}px`
  box.style.width = `${rect.width + pad * 2}px`
  box.style.height = `${rect.height + pad * 2}px`
}

// Repaint both overlays from the live range's current viewport rect.
function repaint() {
  const sentenceRect = currentRange ? rectFromRange(currentRange) : null
  paintMarker(sentenceRect)
  // Focus mode lights the sentence together with its translation below it.
  const transRect = currentTranslationEl ? rectFromEl(currentTranslationEl) : null
  paintFocus(unionRects(sentenceRect, transRect))
}

// ── Scroll / resize tracking ──────────────────────────────────────────────────
// Fixed-positioned overlays are viewport-relative, so their on-screen position
// only stays correct if we recompute the sentence rect whenever the page scrolls
// or resizes. Listeners run only while a sentence is active.

function onViewportChange() {
  if (repositionRaf) return
  repositionRaf = requestAnimationFrame(() => {
    repositionRaf = 0
    repaint()
  })
}

function startTracking() {
  if (trackingActive) return
  trackingActive = true
  // capture:true so we also catch scrolls on nested scroll containers.
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true })
  window.addEventListener('resize', onViewportChange, { passive: true })
}

function stopTracking() {
  if (!trackingActive) return
  trackingActive = false
  window.removeEventListener('scroll', onViewportChange, { capture: true })
  window.removeEventListener('resize', onViewportChange)
  if (repositionRaf) {
    cancelAnimationFrame(repositionRaf)
    repositionRaf = 0
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Update both overlays to track `range` (the current sentence). Safe to call
 * with an empty/detached range — overlays are simply hidden in that case.
 * `contentEl` is the exact paragraph/content block buildSentencePlan built this
 * sentence from, when known — it makes finding the sentence's translation
 * deterministic instead of guessing from the sentence's own (possibly deeply
 * nested, or non-last-within-its-paragraph) range.
 */
export function updateReadingOverlays(range: Range, contentEl: HTMLElement | null = null): void {
  currentRange = range
  translationGeneration++
  clearTranslationWatch()
  currentTranslationEl = findTranslationForContentEl(range, contentEl) ?? findTranslationForRange(range)
  if (currentTranslationEl) {
    watchTranslationEl(currentTranslationEl, translationGeneration)
  } else {
    // Not injected yet (paragraph-mode translation is lazy) — keep looking
    // while this sentence is current.
    scheduleTranslationRetries(range, contentEl, translationGeneration)
  }
  startTracking()
  repaint()
}

/** Hide both overlays (read-aloud paused into idle / stopped). Keeps hosts. */
export function hideReadingOverlays(): void {
  currentRange = null
  currentTranslationEl = null
  translationGeneration++
  clearTranslationWatch()
  stopTracking()
  if (markerBar) markerBar.style.display = 'none'
  if (focusBox) focusBox.style.display = 'none'
}

/** Fully tear down overlay hosts (e.g. when the widget is removed). */
export function destroyReadingOverlays(): void {
  hideReadingOverlays()
  markerHost?.remove()
  focusHost?.remove()
  markerHost = null
  markerBar = null
  focusHost = null
  focusBox = null
}

/** Turn focus/spotlight mode on or off. Repaints immediately. */
export function setFocusMode(enabled: boolean): void {
  focusEnabled = enabled
  const sentenceRect = currentRange ? rectFromRange(currentRange) : null
  const transRect = currentTranslationEl ? rectFromEl(currentTranslationEl) : null
  paintFocus(unionRects(sentenceRect, transRect))
}

export function isFocusMode(): boolean {
  return focusEnabled
}
