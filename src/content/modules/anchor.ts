import { SavedItem } from '../../shared/types'
import { updateReadingOverlays, hideReadingOverlays } from './readAloudOverlay'

// ── window.find() helper ─────────────────────────────────────────────────────

type WFind = (
  text: string,
  caseSensitive?: boolean,
  backwards?: boolean,
  wrap?: boolean,
  wholeWord?: boolean,
  searchInFrames?: boolean,
  showDialog?: boolean
) => boolean

const wFind = (window as unknown as { find: WFind }).find.bind(window)

/**
 * Use the browser's native text search to find the Nth occurrence of `text`.
 * Saves + restores scroll position. Clears the selection afterwards.
 * Returns a cloned Range or null.
 */
function findNthOccurrence(text: string, n: number): Range | null {
  const sx = window.scrollX, sy = window.scrollY
  window.getSelection()?.removeAllRanges()

  for (let i = 0; i <= n; i++) {
    if (!wFind(text, true, false, false, false, false, false)) {
      window.getSelection()?.removeAllRanges()
      window.scrollTo(sx, sy)
      return null
    }
  }

  const range = window.getSelection()?.getRangeAt(0)?.cloneRange() ?? null
  window.getSelection()?.removeAllRanges()
  window.scrollTo(sx, sy)
  return range
}

// ── CSS Custom Highlight API ─────────────────────────────────────────────────

// Map bookmark id → Range so we can remove/scroll later
const bookmarkRanges = new Map<string, Range>()

// ── Selection context ─────────────────────────────────────────────────────────

/**
 * Called from content script when the user's selection is still active.
 * Uses window.find() to count how many times the selected text appears
 * before the actual selection position — this is the occurrence index
 * needed to re-locate the highlight on future page visits.
 */
