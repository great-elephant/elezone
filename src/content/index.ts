import { getSelectionContext, applyHighlight, scrollToHighlight, removeHighlight, getBookmarkAtPoint, getWordRangeAtPoint } from './modules/anchor'
import { start, startFrom, startFromElement, setOnStateChange, setOnVoiceInfoChange, getVoiceInfo, getState, syncRemoteState, getProgress, handleWordEvent } from './modules/readAloud'
import { showWidget, hideWidget, updateWidgetState, updateWidgetProgress, updateWidgetVoice } from './modules/floatingWidget'
import { destroyReadingOverlays } from './modules/readAloudOverlay'
import { initReadAloudAffordances, setEnabled as setAffordancesEnabled, setAffordanceSpeed } from './modules/readAloudAffordances'
import { enable as enableTranslation, disable as disableTranslation, isTranslatorAvailable, getTranslatorStatus } from './modules/translation'
import { SavedItem, Settings, BOOKMARK_COLORS, BookmarkColor } from '../shared/types'
import { initDictionary } from './modules/dictionary'
import { initSelectionChip, maybeShowSelectionTip } from './modules/selectionChip'
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
    /* Current sentence: a stronger translucent band than before so it reads on
       both light and dark pages. The left "reading" accent bar is drawn
       separately (CSS Highlight API can't paint pseudo-elements). */
    ::highlight(cxt-speaking) {
      background-color: rgba(79, 110, 247, 0.38);
      color: inherit;
    }
    /* Karaoke: the single word currently being spoken, painted over cxt-speaking. */
    ::highlight(cxt-word) {
      background-color: rgba(79, 110, 247, 0.9);
      color: #ffffff;
      text-decoration: underline;
      text-decoration-color: rgba(255, 217, 61, 0.95);
      text-decoration-thickness: 2px;
    }

    /* Force text selection to work inside extension popups, overriding any site CSS */
    #cxt-ocr-root *, .cxt-dict-host *, .cxt-delete-tooltip * {
      user-select: text !important;
      -webkit-user-select: text !important;
      pointer-events: auto !important;
    }
  `
  document.head.appendChild(style)
}

async function reanchor(url: string) {
  const items: SavedItem[] = await chrome.runtime.sendMessage({ type: 'GET_ITEMS' })
  const pageItems = items.filter(b => b.url === url && b.occurrenceIndex !== undefined)
  for (const item of pageItems) {
    const found = applyHighlight(item)
    if (!found && !item.orphaned) {
      chrome.runtime.sendMessage({ type: 'MARK_ORPHANED', payload: item.id }).catch(() => { })
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
  if (newState === 'idle') {
    hideWidget()
    // Tear down the reading marker + focus spotlight hosts when reading stops.
    destroyReadingOverlays()
    // Reading finished/stopped — bring the idle "Listen" chip + ▶ handle back.
    setAffordancesEnabled(true)
  } else {
    // Reading is active — hide the idle affordances so they don't overlap the
    // mini-player or the click-to-define flow.
    setAffordancesEnabled(false)
    const { index, total } = getProgress()
    updateWidgetProgress(index, total)
    const { voice, lang } = getVoiceInfo()
    updateWidgetVoice(voice, lang)
  }
})

// Refresh the mini-player voice chip whenever the background reports a new
// resolved/auto-picked voice or language (D14/D16).
setOnVoiceInfoChange(() => {
  const { voice, lang } = getVoiceInfo()
  updateWidgetVoice(voice, lang)
})

// Shared "start reading from the top" path, mirroring the popup's Start Reading:
// pull settings, show the mini-player, kick off translation if enabled, then
// read from the article top. Reused by the popup message, the keyboard command,
// and the "🎧 Listen" chip.
async function startReadingFromTop() {
  if (getState() !== 'idle') return
  const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
  if (!settings?.readAloud) return
  showWidget()
  if (settings.translation?.enabled) {
    await enableTranslation(settings.translation.defaultTargetLanguage, settings.translation.mode, settings.translation.asideForceGoogle ?? true)
  }
  await start(settings.readAloud)
}

// Same as above but starts at a specific content paragraph (the ▶ handle).
async function startReadingFromElement(el: HTMLElement) {
  if (getState() !== 'idle') return
  const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
  if (!settings?.readAloud) return
  showWidget()
  if (settings.translation?.enabled) {
    await enableTranslation(settings.translation.defaultTargetLanguage, settings.translation.mode, settings.translation.asideForceGoogle ?? true)
  }
  await startFromElement(settings.readAloud, el)
}

// Keep the chip's "~N min" estimate in sync with the configured speed.
chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((s: Settings) => {
  if (s?.readAloud?.speed) setAffordanceSpeed(s.readAloud.speed)
}).catch(() => { })
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['settings']) {
    const speed = (changes['settings'].newValue as Settings)?.readAloud?.speed
    if (speed) setAffordanceSpeed(speed)
  }
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
}).catch(() => { })

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
        chrome.runtime.sendMessage({ type: 'SPEAK_TEXT', payload: { text: item.text, lang: item.sourceLang } }).catch(() => { })
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

      chrome.runtime.sendMessage({ type: 'UPDATE_ITEM', payload: item }).catch(() => { })
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
    chrome.runtime.sendMessage({ type: 'DELETE_ITEM', payload: tooltipBookmarkId }).catch(() => { })
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
    updateTooltipContent(id).catch(() => { })
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

// ── Click-a-word-to-define while reading ──────────────────────────────────────

// While read-aloud is active, a plain click on a page word opens the dictionary
// popover for it — without stopping playback. Skips interactive elements, the
// extension's own UI, and cases where the user is actually selecting text.
function isInteractiveOrOwnUi(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  // Extension UI hosts (mini-player, dictionary, tooltip, OCR, toast). Events
  // from shadow content are retargeted to the host, so checking the target
  // element's own class/ancestry is sufficient.
  if (target.closest('.cxt-player-host, .cxt-dict-host, .cxt-delete-tooltip, .cxt-toast-host, #cxt-ocr-root')) {
    return true
  }
  // Don't hijack real interactive controls.
  if (target.closest('a, button, [role="button"], input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
    return true
  }
  return false
}

document.addEventListener('click', (e: MouseEvent) => {
  if (getState() === 'idle') return
  if (e.button !== 0 || e.defaultPrevented) return
  if (isInteractiveOrOwnUi(e.target)) return

  // If the user made a real (multi-char) selection, let the normal save flow
  // handle it — don't override with a single-word lookup.
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return

  const range = getWordRangeAtPoint(e.clientX, e.clientY)
  if (!range) return

  // Open the dictionary for this word. Playback is untouched — we never send a
  // read-aloud control message here.
  import('./modules/dictionary')
    .then(({ showPopoverForRange }) => showPopoverForRange(range))
    .catch(() => { })
}, { capture: false })

// ─────────────────────────────────────────────────────────────────────────────

function protectFromSiteEvents(container: HTMLElement) {
  const stopProp = (e: Event) => e.stopPropagation();
  ['contextmenu', 'selectstart', 'dragstart', 'copy', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup'].forEach(evt => {
    container.addEventListener(evt, stopProp);
  });
}

async function init() {
  initDictionary()
  initSelectionChip()
  // Idle discoverability: "🎧 Listen" chip near the title + per-paragraph ▶.
  // Only active while read-aloud is idle (toggled via the state-change handler).
  initReadAloudAffordances(
    () => { void startReadingFromTop() },
    (el) => { void startReadingFromElement(el) },
  )
  void maybeShowSelectionTip()
  await reanchor(window.location.href)
  checkScrollTarget()

  const ocrContainer = document.createElement('div')
  ocrContainer.id = 'cxt-ocr-root'
  document.body.appendChild(ocrContainer)
  const root = createRoot(ocrContainer)
  root.render(React.createElement(OcrManager))
  protectFromSiteEvents(ocrContainer)

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
      await startReadingFromTop()
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
      await startFrom(settings2.readAloud, selectedText, lastKnownSelection)
      return { ok: true }
    }

    case 'STOP_READ_ALOUD':
      syncRemoteState('idle')
      return { ok: true }

    case 'READ_ALOUD_UPDATE': {
      const { state, index, total, speed, voice, lang } = msg.payload as { state: 'idle' | 'playing' | 'paused'; index?: number; total?: number; speed?: number; voice?: string; lang?: string }
      syncRemoteState(state, index, speed, voice, lang)
      if (state !== 'idle') {
        const progress = getProgress()
        // Prefer content-side counts; fall back to the background's authoritative total.
        updateWidgetProgress(progress.index, progress.total || total || 0)
      }
      return { ok: true }
    }

    case 'READ_ALOUD_WORD': {
      const { index, charIndex, length } = msg.payload as { index: number; charIndex: number; length?: number }
      handleWordEvent(index, charIndex, length)
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

    case 'GET_TRANSLATOR_STATUS':
      return { status: await getTranslatorStatus() }

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
