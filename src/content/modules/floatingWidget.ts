import { pause, resume, stop, getState, next, prev, replay, seekTo, setSpeed, getSpeed, setVoice, setShadowing, setRepetition } from './readAloud'
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
// H29/H30/H31 — learner controls.
let shadowBtn: HTMLButtonElement | null = null
let repeatBtn: HTMLButtonElement | null = null
let shadowIndicator: HTMLElement | null = null
// Live shadowing/repetition state mirrored from readAloud so the controls render
// the right values.
let curShadowing = false
let curRepetition = 1
let curInGap = false

// Per-sentence repetition presets shown by the Repeat control (H31).
const REPEAT_STEPS = [1, 2, 3]

// Finished card (F22) — a separate lightweight host so it doesn't entangle the
// player refs; shown when reading ends naturally.
let finishedHost: HTMLElement | null = null

let curIndex = 0
let curTotal = 0
let curVoice = ''
let curLang = ''

// Restart-from-top callback (F22 Replay). Set by the content entry so Replay
// mirrors the popup's Start path (settings + translation), not just start().
let onReplayFromTop: (() => void) | null = null

export function setOnReplay(cb: () => void) {
  onReplayFromTop = cb
}

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
    min-width: 32px;
    min-height: 32px;
    height: 32px;
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
    height: 28px;
    min-height: 28px;
    min-width: 0;
    max-width: 100%;
    padding: 0 10px;
    border-radius: 14px;
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

  .header-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Shadowing toggle + Repeat controls (now in the header) — H29/H31 */
  button.shadow-toggle {
    font-size: 14px;
    flex: 0 0 auto;
  }
  button.shadow-toggle.active {
    color: #4ade80;
    background: #21322a;
  }
  button.shadow-toggle.active:hover { background: #294032; }
  button.repeat {
    font-size: 11px;
    font-weight: 700;
    color: #a8b0d8;
    background: #22223e;
    border: 1px solid #33335a;
    min-width: 46px;
    height: 28px;
    min-height: 28px;
    border-radius: 14px;
    padding: 0 10px;
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
  button.repeat:hover { background: #2a2a4a; color: #c8d0f0; }
  button.repeat.active { color: #4ade80; border-color: #2f5a42; }
  /* Subtle "shadowing…" gap indicator (replaces the ● dot in the title). */
  .title .shadow-hint {
    color: #4ade80;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .title .shadow-hint .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4ade80;
    animation: cxt-shadow-pulse 1s ease-in-out infinite;
  }
  @keyframes cxt-shadow-pulse {
    0%, 100% { opacity: 0.35; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1.15); }
  }
  @media (prefers-reduced-motion: reduce) {
    .title .shadow-hint .pulse { animation: none; opacity: 0.8; }
  }
`

// The Finished card (F22) is its own tiny host with self-contained styles.
const FINISHED_CSS = `
  :host { all: initial; }
  .card {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    box-sizing: border-box;
    width: 260px;
    background: #1a1a2e;
    border: 1px solid #3a3a6a;
    border-radius: 12px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
    color: #c0c0e0;
    user-select: none;
  }
  .card * { box-sizing: border-box; }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .done {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: #c0c0e0;
  }
  .done .check { color: #4ade80; font-size: 15px; line-height: 1; }
  .actions { display: flex; gap: 8px; }
  button {
    font-family: system-ui, sans-serif;
    cursor: pointer;
    border-radius: 8px;
    line-height: 1;
  }
  button.replay {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 34px;
    font-size: 13px;
    font-weight: 600;
    color: #ffffff;
    background: #4f6ef7;
    border: none;
  }
  button.replay:hover { background: #6b8aff; }
  button.replay:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }
  button.dismiss {
    width: 34px;
    height: 34px;
    font-size: 15px;
    color: #9a9ac0;
    background: transparent;
    border: 1px solid #33335a;
  }
  button.dismiss:hover { color: #ff8888; background: #2a1a1a; }
  button.dismiss:focus-visible { outline: 2px solid #6b8aff; outline-offset: 2px; }
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

// ── Learner controls (H29 shadowing, H31 repeat, H30 save) ────────────────────

function refreshShadowButton() {
  if (!shadowBtn) return
  shadowBtn.classList.toggle('active', curShadowing)
  const label = curShadowing ? 'Shadowing mode: on' : 'Shadowing mode: off'
  shadowBtn.title = `${label}\nPauses between sentences so you can repeat aloud`
  shadowBtn.setAttribute('aria-label', label)
  shadowBtn.setAttribute('aria-pressed', String(curShadowing))
}

function toggleShadowing() {
  curShadowing = !curShadowing
  setShadowing(curShadowing)
  refreshShadowButton()
  // If shadowing is turned off, drop any lingering "shadowing…" indicator.
  if (!curShadowing) { curInGap = false; refreshShadowIndicator() }
}

function refreshRepeatButton() {
  if (!repeatBtn) return
  repeatBtn.textContent = `↻ ${curRepetition}×`
  repeatBtn.classList.toggle('active', curRepetition > 1)
  const label = `Repeat each sentence ${curRepetition}×`
  repeatBtn.title = `${label}\nClick to change`
  repeatBtn.setAttribute('aria-label', label)
}

function cycleRepeat() {
  // Advance to the next preset (wrapping), snapping the current value onto the
  // nearest step first so an out-of-range value from settings still cycles cleanly.
  let idx = REPEAT_STEPS.indexOf(curRepetition)
  if (idx < 0) {
    let bestDiff = Infinity
    for (let i = 0; i < REPEAT_STEPS.length; i++) {
      const d = Math.abs(REPEAT_STEPS[i] - curRepetition)
      if (d < bestDiff) { bestDiff = d; idx = i }
    }
  }
  curRepetition = REPEAT_STEPS[(idx + 1) % REPEAT_STEPS.length]
  setRepetition(curRepetition)
  refreshRepeatButton()
}

// Subtle "shadowing…" hint in the title, shown only during the intentional gap.
function refreshShadowIndicator() {
  if (!shadowIndicator) return
  const show = curShadowing && curInGap
  shadowIndicator.style.display = show ? 'inline-flex' : 'none'
}

export function updateWidgetShadowInfo(shadowing: boolean, repetition: number, inGap: boolean) {
  if (typeof shadowing === 'boolean') curShadowing = shadowing
  if (typeof repetition === 'number' && repetition >= 1) curRepetition = Math.round(repetition)
  if (typeof inGap === 'boolean') curInGap = inGap
  refreshShadowButton()
  refreshRepeatButton()
  refreshShadowIndicator()
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
  // Subtle "shadowing…" indicator shown only during the intentional inter-
  // sentence gap (H29). Hidden by default.
  shadowIndicator = document.createElement('span')
  shadowIndicator.className = 'shadow-hint'
  shadowIndicator.style.display = 'none'
  const pulse = document.createElement('span')
  pulse.className = 'pulse'
  const shadowHintText = document.createElement('span')
  shadowHintText.textContent = 'shadowing…'
  shadowIndicator.append(pulse, shadowHintText)
  title.append(dot, titleText, shadowIndicator)

  shadowBtn = makeButton('shadow-toggle', '🗣', 'Shadowing mode: off', toggleShadowing)
  shadowBtn.setAttribute('aria-pressed', 'false')

  repeatBtn = makeButton('repeat', '↻ 1×', 'Repeat each sentence', cycleRepeat)

  const closeBtn = makeButton('close', '⏹', 'Stop', () => { stop(); hideWidget() })

  const headerRight = document.createElement('div')
  headerRight.className = 'header-right'
  headerRight.append(shadowBtn, repeatBtn, closeBtn)

  header.append(title, headerRight)

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

  // Play/pause is a two-state toggle; expose it to AT via aria-pressed
  // (pressed = currently playing).
  pauseBtn.setAttribute('aria-pressed', 'true')

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
  refreshShadowButton()
  refreshRepeatButton()
  refreshShadowIndicator()
  makeDraggable(player, header)
}

export function updateWidgetState(state: 'playing' | 'paused' | 'idle') {
  if (!pauseBtn) return
  if (state === 'playing') {
    pauseBtn.textContent = '⏸'
    pauseBtn.title = 'Pause'
    pauseBtn.setAttribute('aria-label', 'Pause')
    pauseBtn.setAttribute('aria-pressed', 'true')
  } else if (state === 'paused') {
    pauseBtn.textContent = '▶'
    pauseBtn.title = 'Resume'
    pauseBtn.setAttribute('aria-label', 'Resume')
    pauseBtn.setAttribute('aria-pressed', 'false')
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
  shadowBtn = null
  repeatBtn = null
  shadowIndicator = null
  curIndex = 0
  curTotal = 0
  curVoice = ''
  curLang = ''
  // Note: curShadowing / curRepetition are intentionally NOT reset here so the
  // next session's mini-player renders the last-used values before the first
  // background broadcast (they're re-seeded from settings on start anyway).
  curInGap = false
  hideWarning()
}

// ── Finished card (F22) ───────────────────────────────────────────────────────

/**
 * Replace the mini-player with a "✓ Finished" card offering Replay (restart
 * from the top) and a dismiss. Shown only when reading ends *naturally*; a plain
 * user stop just hides the widget. Tears down the live player first so we never
 * show both at once.
 */
export function showFinishedCard() {
  // The player and the finished card are mutually exclusive.
  hideWidget()
  hideFinishedCard()

  finishedHost = document.createElement('div')
  finishedHost.className = 'cxt-player-host'
  const fShadow = finishedHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = FINISHED_CSS

  const card = document.createElement('div')
  card.className = 'card'

  const row = document.createElement('div')
  row.className = 'row'

  const done = document.createElement('div')
  done.className = 'done'
  const check = document.createElement('span')
  check.className = 'check'
  check.textContent = '✓'
  const doneText = document.createElement('span')
  doneText.textContent = 'Finished'
  done.append(check, doneText)
  row.appendChild(done)

  const actions = document.createElement('div')
  actions.className = 'actions'

  const replayBtn = document.createElement('button')
  replayBtn.className = 'replay'
  replayBtn.type = 'button'
  replayBtn.textContent = '↺ Replay'
  replayBtn.title = 'Replay from the top'
  replayBtn.setAttribute('aria-label', 'Replay from the top')
  replayBtn.onclick = () => {
    hideFinishedCard()
    // Restart from the top via the popup-equivalent Start path (settings +
    // translation), falling back to nothing if not wired.
    onReplayFromTop?.()
  }

  const dismissBtn = document.createElement('button')
  dismissBtn.className = 'dismiss'
  dismissBtn.type = 'button'
  dismissBtn.textContent = '✕'
  dismissBtn.title = 'Dismiss'
  dismissBtn.setAttribute('aria-label', 'Dismiss')
  dismissBtn.onclick = () => hideFinishedCard()

  actions.append(replayBtn, dismissBtn)

  card.append(row, actions)
  fShadow.append(style, card)
  document.body.appendChild(finishedHost)
  replayBtn.focus()
}

export function hideFinishedCard() {
  finishedHost?.remove()
  finishedHost = null
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
