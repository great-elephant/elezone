import { SavedItem } from '../../shared/types'

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
): Array<{ text: string; range: Range }> {
  let segmenter: Intl.Segmenter
  try {
    segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' })
  } catch {
    segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  }

  const plan: Array<{ text: string; range: Range }> = []

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

      if (matchStart === -1) {
        plan.push({ text: sentence, range: new Range() })
        continue
      }

      const startPos = resolveOffset(entries, matchStart)
      const endPos = resolveOffset(entries, matchEnd, true)

      if (!startPos || !endPos) {
        plan.push({ text: sentence, range: new Range() })
        continue
      }

      const range = new Range()
      range.setStart(startPos.node, startPos.nodeOffset)
      range.setEnd(endPos.node, endPos.nodeOffset)
      plan.push({ text: sentence, range })
      searchFrom = matchEnd
    }
  }

  return plan
}

export function highlightSentenceRange(range: Range): void {
  if (!range.toString()) return
  CSS.highlights.set('cxt-speaking', new Highlight(range))

  const rect = range.getBoundingClientRect()
  if (rect.height > 0) {
    window.scrollTo({
      top: window.scrollY + rect.top - window.innerHeight / 3,
      behavior: 'smooth',
    })
  }
}

export function clearSentenceHighlight(): void {
  CSS.highlights.delete('cxt-speaking')
  clearWordHighlight()
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
export function prepareWordIndex(range: Range, ttsText: string): void {
  wordIndexEntries = []
  wordIndexTextOffset = 0
  wordIndexRawText = ''

  if (!range || !range.startContainer || range.collapsed) return

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

/**
 * Resolve the word under a viewport point to a DOM Range, using caret
 * positioning + Intl word segmentation. Returns null when the point isn't over
 * readable text. Used by click-to-define during read-aloud.
 */
export function getWordRangeAtPoint(x: number, y: number): Range | null {
  const caret = caretRangeFromPoint(x, y)
  if (!caret) return null
  const node = caret.node
  const text = node.nodeValue ?? ''
  if (!text.trim()) return null

  const [start, end] = wordBoundsAt(text, caret.offset)
  if (end <= start) return null
  if (!text.slice(start, end).trim()) return null

  try {
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return range
  } catch {
    return null
  }
}

// Cross-browser caret-from-point → (text node, offset).
function caretRangeFromPoint(x: number, y: number): { node: Text; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    if (pos && pos.offsetNode.nodeType === Node.TEXT_NODE) {
      return { node: pos.offsetNode as Text, offset: pos.offset }
    }
    return null
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(x, y)
    if (r && r.startContainer.nodeType === Node.TEXT_NODE) {
      return { node: r.startContainer as Text, offset: r.startOffset }
    }
  }
  return null
}

// Expand [offset] to word boundaries within `text` using Intl.Segmenter when
// available, falling back to a whitespace/punctuation split.
function wordBoundsAt(text: string, offset: number): [number, number] {
  const idx = Math.max(0, Math.min(offset, text.length))
  try {
    const seg = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: 'word' })
    for (const s of seg.segment(text) as Iterable<{ index: number; segment: string; isWordLike?: boolean }>) {
      const segEnd = s.index + s.segment.length
      if (idx >= s.index && idx < segEnd && s.isWordLike) {
        return [s.index, segEnd]
      }
    }
    // Point landed on whitespace/punctuation — try the word just before it.
    for (const s of seg.segment(text) as Iterable<{ index: number; segment: string; isWordLike?: boolean }>) {
      const segEnd = s.index + s.segment.length
      if (segEnd === idx && s.isWordLike) return [s.index, segEnd]
    }
    return [idx, idx]
  } catch {
    // Fallback: expand over non-space characters around idx.
    let start = idx
    let end = idx
    while (start > 0 && !/\s/.test(text[start - 1])) start--
    while (end < text.length && !/\s/.test(text[end])) end++
    return [start, end]
  }
}
