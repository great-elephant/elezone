import { getSelectionContext, applyHighlight, scrollToHighlight, removeHighlight, getBookmarkAtPoint } from './modules/anchor'
import { start, startFrom, setOnStateChange, getState, syncRemoteState } from './modules/readAloud'
import { showWidget, hideWidget, updateWidgetState, showWarning } from './modules/floatingWidget'
import { enable as enableTranslation, disable as disableTranslation, isTranslatorAvailable } from './modules/translation'
import { SavedItem, Settings, BOOKMARK_COLORS, BookmarkColor } from '../shared/types'
import { initDictionary } from './modules/dictionary'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { OcrManager } from './components/OcrManager'

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
let tooltipContentContainer: HTMLDivElement | null = null
let cachedDeckLabels: Partial<Record<BookmarkColor, string>> = {}
const tooltipDots: Partial<Record<BookmarkColor, HTMLDivElement>> = {}

// Keep deck labels in sync so tooltip titles stay current.
chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((s: Settings) => {
  cachedDeckLabels = s?.deckLabels || {}
}).catch(() => {})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['settings']) {
    cachedDeckLabels = (changes['settings'].newValue as Settings)?.deckLabels || {}
  }
})

async function updateTooltipContent(id: string) {
  if (!tooltipContentContainer) return
  tooltipContentContainer.innerHTML = ''
  tooltipContentContainer.style.display = 'none'
  const items: SavedItem[] = await chrome.runtime.sendMessage({ type: 'GET_ITEMS' })
  const item = items.find(i => i.id === id)
  if (!item || tooltipBookmarkId !== id) return
  
  if (item.text || item.translation || item.phonetics) {
    tooltipContentContainer.style.display = 'flex'
    if (item.text) {
      const origContainer = document.createElement('div')
      origContainer.style.display = 'flex'
      origContainer.style.flexDirection = 'column'
      origContainer.style.gap = '2px'
      origContainer.style.borderBottom = item.translation ? '1px solid #3a3a6a' : 'none'
      origContainer.style.paddingBottom = item.translation ? '4px' : '0'
      origContainer.style.marginBottom = item.translation ? '4px' : '0'

      const topRow = document.createElement('div')
      topRow.style.display = 'flex'
      topRow.style.alignItems = 'flex-start'
      topRow.style.gap = '8px'
      topRow.style.maxWidth = '300px'
      
      const textSpan = document.createElement('span')
      textSpan.textContent = item.text
      textSpan.style.color = '#ffffff'
      textSpan.style.fontWeight = 'bold'
      textSpan.style.fontSize = '15px'
      textSpan.style.wordBreak = 'break-word'
      topRow.appendChild(textSpan)

      const speakerBtn = document.createElement('button')
      speakerBtn.textContent = '🔊'
      speakerBtn.title = 'Read aloud'
      speakerBtn.style.cssText = 'background:none; border:none; cursor:pointer; font-size:14px; padding:0; margin-top:2px; opacity:0.7; flex-shrink:0;'
      speakerBtn.onmouseover = () => { speakerBtn.style.opacity = '1' }
      speakerBtn.onmouseout = () => { speakerBtn.style.opacity = '0.7' }
      speakerBtn.onmousedown = (e) => {
         e.preventDefault()
         e.stopPropagation()
         chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: item.text }).catch(() => {})
      }
      topRow.appendChild(speakerBtn)
      
      origContainer.appendChild(topRow)

      if (item.phonetics) {
        const pSpan = document.createElement('div')
        pSpan.textContent = item.phonetics
        pSpan.style.color = '#8888aa'
        pSpan.style.fontSize = '13px'
        origContainer.appendChild(pSpan)
      }
      
      tooltipContentContainer.appendChild(origContainer)
    }
    if (item.translation) {
      const t = document.createElement('div')
      t.textContent = item.translation
      t.style.color = '#6bcfff'
      tooltipContentContainer.appendChild(t)
    }
  }
}

function ensureTooltip(): HTMLDivElement {
  if (deleteTooltip) return deleteTooltip
  deleteTooltip = document.createElement('div')
  deleteTooltip.className = 'cxt-delete-tooltip'
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
    tooltipDots[color as BookmarkColor] = dot
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

  tooltipContentContainer = document.createElement('div')
  tooltipContentContainer.style.cssText = 'display:none;flex-direction:column;gap:4px;font-size:14px;padding:4px 0;'

  deleteTooltip.appendChild(colorsRow)
  deleteTooltip.appendChild(tooltipContentContainer)
  deleteTooltip.appendChild(deleteBtn)

  deleteTooltip.addEventListener('mouseenter', () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  })
  deleteTooltip.addEventListener('mouseleave', scheduleHide)

  document.body.appendChild(deleteTooltip)
  return deleteTooltip
}

function refreshTooltipDotTitles() {
  for (const [color, dot] of Object.entries(tooltipDots)) {
    const label = cachedDeckLabels[color as BookmarkColor]
    dot.title = label || color
  }
}

function showDeleteTooltip(id: string, range: Range) {
  const t = ensureTooltip()
  refreshTooltipDotTitles()
  if (tooltipBookmarkId !== id) {
    tooltipBookmarkId = id
    updateTooltipContent(id).catch(() => {})
  }
  const r = range.getBoundingClientRect()
  t.style.display = 'flex'
  if (r.top > 150) {
    t.style.bottom = `${window.innerHeight - r.top + 8}px`
    t.style.top = 'auto'
  } else {
    t.style.top = `${r.bottom + 8}px`
    t.style.bottom = 'auto'
  }
  const left = Math.max(0, Math.min(r.left, window.innerWidth - (t.offsetWidth || 150)))
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
  
  const ocrContainer = document.createElement('div')
  ocrContainer.id = 'cxt-ocr-root'
  document.body.appendChild(ocrContainer)
  const root = createRoot(ocrContainer)
  root.render(React.createElement(OcrManager))
  
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
        await enableTranslation(settings.translation.defaultTargetLanguage, settings.translation.mode, settings.translation.asideForceGoogle ?? true)
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
