// Reflows the Netflix player so our UI sits *beside* and *below* the picture
// instead of covering it.
//
// The player's containers are full-viewport boxes, so we shrink them by the
// width of the dialogue sidebar and the height of the subtitle strip. Both are
// published as custom properties on :root, which the overlay shadow roots read
// (custom properties inherit through shadow boundaries, and `all: initial` on
// :host does not reset them).

const STYLE_ID = 'elezone-video-layout'

// Netflix renames these between releases, so cast a wide net — a selector that
// matches nothing simply does nothing.
const PLAYER_SELECTORS = [
  '.watch-video',
  '.watch-video--player-view',
  '.watch-video--playback-container',
  '[data-uia="player"]',
  '.nfp.AkiraPlayer',
]

const LAYOUT_CSS = `
${PLAYER_SELECTORS.join(',\n')} {
  top: 0 !important;
  left: 0 !important;
  right: auto !important;
  bottom: auto !important;
  width: calc(100vw - var(--elezone-sidebar-w, 0px)) !important;
  height: calc(100vh - var(--elezone-subs-h, 0px)) !important;
}

/* Let the picture letterbox inside the smaller box rather than crop. */
${PLAYER_SELECTORS.map(s => `${s} video`).join(',\n')} {
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
}
`

export function installNetflixLayout(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = LAYOUT_CSS
  document.head.appendChild(style)
}

export function removeNetflixLayout(): void {
  document.getElementById(STYLE_ID)?.remove()
  const root = document.documentElement
  root.style.removeProperty('--elezone-sidebar-w')
  root.style.removeProperty('--elezone-subs-h')
}

/**
 * Publish how much room the sidebar and subtitle strip need. Everything else —
 * the player size and both overlays — is driven off these two values.
 */
export function setNetflixLayoutMetrics(sidebarWidth: number, subtitleHeight: number): void {
  const root = document.documentElement
  root.style.setProperty('--elezone-sidebar-w', `${Math.round(sidebarWidth)}px`)
  root.style.setProperty('--elezone-subs-h', `${Math.round(subtitleHeight)}px`)
}
