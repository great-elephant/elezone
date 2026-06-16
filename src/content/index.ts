import { getSelectionContext, applyHighlight, scrollToHighlight } from './modules/anchor'
import { start, setOnStateChange, getState } from './modules/readAloud'
import { showWidget, hideWidget, updateWidgetState, showWarning } from './modules/floatingWidget'
import { enable as enableTranslation, disable as disableTranslation, isTranslatorAvailable } from './modules/translation'
import { Bookmark, Settings } from '../shared/types'

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
  const bookmarks: Bookmark[] = await chrome.runtime.sendMessage({ type: 'GET_BOOKMARKS' })
  const pageBookmarks = bookmarks.filter(b => b.url === url)
  for (const bookmark of pageBookmarks) {
    const found = applyHighlight(bookmark)
    if (!found && !bookmark.orphaned) {
      chrome.runtime.sendMessage({ type: 'MARK_ORPHANED', payload: bookmark.id }).catch(() => {})
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
  // Send to runtime so the popup (if open) can reflect current state
  chrome.runtime.sendMessage({ type: 'READ_ALOUD_STATE', payload: newState }).catch(() => {})
})

async function init() {
  await reanchor(window.location.href)
  checkScrollTarget()
  const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
  if (settings?.translation?.enabled) {
    enableTranslation(settings.translation.defaultTargetLanguage)
  }
}

init()

chrome.runtime.onMessage.addListener(
  (msg: { type: string; payload?: unknown }, _sender, sendResponse) => {
    handleMessage(msg).then(sendResponse).catch(() => sendResponse(null))
    return true
  }
)

async function handleMessage(msg: { type: string; payload?: unknown }): Promise<unknown> {
  switch (msg.type) {
    case 'GET_SELECTION_CONTEXT':
      return getSelectionContext()

    case 'HIGHLIGHT_BOOKMARK':
      applyHighlight(msg.payload as Bookmark)
      return { ok: true }

    case 'REANCHOR':
      await reanchor((msg.payload as { url: string }).url)
      return { ok: true }

    case 'START_READ_ALOUD': {
      if (getState() !== 'idle') return { ok: true }
      const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
      showWidget()
      start(settings.readAloud, msg => showWarning(msg))
      return { ok: true }
    }

    case 'TOGGLE_TRANSLATION': {
      const { enabled } = msg.payload as { enabled: boolean }
      if (enabled) {
        const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
        await enableTranslation(settings.translation.defaultTargetLanguage)
      } else {
        disableTranslation()
      }
      return { ok: true }
    }

    case 'CHECK_TRANSLATOR_AVAILABLE':
      return isTranslatorAvailable()

    case 'CHECK_READABLE': {
      const { extractSentences } = await import('./modules/readAloud')
      return { readable: extractSentences().length > 0 }
    }

    default:
      return null
  }
}
