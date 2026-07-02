import { pause, resume, stop, getState, next, prev, replay, seekTo, setSpeed, getSpeed } from './readAloud'

let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let pauseBtn: HTMLButtonElement | null = null
let speedBtn: HTMLButtonElement | null = null
let progressLabel: HTMLElement | null = null
let progressFill: HTMLElement | null = null
let progressTrack: HTMLElement | null = null
let warningBanner: HTMLElement | null = null

let curIndex = 0
let curTotal = 0

const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 2]

const WIDGET_CSS = `
  :host { all: initial; }
  .player {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    box-sizing: border-box;
    width: 260px;
    background: #1a1a2e;
    border: 1px solid #3a3a6a;
    border-radius: 12px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
    color: #c0c0e0;
    user-select: none;
  }
  .player *, .player *::before, .player *::after { box-sizing: border-box; }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    cursor: move;
  }
  .title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #c0c0e0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .title .dot { color: #4ade80; font-size: 10px; line-height: 1; }
  .progress-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .progress-label {
    font-size: 11px;
    color: #8a8ab0;
    font-variant-numeric: tabular-nums;
  }
  .track {
    position: relative;
    height: 6px;
    border-radius: 3px;
    background: #2a2a4a;
    cursor: pointer;
  }
  .track:hover { background: #32325a; }
  .fill {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    width: 0%;
    border-radius: 3px;
    background: #4f6ef7;
    pointer-events: none;
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
  button {
    background: transparent;
    border: none;
    color: #c0c0e0;
    font-size: 16px;
    cursor: pointer;
    padding: 4px 6px;
    min-width: 30px;
    height: 30px;
    border-radius: 6px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  button:hover { background: #2a2a4a; }
  button:focus-visible {
    outline: 2px solid #6b8aff;
    outline-offset: 2px;
  }
  button.play {
    color: #4ade80;
    font-size: 20px;
  }
  button.speed {
    font-size: 12px;
    font-weight: 700;
    color: #4f6ef7;
    min-width: 42px;
    font-variant-numeric: tabular-nums;
  }
  button.close { color: #9a9ac0; font-size: 16px; }
  button.close:hover { color: #ff8888; background: #2a1a1a; }
  .warning {
    position: fixed;
    bottom: 130px;
    right: 24px;
    z-index: 2147483647;
    box-sizing: border-box;
    background: #2a1a1a;
    border: 1px solid #6a3a3a;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 12px;
    color: #ffaaaa;
    font-family: system-ui, sans-serif;
    max-width: 260px;
  }
`

function makeButton(cls: string, label: string, aria: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = cls
  btn.textContent = label
  btn.title = aria
  btn.setAttribute('aria-label', aria)
  btn.onclick = onClick
  return btn
}

function nearestSpeedLabel(rate: number): string {
  // Snap to the closest preset for display so the label always shows a clean value.
  let best = SPEED_STEPS[0]
  let bestDiff = Infinity
  for (const s of SPEED_STEPS) {
    const d = Math.abs(s - rate)
    if (d < bestDiff) { bestDiff = d; best = s }
  }
  return `${best}x`
}

function cycleSpeed() {
  const cur = getSpeed()
  // Find the nearest preset, then advance to the next one (wrapping around).
  let idx = 0
  let bestDiff = Infinity
  for (let i = 0; i < SPEED_STEPS.length; i++) {
    const d = Math.abs(SPEED_STEPS[i] - cur)
    if (d < bestDiff) { bestDiff = d; idx = i }
  }
  const nextRate = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length]
  setSpeed(nextRate)
  refreshSpeedLabel()
}

function refreshSpeedLabel() {
  if (speedBtn) speedBtn.textContent = nearestSpeedLabel(getSpeed())
}

