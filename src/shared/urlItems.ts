import type { SavedItem } from './types'

// Exact match on the full URL (query and #hash included), the same rule
// getItemsForUrl applies. Items saved without a url never match.
export function filterItemsForUrl(items: SavedItem[], url: string | undefined): SavedItem[] {
  if (!url) return []
  return items.filter(i => i.url === url)
}
