// Makes room for Video Mode on a YouTube watch page.
//
// Nothing like the Netflix layout, and deliberately so. On Netflix the player is
// the whole page, so there is nothing to preserve and the picture is shrunk to
// make a band for the dialogue. YouTube's watch page is a page: a player beside
// a recommendations column, with a title, a description and comments below. Take
// height away from the player and the rest of that page has to be re-laid-out
// around it — which is what the earlier attempts here did, and each one broke
// something else. The last of them zeroed the padding YouTube builds the player
// box from and took the video off the screen entirely.
//
// So the picture is left completely alone. The dialogue floats *over* it, where
// a caption would be anyway, and can be dragged wherever the learner wants —
// there is no single right place, since a fixed spot lands on the speaker's face
// in one video and on burnt-in captions in the next.
//
// The strip lives inside the player element, which pays for itself twice:
// YouTube's own layout never sees it, and because that element is what goes
// fullscreen, fullscreen needs no special case at all.
//
// The sidebar still takes the recommendations column — that part works, and it
// replaces the most distracting thing on the page with the transcript.

const STYLE_ID = 'elezone-youtube-layout'
const STRIP_ID = 'elezone-subtitle-card'
const SIDEBAR_ID = 'elezone-dialogue-sidebar'

const SECONDARY_COLUMN = '#secondary-inner, ytd-watch-flexy #secondary'
// `#movie_player` is both the element that goes fullscreen and an established
// positioning context, so the overlay can be absolutely placed inside it.
const PLAYER_BOX = '#movie_player, #player-container-inner, #player'

// `:host { all: initial }` inside each overlay resets its display to inline, so
// the hosts have to be made blocks from outside — an outer rule beats a :host
// rule, which is exactly why this lives here and not in the shadow CSS.
const LAYOUT_CSS = `
#${SIDEBAR_ID}.elezone-yt-inflow {
  display: block !important;
  width: 100% !important;
  margin: 0 0 12px 0 !important;
}
#${STRIP_ID}.elezone-yt-overlay {
  display: block !important;
  position: static !important;
}

/* Not yet placed. The overlays are built the moment Video Mode turns on, which
   on a fresh load is before YouTube has rendered the column and the player they
   belong in. Shown anyway they take their fallback shape first — a full-height
   panel down the right, a band across the bottom — and then jump into place a
   moment later. Better to not be there for that moment. */
#${STRIP_ID}.elezone-yt-pending,
#${SIDEBAR_ID}.elezone-yt-pending {
  visibility: hidden !important;
}

/* Fullscreen takes the Netflix shape: the picture gives up a column on the
   right and a band at the bottom, and nothing is covered.
   Only the <video> element is resized — never its containers. Sizing the
   containers is what broke the player before: YouTube builds their height from
   percentage padding, so overriding half of that arrangement collapses it. The
   video is positioned by inline styles that an !important rule outranks, and
   if it ever stops working the picture simply stays full-size with the panels
   over it, which is where this started. */
.elezone-fs-fit video {
  left: 0 !important;
  top: 0 !important;
  width: calc(100vw - var(--elezone-sidebar-w, 0px)) !important;
  height: calc(100vh - var(--elezone-subs-h, 0px)) !important;
  object-fit: contain !important;
}
/* Lift the player's own controls clear of the band. Cosmetic: a wrong selector
   here leaves them where they were, under the dialogue. */
.elezone-fs-fit .ytp-chrome-bottom {
  bottom: calc(var(--elezone-subs-h, 0px) + 14px) !important;
  width: calc(100vw - var(--elezone-sidebar-w, 0px) - 48px) !important;
}
`

let _installed = false

/** How far down the masthead pushes the content; differs between layouts. */
function mastheadHeight(): number {
  const masthead = document.querySelector<HTMLElement>('#masthead-container, ytd-masthead')
  const height = masthead?.getBoundingClientRect().height ?? 0
  return height > 0 && height < 200 ? Math.round(height) : 56
}

const STRIP_VARS = [
  '--elezone-strip-position',
  '--elezone-strip-left',
  '--elezone-strip-right',
  '--elezone-strip-bottom',
  '--elezone-strip-top',
  '--elezone-strip-width',
  '--elezone-strip-radius',
  '--elezone-strip-minh',
  '--elezone-strip-bg',
  '--elezone-strip-bg-hover',
  '--elezone-strip-text-shadow',
  '--elezone-strip-maxw',
  '--elezone-strip-padding',
]

const SIDE_VARS = [
  '--elezone-side-position',
  '--elezone-side-top',
  '--elezone-side-right',
  '--elezone-side-bottom',
  '--elezone-side-height',
  '--elezone-side-width',
  '--elezone-side-radius',
]

function clearVars(names: string[]): void {
  for (const name of names) document.documentElement.style.removeProperty(name)
}

/**
 * Put an overlay back to the floating form it uses on Netflix, and back under a
 * node that is actually rendered.
 *
 * The re-parenting is not optional. Leaving a host inside `#secondary` when that
 * column is hidden means `display: none` on an ancestor, which removes the whole
 * subtree from the page — the element is still floating, and still invisible.
 */
