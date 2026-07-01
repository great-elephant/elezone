import { pause, resume, stop, getState } from './readAloud'

let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let pauseBtn: HTMLButtonElement | null = null
let warningBanner: HTMLElement | null = null

const WIDGET_CSS = `
  :host { all: initial; }
  .widget {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    background: #1a1a2e;
    border: 1px solid #3a3a6a;
    border-radius: 12px;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
    user-select: none;
    cursor: move;
  }
  button {
    background: transparent;
    border: none;
    color: #c0c0e0;
    font-size: 18px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 6px;
    line-height: 1;
  }
  button:hover { background: #2a2a4a; }
  button:focus-visible {
    outline: 2px solid #6b8aff;
    outline-offset: 2px;
  }
  .warning {
    position: fixed;
    bottom: 80px;
    right: 24px;
    z-index: 2147483647;
    background: #2a1a1a;
    border: 1px solid #6a3a3a;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 12px;
    color: #ffaaaa;
    font-family: system-ui, sans-serif;
    max-width: 280px;
  }
`

export function showWidget() {
  if (host) return

  host = document.createElement('div')
  shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = WIDGET_CSS

  const widget = document.createElement('div')
  widget.className = 'widget'

  pauseBtn = document.createElement('button')
  pauseBtn.textContent = '⏸'
  pauseBtn.title = 'Pause'
  pauseBtn.setAttribute('aria-label', 'Pause')
  pauseBtn.onclick = togglePause

  const stopBtn = document.createElement('button')
  stopBtn.textContent = '⏹'
  stopBtn.title = 'Stop'
  stopBtn.setAttribute('aria-label', 'Stop')
  stopBtn.onclick = () => { stop(); hideWidget() }

  widget.append(pauseBtn, stopBtn)
  shadow.append(style, widget)
  document.body.appendChild(host)

  makeDraggable(widget)
}

export function updateWidgetState(state: 'playing' | 'paused' | 'idle') {
  if (!pauseBtn) return
  if (state === 'playing') {
    pauseBtn.textContent = '⏸'
    pauseBtn.title = 'Pause'
    pauseBtn.setAttribute('aria-label', 'Pause')
  } else if (state === 'paused') {
    pauseBtn.textContent = '▶'
    pauseBtn.title = 'Resume'
    pauseBtn.setAttribute('aria-label', 'Resume')
  }
}

export function hideWidget() {
  host?.remove()
  host = null
  shadow = null
  pauseBtn = null
  hideWarning()
}

export function showWarning(msg: string) {
  if (!shadow) return
  hideWarning()
  warningBanner = document.createElement('div')
  warningBanner.className = 'warning'
  warningBanner.textContent = msg
  shadow.appendChild(warningBanner)
  setTimeout(hideWarning, 6000)
}

function hideWarning() {
  warningBanner?.remove()
  warningBanner = null
}

function togglePause() {
  const s = getState()
  if (s === 'playing') pause()
  else if (s === 'paused') resume()
}

function makeDraggable(el: HTMLElement) {
  let startX = 0, startY = 0, origRight = 24, origBottom = 24
  el.style.right = `${origRight}px`
  el.style.bottom = `${origBottom}px`

  el.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault(); // Prevent native drag-and-drop
    startX = e.clientX
    startY = e.clientY

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      origRight = Math.max(0, origRight - dx)
      origBottom = Math.max(0, origBottom - dy)
      el.style.right = `${origRight}px`
      el.style.bottom = `${origBottom}px`
      startX = e.clientX
      startY = e.clientY
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove, { capture: true })
      document.removeEventListener('mouseup', onUp, { capture: true })
    }

    document.addEventListener('mousemove', onMove, { capture: true })
    document.addEventListener('mouseup', onUp, { capture: true })
  })
}
