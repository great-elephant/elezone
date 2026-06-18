import { getSelectionContext, applyHighlight, scrollToHighlight, removeHighlight, getBookmarkAtPoint } from './modules/anchor'
import { start, startFrom, setOnStateChange, getState, syncRemoteState } from './modules/readAloud'
import { showWidget, hideWidget, updateWidgetState, showWarning } from './modules/floatingWidget'
import { enable as enableTranslation, disable as disableTranslation, isTranslatorAvailable } from './modules/translation'
import { SavedItem, Settings, BOOKMARK_COLORS, BookmarkColor } from '../shared/types'
import { initDictionary } from './modules/dictionary'

injectHighlightStyles()

function injectHighlightStyles() {
  if (document.getElementById('cxt-styles')) return
  const style = document.createElement('style')
  style.id = 'cxt-styles'
  style.textContent = `
    ::highlight(cxt-red)    { background-color: rgba(255, 107, 107, 0.45); color: inherit; }
    ::highlight(cxt-yellow) { background-color: rgba(255, 217,  61, 0.55); color: inherit; }
    ::highlight(cxt-cyan)   { background-color: rgba(107, 207, 255, 0.45); color: inherit; }
    ::highlight(cxt-green)  { background-color: rgba(107, 255, 158, 0.45); color: inherit; }
    ::highlight(cxt-blue)   { background-color: rgba(107, 158, 255, 0.45); color: inherit; }
    ::highlight(cxt-orange) { background-color: rgba(255, 179, 107, 0.45); color: inherit; }
    ::highlight(cxt-purple) { background-color: rgba(192, 107, 255, 0.45); color: inherit; }
    ::highlight(cxt-pink)   { background-color: rgba(255, 107, 192, 0.45); color: inherit; }
    ::highlight(cxt-teal)   { background-color: rgba(107, 255, 217, 0.45); color: inherit; }
    ::highlight(cxt-gray)   { background-color: rgba(192, 192, 192, 0.45); color: inherit; }
    ::highlight(cxt-flash)    { background-color: rgba(255, 217, 61, 0.7); color: inherit; }
    ::highlight(cxt-speaking) { background-color: rgba(79, 110, 247, 0.25); color: inherit; }
  `
  document.head.appendChild(style)
}

async function reanchor(url: string) {
  const items: SavedItem[] = await chrome.runtime.sendMessage({ type: 'GET_ITEMS' })
  const pageItems = items.filter(b => b.url === url && b.occurrenceIndex !== undefined)
  for (const item of pageItems) {
    const found = applyHighlight(item)
    if (!found && !item.orphaned) {
      chrome.runtime.sendMessage({ type: 'MARK_ORPHANED', payload: item.id }).catch(() => {})
    }
  }
}

function checkScrollTarget() {
  const match = window.location.hash.match(/cxt-bookmark=([a-z0-9-]+)/)
  if (!match) return
  const id = match[1]
  setTimeout(() => scrollToHighlight(id), 500)
  history.replaceState(null, '', window.location.pathname + window.location.search)
}

// Broadcast Read Aloud state to the extension popup so it can update its UI
setOnStateChange(newState => {
  updateWidgetState(newState)
  if (newState === 'idle') hideWidget()
})

// ── Bookmark delete tooltip ───────────────────────────────────────────────────

let deleteTooltip: HTMLDivElement | null = null
let tooltipBookmarkId: string | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

function ensureTooltip(): HTMLDivElement {
  if (deleteTooltip) return deleteTooltip
  deleteTooltip = document.createElement('div')
  deleteTooltip.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'background:#1a1a2e',
    'border:1px solid #3a3a6a',
    'border-radius:8px',
    'padding:8px',
    'box-shadow:0 4px 12px rgba(0,0,0,.5)',
    'pointer-events:auto',
    'font-family:system-ui,sans-serif',
  ].join(';')

  // Colors row
  const colorsRow = document.createElement('div')
  colorsRow.style.display = 'flex'
  colorsRow.style.gap = '4px'

  for (const [color, hex] of Object.entries(BOOKMARK_COLORS)) {
    const dot = document.createElement('div')
    dot.style.cssText = `
      width:16px; height:16px; border-radius:50%; background:${hex}; cursor:pointer;
      border: 1px solid transparent; transition: transform 0.1s;
    `
    dot.title = color
    dot.onmouseenter = () => { dot.style.transform = 'scale(1.2)' }
    dot.onmouseleave = () => { dot.style.transform = 'scale(1)' }
    dot.onmousedown = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!tooltipBookmarkId) return
      
      const items: SavedItem[] = await chrome.runtime.sendMessage({ type: 'GET_ITEMS' })
      const item = items.find(i => i.id === tooltipBookmarkId)
      if (!item) return
      
      removeHighlight(item.id)
      item.color = color as BookmarkColor
      applyHighlight(item)
      
      chrome.runtime.sendMessage({ type: 'UPDATE_ITEM', payload: item }).catch(() => {})
      hideNow()
    }
    colorsRow.appendChild(dot)
  }

  // Delete button
  const deleteBtn = document.createElement('div')
  deleteBtn.style.cssText = [
    'font-size:12px',
    'color:#ff8888',
    'cursor:pointer',
    'user-select:none',
    'text-align:center',
    'padding-top:4px',
    'border-top:1px solid #3a3a6a'
  ].join(';')
  deleteBtn.textContent = '✕ Delete Highlight'
  deleteBtn.onmousedown = e => {
    e.preventDefault()
    e.stopPropagation()
    if (!tooltipBookmarkId) return
    removeHighlight(tooltipBookmarkId)
    chrome.runtime.sendMessage({ type: 'DELETE_ITEM', payload: tooltipBookmarkId }).catch(() => {})
    hideNow()
  }

  deleteTooltip.appendChild(colorsRow)
  deleteTooltip.appendChild(deleteBtn)

  deleteTooltip.addEventListener('mouseenter', () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  })
  deleteTooltip.addEventListener('mouseleave', scheduleHide)

  document.body.appendChild(deleteTooltip)
  return deleteTooltip
}

