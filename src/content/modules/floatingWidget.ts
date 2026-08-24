import { pause, resume, stop, getState, next, prev, seekTo, setSpeed, getSpeed, setVoice, setShadowing, setRepetition } from './readAloud'
import { setFocusMode, isFocusMode } from './readAloudOverlay'
import { Settings, TtsVoiceInfo } from '../../shared/types'

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
// Secondary controls (voice, shadowing, repeat, speed) live in a "⋯" overflow
// popover instead of the always-visible player, so the main widget only shows
// transport controls (prev/play/next), focus mode, + progress at rest.
let overflowBtn: HTMLButtonElement | null = null
let overflowMenu: HTMLElement | null = null
// Live shadowing/repetition state mirrored from readAloud so the controls render
// the right values.
let curShadowing = false
let curRepetition = 1

// Volume control — lives next to focus mode on the right of the transport row.
// Unlike speed/shadowing/repetition, volume isn't part of the read-aloud
// session broadcast loop (it only applies at session start or via a live
// settings-triggered restart in the background), so it's read/written directly
// against the Settings object rather than through readAloud.ts.
let volumeBtn: HTMLButtonElement | null = null
let volumeWrap: HTMLElement | null = null
let volumePopover: HTMLElement | null = null
let volumeSlider: HTMLInputElement | null = null
let volumePctLabel: HTMLElement | null = null
let cachedSettings: Settings | null = null
let curVolume = 1

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
    border-radius: 10px;
    padding: 9px 11px;
    display: flex;
    flex-direction: column;
    gap: 7px;
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
    line-height: 1;
    color: #c0c0e0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .title .logo { width: 14px; height: 14px; object-fit: contain; display: block; flex-shrink: 0; }
  .progress-label {
    font-size: 11px;
    font-weight: 700;
    color: #a8b0d8;
    background: #22223e;
    border: 1px solid #33335a;
    border-radius: 5px;
    padding: 2px 6px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .track {
    position: relative;
    height: 5px;
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
    gap: 16px;
  }
  .controls-left, .controls-right {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .controls button {
    width: 28px;
    height: 28px;
    min-width: 28px;
    min-height: 28px;
    font-size: 15px;
  }
  button {
    background: transparent;
    border: none;
    color: #c0c0e0;
    font-size: 15px;
    cursor: pointer;
    padding: 3px 5px;
    min-width: 28px;
    min-height: 28px;
    height: 28px;
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
  svg.i { display: block; width: 15px; height: 15px; }
  .controls button.play svg.i { width: 16px; height: 16px; }
  .controls button.play {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    color: #ffffff;
    background: #4f6ef7;
    border-radius: 9px;
  }
  .controls button.play:hover { background: #6b8aff; }
  button.speed {
    font-size: 12px;
    font-weight: 700;
    color: #4f6ef7;
    min-width: 42px;
    font-variant-numeric: tabular-nums;
  }
  button.focus.active {
    color: #ffffff;
    background: #2a2a4a;
  }
  button.focus.active:hover { background: #32325a; }
  button.close { color: #9a9ac0; }
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
  .voice-option[aria-selected="true"] { color: #4f6ef7; }
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
  .voice-option .vo-check { flex: 0 0 auto; color: #4f6ef7; font-size: 11px; width: 12px; }

  .header-right {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  button.overflow-toggle { color: #9a9ac0; }
  .overflow-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 1;
    box-sizing: border-box;
    width: 208px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: #16162a;
    border: 1px solid #3a3a6a;
    border-radius: 10px;
    padding: 8px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.55);
  }
  .overflow-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }

  .volume-wrap { position: relative; }
  button.volume-toggle { color: #9a9ac0; }
  .volume-popover {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 1;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    background: #16162a;
    border: 1px solid #3a3a6a;
    border-radius: 10px;
    padding: 8px 6px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.55);
  }
  .volume-popover .volume-pct {
    font-size: 10px;
    font-weight: 700;
    color: #a8b0d8;
    width: 30px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .volume-popover input[type="range"] {
    writing-mode: vertical-lr;
    direction: rtl;
    width: 6px;
    height: 64px;
    margin: 0;
    accent-color: #4f6ef7;
    cursor: pointer;
  }

  /* Shadowing toggle + Repeat controls (now in the header) — H29/H31 */
  button.shadow-toggle {
    font-size: 14px;
    flex: 0 0 auto;
  }
  button.shadow-toggle.active {
    color: #4f6ef7;
    background: #232c56;
  }
  button.shadow-toggle.active:hover { background: #2b3568; }
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
  button.repeat.active { color: #4f6ef7; border-color: #3d4d99; }
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
  .done .check { color: #4f6ef7; font-size: 15px; line-height: 1; }
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

// Emoji glyphs (⏮⏸⏭🔦⏹) render as full-color, platform-specific pictures that
// clash with the widget's flat single-accent dark UI and look inconsistent
// across OSes. These are fixed, hardcoded markup strings (no user input), so
// building them via innerHTML is safe.
const ICON_PREV = '<svg class="i" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM19 5v14l-10-7z"/></svg>'
const ICON_NEXT = '<svg class="i" viewBox="0 0 24 24" fill="currentColor"><path d="M5 5v14l10-7zM16 5h2v14h-2z"/></svg>'
const ICON_PLAY = '<svg class="i" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg>'
const ICON_PAUSE = '<svg class="i" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
const ICON_STOP = '<svg class="i" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>'
// "Sun" — reads as light/illumination at a glance even at 15px, unlike a
// flashlight/torch silhouette which turned out illegible that small.
const ICON_FOCUS = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/></g></svg>'
const ICON_MORE = '<svg class="i" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>'
const ICON_VOLUME = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
const ICON_VOLUME_MUTE = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'

function makeIconButton(cls: string, icon: string, aria: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = cls
  btn.innerHTML = icon
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
  const next = !isFocusMode()
  setFocusMode(next)
  refreshFocusButton()
  persistFocus(next)
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

export function updateWidgetShadowInfo(shadowing: boolean, repetition: number) {
  if (typeof shadowing === 'boolean') curShadowing = shadowing
  if (typeof repetition === 'number' && repetition >= 1) curRepetition = Math.round(repetition)
  refreshShadowButton()
  refreshRepeatButton()
}

function renderProgress() {
  if (progressLabel) {
    progressLabel.textContent = curTotal > 0
      ? `${Math.min(curIndex + 1, curTotal)} / ${curTotal}`
      : '– / –'
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
  // Close on any click outside the menu itself and its own toggle (the chip) —
  // not just clicks outside the whole widget — so e.g. clicking a different
  // widget button while the list is open closes it too, rather than leaving
  // it stuck open behind/alongside whatever the click just did.
  const path = e.composedPath()
  if (voiceChip && path.includes(voiceChip)) return
  if (voiceMenu && path.includes(voiceMenu)) return
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

// ── Overflow ("⋯") popover — voice, shadowing, repeat, focus, speed, replay ──

function toggleOverflowMenu() {
  if (overflowMenu) closeOverflowMenu()
  else openOverflowMenu()
}

function onDocMouseDownForOverflow(e: MouseEvent) {
  // Same rationale as onDocMouseDownForMenu: bound to the popover + its own
  // toggle, not the whole widget, so clicking another widget button (e.g.
  // play/pause) while the popover is open closes it instead of leaving it
  // floating over the rest of the interaction.
  const path = e.composedPath()
  if (overflowBtn && path.includes(overflowBtn)) return
  if (overflowMenu && path.includes(overflowMenu)) return
  closeOverflowMenu()
}

function closeOverflowMenu() {
  // The voice submenu can be open nested inside; tear it down first so its own
  // outside-click listener doesn't linger after we remove its parent.
  closeVoiceMenu()
  overflowMenu?.remove()
  overflowMenu = null
  voiceChip = null
  shadowBtn = null
  repeatBtn = null
  speedBtn = null
  overflowBtn?.setAttribute('aria-expanded', 'false')
  document.removeEventListener('mousedown', onDocMouseDownForOverflow, { capture: true })
}

function openOverflowMenu() {
  if (!overflowBtn || !overflowBtn.parentElement) return

  overflowMenu = document.createElement('div')
  overflowMenu.className = 'overflow-menu'

  const voiceRow = document.createElement('div')
  voiceRow.className = 'voice-row'
  voiceChip = document.createElement('button')
  voiceChip.className = 'voice-chip'
  voiceChip.setAttribute('aria-haspopup', 'listbox')
  voiceChip.setAttribute('aria-expanded', 'false')
  voiceChip.onclick = toggleVoiceMenu
  voiceRow.appendChild(voiceChip)

  const row = document.createElement('div')
  row.className = 'overflow-row'
  shadowBtn = makeButton('shadow-toggle', '🗣', 'Shadowing mode: off', toggleShadowing)
  shadowBtn.setAttribute('aria-pressed', 'false')
  repeatBtn = makeButton('repeat', '↻ 1×', 'Repeat each sentence', cycleRepeat)
  speedBtn = makeButton('speed', `${getSpeed()}x`, 'Playback speed', cycleSpeed)
  row.append(shadowBtn, repeatBtn, speedBtn)

  overflowMenu.append(voiceRow, row)
  overflowBtn.parentElement.appendChild(overflowMenu)
  overflowBtn.setAttribute('aria-expanded', 'true')
  document.addEventListener('mousedown', onDocMouseDownForOverflow, { capture: true })

  renderVoiceChip()
  refreshSpeedLabel()
  refreshShadowButton()
  refreshRepeatButton()
}

// ── Volume popover ────────────────────────────────────────────────────────

function refreshVolumeIcon() {
  if (!volumeBtn) return
  volumeBtn.innerHTML = curVolume <= 0 ? ICON_VOLUME_MUTE : ICON_VOLUME
  const label = `Volume: ${Math.round(curVolume * 100)}%`
  volumeBtn.title = label
  volumeBtn.setAttribute('aria-label', label)
}

// Persists the live volume to settings so it survives across sessions, and
// (via the background's SAVE_SETTINGS handler) live-restarts the current
// utterance if reading is in progress.
function persistVolume(vol: number) {
  const base = cachedSettings
  if (!base) return
  cachedSettings = { ...base, updatedAt: Date.now(), readAloud: { ...base.readAloud, volume: vol } }
  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: cachedSettings }).catch(() => { })
}

function persistFocus(enabled: boolean) {
  const base = cachedSettings
  if (!base) return
  cachedSettings = { ...base, updatedAt: Date.now(), readAloud: { ...base.readAloud, focus: enabled } }
  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: cachedSettings }).catch(() => { })
}

function setVolumeLive(vol: number) {
  curVolume = Math.max(0, Math.min(1, vol))
  refreshVolumeIcon()
  if (volumeSlider) volumeSlider.value = String(curVolume)
  if (volumePctLabel) volumePctLabel.textContent = `${Math.round(curVolume * 100)}%`
  persistVolume(curVolume)
}

// Keep the widget's volume control in sync with changes made elsewhere (the
// popup's own volume slider, or another tab) — without this, cachedSettings
// only gets seeded once when the widget first shows, so it'd silently drift
// from whatever the popup last saved and could stomp it on the next local
// tweak.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes['settings']) return
  const next = changes['settings'].newValue as Settings | undefined
  if (!next) return
  cachedSettings = next
  const vol = next.readAloud?.volume ?? 1
  if (vol === curVolume) return
  curVolume = vol
  refreshVolumeIcon()
  if (volumeSlider) volumeSlider.value = String(curVolume)
  if (volumePctLabel) volumePctLabel.textContent = `${Math.round(curVolume * 100)}%`
})

function toggleVolumePopover() {
  if (volumePopover) closeVolumePopover()
  else openVolumePopover()
}

function onDocMouseDownForVolume(e: MouseEvent) {
  const path = e.composedPath()
  if (volumeWrap && path.includes(volumeWrap)) return
  closeVolumePopover()
}

function closeVolumePopover() {
  volumePopover?.remove()
  volumePopover = null
  volumeSlider = null
  volumePctLabel = null
  volumeBtn?.setAttribute('aria-expanded', 'false')
  document.removeEventListener('mousedown', onDocMouseDownForVolume, { capture: true })
}

function openVolumePopover() {
  if (!volumeWrap) return

  volumePopover = document.createElement('div')
  volumePopover.className = 'volume-popover'

  volumePctLabel = document.createElement('span')
  volumePctLabel.className = 'volume-pct'
  volumePctLabel.textContent = `${Math.round(curVolume * 100)}%`

  volumeSlider = document.createElement('input')
  volumeSlider.type = 'range'
  volumeSlider.min = '0'
  volumeSlider.max = '1'
  volumeSlider.step = '0.05'
  volumeSlider.value = String(curVolume)
  volumeSlider.setAttribute('aria-label', 'Read-aloud volume')
  volumeSlider.oninput = () => setVolumeLive(parseFloat(volumeSlider!.value))

  volumePopover.append(volumePctLabel, volumeSlider)
  volumeWrap.appendChild(volumePopover)
  volumeBtn?.setAttribute('aria-expanded', 'true')
  document.addEventListener('mousedown', onDocMouseDownForVolume, { capture: true })
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
  const logo = document.createElement('img')
  logo.className = 'logo'
  logo.src = chrome.runtime.getURL('icons/logo.png')
  logo.alt = ''
  const titleText = document.createElement('span')
  titleText.textContent = 'Read Aloud'

  // The sentence counter sits right next to the title (not its own row), so
  // the title/counter/overflow-menu toggle share a single draggable line and
  // the seek track is the only thing left below it.
  progressLabel = document.createElement('span')
  progressLabel.className = 'progress-label'

  title.append(logo, titleText, progressLabel)

  overflowBtn = makeIconButton('overflow-toggle', ICON_MORE, 'More options', toggleOverflowMenu)
  overflowBtn.setAttribute('aria-haspopup', 'true')
  overflowBtn.setAttribute('aria-expanded', 'false')

  const headerRight = document.createElement('div')
  headerRight.className = 'header-right'
  headerRight.append(overflowBtn)

  header.append(title, headerRight)

  // ── Progress (seek track only — the counter moved into the header) ─────
  const progressRow = document.createElement('div')
  progressRow.className = 'progress-row'

  progressTrack = document.createElement('div')
  progressTrack.className = 'track'
  progressTrack.setAttribute('role', 'slider')
  progressTrack.setAttribute('aria-label', 'Seek to sentence')
  progressTrack.title = 'Seek to sentence'

  progressFill = document.createElement('div')
  progressFill.className = 'fill'
  progressTrack.appendChild(progressFill)

  attachSeekHandlers(progressTrack)

  progressRow.append(progressTrack)

  // ── Controls (transport + stop on the left; focus mode + volume on the
  // right — voice/shadowing/repeat/speed live in the "⋯" overflow popover) ──
  const controls = document.createElement('div')
  controls.className = 'controls'

  const controlsLeft = document.createElement('div')
  controlsLeft.className = 'controls-left'

  const prevBtn = makeIconButton('prev', ICON_PREV, 'Previous sentence', () => prev())
  pauseBtn = makeIconButton('play', ICON_PAUSE, 'Pause', togglePause)
  const nextBtn = makeIconButton('next', ICON_NEXT, 'Next sentence', () => next())

  // Play/pause is a two-state toggle; expose it to AT via aria-pressed
  // (pressed = currently playing).
  pauseBtn.setAttribute('aria-pressed', 'true')

  const closeBtn = makeIconButton('close', ICON_STOP, 'Stop', () => { stop(); hideWidget() })

  controlsLeft.append(prevBtn, pauseBtn, nextBtn, closeBtn)

  const controlsRight = document.createElement('div')
  controlsRight.className = 'controls-right'

  focusBtn = makeIconButton('focus', ICON_FOCUS, 'Focus mode: off', toggleFocusMode)

  volumeWrap = document.createElement('div')
  volumeWrap.className = 'volume-wrap'
  volumeBtn = makeIconButton('volume-toggle', ICON_VOLUME, 'Volume', toggleVolumePopover)
  volumeBtn.setAttribute('aria-haspopup', 'true')
  volumeBtn.setAttribute('aria-expanded', 'false')
  // Scroll-to-adjust while the popover is open, mirroring the popup's volume control.
  volumeWrap.onwheel = (e) => {
    if (!volumePopover) return
    e.preventDefault()
    setVolumeLive(curVolume + (e.deltaY < 0 ? 1 : -1) * 0.05)
  }
  volumeWrap.appendChild(volumeBtn)

  controlsRight.append(focusBtn, volumeWrap)

  controls.append(controlsLeft, controlsRight)

  player.append(header, progressRow, controls)
  shadow.append(style, player)
  document.body.appendChild(host)

  renderProgress()
  refreshFocusButton()
  refreshVolumeIcon()
  makeDraggable(player, header)

  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((s: Settings) => {
    cachedSettings = s
    curVolume = s?.readAloud?.volume ?? 1
    refreshVolumeIcon()
    setFocusMode(s?.readAloud?.focus === true)
    refreshFocusButton()
  }).catch(() => { })
}

export function updateWidgetState(state: 'playing' | 'paused' | 'idle') {
  if (!pauseBtn) return
  if (state === 'playing') {
    pauseBtn.innerHTML = ICON_PAUSE
    pauseBtn.title = 'Pause'
    pauseBtn.setAttribute('aria-label', 'Pause')
    pauseBtn.setAttribute('aria-pressed', 'true')
  } else if (state === 'paused') {
    pauseBtn.innerHTML = ICON_PLAY
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
  // Clear the transient spotlight while the widget is torn down; the persisted
  // focus setting (if on) is re-applied on next showWidget().
  setFocusMode(false)
  // Tears down the overflow popover (and any nested voice submenu), clearing
  // their document-level outside-click listeners along with voiceChip/
  // shadowBtn/repeatBtn/speedBtn.
  closeOverflowMenu()
  overflowBtn = null
  // Tears down the volume popover + its own outside-click listener.
  closeVolumePopover()
  volumeBtn = null
  volumeWrap = null
  cachedSettings = null
  host?.remove()
  host = null
  shadow = null
  pauseBtn = null
  focusBtn = null
  progressLabel = null
  progressFill = null
  progressTrack = null
  curIndex = 0
  curTotal = 0
  curVoice = ''
  curLang = ''
  // Note: curShadowing / curRepetition are intentionally NOT reset here so the
  // next session's mini-player renders the last-used values before the first
  // background broadcast (they're re-seeded from settings on start anyway).
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

    const rect = el.getBoundingClientRect()
    const elWidth = rect.width
    const elHeight = rect.height
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    const scrollbarHeight = window.innerHeight - document.documentElement.clientHeight
    const availableWidth = window.innerWidth - scrollbarWidth
    const availableHeight = window.innerHeight - scrollbarHeight
    const maxRight = Math.max(0, availableWidth - elWidth)
    const maxBottom = Math.max(0, availableHeight - elHeight)

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      origRight = Math.max(0, Math.min(origRight - dx, maxRight))
      origBottom = Math.max(0, Math.min(origBottom - dy, maxBottom))
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
