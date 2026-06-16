import {
  saveBookmark,
  getAllBookmarks,
  deleteBookmark,
  getBookmarksForUrl,
  getSettings,
  saveSettings,
  markOrphaned,
} from '../shared/storage'
import { Bookmark, BookmarkColor, BOOKMARK_COLORS, Settings } from '../shared/types'

const COLORS = Object.keys(BOOKMARK_COLORS) as BookmarkColor[]

const COLOR_EMOJI: Record<BookmarkColor, string> = {
  red: '🔴', yellow: '🟡', cyan: '🔵', green: '🟢', blue: '💙',
  orange: '🟠', purple: '🟣', pink: '🩷', teal: '🩵', gray: '⚫',
}

chrome.runtime.onInstalled.addListener(setupContextMenus)
chrome.runtime.onStartup.addListener(setupContextMenus)

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'bookmark-parent',
      title: 'Bookmark',
      contexts: ['selection'],
    })
    for (const color of COLORS) {
      chrome.contextMenus.create({
        id: `bookmark-${color}`,
        parentId: 'bookmark-parent',
        title: `${COLOR_EMOJI[color]} ${color.charAt(0).toUpperCase() + color.slice(1)}`,
        contexts: ['selection'],
      })
    }
  })
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !info.selectionText) return
  const match = info.menuItemId.toString().match(/^bookmark-(.+)$/)
  if (!match || match[1] === 'parent') return

  const color = match[1] as BookmarkColor

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'GET_SELECTION_CONTEXT',
  }).catch(() => null) as { prefix: string; suffix: string; occurrenceIndex: number } | null

  if (!response) return

  const bookmark: Bookmark = {
    id: crypto.randomUUID(),
    url: info.pageUrl,
    text: info.selectionText,
    prefix: response.prefix,
    suffix: response.suffix,
    occurrenceIndex: response.occurrenceIndex,
    color,
    createdAt: Date.now(),
    orphaned: false,
  }

  await saveBookmark(bookmark)
  chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_BOOKMARK', payload: bookmark }).catch(() => {})
})

// Re-anchor highlights when SPA navigates
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return
  const bookmarks = await getBookmarksForUrl(details.url)
  if (bookmarks.length === 0) return
  chrome.tabs.sendMessage(details.tabId, {
    type: 'REANCHOR',
    payload: { url: details.url },
  }).catch(() => {})
})

chrome.runtime.onMessage.addListener(
  (msg: { type: string; payload?: unknown }, _sender, sendResponse) => {
    dispatch(msg).then(sendResponse).catch(() => sendResponse(null))
    return true
  }
)

async function dispatch(msg: { type: string; payload?: unknown }): Promise<unknown> {
  switch (msg.type) {
    case 'GET_BOOKMARKS':
      return getAllBookmarks()
    case 'DELETE_BOOKMARK':
      await deleteBookmark(msg.payload as string)
      return { ok: true }
    case 'GET_SETTINGS':
      return getSettings()
    case 'SAVE_SETTINGS':
      await saveSettings(msg.payload as Settings)
      return { ok: true }
    case 'MARK_ORPHANED':
      await markOrphaned(msg.payload as string)
      return { ok: true }
    default:
      return null
  }
}