function useOverlayForm(id: string, vars: string[]): void {
  clearVars(vars)
  const el = document.getElementById(id)
  if (!el) return
  el.classList.remove('elezone-yt-inflow', 'elezone-yt-overlay', 'elezone-yt-pending')
  const root = document.fullscreenElement ?? document.body
  if (el.parentElement !== root) root.appendChild(el)
}

/**
 * Whether the watch page has finished rendering the parts we attach to.
 *
 * Needed to tell "not built yet" from "genuinely absent". Theater mode really
 * does remove the recommendations column, and there the floating fallback is
 * the right answer; a page that is still assembling only looks the same.
 */
function isTheaterMode(): boolean {
  return document.querySelector('ytd-watch-flexy')?.hasAttribute('theater') === true
}

// When each overlay started waiting for its slot. Waiting hides it, so a slot
// that never arrives would hide it for good — and a panel that is silently
// absent is a worse failure than one in the wrong place.
const _pendingSince = new Map<string, number>()
const PENDING_GIVE_UP_MS = 10_000

function markPending(id: string, vars: string[]): boolean {
  const el = document.getElementById(id)
  if (!el) return false

  const since = _pendingSince.get(id) ?? Date.now()
  _pendingSince.set(id, since)
  if (Date.now() - since > PENDING_GIVE_UP_MS) {
    console.info(`[EleZone] ${id}: no slot on the page after 10s; floating it instead`)
    useOverlayForm(id, vars)
    return false
  }

  clearVars(vars)
  el.classList.remove('elezone-yt-inflow', 'elezone-yt-overlay')
  el.classList.add('elezone-yt-pending')
  return true
}

/** Shrink (or release) the picture so the fullscreen panels have room. */
function fitFullscreenVideo(player: HTMLElement | null, fit: boolean): void {
  const current = document.querySelector('.elezone-fs-fit')
  if (current && (!fit || current !== player)) current.classList.remove('elezone-fs-fit')
  if (fit && player) player.classList.add('elezone-fs-fit')
}

export function installYouTubeLayout(): void {
  if (_installed) return
  _installed = true
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = LAYOUT_CSS
    document.head.appendChild(style)
  }
}

export function removeYouTubeLayout(): void {
  _installed = false
  document.getElementById(STYLE_ID)?.remove()
  const root = document.documentElement
  root.style.removeProperty('--elezone-sidebar-w')
  root.style.removeProperty('--elezone-subs-h')
  useOverlayForm(STRIP_ID, STRIP_VARS)
  useOverlayForm(SIDEBAR_ID, SIDE_VARS)
  fitFullscreenVideo(null, false)
}

export function setYouTubeLayoutMetrics(sidebarWidth: number, subtitleHeight: number): void {
  const root = document.documentElement
  root.style.setProperty('--elezone-sidebar-w', `${Math.round(sidebarWidth)}px`)
  root.style.setProperty('--elezone-subs-h', `${Math.round(subtitleHeight)}px`)
  placeYouTubeOverlays()
}

/** Whether the strip is currently floating over the picture, i.e. draggable. */
export function isStripOverlaid(): boolean {
  return document.getElementById(STRIP_ID)?.classList.contains('elezone-yt-overlay') === true
}

/**
 * Where the dialogue sits before anyone moves it: clear of the scrubber, so the
 * one control people reach for mid-sentence is never under the text.
 *
 * Measured rather than set to a percentage that looks about right — the control
 * bar is a fixed number of pixels tall while the player is not, so any constant
 * would only be correct at one window size. Returns null when there is nothing
 * to measure yet, which leaves the stored or built-in default in place.
 */
// Extra clearance above the control bar so the strip doesn't land on YouTube's
// own "Skip Ads" button, which sits in that same bottom-right area during an ad.
const SKIP_AD_CLEARANCE_PX = 100

export function defaultStripPosition(): { xPct: number; yPct: number } | null {
  const player = document.querySelector<HTMLElement>(PLAYER_BOX)
  const height = player?.clientHeight ?? 0
  if (!player || height === 0) return null

  // Still measurable while the controls are faded out — they are moved and made
  // transparent, not removed.
  const chrome = player.querySelector<HTMLElement>('.ytp-chrome-bottom')
  const chromeHeight = chrome?.getBoundingClientRect().height || 48
  return { xPct: 50, yPct: ((chromeHeight + 10 + SKIP_AD_CLEARANCE_PX) / height) * 100 }
}

/**
 * Put the overlays where this layout wants them, for whatever mode the page is
 * in right now. Always returns true: on YouTube this module owns placement, and
 * the caller must not then fall back to its own.
 *
 * Called from the orchestrator's re-parent pass, which runs on every fullscreen
 * change and once a second — YouTube re-renders `#secondary` as it loads more
 * recommendations, and re-creates the player subtree on navigation, either of
 * which would otherwise orphan an overlay.
 */
