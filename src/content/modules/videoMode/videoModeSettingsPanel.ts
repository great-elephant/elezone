// The ⚙ panel that opens over the subtitle strip.
//
// Follows progressive disclosure: the handful of settings that change how a
// session feels are up front, and the rest is folded away under Advanced.

import type { VideoModeSettings, EndOfLinePause } from '../../../shared/types'

type ChangeHandler = (patch: Partial<VideoModeSettings>) => void

let _host: HTMLElement | null = null
let _shadow: ShadowRoot | null = null
let _settings: VideoModeSettings | null = null
let _onChange: ChangeHandler | null = null
let _advancedOpen = false

const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }

  .panel {
    position: fixed;
    z-index: 2147483645;
    width: 420px;
    max-height: 70vh;
    overflow-y: auto;
    background: rgba(16, 18, 26, 0.98);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    box-shadow: 0 12px 48px rgba(0,0,0,0.7);
    padding: 14px;
    font-family: 'Netflix Sans', 'Segoe UI', system-ui, -apple-system, sans-serif;
    color: #e8e8f0;
    font-size: 13px;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.18) transparent;
  }

  .section-label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: rgba(255,255,255,0.4);
    margin-bottom: 8px;
  }


  .divider { height: 1px; background: rgba(255,255,255,0.08); margin: 12px 0; }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 2px;
  }
  .row-label { flex: 1; min-width: 0; }
  .row-hint { font-size: 11px; color: rgba(255,255,255,0.42); margin-top: 2px; line-height: 1.4; }

  .toggle {
    position: relative;
    width: 34px; height: 19px;
    border-radius: 10px;
    border: none;
    background: #3a3a5a;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .toggle.on { background: #4f6ef7; }
  .thumb {
    position: absolute;
    top: 2.5px; left: 2.5px;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: left 0.15s;
  }
  .toggle.on .thumb { left: 17.5px; }

  select, input[type="number"] {
    background: #22243a;
    color: #e8e8f0;
    border: 1px solid rgba(255,255,255,0.14);
    border-radius: 6px;
    padding: 4px 7px;
    font-size: 12.5px;
    font-family: inherit;
  }
  input[type="number"] { width: 62px; }
  input[type="range"] { flex: 1; accent-color: #4f6ef7; }
  .value { font-size: 11.5px; color: rgba(255,255,255,0.55); width: 44px; text-align: right; font-variant-numeric: tabular-nums; }

  .adv-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    color: rgba(255,255,255,0.65);
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    padding: 4px 0;
    width: 100%;
  }
  .adv-toggle:hover { color: #fff; }
  .chevron { transition: transform 0.15s; }
  .chevron.open { transform: rotate(90deg); }
  .adv-body { display: none; padding-top: 4px; }
  .adv-body.open { display: block; }

  .keys {
    margin-top: 8px;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .key-row { display: flex; gap: 10px; padding: 3px 0; font-size: 11.5px; }
  kbd {
    background: #2c2e46;
    border: 1px solid rgba(255,255,255,0.16);
    border-bottom-width: 2px;
    border-radius: 4px;
    padding: 0 5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
    min-width: 46px;
    text-align: center;
    flex-shrink: 0;
  }
  .key-desc { color: rgba(255,255,255,0.6); }
`

const SHORTCUTS: Array<[string, string]> = [
  ['A / D', 'Previous / next line'],
  ['R', 'Replay this line'],
  ['Z', 'Show / hide translation'],
  ['Space', 'Continue when paused at a line'],
]

const END_OF_LINE_LABELS: Record<EndOfLinePause, string> = {
  off: "Don't pause",
  manual: 'Wait for Space',
  shadowing: 'Shadowing gap',
}

// ── Builders ──────────────────────────────────────────────────────────────────

function toggleRow(label: string, value: boolean, hint: string | null, onFlip: (next: boolean) => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'row'

  const labelWrap = document.createElement('div')
  labelWrap.className = 'row-label'
  const title = document.createElement('div')
  title.textContent = label
  labelWrap.appendChild(title)
  if (hint) {
    const hintEl = document.createElement('div')
    hintEl.className = 'row-hint'
    hintEl.textContent = hint
    labelWrap.appendChild(hintEl)
  }

  const btn = document.createElement('button')
  btn.className = `toggle${value ? ' on' : ''}`
  btn.setAttribute('role', 'switch')
  btn.setAttribute('aria-checked', String(value))
  btn.setAttribute('aria-label', label)
  btn.innerHTML = '<span class="thumb"></span>'
  btn.addEventListener('click', () => onFlip(!value))

  row.append(labelWrap, btn)
  return row
}

function numberRow(
  label: string,
  value: number,
  attrs: { min: number; max: number; step?: number },
  hint: string | null,
  onSet: (next: number) => void,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'row'

  const labelWrap = document.createElement('div')
  labelWrap.className = 'row-label'
  const title = document.createElement('div')
  title.textContent = label
  labelWrap.appendChild(title)
  if (hint) {
    const hintEl = document.createElement('div')
    hintEl.className = 'row-hint'
    hintEl.textContent = hint
    labelWrap.appendChild(hintEl)
  }

  const input = document.createElement('input')
  input.type = 'number'
  input.min = String(attrs.min)
  input.max = String(attrs.max)
  input.step = String(attrs.step ?? 1)
  input.value = String(value)
  input.addEventListener('change', () => {
    const parsed = Number(input.value)
    if (!Number.isFinite(parsed)) return
    const clamped = Math.min(attrs.max, Math.max(attrs.min, parsed))
    input.value = String(clamped)
    onSet(clamped)
  })

  row.append(labelWrap, input)
  return row
}

function selectRow<T extends string>(
  label: string,
  value: T,
  options: Array<[T, string]>,
  hint: string | null,
  onSet: (next: T) => void,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'row'

  const labelWrap = document.createElement('div')
  labelWrap.className = 'row-label'
  const title = document.createElement('div')
  title.textContent = label
  labelWrap.appendChild(title)
  if (hint) {
    const hintEl = document.createElement('div')
    hintEl.className = 'row-hint'
    hintEl.textContent = hint
    labelWrap.appendChild(hintEl)
  }

  const select = document.createElement('select')
  for (const [optValue, optLabel] of options) {
    const option = document.createElement('option')
    option.value = optValue
    option.textContent = optLabel
    if (optValue === value) option.selected = true
    select.appendChild(option)
  }
  select.addEventListener('change', () => onSet(select.value as T))

  row.append(labelWrap, select)
  return row
}

function render(): void {
  if (!_shadow || !_settings) return
  const settings = _settings
  const panel = _shadow.querySelector<HTMLElement>('.panel')
  if (!panel) return

  const scroll = panel.scrollTop
  panel.innerHTML = ''

  // ── Always-visible controls ──
  panel.appendChild(toggleRow('Translation', settings.showTranslation, null, next => {
    _onChange?.({ showTranslation: next })
  }))

  panel.appendChild(toggleRow(
    'Phonetics under words', settings.phoneticsUnderWords,
    'Shows IPA under each English word of the line being spoken.',
    next => _onChange?.({ phoneticsUnderWords: next }),
  ))

  // No row for the dialogue sidebar: its own button sits on the subtitle strip,
  // in view whenever the sidebar is, and a second switch for the same thing two
  // clicks deeper is only somewhere for the two to disagree.

  panel.appendChild(selectRow<EndOfLinePause>(
    'At the end of a line',
    settings.endOfLinePause,
    (Object.keys(END_OF_LINE_LABELS) as EndOfLinePause[]).map(k => [k, END_OF_LINE_LABELS[k]]),
    settings.endOfLinePause === 'shadowing'
      ? 'Freezes for as long as the line took to say, then plays on.'
      : null,
    next => _onChange?.({ endOfLinePause: next }),
  ))

  panel.appendChild(numberRow(
    'Repeat each line', settings.repeat, { min: 1, max: 5 },
    settings.endOfLinePause === 'shadowing'
      ? 'With a shadowing gap between every repeat.'
      : '1 means play each line once.',
    next => _onChange?.({ repeat: next }),
  ))

  panel.appendChild(toggleRow(
    'Pause on a saved word', settings.pauseOnSavedWord,
    'Stops when a line contains a word from your library.',
    next => _onChange?.({ pauseOnSavedWord: next }),
  ))

  panel.appendChild(divider())

  // ── Advanced ──
  const advToggle = document.createElement('button')
  advToggle.className = 'adv-toggle'
  advToggle.innerHTML = `
    <svg class="chevron${_advancedOpen ? ' open' : ''}" width="12" height="12" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6"></polyline>
    </svg>
    <span>Advanced</span>
  `
  advToggle.addEventListener('click', () => {
    _advancedOpen = !_advancedOpen
    render()
  })
  panel.appendChild(advToggle)

  const advBody = document.createElement('div')
  advBody.className = `adv-body${_advancedOpen ? ' open' : ''}`

  advBody.appendChild(toggleRow(
    'Hide sound effects', settings.hideSoundEffects,
    'Drops lines like "[door opens]" that describe sound rather than speech.',
    next => _onChange?.({ hideSoundEffects: next }),
  ))

  advBody.appendChild(numberRow(
    'Subtitle size', settings.subtitleFontSize, { min: 16, max: 48 }, 'Pixels.',
    next => _onChange?.({ subtitleFontSize: next }),
  ))

  advBody.appendChild(selectRow(
    'Translation from', settings.translationSource,
    [['auto', "The site's own subtitles, else machine"], ['machine', 'Always machine']],
    "A published translation reads better; machine translation stays closer to the literal wording.",
    next => _onChange?.({ translationSource: next }),
  ))

  advBody.appendChild(numberRow(
    'Shadowing gap', settings.shadowGapFactor, { min: 0.5, max: 3, step: 0.1 },
    'Multiplier on how long the line took to say.',
    next => _onChange?.({ shadowGapFactor: next }),
  ))

  advBody.appendChild(toggleRow('Keyboard shortcuts', settings.keyboardShortcuts, null, next => {
    _onChange?.({ keyboardShortcuts: next })
  }))

  const keys = document.createElement('div')
  keys.className = 'keys'
  for (const [key, desc] of SHORTCUTS) {
    const row = document.createElement('div')
    row.className = 'key-row'
    const kbd = document.createElement('kbd')
    kbd.textContent = key
    const label = document.createElement('span')
    label.className = 'key-desc'
    label.textContent = desc
    row.append(kbd, label)
    keys.appendChild(row)
  }
  advBody.appendChild(keys)

  panel.appendChild(advBody)
  panel.scrollTop = scroll
}

function divider(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'divider'
  return el
}

// ── Public API ────────────────────────────────────────────────────────────────

function onDocumentPointerDown(e: Event) {
  // Clicks inside the panel land on the host, not on its shadow children.
  if (_host && e.composedPath().includes(_host)) return
  closeSettingsPanel()
}

export function isSettingsPanelOpen(): boolean {
  return _host !== null
}

export function openSettingsPanel(
  anchor: HTMLElement,
  settings: VideoModeSettings,
  onChange: ChangeHandler,
): void {
  closeSettingsPanel()

  _settings = settings
  _onChange = onChange

  _host = document.createElement('div')
  _host.id = 'elezone-video-settings'
  _shadow = _host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  _shadow.appendChild(style)

  const panel = document.createElement('div')
  panel.className = 'panel'
  _shadow.appendChild(panel)

  // Fullscreen only paints the fullscreen element's subtree, so the panel has to
  // live alongside whatever opened it rather than always on <body>. The anchor
  // is the gear in the sidebar's toolbar; its shadow host's parent is that
  // subtree in every layout, floating or in-flow.
  const ownerHost = (anchor.getRootNode() as ShadowRoot).host as HTMLElement | undefined
  ;(ownerHost?.parentElement ?? document.body).appendChild(_host)

  render()

  const rect = anchor.getBoundingClientRect()
  const width = 420
  const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12))
  panel.style.left = `${Math.round(left)}px`
  panel.style.bottom = `${Math.round(window.innerHeight - rect.top + 10)}px`

  // Defer so the click that opened the panel doesn't immediately close it.
  setTimeout(() => document.addEventListener('pointerdown', onDocumentPointerDown, true), 0)
}

export function closeSettingsPanel(): void {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  _host?.remove()
  _host = null
  _shadow = null
  _settings = null
  _onChange = null
}

/** Re-render in place after the orchestrator applies a change. */
export function refreshSettingsPanel(settings: VideoModeSettings): void {
  if (!_host) return
  _settings = settings
  render()
}
