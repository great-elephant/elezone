/**
 * Read Aloud visual overlays that can't be expressed via the CSS Custom
 * Highlight API (which paints text ranges only, no pseudo-elements or box
 * decorations):
 *
 *  1. A thin left "reading" accent bar tracking the current sentence's left
 *     edge + vertical span (E19).
 *  2. An optional focus/spotlight mode that dims the rest of the page and keeps
 *     the current sentence bright, using the CropOverlay box-shadow technique
 *     (E20).
 *
 * Both live in their own shadow-DOM hosts so page CSS can't touch them. Both are
 * driven off a single `Rect | null` that is updated whenever the current
 * sentence changes (via updateReadingOverlays) and cleared when read-aloud stops
 * or the range has no geometry (never throws on an empty/detached range).
 *
 * z-index: kept BELOW the mini-player (2147483647) so the player stays clickable
 * and on top.
 */

type Rect = { left: number; top: number; width: number; height: number }

const OVERLAY_Z = 2147483646

// ── Shared host management ────────────────────────────────────────────────────

let markerHost: HTMLElement | null = null
let markerBar: HTMLElement | null = null

let focusHost: HTMLElement | null = null
let focusBox: HTMLElement | null = null

// Whether focus/spotlight mode is toggled on (in-session; not persisted).
let focusEnabled = false
// The current sentence's Range, kept so we can recompute its (viewport-relative,
// fixed-positioned) rect after the page scrolls/resizes while the same sentence
// is showing. Null when no sentence is active.
let currentRange: Range | null = null
// rAF handle to coalesce scroll/resize repositioning.
let repositionRaf = 0
// Whether our scroll/resize listeners are currently attached.
let trackingActive = false

function ensureMarker(): HTMLElement {
  if (markerBar) return markerBar

  markerHost = document.createElement('div')
  markerHost.className = 'cxt-reading-marker-host'
  const shadow = markerHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .bar {
      position: fixed;
      z-index: ${OVERLAY_Z};
      pointer-events: none;
      border-radius: 2px;
      background: #4f6ef7;
      box-shadow: 0 0 6px rgba(79, 110, 247, 0.6);
      display: none;
      transition: top 0.15s ease, height 0.15s ease, left 0.15s ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .bar { transition: none; }
    }
  `

  markerBar = document.createElement('div')
  markerBar.className = 'bar'
  shadow.append(style, markerBar)
  document.body.appendChild(markerHost)
  return markerBar
}

function ensureFocus(): HTMLElement {
  if (focusBox) return focusBox

  focusHost = document.createElement('div')
  focusHost.className = 'cxt-reading-focus-host'
  const shadow = focusHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .box {
      position: fixed;
      z-index: ${OVERLAY_Z};
      pointer-events: none;
      border-radius: 6px;
      /* Everything outside this box is dimmed by the huge spread shadow. */
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
      display: none;
      transition: top 0.15s ease, left 0.15s ease, width 0.15s ease, height 0.15s ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .box { transition: none; }
    }
  `

  focusBox = document.createElement('div')
  focusBox.className = 'box'
  shadow.append(style, focusBox)
  document.body.appendChild(focusHost)
  return focusBox
}

// ── Rect extraction ───────────────────────────────────────────────────────────

// Get the current sentence's viewport rect, or null if the range has no
// geometry (empty/detached/zero-size). Never throws.
function rectFromRange(range: Range): Rect | null {
  try {
    const r = range.getBoundingClientRect()
    if (!r || (r.width === 0 && r.height === 0)) return null
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  } catch {
    return null
  }
}

// ── Painting ──────────────────────────────────────────────────────────────────

function paintMarker(rect: Rect | null) {
  if (!markerBar && !rect) return
  const bar = ensureMarker()
  if (!rect) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'block'
  bar.style.left = `${rect.left - 6}px`
  bar.style.top = `${rect.top}px`
  bar.style.width = `3px`
  bar.style.height = `${rect.height}px`
}

function paintFocus(rect: Rect | null) {
  if (!focusEnabled || !rect) {
    if (focusBox) focusBox.style.display = 'none'
    return
  }
  const box = ensureFocus()
  // Pad slightly so glyph ascenders/descenders aren't clipped by the bright box.
  const pad = 6
  box.style.display = 'block'
  box.style.left = `${rect.left - pad}px`
  box.style.top = `${rect.top - pad}px`
  box.style.width = `${rect.width + pad * 2}px`
  box.style.height = `${rect.height + pad * 2}px`
}

// Repaint both overlays from the live range's current viewport rect.
function repaint() {
  const rect = currentRange ? rectFromRange(currentRange) : null
  paintMarker(rect)
  paintFocus(rect)
}

// ── Scroll / resize tracking ──────────────────────────────────────────────────
// Fixed-positioned overlays are viewport-relative, so their on-screen position
// only stays correct if we recompute the sentence rect whenever the page scrolls
// or resizes. Listeners run only while a sentence is active.

function onViewportChange() {
  if (repositionRaf) return
  repositionRaf = requestAnimationFrame(() => {
    repositionRaf = 0
    repaint()
  })
}

function startTracking() {
  if (trackingActive) return
  trackingActive = true
  // capture:true so we also catch scrolls on nested scroll containers.
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true })
  window.addEventListener('resize', onViewportChange, { passive: true })
}

function stopTracking() {
  if (!trackingActive) return
  trackingActive = false
  window.removeEventListener('scroll', onViewportChange, { capture: true })
  window.removeEventListener('resize', onViewportChange)
  if (repositionRaf) {
    cancelAnimationFrame(repositionRaf)
    repositionRaf = 0
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Update both overlays to track `range` (the current sentence). Safe to call
 * with an empty/detached range — overlays are simply hidden in that case.
 */
export function updateReadingOverlays(range: Range): void {
  currentRange = range
  startTracking()
  repaint()
}

/** Hide both overlays (read-aloud paused into idle / stopped). Keeps hosts. */
export function hideReadingOverlays(): void {
  currentRange = null
  stopTracking()
  if (markerBar) markerBar.style.display = 'none'
  if (focusBox) focusBox.style.display = 'none'
}

/** Fully tear down overlay hosts (e.g. when the widget is removed). */
export function destroyReadingOverlays(): void {
  hideReadingOverlays()
  markerHost?.remove()
  focusHost?.remove()
  markerHost = null
  markerBar = null
  focusHost = null
  focusBox = null
}

/** Turn focus/spotlight mode on or off. Repaints immediately. */
export function setFocusMode(enabled: boolean): void {
  focusEnabled = enabled
  const rect = currentRange ? rectFromRange(currentRange) : null
  paintFocus(rect)
}

export function isFocusMode(): boolean {
  return focusEnabled
}