export function getSelectionContext(searchString?: string): {
  prefix: string
  suffix: string
  occurrenceIndex: number
  sourceLang?: string
} | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null

  const text = searchString || sel.toString()
  if (!text.trim()) return null

  const currentRange = sel.getRangeAt(0).cloneRange()
  const sx = window.scrollX, sy = window.scrollY

  // Count occurrences that appear BEFORE our selection in DOM order
  window.getSelection()?.removeAllRanges()
  let occurrenceIndex = 0

  while (wFind(text, true, false, false, false, false, false)) {
    const found = window.getSelection()?.getRangeAt(0)
    if (!found) break
    // If the found range starts at or after our selection, stop
    if (found.compareBoundaryPoints(Range.START_TO_START, currentRange) >= 0) break
    occurrenceIndex++
  }

  // Restore
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(currentRange)
  window.scrollTo(sx, sy)

  // Use a TreeWalker to extract exactly the surrounding text from the DOM.
  // This guarantees we get the context for the exact occurrence the user highlighted,
  // bypassing innerText/indexOf drifting issues.
  
  let sourceLang: string | undefined = undefined
  let langNode: Node | null = currentRange.startContainer
  while (langNode && langNode !== document.body) {
    if (langNode.nodeType === Node.ELEMENT_NODE) {
      const l = (langNode as Element).getAttribute('lang')
      if (l) {
        sourceLang = l
        break
      }
    }
    langNode = langNode.parentNode
  }

  // Find the closest block container
  let block: HTMLElement = document.body
  let currNode: Node | null = currentRange.startContainer
  while (currNode && currNode !== document.body) {
    if (currNode.nodeType === Node.ELEMENT_NODE) {
      const display = window.getComputedStyle(currNode as Element).display
      if (['block', 'flex', 'grid', 'table-cell', 'list-item'].includes(display) || 
          ['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'TD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes((currNode as Element).tagName.toUpperCase())) {
        block = currNode as HTMLElement
        break
      }
    }
    currNode = currNode.parentNode
  }

  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement
      if (!el) return NodeFilter.FILTER_REJECT
      // See buildElementTextIndex — a <noscript>'s content is one literal text
      // node holding raw markup source once scripting is enabled.
      if (el.closest('noscript')) return NodeFilter.FILTER_REJECT
      const s = window.getComputedStyle(el)
      if (s.display === 'none' || s.visibility === 'hidden') return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })

  let rawPrefix = ''
  let rawSuffix = ''
  let pastSelection = false
  let insideSelection = false

  let n: Node | null
  while ((n = walker.nextNode())) {
    const isStart = n === currentRange.startContainer
    const isEnd = n === currentRange.endContainer

    if (isStart) {
      rawPrefix += n.nodeValue?.slice(0, currentRange.startOffset) || ''
      insideSelection = true
    }

    if (!insideSelection && !pastSelection) {
      rawPrefix += n.nodeValue || ''
    }

    if (pastSelection) {
      rawSuffix += n.nodeValue || ''
    }

    if (isEnd) {
      rawSuffix += n.nodeValue?.slice(currentRange.endOffset) || ''
      insideSelection = false
      pastSelection = true
    }
  }

  // Handle trailing/leading spaces inside the selection that get dropped
  const rangeText = currentRange.toString()
  const trimmedText = rangeText.trim()
  
  if (trimmedText) {
    const startSpaces = rangeText.slice(0, rangeText.indexOf(trimmedText))
    const endSpaces = rangeText.slice(rangeText.indexOf(trimmedText) + trimmedText.length)
    rawPrefix += startSpaces
    rawSuffix = endSpaces + rawSuffix
  }

  let prefix = rawPrefix.replace(/\s+/g, ' ')
  let suffix = rawSuffix.replace(/\s+/g, ' ')

  // Extract ONLY the sentence the word belongs to
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
    
    const prefixSegments = [...segmenter.segment(prefix)]
    if (prefixSegments.length > 0) {
      prefix = prefixSegments[prefixSegments.length - 1].segment
    }

    const suffixSegments = [...segmenter.segment(suffix)]
    if (suffixSegments.length > 0) {
      suffix = suffixSegments[0].segment
    }
  } catch {
    // Fallback if Intl.Segmenter is not available
    if (prefix.length > 150) {
      const sliced = prefix.slice(-150)
      const spaceIdx = sliced.indexOf(' ')
      prefix = spaceIdx !== -1 ? '...' + sliced.slice(spaceIdx) : '...' + sliced
    }
    if (suffix.length > 150) {
      const sliced = suffix.slice(0, 150)
      const spaceIdx = sliced.lastIndexOf(' ')
      suffix = spaceIdx !== -1 ? sliced.slice(0, spaceIdx) + '...' : sliced + '...'
    }
  }

  const match = prefix.match(/(?:^|[.!?。！？\n])\s*([^.!?。！？\n]*)$/)
  const finalPrefix = match ? match[1] : prefix

  const suffixMatch = suffix.match(/^([^.!?。！？\n]*)/)
  const finalSuffix = suffixMatch ? suffixMatch[1] : suffix

  return { prefix: finalPrefix, suffix: finalSuffix, occurrenceIndex, sourceLang }
}

// ── Bookmark highlights ───────────────────────────────────────────────────────

/**
 * Apply a CSS Custom Highlight for a bookmark.
 * Does NOT modify the DOM — works with any range including cross-element ones.
 */
export function applyHighlight(bookmark: SavedItem): boolean {
  const range = findNthOccurrence(bookmark.text, bookmark.occurrenceIndex)
  if (!range) return false

  bookmarkRanges.set(bookmark.id, range)

  const key = `cxt-${bookmark.color}`
  const hl = CSS.highlights.get(key) ?? new Highlight()
  hl.add(range)
  CSS.highlights.set(key, hl)

  return true
}

export function removeHighlight(bookmarkId: string) {
  const range = bookmarkRanges.get(bookmarkId)
  if (!range) return
  bookmarkRanges.delete(bookmarkId)
  CSS.highlights.forEach(hl => hl.delete(range))
}

