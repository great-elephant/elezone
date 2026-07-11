import { showPopoverFromSelection } from './dictionary'
import { Settings, BookmarkColor } from '../../shared/types'

// The default color the extension uses for a quick save.
const DEFAULT_COLOR: BookmarkColor = 'red'

let chipHost: HTMLElement | null = null
let chipShadow: ShadowRoot | null = null
// Cache the selected text at mouseup so a later click still saves the right word
// even if the browser collapses the selection.
let pendingText = ''

const CHIP_CSS = `
  :host { all: initial; }
  .chip {
    position: fixed;
    z-index: 2147483647;
    width: 34px;
    height: 34px;
    background: #1a1a2e;
    border: 1px solid #3a3a6a;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .chip:hover {
    border-color: #4ade80;
    background: #222244;
  }
  .chip:hover img {
    transform: scale(1.1);
  }
  .chip:focus-visible {
    outline: 2px solid #4ade80;
    outline-offset: 2px;
  }
  .chip img {
    width: 20px;
    height: 20px;
    object-fit: contain;
    display: block;
    pointer-events: none;
    transition: transform 0.1s ease;
  }
`

const TIP_CSS = `
  :host { all: initial; }
  .tip {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    background: #1a1a2e;
    border: 1px solid #3a3a6a;
    border-radius: 10px;
    padding: 10px 14px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
    font-size: 13px;
    color: #c0c0e0;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 90vw;
  }
  .tip-close {
    background: transparent;
    border: none;
    color: #8888aa;
    font-size: 14px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }
  .tip-close:hover { color: #ffffff; }
  .tip-close:focus-visible {
    outline: 2px solid #6b8aff;
    outline-offset: 2px;
  }
`

const CHIP_WIDTH = 34 // approximate width for clamping
const CHIP_MARGIN = 8

function removeChip() {
  chipHost?.remove()
  chipHost = null
  chipShadow = null
  pendingText = ''
}

// Mirror the dictionary guard: reasonable-length, non-empty selection only.
function isSavableWord(word: string): boolean {
  return !!word && word.split(/\s+/).length <= 10
}

// Skip editable fields and the extension's own popover so we don't fight them.
function isInEditableOrOwn(node: Node | null): boolean {
  let el: HTMLElement | null =
    node?.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node?.parentElement ?? null
  // The OCR result popup's text is contentEditable, but we still want the
  // quick-save chip to work there — allow selections inside it.
  if (el?.closest('.cxt-ocr-popup')) return false
  while (el) {
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return true
    if (el.isContentEditable) return true
    if (el.classList && el.classList.contains('cxt-dict-host')) return true
    el = el.parentElement
  }
  return false
}

function showChip(rect: DOMRect) {
  removeChip()

  chipHost = document.createElement('div')
  chipHost.className = 'cxt-selchip-host'
  chipShadow = chipHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = CHIP_CSS

  const chip = document.createElement('div')
  chip.className = 'chip'
  const logo = document.createElement('img')
  logo.src = chrome.runtime.getURL('icons/logo.png')
  logo.alt = ''
  chip.appendChild(logo)
  chip.setAttribute('role', 'button')
  chip.title = 'Save selection'
  chip.setAttribute('aria-label', 'Save selection')

  // Horizontal: anchor to the selection start, clamped to the viewport.
  let left = rect.left
  if (left + CHIP_WIDTH > window.innerWidth) {
    left = window.innerWidth - CHIP_WIDTH - CHIP_MARGIN
  }
  if (left < CHIP_MARGIN) left = CHIP_MARGIN
  chip.style.left = `${left}px`

  // Vertical: above the selection, flipping below when there isn't room.
  const CHIP_HEIGHT = 34
  if (rect.top > CHIP_HEIGHT + CHIP_MARGIN) {
    chip.style.top = `${rect.top - CHIP_HEIGHT - 4}px`
  } else {
    chip.style.top = `${rect.bottom + 4}px`
  }

  // Use mousedown so we act before the browser collapses the selection on click,
  // and prevent the default so the selection stays intact for the popover to read.
  chip.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const text = pendingText
    removeChip()
    showPopoverFromSelection(text, DEFAULT_COLOR)
  })

  chipShadow.append(style, chip)
  document.body.appendChild(chipHost)
}

let enabled = true

async function refreshEnabled() {
  try {
    const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
    // Only disable when explicitly set to false; default is enabled.
    enabled = settings?.selectionChipEnabled !== false
  } catch {
    enabled = true
  }
}

function handleMouseUp(e: MouseEvent) {
  if (!enabled) return
  // Ignore clicks originating inside our own chip host.
  if (chipHost && chipHost.contains(e.target as Node)) return

  // Defer so the selection is finalized after mouseup.
  setTimeout(() => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      removeChip()
      return
    }
    const word = sel.toString().trim()
    if (!isSavableWord(word) || isInEditableOrOwn(sel.anchorNode)) {
      removeChip()
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      removeChip()
      return
    }
    pendingText = word
    showChip(rect)
  }, 0)
}

function handleSelectionChange() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    removeChip()
  }
}

function handleMouseDown(e: MouseEvent) {
  // A new mousedown outside our chip means the user is starting a new action;
  // drop the current chip (a fresh selection will re-show it on mouseup).
  if (chipHost && chipHost.contains(e.target as Node)) return
  removeChip()
}

export function initSelectionChip() {
  void refreshEnabled()
  // Keep the enabled flag in sync with settings changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['settings']) {
      const next = changes['settings'].newValue as Settings | undefined
      enabled = next?.selectionChipEnabled !== false
    }
  })

  // Capture phase so the OCR popup's event guard (which stops mouseup bubbling)
  // doesn't prevent the chip from appearing for selections inside it.
  document.addEventListener('mouseup', handleMouseUp, { capture: true })
  document.addEventListener('mousedown', handleMouseDown, { capture: true })
  document.addEventListener('selectionchange', handleSelectionChange)
  window.addEventListener('scroll', removeChip, { passive: true, capture: true })
}

// ── One-time first-run coaching tip ────────────────────────────────────────────

const TIP_FLAG = 'hasSeenSelectionTip'

export async function maybeShowSelectionTip() {
  // Only run on normal web pages, never inside the extension's own pages.
  if (location.protocol === 'chrome-extension:') return

  let seen = false
  try {
    const res = await chrome.storage.local.get(TIP_FLAG)
    seen = !!res[TIP_FLAG]
  } catch {
    return
  }
  if (seen) return

  // Persist immediately so it never shows twice, even across quick reloads.
  try {
    await chrome.storage.local.set({ [TIP_FLAG]: true })
  } catch {
    return
  }

  const host = document.createElement('div')
  host.className = 'cxt-seltip-host'
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = TIP_CSS

  const tip = document.createElement('div')
  tip.className = 'tip'

  const msg = document.createElement('span')
  msg.textContent = '💡 Tip: highlight any word on a page to save it.'

  const close = document.createElement('button')
  close.className = 'tip-close'
  close.textContent = '✕'
  close.title = 'Dismiss'
  close.setAttribute('aria-label', 'Dismiss')

  let dismissed = false
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    clearTimeout(timer)
    host.remove()
  }
  close.addEventListener('click', dismiss)

  tip.append(msg, close)
  shadow.append(style, tip)
  document.body.appendChild(host)

  const timer = setTimeout(dismiss, 8000)
}
