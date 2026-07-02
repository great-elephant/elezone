/**
 * Read Aloud discoverability affordances (idle-only):
 *
 *  C12 — a "🎧 Listen · ~N min" chip anchored near the article title. Advertises
 *        that the page is readable and previews the estimated duration. Clicking
 *        it starts read-aloud from the top (same as the popup's Start Reading).
 *
 *  C10 — a small "▶" handle that appears at the left edge of a content paragraph
 *        on hover; clicking it starts reading from that paragraph.
 *
 * Both are shown ONLY while read-aloud is idle and hidden the moment reading
 * starts (the mini-player takes over then). Click-to-define, which is active
 * *during* playback, lives elsewhere — these two are strictly idle affordances,
 * so they never fight over the same pointer events.
 *
 * Everything lives inside its own `cxt-`-prefixed shadow-DOM host so page CSS
 * can't touch it and our styles can't leak onto the page. The ▶ handle is a
 * single dedicated element positioned over a paragraph — we never hijack
 * document-wide clicks, so normal page interaction is untouched.
 */

import { extractSentences } from './readAloud'
import { extractReadableArticle, getPrimaryTitleElement, getContentParagraphs } from './contentDiscovery'

// Assumed average speech rate at 1x. Duration scales inversely with the
// configured speed multiplier.
const WORDS_PER_MINUTE = 180

type StartTop = () => void
type StartFromElement = (el: HTMLElement) => void

let startTop: StartTop = () => {}
let startFromElement: StartFromElement = () => {}

let enabled = false
let currentSpeed = 1

// ── Listen chip ─────────────────────────────────────────────────────────────

let chipHost: HTMLElement | null = null
let chipButton: HTMLButtonElement | null = null
let chipLabel: HTMLElement | null = null

const CHIP_CSS = `
  :host { all: initial; }
  .chip {
    all: initial;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 8px 0;
    padding: 6px 12px;
    background: #1a1a2e;
    color: #e6e6ff;
    border: 1px solid #3a3a6a;
    border-radius: 999px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.28);
    transition: background 0.12s ease, transform 0.12s ease;
    vertical-align: middle;
  }
  .chip:hover { background: #24244a; transform: translateY(-1px); }
  .chip:active { transform: translateY(0); }
  .chip:focus-visible { outline: 2px solid #6b8aff; outline-offset: 2px; }
  .chip .emoji { font-size: 14px; line-height: 1; }
  .chip .sep { opacity: 0.5; }
  .chip .est { color: #9fb0ff; font-weight: 600; }
  /* Floating fallback when no title anchor is found. */
  .chip.floating {
    position: fixed;
    left: 16px;
    bottom: 16px;
    z-index: 2147483646;
    margin: 0;
    box-shadow: 0 4px 16px rgba(0,0,0,0.45);
  }
`

function estimatedMinutes(): number {
  const article = extractReadableArticle()
  const text = article ? `${article.title ?? ''} ${article.textContent ?? ''}` : ''
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const speed = currentSpeed > 0 ? currentSpeed : 1
  const minutes = words / (WORDS_PER_MINUTE * speed)
  // Always advertise at least "~1 min" so the chip never reads "~0 min".
  return Math.max(1, Math.round(minutes))
}

function buildChip() {
  chipHost = document.createElement('div')
  chipHost.className = 'cxt-listen-host'
  const shadow = chipHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = CHIP_CSS

  chipButton = document.createElement('button')
  chipButton.className = 'chip'
  chipButton.type = 'button'
  chipButton.setAttribute('aria-label', 'Listen to this article')

  const emoji = document.createElement('span')
  emoji.className = 'emoji'
  emoji.textContent = '🎧'

  const text = document.createElement('span')
  text.textContent = 'Listen'

  const sep = document.createElement('span')
  sep.className = 'sep'
  sep.textContent = '·'

  chipLabel = document.createElement('span')
  chipLabel.className = 'est'

  chipButton.append(emoji, text, sep, chipLabel)

  // Start on mousedown (before focus/selection side effects) but prevent the
  // default so we don't steal focus or begin a text selection on the page.
  chipButton.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  chipButton.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    startTop()
  })

  shadow.append(style, chipButton)
}

function refreshChipLabel() {
  if (chipLabel) chipLabel.textContent = `~${estimatedMinutes()} min`
}

function placeChip() {
  if (!chipHost || !chipButton) return
  const title = getPrimaryTitleElement()
  if (title && title.parentElement && document.contains(title)) {
    // Insert right after the title so it reads as part of the article header.
    chipButton.classList.remove('floating')
    title.insertAdjacentElement('afterend', chipHost)
  } else {
    // No title anchor — fall back to a small fixed chip in the corner.
    chipButton.classList.add('floating')
    if (chipHost.parentElement !== document.body) {
      document.body.appendChild(chipHost)
    }
  }
}

function showChip() {
  // Only inject when there's genuinely readable content.
  if (extractSentences().length === 0) {
    removeChip()
    return
  }
  if (!chipHost) buildChip()
  refreshChipLabel()
  placeChip()
}

function removeChip() {
  chipHost?.remove()
  chipHost = null
  chipButton = null
  chipLabel = null
}

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
    width: 22px;
    height: 22px;
    padding: 0;
    background: #4f6ef7;
    color: #ffffff;
    border: none;
    border-radius: 6px;
    font-family: system-ui, sans-serif;
    font-size: 12px;
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
  const left = Math.max(2, rect.left - 28)
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
  if (target.closest('.cxt-para-play-host, .cxt-listen-host, .cxt-player-host, .cxt-dict-host, .cxt-delete-tooltip, .cxt-toast-host, #cxt-ocr-root')) {
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
 * Wire up the idle affordances. `onStartTop` starts reading from the article
 * top; `onStartFromElement` starts from a specific paragraph. Both should mirror
 * the popup's Start path (show mini-player, enable translation, warnings).
 */
export function initReadAloudAffordances(
  onStartTop: StartTop,
  onStartFromElement: StartFromElement,
) {
  startTop = onStartTop
  startFromElement = onStartFromElement

  document.addEventListener('mouseover', onDocMouseOver, { passive: true })
  document.addEventListener('mouseout', onDocMouseOut, { passive: true })
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true })
  window.addEventListener('resize', onViewportChange, { passive: true })

  // Read-aloud is idle on load, so show the affordances right away.
  setEnabled(true)
}

/** Enable (idle) or disable (reading) the affordances. */
export function setEnabled(next: boolean) {
  enabled = next
  if (next) {
    refreshContentSet()
    showChip()
  } else {
    removeChip()
    hideHandle()
    cancelHideHandle()
  }
}

/** Keep the estimated duration in sync when the configured speed changes. */
export function setAffordanceSpeed(speed: number) {
  if (Number.isFinite(speed) && speed > 0) {
    currentSpeed = speed
    if (enabled) refreshChipLabel()
  }
}