function renderProgress() {
  if (progressLabel) {
    progressLabel.textContent = curTotal > 0
      ? `Sentence ${Math.min(curIndex + 1, curTotal)} / ${curTotal}`
      : 'Sentence – / –'
  }
  if (progressFill) {
    const pct = curTotal > 1 ? (curIndex / (curTotal - 1)) * 100 : (curTotal === 1 ? 100 : 0)
    progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`
  }
}

function seekFromClientX(clientX: number) {
  if (!progressTrack || curTotal <= 0) return
  const rect = progressTrack.getBoundingClientRect()
  if (rect.width <= 0) return
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  const target = Math.round(ratio * (curTotal - 1))
  // Update the fill immediately for responsiveness.
  curIndex = target
  renderProgress()
  seekTo(target)
}

export function showWidget() {
  if (host) return

  host = document.createElement('div')
  host.className = 'cxt-player-host'
  shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = WIDGET_CSS

  const player = document.createElement('div')
  player.className = 'player'

  // ── Header (drag handle) ──────────────────────────────────────────────
  const header = document.createElement('div')
  header.className = 'header'

  const title = document.createElement('div')
  title.className = 'title'
  const dot = document.createElement('span')
  dot.className = 'dot'
  dot.textContent = '●'
  const titleText = document.createElement('span')
  titleText.textContent = 'Read Aloud'
  title.append(dot, titleText)

  const closeBtn = makeButton('close', '⏹', 'Stop', () => { stop(); hideWidget() })

  header.append(title, closeBtn)

  // ── Progress ──────────────────────────────────────────────────────────
  const progressRow = document.createElement('div')
  progressRow.className = 'progress-row'

  progressLabel = document.createElement('div')
  progressLabel.className = 'progress-label'

  progressTrack = document.createElement('div')
  progressTrack.className = 'track'
  progressTrack.setAttribute('role', 'slider')
  progressTrack.setAttribute('aria-label', 'Seek to sentence')
  progressTrack.title = 'Seek to sentence'

  progressFill = document.createElement('div')
  progressFill.className = 'fill'
  progressTrack.appendChild(progressFill)

  attachSeekHandlers(progressTrack)

  progressRow.append(progressLabel, progressTrack)

  // ── Controls ──────────────────────────────────────────────────────────
  const controls = document.createElement('div')
  controls.className = 'controls'

  const prevBtn = makeButton('prev', '⏮', 'Previous sentence', () => prev())
  const replayBtn = makeButton('replay', '↺', 'Replay current sentence', () => replay())
  pauseBtn = makeButton('play', '⏸', 'Pause', togglePause)
  const nextBtn = makeButton('next', '⏭', 'Next sentence', () => next())

  speedBtn = makeButton('speed', `${getSpeed()}x`, 'Playback speed', cycleSpeed)

  controls.append(prevBtn, replayBtn, pauseBtn, nextBtn, speedBtn)

  player.append(header, progressRow, controls)
  shadow.append(style, player)
  document.body.appendChild(host)

  renderProgress()
  refreshSpeedLabel()
  makeDraggable(player, header)
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
  refreshSpeedLabel()
}

export function updateWidgetProgress(index: number, total: number) {
  if (typeof index === 'number' && index >= 0) curIndex = index
  if (typeof total === 'number' && total >= 0) curTotal = total
  renderProgress()
}

export function hideWidget() {
  host?.remove()
  host = null
  shadow = null
  pauseBtn = null
  speedBtn = null
  progressLabel = null
  progressFill = null
  progressTrack = null
  curIndex = 0
  curTotal = 0
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

function attachSeekHandlers(track: HTMLElement) {
  track.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    seekFromClientX(e.clientX)

    const onMove = (ev: MouseEvent) => {
      seekFromClientX(ev.clientX)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, { capture: true })
      document.removeEventListener('mouseup', onUp, { capture: true })
    }
    document.addEventListener('mousemove', onMove, { capture: true })
    document.addEventListener('mouseup', onUp, { capture: true })
  })

  // Keyboard support for the slider.
  track.tabIndex = 0
  track.addEventListener('keydown', (e: KeyboardEvent) => {
    if (curTotal <= 0) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      seekTo(Math.min(curIndex + 1, curTotal - 1))
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      seekTo(Math.max(curIndex - 1, 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      seekTo(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      seekTo(curTotal - 1)
    }
  })
}

function makeDraggable(el: HTMLElement, handle: HTMLElement) {
  let startX = 0, startY = 0, origRight = 24, origBottom = 24
  el.style.right = `${origRight}px`
  el.style.bottom = `${origBottom}px`

  handle.addEventListener('mousedown', (e: MouseEvent) => {
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
