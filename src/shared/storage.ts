import { Bookmark, Settings, DEFAULT_SETTINGS } from './types'

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings')
  if (!result['settings']) return DEFAULT_SETTINGS
  return { ...DEFAULT_SETTINGS, ...result['settings'] }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings })
}

export async function getAllBookmarks(): Promise<Bookmark[]> {
  const all = await chrome.storage.local.get(null)
  return Object.entries(all)
    .filter(([key]) => key.startsWith('bookmark:'))
    .map(([, val]) => val as Bookmark)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveBookmark(bookmark: Bookmark): Promise<void> {
  await chrome.storage.local.set({ [`bookmark:${bookmark.id}`]: bookmark })
}

export async function deleteBookmark(id: string): Promise<void> {
  await chrome.storage.local.remove(`bookmark:${id}`)
}

export async function getBookmarksForUrl(url: string): Promise<Bookmark[]> {
  const all = await getAllBookmarks()
  return all.filter(b => b.url === url)
}

export async function markOrphaned(id: string): Promise<void> {
  const result = await chrome.storage.local.get(`bookmark:${id}`)
  const bookmark = result[`bookmark:${id}`] as Bookmark | undefined
  if (bookmark) {
    await chrome.storage.local.set({ [`bookmark:${id}`]: { ...bookmark, orphaned: true } })
  }
}
