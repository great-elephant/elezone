import { Bookmark } from '../../shared/types'

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
export function getSelectionContext(): {
  prefix: string
  suffix: string
  occurrenceIndex: number
} | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null

  const text = sel.toString()
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

  // prefix/suffix: kept for potential future fallback, extracted from innerText
  const body = document.body.innerText
  const pos = body.indexOf(text)
  const prefix = pos >= 0 ? body.slice(Math.max(0, pos - 40), pos) : ''
  const suffix = pos >= 0 ? body.slice(pos + text.length, pos + text.length + 40) : ''

  return { prefix, suffix, occurrenceIndex }
}

// ── Bookmark highlights ───────────────────────────────────────────────────────

/**
 * Apply a CSS Custom Highlight for a bookmark.
 * Does NOT modify the DOM — works with any range including cross-element ones.
 */
export function applyHighlight(bookmark: Bookmark): boolean {
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

export function scrollToHighlight(bookmarkId: string) {
  const range = bookmarkRanges.get(bookmarkId)
  if (!range) return

  range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  const flash = new Highlight(range)
  CSS.highlights.set('cxt-flash', flash)
  setTimeout(() => CSS.highlights.delete('cxt-flash'), 1500)
}

// ── Read Aloud sentence highlighting ─────────────────────────────────────────

/**
 * Highlight the next occurrence of `text` during Read Aloud playback.
 * Uses window.find() which advances from the current selection position,
 * so sentences naturally progress forward through the document.
 * Scrolls to the sentence automatically.
 */
export function highlightSentence(text: string): void {
  if (!text) return
  const found = wFind(text, true, false, false, false, false, false)
  if (!found) return

  const range = window.getSelection()?.getRangeAt(0)?.cloneRange()
  // Collapse to end so next call advances forward (not restart from top)
  window.getSelection()?.collapseToEnd()

  if (range) {
    const hl = new Highlight(range)
    CSS.highlights.set('cxt-speaking', hl)
    range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

export function clearSentenceHighlight(): void {
  CSS.highlights.delete('cxt-speaking')
  window.getSelection()?.removeAllRanges()
}
