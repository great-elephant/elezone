/**
 * Read Aloud discoverability affordance (idle-only):
 *
 *  C10 — a small "▶" handle that appears at the left edge of a content paragraph
 *        on hover; clicking it starts reading from that paragraph.
 *
 * Shown ONLY while read-aloud is idle and hidden the moment reading starts (the
 * mini-player takes over then). Click-to-define, which is active *during*
 * playback, lives elsewhere — this is a strictly idle affordance, so it never
 * fights over the same pointer events.
 *
 * Lives inside its own `cxt-`-prefixed shadow-DOM host so page CSS can't touch
 * it and our styles can't leak onto the page. It's a single dedicated element
 * positioned over a paragraph — we never hijack document-wide clicks, so
 * normal page interaction is untouched.
 *
 * (There used to also be a "Listen · ~N min" chip anchored near the article
 * title, but article-title detection isn't reliable enough across sites —
 * it surfaced on pages that aren't real articles, so it was removed.)
 */

import { extractReadableArticle, getContentParagraphs } from './contentDiscovery'

type StartFromElement = (el: HTMLElement) => void

let startFromElement: StartFromElement = () => {}

let enabled = false

// ── Paragraph "▶ Read from here" handle ───────────────────────────────────────

let handleHost: HTMLElement | null = null
let handleButton: HTMLButtonElement | null = null
let handleTarget: HTMLElement | null = null
let contentSet: WeakSet<HTMLElement> = new WeakSet()
let hideHandleTimer: ReturnType<typeof setTimeout> | null = null
let repositionRaf = 0

const HANDLE_CSS = `
  :host { all: initial; }
  .handle {
    all: initial;
    box-sizing: border-box;
    position: fixed;
    z-index: 2147483645;
    display: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: #4f6ef7;
    color: #ffffff;
    border: none;
    border-radius: 7px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    opacity: 0.95;
  }
  .handle:hover { background: #6b8aff; opacity: 1; }
  .handle:focus-visible { outline: 2px solid #ffffff; outline-offset: 1px; }
`

function buildHandle() {
  handleHost = document.createElement('div')
  handleHost.className = 'cxt-para-play-host'
  const shadow = handleHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = HANDLE_CSS

  handleButton = document.createElement('button')
  handleButton.className = 'handle'
  handleButton.type = 'button'
  handleButton.textContent = '▶'
  handleButton.title = 'Read from here'
  handleButton.setAttribute('aria-label', 'Read from here')

  handleButton.addEventListener('mouseenter', cancelHideHandle)
  handleButton.addEventListener('mouseleave', scheduleHideHandle)
  handleButton.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  handleButton.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const target = handleTarget
    hideHandle()
    if (target) startFromElement(target)
  })

  shadow.append(style, handleButton)
  document.body.appendChild(handleHost)
}

// Skip tiny / non-textual blocks so the handle only offers on real paragraphs.
function isEligibleParagraph(el: HTMLElement): boolean {
  if (!contentSet.has(el)) return false
  const text = el.innerText?.replace(/\s+/g, ' ').trim() ?? ''
  if (text.length < 20) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 60 || rect.height < 16) return false
  return true
}

function positionHandle(el: HTMLElement) {
  if (!handleButton) return
  const rect = el.getBoundingClientRect()
  // Sit just left of the paragraph's first line, clamped into the viewport so
  // it stays reachable even for blocks flush against the left edge.
  const left = Math.max(2, rect.left - 34)
  const top = rect.top + 2
  handleButton.style.left = `${left}px`
  handleButton.style.top = `${top}px`
  handleButton.style.display = 'flex'
}

function showHandleFor(el: HTMLElement) {
  if (!enabled) return
  if (!isEligibleParagraph(el)) return
  if (!handleHost) buildHandle()
  cancelHideHandle()
  handleTarget = el
  positionHandle(el)
}

function hideHandle() {
  handleTarget = null
  if (handleButton) handleButton.style.display = 'none'
}

function scheduleHideHandle() {
  cancelHideHandle()
  // Short grace period so the cursor can travel from the paragraph onto the
  // handle without it vanishing.
  hideHandleTimer = setTimeout(() => { hideHandle(); hideHandleTimer = null }, 150)
}

function cancelHideHandle() {
  if (hideHandleTimer) { clearTimeout(hideHandleTimer); hideHandleTimer = null }
}

// Delegated hover: one document-level listener, not per-paragraph handlers.
function onDocMouseOver(e: MouseEvent) {
  if (!enabled) return
  const target = e.target
  if (!(target instanceof Element)) return
  // Ignore hovers that originate inside any of our own hosts.
  if (target.closest('.cxt-para-play-host, .cxt-player-host, .cxt-dict-host, .cxt-delete-tooltip, .cxt-toast-host, #cxt-ocr-root')) {
    return
  }
  // Find the nearest element that is a known content paragraph.
  let el: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement
  while (el && el !== document.body) {
    if (contentSet.has(el)) {
      showHandleFor(el)
      return
    }
    el = el.parentElement
  }
}

function onDocMouseOut(e: MouseEvent) {
  if (!enabled) return
  const related = e.relatedTarget
  // Keep the handle while moving onto it (it lives in a shadow host, so
  // relatedTarget retargets to the host element).
  if (related instanceof Element && related.closest('.cxt-para-play-host')) return
  scheduleHideHandle()
}

function onViewportChange() {
  if (!handleTarget) return
  if (repositionRaf) return
  repositionRaf = requestAnimationFrame(() => {
    repositionRaf = 0
    if (handleTarget && document.contains(handleTarget)) {
      positionHandle(handleTarget)
    } else {
      hideHandle()
    }
  })
}

// Recompute which elements count as content. Cheap enough to run when we
// (re)enter idle; the hover listeners then just do WeakSet membership checks.
function refreshContentSet() {
  const readableText = extractReadableArticle()?.textContent ?? ''
  const paras = getContentParagraphs(readableText)
  const set = new WeakSet<HTMLElement>()
  for (const el of paras) set.add(el)
  contentSet = set
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Wire up the idle affordance. `onStartFromElement` starts reading from a
 * specific paragraph — it should mirror the popup's Start path (show
 * mini-player, enable translation, warnings).
 */
export function initReadAloudAffordances(onStartFromElement: StartFromElement) {
  startFromElement = onStartFromElement

  document.addEventListener('mouseover', onDocMouseOver, { passive: true })
  document.addEventListener('mouseout', onDocMouseOut, { passive: true })
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true })
  window.addEventListener('resize', onViewportChange, { passive: true })

  // Read-aloud is idle on load, so show the affordance right away.
  setEnabled(true)
}

/** Enable (idle) or disable (reading) the affordance. */
export function setEnabled(next: boolean) {
  enabled = next
  if (next) {
    refreshContentSet()
  } else {
    hideHandle()
    cancelHideHandle()
  }
}