function showDeleteTooltip(id: string, range: Range) {
  const t = ensureTooltip()
  tooltipBookmarkId = id
  const r = range.getBoundingClientRect()
  t.style.display = 'flex'
  const tooltipHeight = t.offsetHeight || 60
  const top = r.top < tooltipHeight + 8 ? r.bottom + 6 : r.top - tooltipHeight - 6
  const left = Math.max(0, Math.min(r.left, window.innerWidth - t.offsetWidth))
  t.style.top = `${top}px`
  t.style.left = `${left}px`
}

function hideNow() {
  if (deleteTooltip) deleteTooltip.style.display = 'none'
  tooltipBookmarkId = null
}

function scheduleHide() {
  if (hideTimer) return
  // 300ms grace period — long enough to move from highlighted text to tooltip
  hideTimer = setTimeout(() => { hideNow(); hideTimer = null }, 300)
}

// bufferY=10: cursor within 10px above/below the range still counts as "on it",
// covering the 6px gap between highlighted text and the tooltip.
document.addEventListener('mousemove', (e: MouseEvent) => {
  if (deleteTooltip && deleteTooltip.contains(e.target as Node)) {
    return
  }

  const hit = getBookmarkAtPoint(e.clientX, e.clientY, 10)
  if (hit) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    showDeleteTooltip(hit.id, hit.range)
  } else {
    scheduleHide()
  }
})

// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  initDictionary()
  await reanchor(window.location.href)
  checkScrollTarget()
  // Translation is NOT auto-started on page load.
  // It starts only when the user presses "Start Reading" with the toggle ON.
}

init()

chrome.runtime.onMessage.addListener(
  (msg: { type: string; payload?: unknown }, _sender, sendResponse) => {
    handleMessage(msg).then(sendResponse).catch(() => sendResponse(null))
    return true
  }
)

let lastKnownSelection: Range | null = null
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
    lastKnownSelection = sel.getRangeAt(0).cloneRange()
  }
})

async function handleMessage(msg: { type: string; payload?: unknown }): Promise<unknown> {
  switch (msg.type) {
    case 'GET_SELECTION_CONTEXT': {
      const { searchString } = (msg.payload || {}) as { searchString?: string }
      return getSelectionContext(searchString)
    }

    case 'HIGHLIGHT_BOOKMARK':
      applyHighlight(msg.payload as SavedItem)
      return { ok: true }

    case 'REANCHOR':
      await reanchor((msg.payload as { url: string }).url)
      return { ok: true }

    case 'START_READ_ALOUD': {
      if (getState() !== 'idle') return { ok: true }
      const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
      if (!settings?.readAloud) return { ok: true }
      showWidget()
      // Start translation alongside reading if the toggle is ON
      if (settings.translation?.enabled) {
        await enableTranslation(settings.translation.defaultTargetLanguage, settings.translation.mode)
      }
      await start(settings.readAloud, msg => showWarning(msg))
      return { ok: true }
    }

    case 'START_READ_ALOUD_FROM': {
      const settings2: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
      if (!settings2?.readAloud) return { ok: true }
      showWidget()
      if (settings2.translation?.enabled) {
        await enableTranslation(settings2.translation.defaultTargetLanguage, settings2.translation.mode)
      }
      const { selectedText } = msg.payload as { selectedText: string }
      await startFrom(settings2.readAloud, selectedText, lastKnownSelection, m => showWarning(m))
      return { ok: true }
    }

    case 'STOP_READ_ALOUD':
      syncRemoteState('idle')
      return { ok: true }

    case 'READ_ALOUD_UPDATE': {
      const { state, index } = msg.payload as { state: 'idle' | 'playing' | 'paused'; index?: number }
      syncRemoteState(state, index)
      return { ok: true }
    }

    case 'TOGGLE_TRANSLATION': {
      const { enabled } = msg.payload as { enabled: boolean }
      // Turning OFF stops translation immediately; turning ON just saves the
      // preference — translation will start on the next "Start Reading" press.
      if (!enabled) disableTranslation()
      return { ok: true }
    }

    case 'CHECK_TRANSLATOR_AVAILABLE':
      return isTranslatorAvailable()

    case 'CHECK_READABLE': {
      const { extractSentences } = await import('./modules/readAloud')
      return { readable: extractSentences().length > 0 }
    }

    case 'SHOW_DICTIONARY_POPOVER': {
      const { showPopoverFromSelection } = await import('./modules/dictionary')
      const { selectedText, color } = msg.payload as { selectedText: string; color?: any }
      showPopoverFromSelection(selectedText, color)
      return { ok: true }
    }

    default:
      return null
  }
}