let pulseStyleInjected = false
function ensurePulseStyle() {
  if (pulseStyleInjected) return
  pulseStyleInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes cxt-save-pulse {
      0%   { opacity: 0; transform: scale(1); }
      25%  { opacity: 0.5; transform: scale(1.08); }
      100% { opacity: 0; transform: scale(1.16); }
    }
    @keyframes cxt-save-fade { 0% { opacity: 0.5 } 100% { opacity: 0 } }
    @media (prefers-reduced-motion: reduce) {
      .cxt-save-pulse { animation-name: cxt-save-fade !important; }
    }
  `
  document.head.appendChild(style)
}

// Brief pulse over a just-saved highlight, tying the reward to the actual word.
// Draws short-lived overlay boxes on the word's client rects (the highlight
// itself is painted via the CSS Custom Highlight API, so there's no element).
export function pulseHighlight(bookmarkId: string, color: string) {
  const range = bookmarkRanges.get(bookmarkId)
  if (!range) return
  ensurePulseStyle()
  for (const rect of range.getClientRects()) {
    if (rect.width === 0 || rect.height === 0) continue
    const el = document.createElement('div')
    el.className = 'cxt-save-pulse'
    el.style.cssText = `
      position: fixed;
      left: ${rect.left - 2}px;
      top: ${rect.top - 2}px;
      width: ${rect.width + 4}px;
      height: ${rect.height + 4}px;
      border-radius: 4px;
      background: ${color};
      box-shadow: 0 0 10px ${color};
      opacity: 0;
      pointer-events: none;
      z-index: 2147483646;
      animation: cxt-save-pulse 0.7s ease-out forwards;
    `
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 750)
  }
}

// bufferY extends the hit zone upward and downward so the cursor can travel from the
// highlighted text to the tooltip across the gap without triggering the hide timer.
export function getBookmarkAtPoint(x: number, y: number, bufferY = 0): { id: string; range: Range } | null {
  for (const [id, range] of bookmarkRanges) {
    for (const rect of range.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top - bufferY && y <= rect.bottom + bufferY) {
        return { id, range }
      }
    }
  }
  return null
}

export function scrollToHighlight(bookmarkId: string) {
  const range = bookmarkRanges.get(bookmarkId)
  if (!range) return

  range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  const flash = new Highlight(range)
  CSS.highlights.set('cxt-flash', flash)
  setTimeout(() => CSS.highlights.delete('cxt-flash'), 1500)
}

// ── Read Aloud sentence highlighting ─────────────────────────────────────────

// ── Element-scoped text index ─────────────────────────────────────────────────

type TextEntry = { node: Text; start: number }

function isNoisyInteractiveText(el: HTMLElement): boolean {
  if (el.closest('button, [role="button"], input, select, textarea, label')) return true

  const link = el.closest('a')
  if (!link) return false

  const attrs = `${link.className} ${link.id} ${link.getAttribute('aria-label') ?? ''}`.toLowerCase()
  if (/\b(btn|button|share|social|follow|subscribe|signup|sign-up|login|register|comment|banner|advert|promo)\b/.test(attrs)) {
    return true
  }

  const linkText = link.innerText.replace(/\s+/g, ' ').trim()
  if (link.querySelector('img, svg, picture') && linkText.length > 20) return true

  return false
}

// Walk visible, non-overlay text nodes within a single DOM element.
function buildElementTextIndex(root: HTMLElement): { entries: TextEntry[]; text: string } {
  const entries: TextEntry[] = []
  const parts: string[] = []
  let offset = 0

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = (node as Text).parentElement
      if (!el) return NodeFilter.FILTER_REJECT
      // A <noscript>'s content is inert markup source, not real child elements,
      // whenever scripting is enabled (i.e. always, in a browser running this
      // extension) — the browser keeps it as one literal text node holding the
      // raw "<div><time>...</time></div>" source. getComputedStyle(display)
      // isn't a reliable enough guard against it in the wild (seen leaking
      // through on real pages), so exclude it explicitly.
      if (el.closest('noscript')) return NodeFilter.FILTER_REJECT
      const s = getComputedStyle(el)
      if (s.display === 'none' || s.visibility === 'hidden') return NodeFilter.FILTER_REJECT
      if (el.closest('[data-cxt-translation]')) return NodeFilter.FILTER_REJECT
      if (isNoisyInteractiveText(el)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    const val = t.nodeValue ?? ''
    entries.push({ node: t, start: offset })
    parts.push(val)
    offset += val.length
  }

  return { entries, text: parts.join('') }
}

// Normalise typographic characters to ASCII equivalents (length-preserving).
function normText(s: string): string {
  return s
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ')
}

// Binary-search for the text node that owns `absOffset`.
// preferPrev: when offset lands exactly on a node boundary, use the END of the
// previous node — keeps Range endpoints inside their originating text node so
// we never accidentally span a translation overlay sitting between paragraphs.
function resolveOffset(
  entries: TextEntry[],
  absOffset: number,
  preferPrev = false,
): { node: Text; nodeOffset: number } | null {
  if (!entries.length) return null
  let lo = 0, hi = entries.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (entries[mid].start <= absOffset) lo = mid
    else hi = mid - 1
  }
  const e = entries[lo]
  const nodeOffset = absOffset - e.start
  if (preferPrev && nodeOffset === 0 && lo > 0) {
    const prev = entries[lo - 1]
    return { node: prev.node, nodeOffset: prev.node.nodeValue?.length ?? 0 }
  }
  if (nodeOffset > (e.node.nodeValue?.length ?? 0)) return null
  return { node: e.node, nodeOffset }
}

// Range spanning every indexed text node, start to end — used as a fallback
// when the precise regex-based match for a single-sentence element fails.
function wholeEntriesRange(entries: TextEntry[]): Range | null {
  if (entries.length === 0) return null
  const first = entries[0]
  const last = entries[entries.length - 1]
  const range = new Range()
  range.setStart(first.node, 0)
  range.setEnd(last.node, last.node.nodeValue?.length ?? 0)
  return range
}

/**
 * Segment each element's text individually and compute DOM Ranges scoped to
 * that element. Because we never concatenate adjacent elements, Ranges are
 * guaranteed to stay inside their source block — no cross-paragraph spans,
 * no translation-overlay bleed.
 *
 * Two-step search strategy to handle source-code whitespace in text nodes:
 *  1. Collapse whitespace before segmentation so source newlines/indentation
 *     are not treated as sentence boundaries by Intl.Segmenter.
 *  2. Search each segment in the unicode-normalised raw text using a regex
 *     that treats \s+ as flexible whitespace. normText() is 1-for-1
 *     (length-preserving), so regex positions in normText(raw) map directly
 *     to entries offsets used by resolveOffset().
 */
export function buildSentencePlan(
  elements: HTMLElement[],
  lang: string,
): Array<{ text: string; range: Range; el: HTMLElement }> {
  let segmenter: Intl.Segmenter
  try {
    segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' })
  } catch {
    segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  }

  const plan: Array<{ text: string; range: Range; el: HTMLElement }> = []

  for (const el of elements) {
    const { entries, text: raw } = buildElementTextIndex(el)
    if (!raw.trim()) continue

    // normRaw: unicode chars normalised (1:1, positions preserved vs raw)
    const normRaw = normText(raw)
    // collapsed: whitespace collapsed — used for segmentation only
    const collapsed = normRaw.replace(/\s+/g, ' ').trim()

    const segments = [...segmenter.segment(collapsed)]
      .map(s => s.segment.trim())
      .filter(s => s.length > 0)

    let searchFrom = 0
    for (const sentence of segments) {
      // Build a regex that matches the sentence with flexible whitespace so
      // "a\n      b" in the raw text matches the collapsed segment "a b".
      let matchStart = -1
      let matchEnd = -1
      try {
        const pattern = normText(sentence)
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex metacharacters
          .replace(/\s+/g, '\\s+')                  // each space → flexible \s+
          .replace(/[。！？]/g, '$&\\s*')             // Chinese punctuation -> optional trailing space
        const re = new RegExp(pattern)
        const match = re.exec(normRaw.slice(searchFrom))
        if (match) {
          matchStart = searchFrom + match.index
          matchEnd = matchStart + match[0].length
        }
      } catch {
        // Regex construction failed — leave matchStart === -1
      }

      // If this element boils down to a single "sentence" (the common case for
      // short elements like list items — no internal terminal punctuation for
      // Intl.Segmenter to split on), fall back to spanning the whole element
      // rather than leaving it collapsed. An empty Range makes
      // highlightSentenceRange silently skip painting anything for it, which
      // looks like read-aloud "got stuck" on the previous sentence while the
      // audio (driven by plain sentence strings, not Ranges) keeps going.
      const wholeElementFallback = segments.length === 1 ? wholeEntriesRange(entries) : null

      if (matchStart === -1) {
        plan.push({ text: sentence, range: wholeElementFallback ?? new Range(), el })
        // BUG (found via user report): searchFrom used to stay put here, so a
        // single failed match within a multi-sentence element would make every
        // later sentence in that same element re-search from the SAME stale
        // position. Since regex.exec just finds the next occurrence forward
        // from there, a later sentence could end up matching a stretch of text
        // that overlaps/duplicates an earlier sentence's own range — which
        // looks exactly like "the highlight didn't move to the next sentence"
        // even though a (wrong) Range genuinely got applied. Advance by the
        // sentence's own length as a best-effort estimate so later sentences in
        // the same element still search forward from roughly the right spot.
        searchFrom += normText(sentence).length
        continue
      }

      const startPos = resolveOffset(entries, matchStart)
      const endPos = resolveOffset(entries, matchEnd, true)

      if (!startPos || !endPos) {
        plan.push({ text: sentence, range: wholeElementFallback ?? new Range(), el })
        // Unlike the matchStart === -1 case above, the regex DID succeed here
        // (only DOM-position resolution failed) — matchEnd is a real, known
        // position in the raw text, so use it exactly rather than guessing.
        searchFrom = matchEnd
        continue
      }

      const range = new Range()
      range.setStart(startPos.node, startPos.nodeOffset)
      range.setEnd(endPos.node, endPos.nodeOffset)
      plan.push({ text: sentence, range, el })
      searchFrom = matchEnd
    }
  }

  return plan
}

// Comfortable viewport band: only auto-scroll when the sentence falls outside
// it. Top margin keeps the line clear of sticky site headers; the bottom margin
// leaves room for the mini-player (~130px tall, bottom: 24px).
const SCROLL_MARGIN_TOP = 80
const SCROLL_MARGIN_BOTTOM = 140

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// Many reading layouts (app shells with a fixed sidebar/header and an
// independently-scrolling content pane) don't scroll the window at all — the
// article sits inside its own `overflow: auto` container. Walk up from the
// sentence to find the element that actually scrolls, so read-aloud can follow
// along there too instead of silently no-op'ing on window.scrollTo.
function findScrollContainer(el: Element | null): Element | null {
  let node = el?.parentElement ?? null
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node)
    const canScrollY = (style.overflowY === 'auto' || style.overflowY === 'scroll')
      && node.scrollHeight > node.clientHeight + 1
    if (canScrollY) return node
    node = node.parentElement
  }
  return null
}

// Defensive clip: on some sites a sentence Range can end up spanning over (part
// of) the inline translation overlay injected right after it — not just when
// the end boundary itself sits inside the overlay, but also when the range
// simply overshoots past its own sentence and the overlay happens to sit
// in between. CSS Custom Highlights paint a Range's full extent regardless of
// what's "in between" the two boundary points, so any such overlay would get
// painted too. Scan the range's own common ancestor (the smallest container
// that could possibly hold anything the range intersects) for translation
// overlays the range actually overlaps, and clip back to end right before the
// earliest one — so the current-sentence text highlight/karaoke paint never
// bleeds onto the translation, no matter the exact cause. The focus-mode
// spotlight box is unaffected — it's meant to cover the translation too, it
// just shouldn't tint its text like a selection.
function clipBeforeTranslation(range: Range): Range {
  const root = range.commonAncestorContainer
  const scope = root.nodeType === Node.ELEMENT_NODE ? root as Element : root.parentElement
  if (!scope) return range

  let earliest: Element | null = null
  for (const el of scope.querySelectorAll('[data-cxt-translation]')) {
    try {
      if (!range.intersectsNode(el)) continue
    } catch {
      continue
    }
    if (!earliest || (el.compareDocumentPosition(earliest) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      earliest = el
    }
  }
  if (!earliest) return range

  try {
    const clipped = range.cloneRange()
    clipped.setEndBefore(earliest)
    return clipped
  } catch {
    return range
  }
}

export function highlightSentenceRange(range: Range, contentEl?: HTMLElement | null): void {
  if (!range.toString()) {
    // buildSentencePlan couldn't resolve this sentence to a real DOM position
    // (falls back to an empty `new Range()`) — clear the previous sentence's
    // highlight/marker/focus box instead of silently leaving them in place.
    // Read-aloud itself doesn't depend on this (chrome.tts speaks the plain
    // sentence string regardless), so without this the visuals would look
    // "stuck" on the last successfully-highlighted sentence while playback
    // audibly continues past it.
    clearSentenceHighlight()
    return
  }
  const ownRange = clipBeforeTranslation(range)
  CSS.highlights.set('cxt-speaking', new Highlight(ownRange))

  // Keep the left "reading" marker + focus spotlight in sync with the sentence.
  // `contentEl` (the exact paragraph/content block this sentence came from, from
  // buildSentencePlan) lets the overlay find its translation deterministically
  // instead of guessing via DOM-climbing from the sentence's own range. Uses the
  // clipped range (never overshoots past this sentence's own text) so the left
  // marker bar can't stretch down into the translation, and the translation
  // lookup starts from this sentence's true end instead of possibly landing
  // past its own translation and grabbing the next sentence's instead — the
  // focus box still unions in the translation rect separately, on purpose.
  updateReadingOverlays(ownRange, contentEl ?? null)

  const rect = range.getBoundingClientRect()
  if (rect.height <= 0) return

  const startEl = contentEl
    ?? (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer as Element | null)
  const container = findScrollContainer(startEl)
  const behavior = prefersReducedMotion() ? 'auto' : 'smooth'

  if (container) {
    const containerRect = container.getBoundingClientRect()
    // Clip the container's own box to the window, in case it's partially
    // offscreen itself — the "comfortable band" should only ever apply to the
    // part of it actually visible.
    const viewTop = Math.max(containerRect.top, 0)
    const viewBottom = Math.min(containerRect.bottom, window.innerHeight)
    const visibleHeight = viewBottom - viewTop
    const tallerThanView = rect.height > visibleHeight - SCROLL_MARGIN_TOP - SCROLL_MARGIN_BOTTOM
    const aboveBand = rect.top < viewTop + SCROLL_MARGIN_TOP
    const belowBand = rect.bottom > viewBottom - SCROLL_MARGIN_BOTTOM

    if (!aboveBand && !belowBand && !tallerThanView) return

    container.scrollTo({
      left: container.scrollLeft,
      top: container.scrollTop + (rect.top - containerRect.top) - visibleHeight / 3,
      behavior,
    })
    return
  }

  const vh = window.innerHeight
  const tallerThanViewport = rect.height > vh - SCROLL_MARGIN_TOP - SCROLL_MARGIN_BOTTOM
  const aboveBand = rect.top < SCROLL_MARGIN_TOP
  const belowBand = rect.bottom > vh - SCROLL_MARGIN_BOTTOM

  // Already comfortably in view — don't scroll (avoids constant jitter).
  if (!aboveBand && !belowBand && !tallerThanViewport) return

  window.scrollTo({
    // Only vertical: keep the existing scrollX so we never pan horizontally.
    left: window.scrollX,
    top: window.scrollY + rect.top - vh / 3,
    behavior,
  })
}

export function clearSentenceHighlight(): void {
  CSS.highlights.delete('cxt-speaking')
  clearWordHighlight()
  hideReadingOverlays()
  window.getSelection()?.removeAllRanges()
}

// ── Read Aloud word (karaoke) highlighting ────────────────────────────────────

// Text-node index for the *currently speaking* sentence range. Built once when a
// sentence starts (via prepareWordIndex) so per-word events resolve cheaply.
type WordIndexEntry = { node: Text; start: number; end: number }
let wordIndexEntries: WordIndexEntry[] = []
// Offset that aligns a charIndex reported against the TTS sentence text with the
// raw concatenated text of the sentence range. TTS text may be trimmed/normalised
// relative to range.toString(), so leading whitespace can differ.
let wordIndexTextOffset = 0
// Raw concatenated text of the sentence range (whitespace preserved) — used to
// find a word's end when the TTS event omits `length`.
let wordIndexRawText = ''

/**
 * Build a character index over the text nodes inside `range`, so a character
 * offset (relative to the sentence's TTS text) can be resolved to a DOM
 * (node, offset) pair. `ttsText` is the exact string handed to chrome.tts for
 * this sentence; we align it against the raw range text to absorb any
 * leading-whitespace / trimming differences.
 *
 * Safe to call with an empty / detached range — it simply produces an empty
 * index and word highlighting is skipped for that sentence.
 */
export function prepareWordIndex(rawRange: Range, ttsText: string): void {
  wordIndexEntries = []
  wordIndexTextOffset = 0
  wordIndexRawText = ''

  if (!rawRange || !rawRange.startContainer || rawRange.collapsed) return
  const range = clipBeforeTranslation(rawRange)

  const entries: WordIndexEntry[] = []
  const parts: string[] = []
  let offset = 0

  const root = range.commonAncestorContainer
  if (root.nodeType === Node.TEXT_NODE) {
    // Single-text-node range.
    const t = root as Text
    const startOff = range.startContainer === t ? range.startOffset : 0
    const endOff = range.endContainer === t ? range.endOffset : (t.nodeValue?.length ?? 0)
    const val = (t.nodeValue ?? '').slice(startOff, endOff)
    entries.push({ node: t, start: 0, end: val.length })
    // NOTE: single-node offsets are relative to startOff; record it so we can
    // translate a range-relative offset back to a node offset below.
    ;(entries[0] as WordIndexEntry & { base?: number }).base = startOff
    parts.push(val)
    offset = val.length
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Only nodes that actually intersect the range.
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    let n: Node | null
    while ((n = walker.nextNode())) {
      const t = n as Text
      const full = t.nodeValue ?? ''
      const startOff = t === range.startContainer ? range.startOffset : 0
      const endOff = t === range.endContainer ? range.endOffset : full.length
      const val = full.slice(startOff, endOff)
      if (!val) continue
      const entry: WordIndexEntry & { base?: number } = { node: t, start: offset, end: offset + val.length, base: startOff }
      entries.push(entry)
      parts.push(val)
      offset += val.length
    }
  }

  wordIndexEntries = entries
  wordIndexRawText = parts.join('')

  // Align the TTS text to the raw range text. TTS `.text` is often the raw text
  // trimmed and unicode-normalised. We only need the *leading* alignment: find
  // where the normalised, trimmed TTS text begins inside the normalised raw text.
  const trimmedTts = ttsText.trimStart()
  const normRaw = normText(wordIndexRawText)
  const normTts = normText(trimmedTts)
  if (normTts) {
    const head = normTts.slice(0, Math.min(24, normTts.length))
    const at = normRaw.indexOf(head)
    wordIndexTextOffset = at >= 0 ? at : 0
  }
}

// Resolve a character offset (relative to the raw range text) to (node, offset).
function resolveWordOffset(rawOffset: number): { node: Text; nodeOffset: number } | null {
  if (!wordIndexEntries.length) return null
  const clamped = Math.max(0, Math.min(rawOffset, wordIndexRawText.length))
  for (const e of wordIndexEntries) {
    if (clamped >= e.start && clamped <= e.end) {
      const base = (e as WordIndexEntry & { base?: number }).base ?? 0
      return { node: e.node, nodeOffset: base + (clamped - e.start) }
    }
  }
  return null
}

/**
 * Given a word position reported by chrome.tts (charIndex relative to the TTS
 * sentence text, optional length), highlight that single word as `cxt-word`
 * on top of the sentence's `cxt-speaking` highlight.
 *
 * Never throws and never falls back to highlighting the whole sentence: if the
 * offset can't be resolved to a sub-range, the word highlight is simply skipped.
 */
export function highlightSpokenWord(charIndex: number, length?: number): void {
  if (!wordIndexEntries.length) return

  // Map TTS-text offset → raw-range offset.
  const rawStart = charIndex + wordIndexTextOffset
  if (rawStart < 0 || rawStart >= wordIndexRawText.length) return

  // Determine the word's end: prefer the reported length, else extend to the
  // next whitespace in the raw range text (word boundary).
  let rawEnd: number
  if (typeof length === 'number' && length > 0) {
    rawEnd = rawStart + length
  } else {
    const ws = wordIndexRawText.slice(rawStart).search(/\s/)
    rawEnd = ws === -1 ? wordIndexRawText.length : rawStart + ws
  }
  rawEnd = Math.min(rawEnd, wordIndexRawText.length)
  if (rawEnd <= rawStart) return

  const startPos = resolveWordOffset(rawStart)
  const endPos = resolveWordOffset(rawEnd)
  if (!startPos || !endPos) return

  try {
    const wordRange = new Range()
    wordRange.setStart(startPos.node, startPos.nodeOffset)
    wordRange.setEnd(endPos.node, endPos.nodeOffset)
    if (wordRange.collapsed) return
    CSS.highlights.set('cxt-word', new Highlight(wordRange))
  } catch {
    // Bad offsets (e.g. node mutated) — skip this word rather than mis-highlight.
  }
}

export function clearWordHighlight(): void {
  CSS.highlights.delete('cxt-word')
}
