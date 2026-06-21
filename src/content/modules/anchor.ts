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
  window.getSelection()?.removeAllRanges()
}
