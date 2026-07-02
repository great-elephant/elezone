import { pause, resume, stop, getState, next, prev, replay, seekTo, setSpeed, getSpeed, setVoice } from './readAloud'
import { setFocusMode, isFocusMode } from './readAloudOverlay'
import { TtsVoiceInfo } from '../../shared/types'

let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let pauseBtn: HTMLButtonElement | null = null
let focusBtn: HTMLButtonElement | null = null
let speedBtn: HTMLButtonElement | null = null
let voiceChip: HTMLButtonElement | null = null
let voiceMenu: HTMLElement | null = null
let progressLabel: HTMLElement | null = null
let progressFill: HTMLElement | null = null
let progressTrack: HTMLElement | null = null
let warningBanner: HTMLElement | null = null

let curIndex = 0
let curTotal = 0
let curVoice = ''
let curLang = ''

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
  button.focus.active {
    color: #ffd93d;
    background: #2a2a4a;
  }
  button.focus.active:hover { background: #32325a; }
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
  /* Calm voice/language chip (replaces the scary mismatch banner). */
  .voice-row {
    position: relative;
    display: flex;
    align-items: center;
  }
  button.voice-chip {
    font-size: 11px;
    font-weight: 600;
    color: #a8b0d8;
    background: #22223e;
    border: 1px solid #33335a;
    height: 24px;
    min-width: 0;
    max-width: 100%;
    padding: 0 8px;
    border-radius: 12px;
    gap: 5px;
    justify-content: flex-start;
    overflow: hidden;
  }
  button.voice-chip:hover { background: #2a2a4a; color: #c8d0f0; }
  .voice-chip .vc-lang {
    color: #6b8aff;
    font-weight: 700;
    letter-spacing: 0.02em;
    flex: 0 0 auto;
  }
  .voice-chip .vc-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .voice-chip .vc-caret { flex: 0 0 auto; font-size: 9px; color: #7a7aa8; }
  .voice-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 1;
    box-sizing: border-box;
    width: 236px;
    max-height: 240px;
    overflow-y: auto;
    background: #16162a;
    border: 1px solid #3a3a6a;
    border-radius: 10px;
    padding: 4px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.55);
  }
  .voice-menu-empty {
    padding: 10px 12px;
    font-size: 11px;
    color: #8a8ab0;
    line-height: 1.4;
  }
  .voice-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border-radius: 7px;
    font-size: 12px;
    color: #c0c0e0;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    height: auto;
    min-width: 0;
  }
  .voice-option:hover, .voice-option.focused { background: #2a2a4a; }
  .voice-option[aria-selected="true"] { color: #4ade80; }
  .voice-option .vo-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .voice-option .vo-lang {
    flex: 0 0 auto;
    font-size: 10px;
    color: #7a7aa8;
    font-variant-numeric: tabular-nums;
  }
  .voice-option .vo-check { flex: 0 0 auto; color: #4ade80; font-size: 11px; width: 12px; }
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

function refreshFocusButton() {
  if (!focusBtn) return
  const on = isFocusMode()
  focusBtn.classList.toggle('active', on)
  const label = on ? 'Focus mode: on' : 'Focus mode: off'
  focusBtn.title = label
  focusBtn.setAttribute('aria-label', label)
  focusBtn.setAttribute('aria-pressed', String(on))
}

function toggleFocusMode() {
  setFocusMode(!isFocusMode())
  refreshFocusButton()
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

// ── Voice chip / picker (D15, D16) ──────────────────────────────────────────

// Short, friendly voice label: drop noisy vendor prefixes like
// "Google US English" / "Microsoft David - English (United States)".
function shortVoiceName(name: string): string {
  if (!name) return ''
  let n = name.replace(/^(Google|Microsoft|Chrome OS|eSpeak)\s+/i, '')
  n = n.split(/\s+[-–]\s+/)[0]
  return n.trim() || name
}

function langCode(lang: string): string {
  if (!lang) return ''
  // Show a compact code: primary subtag upper-cased (e.g. en-US -> EN).
  return lang.split('-')[0].toUpperCase()
}

// The chip shows "EN · Samantha ▾". When we don't yet know the voice name
// (some voices never report one) we still show the language calmly.
function renderVoiceChip() {
  if (!voiceChip) return
  const lang = langCode(curLang)
  const name = shortVoiceName(curVoice)

  voiceChip.replaceChildren()
  if (lang) {
    const langEl = document.createElement('span')
    langEl.className = 'vc-lang'
    langEl.textContent = lang
    voiceChip.appendChild(langEl)
  }
  if (lang && name) {
    const sep = document.createElement('span')
    sep.textContent = '·'
    sep.style.color = '#55557a'
    voiceChip.appendChild(sep)
  }
  const nameEl = document.createElement('span')
  nameEl.className = 'vc-name'
  nameEl.textContent = name || (lang ? 'Auto voice' : 'Voice')
  voiceChip.appendChild(nameEl)

  const caret = document.createElement('span')
  caret.className = 'vc-caret'
  caret.textContent = '▾'
  voiceChip.appendChild(caret)

  const full = [lang && `Language ${lang}`, curVoice ? `Voice: ${curVoice}` : 'Auto-selected voice']
    .filter(Boolean).join(' — ')
  voiceChip.title = `${full}\nClick to change voice`
  voiceChip.setAttribute('aria-label', `Voice: ${name || 'auto'}${lang ? `, language ${lang}` : ''}. Click to change.`)
}

export function updateWidgetVoice(voice: string, lang: string) {
  if (typeof voice === 'string') curVoice = voice
  if (typeof lang === 'string') curLang = lang
  renderVoiceChip()
  // If the picker is open, keep the selected/checked marker in sync.
  if (voiceMenu) markSelectedOption()
}

let voiceMenuVoices: TtsVoiceInfo[] = []

function toggleVoiceMenu() {
  if (voiceMenu) closeVoiceMenu()
  else void openVoiceMenu()
}

function closeVoiceMenu() {
  voiceMenu?.remove()
  voiceMenu = null
  voiceChip?.setAttribute('aria-expanded', 'false')
  document.removeEventListener('mousedown', onDocMouseDownForMenu, { capture: true })
}

function onDocMouseDownForMenu(e: MouseEvent) {
  // Clicks land on the shadow host from the document's perspective; close only
  // when the click is truly outside our widget host.
  if (host && e.composedPath().includes(host)) return
  closeVoiceMenu()
}

async function openVoiceMenu() {
  if (!voiceChip || !voiceChip.parentElement) return

  voiceMenu = document.createElement('div')
  voiceMenu.className = 'voice-menu'
  voiceMenu.setAttribute('role', 'listbox')
  voiceMenu.setAttribute('aria-label', 'Choose a voice')
  const loading = document.createElement('div')
  loading.className = 'voice-menu-empty'
  loading.textContent = 'Loading voices…'
  voiceMenu.appendChild(loading)
  voiceChip.parentElement.appendChild(voiceMenu)
  voiceChip.setAttribute('aria-expanded', 'true')
  document.addEventListener('mousedown', onDocMouseDownForMenu, { capture: true })
  voiceMenu.addEventListener('keydown', onVoiceMenuKeydown)

  // Fetch voices for the current language (background falls back to all
  // languages when nothing matches, so the list is never empty).
  let voices: TtsVoiceInfo[] = []
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_TTS_VOICES',
      payload: curLang ? { lang: curLang } : undefined,
    }) as { voices?: TtsVoiceInfo[] } | undefined
    voices = res?.voices ?? []
  } catch {
    voices = []
  }

  // The user may have closed it while we awaited.
  if (!voiceMenu) return
  voiceMenuVoices = voices
  renderVoiceOptions()
}

function renderVoiceOptions() {
  if (!voiceMenu) return
  voiceMenu.replaceChildren()

  if (voiceMenuVoices.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'voice-menu-empty'
    empty.textContent = 'No voices available. Try installing more system voices.'
    voiceMenu.appendChild(empty)
    return
  }

  for (const v of voiceMenuVoices) {
    const opt = document.createElement('button')
    opt.className = 'voice-option'
    opt.type = 'button'
    opt.setAttribute('role', 'option')
    opt.dataset.voice = v.voiceName

    const nameWrap = document.createElement('span')
    nameWrap.className = 'vo-name'
    const check = document.createElement('span')
    check.className = 'vo-check'
    check.textContent = v.voiceName === curVoice ? '✓' : ''
    const nameText = document.createElement('span')
    nameText.textContent = shortVoiceName(v.voiceName)
    nameText.title = v.voiceName
    nameWrap.append(check, nameText)

    const langSpan = document.createElement('span')
    langSpan.className = 'vo-lang'
    langSpan.textContent = v.lang || ''

    opt.append(nameWrap, langSpan)
    opt.setAttribute('aria-selected', String(v.voiceName === curVoice))
    opt.onclick = () => {
      setVoice(v.voiceName)
      // Optimistically reflect the choice; the background confirms via update.
      curVoice = v.voiceName
      renderVoiceChip()
      closeVoiceMenu()
    }
    voiceMenu.appendChild(opt)
  }

  // Focus the selected option (or the first) for keyboard navigation.
  const options = getVoiceOptionEls()
  const selectedIdx = options.findIndex(o => o.dataset.voice === curVoice)
  const focusIdx = selectedIdx >= 0 ? selectedIdx : 0
  options[focusIdx]?.classList.add('focused')
  options[focusIdx]?.focus()
}

function getVoiceOptionEls(): HTMLButtonElement[] {
  if (!voiceMenu) return []
  return Array.from(voiceMenu.querySelectorAll<HTMLButtonElement>('.voice-option'))
}

function markSelectedOption() {
  for (const opt of getVoiceOptionEls()) {
    const selected = opt.dataset.voice === curVoice
    opt.setAttribute('aria-selected', String(selected))
    const check = opt.querySelector<HTMLElement>('.vo-check')
    if (check) check.textContent = selected ? '✓' : ''
  }
}

function onVoiceMenuKeydown(e: KeyboardEvent) {
  const options = getVoiceOptionEls()
  if (options.length === 0) return
  const activeEl = (shadow?.activeElement as HTMLButtonElement) ?? null
  let idx = options.findIndex(o => o === activeEl)

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    idx = idx < 0 ? 0 : Math.min(idx + 1, options.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    idx = idx <= 0 ? 0 : idx - 1
  } else if (e.key === 'Home') {
    e.preventDefault()
    idx = 0
  } else if (e.key === 'End') {
    e.preventDefault()
    idx = options.length - 1
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeVoiceMenu()
    voiceChip?.focus()
    return
  } else {
    return
  }

  options.forEach(o => o.classList.remove('focused'))
  options[idx]?.classList.add('focused')
  options[idx]?.focus()
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

  // ── Voice chip (calm indicator + live picker) ─────────────────────────
  const voiceRow = document.createElement('div')
  voiceRow.className = 'voice-row'

  voiceChip = document.createElement('button')
  voiceChip.className = 'voice-chip'
  voiceChip.setAttribute('aria-haspopup', 'listbox')
  voiceChip.setAttribute('aria-expanded', 'false')
  voiceChip.onclick = toggleVoiceMenu
  voiceRow.appendChild(voiceChip)

  // ── Controls ──────────────────────────────────────────────────────────
  const controls = document.createElement('div')
  controls.className = 'controls'

  const prevBtn = makeButton('prev', '⏮', 'Previous sentence', () => prev())
  const replayBtn = makeButton('replay', '↺', 'Replay current sentence', () => replay())
  pauseBtn = makeButton('play', '⏸', 'Pause', togglePause)
  const nextBtn = makeButton('next', '⏭', 'Next sentence', () => next())

  focusBtn = makeButton('focus', '🔦', 'Focus mode: off', toggleFocusMode)

  speedBtn = makeButton('speed', `${getSpeed()}x`, 'Playback speed', cycleSpeed)

  controls.append(prevBtn, replayBtn, pauseBtn, nextBtn, focusBtn, speedBtn)

  player.append(header, progressRow, voiceRow, controls)
  shadow.append(style, player)
  document.body.appendChild(host)

  renderProgress()
  renderVoiceChip()
  refreshSpeedLabel()
  refreshFocusButton()
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
  // Reset focus mode so the next session starts with the spotlight off (default).
  setFocusMode(false)
  closeVoiceMenu()
  host?.remove()
  host = null
  shadow = null
  pauseBtn = null
  focusBtn = null
  speedBtn = null
  voiceChip = null
  voiceMenu = null
  progressLabel = null
  progressFill = null
  progressTrack = null
  curIndex = 0
  curTotal = 0
  curVoice = ''
  curLang = ''
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
