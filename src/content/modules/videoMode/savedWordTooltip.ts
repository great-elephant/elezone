// Hover tooltip for a saved word inside the subtitle strip or the dialogue
// sidebar — the Video Mode counterpart of the highlight-hover tooltip shown
// on ordinary pages (src/content/index.ts). Same content and actions (deck
// colour, translation, phonetics, delete), rebuilt here because Video Mode's
// saved words live inside two different shadow roots and are matched by word
// text rather than by a DOM Range, so the page version's Range-based lookup
// doesn't apply.
//
// Attached to `document.body`, not either shadow root — position is computed
// from the hovered element's `getBoundingClientRect()`, which works across a
// shadow boundary same as on the page.

import type { SavedItem, BookmarkColor } from '../../../shared/types'
import { BOOKMARK_COLORS } from '../../../shared/types'

let tooltip: HTMLDivElement | null = null
let contentEl: HTMLDivElement | null = null
let colorDots: Partial<Record<BookmarkColor, HTMLDivElement>> = {}
let hideTimer: ReturnType<typeof setTimeout> | null = null
let _word: string | null = null
let _onChangeColor: ((word: string, color: BookmarkColor) => void) | null = null
let _onDelete: ((word: string) => void) | null = null

function renderContent(item: SavedItem): void {
  if (!contentEl) return
  contentEl.innerHTML = ''

  const origContainer = document.createElement('div')
  origContainer.style.cssText = 'display:flex;flex-direction:column;gap:2px;'

  const textSpan = document.createElement('span')
  textSpan.textContent = item.text
  textSpan.style.cssText = 'color:#fff;font-weight:bold;font-size:15px;word-break:break-word;'
  origContainer.appendChild(textSpan)

  if (item.phonetics) {
    const pSpan = document.createElement('div')
    pSpan.textContent = item.phonetics
    pSpan.style.cssText = 'color:#8888aa;font-size:13px;'
    origContainer.appendChild(pSpan)
  }
  contentEl.appendChild(origContainer)

  if (item.translation) {
    const t = document.createElement('div')
    t.textContent = item.translation
    t.style.cssText = 'color:#6bcfff;border-top:1px solid #3a3a6a;margin-top:4px;padding-top:4px;'
    contentEl.appendChild(t)
  }
}

function ensureTooltip(): HTMLDivElement {
  if (tooltip) return tooltip

  tooltip = document.createElement('div')
  tooltip.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'display:flex', 'flex-direction:column', 'gap:8px',
    'background:#1a1a2e', 'border:1px solid #3a3a6a', 'border-radius:8px', 'padding:8px',
    'box-shadow:0 4px 12px rgba(0,0,0,.5)', 'pointer-events:auto',
    'font-family:system-ui,sans-serif', 'max-width:320px',
  ].join(';')

  const colorsRow = document.createElement('div')
  colorsRow.style.cssText = 'display:flex;gap:4px;'
  for (const [color, hex] of Object.entries(BOOKMARK_COLORS)) {
    const dot = document.createElement('div')
    dot.style.cssText = `width:16px;height:16px;border-radius:50%;background:${hex};cursor:pointer;border:1px solid transparent;transition:transform 0.1s;`
    dot.title = color
    colorDots[color as BookmarkColor] = dot
    dot.addEventListener('mouseenter', () => { dot.style.transform = 'scale(1.2)' })
    dot.addEventListener('mouseleave', () => { dot.style.transform = 'scale(1)' })
    dot.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (_word) _onChangeColor?.(_word, color as BookmarkColor)
      hideNow()
    })
    colorsRow.appendChild(dot)
  }

  const deleteBtn = document.createElement('div')
  deleteBtn.textContent = '✕ Remove from library'
  deleteBtn.style.cssText = 'font-size:12px;color:#ff8888;cursor:pointer;user-select:none;text-align:center;padding-top:4px;border-top:1px solid #3a3a6a;'
  deleteBtn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (_word) _onDelete?.(_word)
    hideNow()
  })

  contentEl = document.createElement('div')
  contentEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:14px;padding:4px 0;'

  tooltip.append(colorsRow, contentEl, deleteBtn)

  // Moving from the word onto the tooltip itself (to reach the colour dots
  // or the delete button) must not let the leave-triggered hide fire first.
  tooltip.addEventListener('mouseenter', cancelHide)
  tooltip.addEventListener('mouseleave', scheduleHide)

  document.body.appendChild(tooltip)
  return tooltip
}

function position(anchor: HTMLElement): void {
  if (!tooltip) return
  const r = anchor.getBoundingClientRect()
  if (r.top > 150) {
    tooltip.style.bottom = `${window.innerHeight - r.top + 8}px`
    tooltip.style.top = 'auto'
  } else {
    tooltip.style.top = `${r.bottom + 8}px`
    tooltip.style.bottom = 'auto'
  }
  const left = Math.max(0, Math.min(r.left, window.innerWidth - (tooltip.offsetWidth || 150)))
  tooltip.style.left = `${left}px`
}

function hideNow(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  if (tooltip) tooltip.style.display = 'none'
  _word = null
}

function cancelHide(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

// Grace period long enough to move the pointer from the word up to the
// tooltip without it disappearing under the cursor first.
function scheduleHide(): void {
  if (hideTimer) return
  hideTimer = setTimeout(hideNow, 300)
}

export function initSavedWordTooltip(opts: {
  onChangeColor: (word: string, color: BookmarkColor) => void
  onDelete: (word: string) => void
}): void {
  _onChangeColor = opts.onChangeColor
  _onDelete = opts.onDelete
}

export function showSavedWordTooltip(word: string, item: SavedItem, anchor: HTMLElement): void {
  cancelHide()
  const t = ensureTooltip()
  _word = word
  renderContent(item)
  t.style.display = 'flex'
  position(anchor)
}

export function scheduleHideSavedWordTooltip(): void {
  scheduleHide()
}

export function destroySavedWordTooltip(): void {
  hideNow()
  tooltip?.remove()
  tooltip = null
  contentEl = null
  colorDots = {}
  _onChangeColor = null
  _onDelete = null
}