export function placeYouTubeOverlays(): boolean {
  if (!_installed) return false

  const root = document.documentElement
  const top = mastheadHeight()
  const strip = document.getElementById(STRIP_ID)
  const sidebar = document.getElementById(SIDEBAR_ID)
  const player = document.querySelector<HTMLElement>(PLAYER_BOX)

  // ── Fullscreen: the Netflix arrangement ──
  //
  // The floating, draggable overlay is an answer to a problem fullscreen does
  // not have. There is no page to preserve here and no layout to avoid
  // disturbing — the picture is the whole screen — so the panels get their own
  // space and stop covering the film.
  if (document.fullscreenElement) {
    // Clearing the custom properties restores the defaults in each overlay's own
    // stylesheet, which are precisely the Netflix forms: a band across the
    // bottom, inset by the sidebar, and a column down the right.
    useOverlayForm(STRIP_ID, STRIP_VARS)
    useOverlayForm(SIDEBAR_ID, SIDE_VARS)
    fitFullscreenVideo(player, true)
    return true
  }
  fitFullscreenVideo(player, false)

  // ── The dialogue, floating over the picture ──
  if (strip && player) {
    if (strip.parentElement !== player) player.appendChild(strip)
    strip.classList.remove('elezone-yt-pending')
    strip.classList.add('elezone-yt-overlay')
    _pendingSince.delete(STRIP_ID)
    root.style.setProperty('--elezone-strip-position', 'absolute')
    // Left / bottom / width all come from the drag-and-resize geometry as inline
    // styles, which outrank these; these only decide what an unplaced box does.
    root.style.setProperty('--elezone-strip-left', '0')
    root.style.setProperty('--elezone-strip-right', 'auto')
    root.style.setProperty('--elezone-strip-top', 'auto')
    root.style.setProperty('--elezone-strip-bottom', '8%')
    root.style.setProperty('--elezone-strip-width', '90%')
    root.style.setProperty('--elezone-strip-maxw', 'none')
    root.style.setProperty('--elezone-strip-radius', '10px')
    // No reserved band: over the picture it should be as small as the words are.
    root.style.setProperty('--elezone-strip-minh', 'auto')
    // No backdrop until pointed at. A slab of dark over a third of the shot for
    // the whole film is worse than the caption it replaces; an outline on the
    // glyphs carries the text over the picture instead, and the panel only
    // materialises when the pointer arrives — which is when it is about to be
    // clicked, read closely, or dragged.
    root.style.setProperty('--elezone-strip-bg', 'transparent')
    root.style.setProperty('--elezone-strip-bg-hover', 'rgba(6, 8, 14, 0.82)')
    root.style.setProperty(
      '--elezone-strip-text-shadow',
      '0 1px 3px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.75), 0 0 1px rgba(0,0,0,1)',
    )
    // Side gutters wide enough for the sidebar toggle, which is pinned to the
    // bottom-right corner of the panel — and the same on the left, or the words
    // stop being centred in the box they sit in.
    root.style.setProperty('--elezone-strip-padding', '10px 52px 8px')
  } else if (strip) {
    // No player element yet — it is coming, so wait rather than flashing the
    // full-width band that the cleared defaults would give.
    markPending(STRIP_ID, STRIP_VARS)
  }

  // ── The transcript, in the recommendations column ──
  // Theater and fullscreen both take that column away; then it floats instead.
  const secondary = document.querySelector(SECONDARY_COLUMN)
  const secondaryUsable =
    !document.fullscreenElement &&
    secondary instanceof HTMLElement &&
    secondary.offsetParent !== null

  if (sidebar && secondaryUsable && secondary) {
    sidebar.classList.remove('elezone-yt-pending')
    sidebar.classList.add('elezone-yt-inflow')
    _pendingSince.delete(SIDEBAR_ID)
    // Static and one screen tall: the first screenful is the study view, and
    // scrolling gets plain YouTube back. Sticky would leave the transcript
    // hanging over the comments, which is not what scrolling down is asking for.
    root.style.setProperty('--elezone-side-position', 'static')
    root.style.setProperty('--elezone-side-width', '100%')
    root.style.setProperty('--elezone-side-radius', '12px')
    // Exactly as tall as the picture it sits beside. Measured, not derived from
    // the viewport: YouTube picks the player's height itself, from the window
    // size, the theater setting and the video's own aspect ratio, and any
    // formula of ours would only agree with it by luck.
    const playerHeight = player?.getBoundingClientRect().height ?? 0
    root.style.setProperty(
      '--elezone-side-height',
      playerHeight > 0 ? `${Math.round(playerHeight)}px` : `calc(100vh - ${top}px - 24px)`,
    )
    if (sidebar.parentElement !== secondary) secondary.prepend(sidebar)
  } else if (sidebar) {
    // Theater mode has no column to sit in, so floating is correct there. Any
    // other reason for it being missing means the page is still assembling.
    if (isTheaterMode()) useOverlayForm(SIDEBAR_ID, SIDE_VARS)
    else markPending(SIDEBAR_ID, SIDE_VARS)
  }

  return true
}
