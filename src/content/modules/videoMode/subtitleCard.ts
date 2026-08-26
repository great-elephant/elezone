// The line being spoken, and its translation:
//
//   • the sentence word-by-word (click to look up, double-click to save)
//   • the translation underneath (optional)
//
// It takes two shapes. On Netflix, a band below a shrunken player — the picture
// is the whole page there, so room has to be made. On YouTube, a box floating
// over the picture that the learner can drag, because the watch page has its own
// layout that is better left untouched.
//
// Both are driven by the same custom properties, set by whichever layout module
// owns the page. The only control here is the sidebar toggle: line controls and
// settings live at the foot of the dialogue sidebar, where they hold still.

import type { SubtitleCue } from './subtitleInterceptor'
import type { SavedItem, BookmarkColor } from '../../../shared/types'
import { translationFor } from './cueTranslation'
import { phoneticsForWords } from '../wordPhonetics'
import { showSavedWordTooltip, scheduleHideSavedWordTooltip } from './savedWordTooltip'

export type SeekTarget = 'prev' | 'replay' | 'next'

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  // Split on word boundaries, keeping punctuation attached to the word before it
  return text.match(/\S+/g) ?? []
}

function strippedWord(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

function isEnglishLearningLang(): boolean {
  return _learningLang.toLowerCase().startsWith('en')
}

/** Saved words whose SRS review is due right now. */
export function dueWordSet(items: SavedItem[]): Set<string> {
  const now = Date.now()
  return new Set(
    items
      .filter(i => typeof i.nextReview === 'number' && i.nextReview <= now)
      .map(i => i.text.toLowerCase())
  )
}

const BOOKMARK_COLOR_HEX: Record<string, string> = {
  red: '#ff6b6b', yellow: '#ffd93d', cyan: '#6bcfff', green: '#6bff9e',
  blue: '#6b9eff', orange: '#ffb36b', purple: '#c06bff', pink: '#ff6bc0',
  teal: '#6bffd9', gray: '#c0c0c0',
}

// ── State ─────────────────────────────────────────────────────────────────────

let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let _onSaveWord: ((word: string, cue: SubtitleCue) => void) | null = null
let _onLookupWord: ((word: string, cue: SubtitleCue) => void) | null = null
let _onToggleSidebar: (() => void) | null = null
let _sidebarVisible = true
// Purely a UI toggle for the learner to hide the line while shadowing without
// losing their place — not persisted, and never touches sync/pacing, which
// keep tracking cues and pausing the video exactly as if it were shown.
let _subtitleHidden = false
let _currentCue: SubtitleCue | null = null
let _showTranslation = true
let _fontSize = 28
let _targetLang = 'vi'
let _phoneticsUnderWords = false
// The dictionaryapi.dev source only covers English; gating here means a
// French or Japanese subtitle line never fires a lookup that would just come
// back empty for every word.
let _learningLang = 'en'
let _savedColorsMap: Map<string, BookmarkColor> = new Map()
// Full items, for the hover tooltip's content (translation/phonetics) — the
// colour map above only carries what the underline needs.
let _savedItemsMap: Map<string, SavedItem> = new Map()
let _dueWords: Set<string> = new Set()

const CARD_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }

  /* Positioned through custom properties because the two sites need different
     answers and a class on the host cannot reach in here — custom properties
     are the one thing that inherits across a shadow boundary. The defaults are
     the overlay form: pinned to the bottom of the viewport, inset by the
     sidebar. YouTube's in-flow layout overrides them to sit under the player as
     an ordinary block. */
  .stage {
    position: var(--elezone-strip-position, fixed);
    left: var(--elezone-strip-left, 0);
    right: var(--elezone-strip-right, var(--elezone-sidebar-w, 0px));
    bottom: var(--elezone-strip-bottom, 0);
    top: var(--elezone-strip-top, auto);
    width: var(--elezone-strip-width, auto);
    /* Square when it spans the screen; rounded when it is a panel sitting in a
       page that has its own corners. */
    border-radius: var(--elezone-strip-radius, 0);
    max-width: var(--elezone-strip-maxw, none);
    /* As a band below the picture this fills the height the player was inset by,
       so no sliver of the page's own background shows through above it — those
       two darks are close but not equal, and the seam is obvious. Floating over
       the picture it wants the opposite: only as much room as the words need. */
    min-height: var(--elezone-strip-minh, var(--elezone-subs-h, 190px));
    background: var(--elezone-strip-bg, #07080d);
    z-index: 2147483640;
    transition: background 0.15s;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    /* Wide gutters keep a full-width band's text away from the screen edges;
       a floating box needs none of that and would just be needlessly large. */
    padding: var(--elezone-strip-padding, 10px 72px);
    font-family: 'Netflix Sans', Roboto, 'Segoe UI', system-ui, -apple-system, sans-serif;
    transition: opacity 0.15s;
  }
  .stage.empty .words-row,
  .stage.empty .translation-row { visibility: hidden; }

  /* Learner-hidden for shadowing: the whole slab collapses to nothing — no
     background, no padding, no reserved height — so it stops sitting over the
     picture and stealing clicks meant for the player underneath. Only the two
     toolbar buttons stay put (own pointer-events, since the stage's own is
     switched off), so hiding is never a dead end. */
  .stage.subtitle-hidden {
    background: transparent;
    padding: 0;
    min-height: 0;
    pointer-events: none;
  }
  .stage.subtitle-hidden:hover { background: transparent; }
  .stage.subtitle-hidden .text-area { display: none; }
  /* The toolbar sits over the stage's own pointer-events:none, so the two
     controls — and the space around them, which is what dragging the
     collapsed panel grabs — stay usable with no background left to click. */
  .stage.subtitle-hidden .toolbar { pointer-events: auto; }
  /* The buttons' own backdrop (rgba(0,0,0,0.55)) reads fine over the solid
     stage, but with the stage gone it sits straight over the picture and
     washes out. Opaque it up so the two controls stay legible over any frame. */
  .stage.subtitle-hidden .sidebar-toggle,
  .stage.subtitle-hidden .subtitle-hide-toggle {
    background: rgba(20,20,24,0.88);
    color: #fff;
  }
  /* The opacity bump above outranks .sidebar-toggle.on on specificity alone
     (three classes beat two), so without this it silently swallows whether
     the sidebar is actually open — every button reads as the same flat dark
     tile regardless of its own toggle state. Carry the highlight through,
     just opaque enough to still read over the picture like the rest of this
     corner. */
  .stage.subtitle-hidden .sidebar-toggle.on,
  .stage.subtitle-hidden .subtitle-hide-toggle.on {
    background: rgba(255,255,255,0.4);
  }

  /* Floating over the picture, the panel is invisible until pointed at: a solid
     slab sitting over a third of the shot all the time is worse than the
     subtitle it replaces. The words stay put either way — only the backdrop
     fades in, so nothing reflows under the pointer. */
  .stage:hover {
    background: var(--elezone-strip-bg-hover, var(--elezone-strip-bg, #07080d));
  }

  /* Dragging is offered only where the strip floats over the picture; a band
     under the video has nowhere to go. The words stay clickable — what you grab
     is the background around them. */
  .stage.draggable { cursor: grab; }
  .stage.dragging { cursor: grabbing; user-select: none; }

  /* Only where the strip floats, and only visible once the pointer is on the
     panel — a grab bar showing over the film at all times is the sort of chrome
     this whole layout exists to avoid. */
  .resize-handle { display: none; }
  .stage.draggable .resize-handle {
    display: block;
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12px;
    cursor: ew-resize;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .stage.draggable .resize-handle::after {
    content: '';
    position: absolute;
    top: 22%;
    bottom: 22%;
    left: 4px;
    width: 3px;
    border-radius: 2px;
    background: rgba(255,255,255,0.55);
  }
  .stage.draggable .resize-handle.left { left: 0; }
  .stage.draggable .resize-handle.right { right: 0; }
  .stage.draggable:hover .resize-handle,
  .stage.dragging .resize-handle { opacity: 1; }

  /* Takes every pixel the toolbar doesn't, and centres the line in it. Without
     the flex:1 the slack all collected above the text, which pinned short
     lines to the bottom of an otherwise empty band. */
  .text-area {
    width: 100%;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  /* Words are separated by real space characters, not by a flex gap. A fixed
     gap is the same number of pixels everywhere, which is not what even spacing
     looks like: it ignores each glyph's own side bearing, so the space after a
     full stop or a comma reads as noticeably wider than the rest. Letting the
     font's own space do the work keeps it uniform and scales with the size. */
  .words-row {
    display: block;
    text-align: center;
    line-height: 1.35;
  }

  .word-unit {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    vertical-align: bottom;
    gap: 1px;
    cursor: pointer;
    border-radius: 4px;
    transition: background 0.12s;
  }
  .word-unit:hover { background: rgba(255,255,255,0.22); }

  .word-text {
    font-size: var(--fs, 28px);
    font-weight: 700;
    line-height: 1.25;
    color: #fff;
    /* Carries the text over a bare picture once the backdrop is gone. Set only
       where the strip floats; against a solid band it would just look muddy. */
    text-shadow: var(--elezone-strip-text-shadow, none);
  }
  .word-text.saved {
    border-bottom: 3px solid var(--save-color, #ffd93d);
    padding-bottom: 1px;
  }
  /* Due for review: meeting the word in real dialogue at the moment the SRS
     schedule wants it is the whole point, so it gets more than an underline. */
  .word-text.due {
    background: rgba(255,217,61,0.22);
    border-radius: 3px;
    box-shadow: 0 0 0 1px rgba(255,217,61,0.4);
  }

  /* Reserves its line even before the lookup resolves (and stays reserved for
     a word that never gets one back) — otherwise words with phonetics sit
     taller than their neighbours and the row's baseline saws up and down as
     lookups trickle in one word at a time. */
  .phonetics-text {
    display: block;
    min-height: calc(var(--fs, 28px) * 0.42 * 1.1);
    font-size: calc(var(--fs, 28px) * 0.42);
    color: rgba(255,255,255,0.55);
    line-height: 1.1;
    text-shadow: var(--elezone-strip-text-shadow, none);
  }

  .translation-row {
    font-size: calc(var(--fs, 28px) * 0.62);
    color: rgba(255,255,255,0.82);
    text-align: center;
    line-height: 1.4;
    text-shadow: var(--elezone-strip-text-shadow, none);
  }

  .status-row {
    font-size: 14px;
    color: rgba(255,255,255,0.7);
    text-align: center;
    line-height: 1.5;
    background: rgba(0,0,0,0.55);
    border-radius: 8px;
    padding: 8px 14px;
    pointer-events: auto;
  }

  /* Shadowing gap: the film is frozen and the learner repeats the line aloud. */
  /* Pinned to a corner: a hint that comes and goes must not move the layout. */
  .gap-row {
    display: none;
    position: absolute;
    bottom: 18px;
    left: 16px;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
    color: rgba(140,210,255,0.95);
  }
  .gap-row.on { display: flex; }

  /* Floats above the strip so showing it never resizes the player. */
  .notice {
    display: none;
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: 90%;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
    color: rgba(255,225,150,0.95);
    background: rgba(120,90,20,0.35);
    border: 1px solid rgba(255,200,90,0.28);
    border-radius: 7px;
    padding: 5px 8px 5px 12px;
  }
  .notice.on { display: flex; }
  .notice-text { flex: 1; }
  .notice-btn {
    flex-shrink: 0;
    background: #d8a02a;
    color: #1a1400;
    border: none;
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .notice-btn:hover { background: #f0b53a; }
  .notice-close {
    flex-shrink: 0;
    background: none;
    border: none;
    color: rgba(255,225,150,0.6);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }
  .notice-close:hover { color: #fff; }

  /* Anchored to the strip's corner, not to the text area, so the strip's side
     padding doesn't hold it 72px off the edge. Stacked column so both controls
     sit in the same corner without crowding the words above them. */
  .toolbar {
    position: absolute;
    right: 14px;
    bottom: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 4px;
  }
  .sidebar-toggle { color: rgba(255,255,255,0.5); }
  .sidebar-toggle.on { color: #fff; background: rgba(255,255,255,0.28); }
  .subtitle-hide-toggle { color: rgba(255,255,255,0.5); }
  .subtitle-hide-toggle.on { color: #fff; background: rgba(255,255,255,0.28); }
  .ctrl-sep {
    width: 1px;
    height: 18px;
    background: rgba(255,255,255,0.15);
    margin: 0 4px;
  }

  .ctrl {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: rgba(0,0,0,0.55);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s;
  }
  .ctrl:hover { background: rgba(255,255,255,0.28); }

  .saved-notice {
    position: absolute;
    top: -26px;
    left: 50%;
    transform: translateX(-50%);
    background: #4f6ef7;
    color: #fff;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 6px;
    white-space: nowrap;
    pointer-events: none;
    animation: fadeUp 1.5s forwards;
  }
  @keyframes fadeUp {
    0% { opacity: 1; transform: translateX(-50%) translateY(0); }
    80% { opacity: 1; }
    100% { opacity: 0; transform: translateX(-50%) translateY(-12px); }
  }
`

// ── DOM ───────────────────────────────────────────────────────────────────────

const SIDEBAR_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg>'
const SUBTITLE_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="10" x2="10" y2="10"/><line x1="13" y1="10" x2="17" y2="10"/><line x1="7" y1="14" x2="13" y2="14"/></svg>'


function buildStage(): HTMLElement {
  if (!shadow) throw new Error('shadow not initialised')

  const stage = document.createElement('div')
  stage.className = 'stage empty'
  stage.style.setProperty('--fs', `${_fontSize}px`)

  // Line controls and settings live at the foot of the dialogue sidebar, not
  // here. On the strip they sat under the words, so every change of line moved
  // them; and once the strip floats over the picture and can be dragged, a row
  // of buttons is exactly what you do not want under the pointer. The sidebar
  // toggle stays, because when the sidebar is hidden it is the only way back.
  const sidebarBtn = document.createElement('button')
  sidebarBtn.className = `ctrl sidebar-toggle${_sidebarVisible ? ' on' : ''}`
  sidebarBtn.innerHTML = SIDEBAR_ICON
  sidebarBtn.title = 'Show / hide the dialogue sidebar'
  makeDraggableButton(sidebarBtn, (e) => {
    e.stopPropagation()
    _onToggleSidebar?.()
  })

  // Hides the line for shadowing: the learner speaks it from memory before
  // it reappears. Sync and pacing never see this — they keep tracking cues
  // and pausing the video exactly as if the line were shown, so replay,
  // next/prev and the shadowing gap still land on the right line.
  const subtitleHideBtn = document.createElement('button')
  // .on means "shown", same as sidebar-toggle — so it lights up when its
  // content is visible, not when the toggle itself has been pressed.
  subtitleHideBtn.className = `ctrl subtitle-hide-toggle${_subtitleHidden ? '' : ' on'}`
  subtitleHideBtn.innerHTML = SUBTITLE_ICON
  subtitleHideBtn.title = 'Show / hide the subtitle'
  makeDraggableButton(subtitleHideBtn, (e) => {
    e.stopPropagation()
    _subtitleHidden = !_subtitleHidden
    subtitleHideBtn.classList.toggle('on', !_subtitleHidden)
    _stage?.classList.toggle('subtitle-hidden', _subtitleHidden)
    // Hidden mode shrinks the box down to just the toolbar (see
    // applyStripPosition) instead of leaving the full strip width invisibly
    // in place — recompute now rather than waiting for the layout's once-a-
    // second reassertion.
    applyStripPosition()
  })

  const gapRow = document.createElement('div')
  gapRow.className = 'gap-row'

  const notice = document.createElement('div')
  notice.className = 'notice'

  const statusRow = document.createElement('div')
  statusRow.className = 'status-row'
  statusRow.style.display = 'none'

  const wordsRow = document.createElement('div')
  wordsRow.className = 'words-row'

  const translationRow = document.createElement('div')
  translationRow.className = 'translation-row'

  const textArea = document.createElement('div')
  textArea.className = 'text-area'
  textArea.append(statusRow, wordsRow, translationRow)

  // Side edges only. There is no bottom handle because the bottom edge is the
  // anchor, and no top handle because the height is the text's to decide.
  const handles = (['left', 'right'] as const).map(edge => {
    const handle = document.createElement('div')
    handle.className = `resize-handle ${edge}`
    handle.title = 'Drag to resize'
    handle.addEventListener('pointerdown', e => onResizeStart(e, edge))
    return handle
  })

  const toolbar = document.createElement('div')
  toolbar.className = 'toolbar'
  toolbar.append(subtitleHideBtn, sidebarBtn)

  stage.append(notice, textArea, toolbar, gapRow, ...handles)
  stage.addEventListener('pointerdown', onDragStart)
  shadow.appendChild(stage)
  return stage
}

function buildWordUnit(token: string, cue: SubtitleCue): HTMLElement {
  const unit = document.createElement('div')
  unit.className = 'word-unit'

  const clean = strippedWord(token)

  const wordSpan = document.createElement('span')
  wordSpan.className = 'word-text'
  wordSpan.textContent = token

  const key = clean.toLowerCase()
  const savedColor = _savedColorsMap.get(key)
  if (savedColor) {
    wordSpan.classList.add('saved')
    wordSpan.style.setProperty('--save-color', BOOKMARK_COLOR_HEX[savedColor] ?? '#ffd93d')
    if (_dueWords.has(key)) {
      wordSpan.classList.add('due')
      unit.title = 'Due for review'
    }
    unit.addEventListener('mouseenter', () => {
      const item = _savedItemsMap.get(key)
      if (item) showSavedWordTooltip(clean, item, unit)
    })
    unit.addEventListener('mouseleave', scheduleHideSavedWordTooltip)
  }

  unit.appendChild(wordSpan)

  if (_phoneticsUnderWords && isEnglishLearningLang()) {
    // Added even for a punctuation-only token (empty `clean`, no lookup ever
    // fired for it) so every word-unit in the row reserves the same second
    // line — otherwise that one token sits shorter than its neighbours.
    const phoneticsSpan = document.createElement('span')
    phoneticsSpan.className = 'phonetics-text'
    if (clean) phoneticsSpan.dataset.word = clean.toLowerCase()
    unit.appendChild(phoneticsSpan)
  }

  unit.addEventListener('click', () => {
    if (clean) _onLookupWord?.(clean, cue)
  })
  unit.addEventListener('dblclick', (e) => {
    e.stopPropagation()
    if (clean) {
      _onSaveWord?.(clean, cue)
      flashSaved(unit, '✓ Saved')
    }
  })

  return unit
}

function flashSaved(anchor: HTMLElement, label: string) {
  const notice = document.createElement('div')
  notice.className = 'saved-notice'
  notice.textContent = label
  anchor.style.position = 'relative'
  anchor.appendChild(notice)
  setTimeout(() => notice.remove(), 1600)
}

// ── Public API ────────────────────────────────────────────────────────────────

let _stage: HTMLElement | null = null
let _wordsRow: HTMLElement | null = null
let _translationRowEl: HTMLElement | null = null
let _statusEl: HTMLElement | null = null
// Shown in place of the subtitle text while there is no cue to display — so the
// overlay still proves Video Mode is on instead of silently rendering nothing.
let _status: string | null = null

export function initSubtitleCard(opts: {
  onSaveWord: (word: string, cue: SubtitleCue) => void
  onLookupWord: (word: string, cue: SubtitleCue) => void
  onToggleSidebar: () => void
  sidebarVisible: boolean
  showTranslation: boolean
  fontSize: number
  targetLang: string
  phoneticsUnderWords: boolean
  learningLang: string
}): void {
  _onSaveWord = opts.onSaveWord
  _onLookupWord = opts.onLookupWord
  _onToggleSidebar = opts.onToggleSidebar
  _sidebarVisible = opts.sidebarVisible
  _showTranslation = opts.showTranslation
  _fontSize = opts.fontSize
  _targetLang = opts.targetLang
  _phoneticsUnderWords = opts.phoneticsUnderWords
  _learningLang = opts.learningLang

  host = document.createElement('div')
  host.id = 'elezone-subtitle-card'
  shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = CARD_CSS
  shadow.appendChild(style)

  _stage = buildStage()
  _wordsRow = shadow.querySelector('.words-row')
  _translationRowEl = shadow.querySelector('.translation-row')
  _statusEl = shadow.querySelector('.status-row')

  document.body.appendChild(host)
}

// ── Moving and resizing the overlay ──────────────────────────────────────────
//
// Where the strip floats over the picture the learner can move it and set how
// wide it is. Both are needed: a fixed spot lands on the speaker's face in one
// video and on burnt-in captions in the next, and a fixed width is either too
// narrow for a long sentence or wider than the shot.
//
// Everything is stored as a percentage of the player box rather than in pixels,
// so it survives resizing the window, going fullscreen, and coming back
// tomorrow on another screen.
//
// Two choices in how the box is anchored, both deliberate:
//
//   • by its *centre* horizontally, so changing the width grows it evenly to
//     both sides instead of walking it across the picture;
//   • by its *bottom* edge vertically, so a line that needs an extra row grows
//     upward. Anchored by the top it would grow down, which on a bottom-placed
//     caption means over the player controls and off the picture.
//
// With the width fixed, longer text can only ever go upward — never sideways,
// never down.

export interface StripPosition { xPct: number; yPct: number }

// Centred, sitting just above the player's own control bar.
const DEFAULT_STRIP_POSITION: StripPosition = { xPct: 50, yPct: 8 }
const DEFAULT_STRIP_WIDTH_PCT = 90
const MIN_STRIP_WIDTH_PX = 220
// How far the pointer has to move, past a toolbar button's own press, before
// it counts as a grab of the panel rather than a click of the button — the
// toolbar's padding is too small on its own to reliably grab.
const DRAG_CLICK_THRESHOLD_PX = 5

let _dragEnabled = false
let _dragging = false
let _position: StripPosition | null = null
let _widthPct = DEFAULT_STRIP_WIDTH_PCT
let _onGeometryChange: ((geometry: { position: StripPosition; widthPct: number }) => void) | null = null

function dragContainer(): HTMLElement | null {
  return host?.parentElement ?? null
}

/** Not a drag: the learner is clicking a word, a control, or a resize edge. */
function isInteractive(path: EventTarget[]): boolean {
  return path.some(node =>
    node instanceof HTMLElement &&
    (node.tagName === 'BUTTON' ||
      node.classList.contains('word-unit') ||
      node.classList.contains('resize-handle'))
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function applyStripPosition(): void {
  const box = dragContainer()
  if (!_stage || !box) return

  if (!_dragEnabled || !_position) {
    for (const prop of ['left', 'right', 'top', 'bottom', 'width']) _stage.style.removeProperty(prop)
    return
  }

  const boxWidth = box.clientWidth
  const boxHeight = box.clientHeight
  if (boxWidth === 0 || boxHeight === 0) return

  const fullWidth = clamp(boxWidth * _widthPct / 100, Math.min(MIN_STRIP_WIDTH_PX, boxWidth), boxWidth)
  // Unclamped: the raw centre the stored xPct maps to, even if the
  // hypothetical full-width panel it implies would sit off-screen. Clamped
  // only for actually rendering that full-width panel (`fullLeft` below) —
  // the hidden branch needs the raw value to recover the exact right edge a
  // narrow-box drag was released at; clamping it first (to keep a full-size
  // panel on screen) would silently drag that edge back in from wherever it
  // was actually dropped.
  const rawFullLeft = boxWidth * _position.xPct / 100 - fullWidth / 2
  const fullLeft = clamp(rawFullLeft, 0, Math.max(0, boxWidth - fullWidth))

  if (_subtitleHidden) {
    // Only the corner toolbar is left visible — shrink the box down to just
    // wrap it instead of leaving the full strip width sitting there invisibly.
    // `.stage`'s own shrink-to-fit sizing can't be used for this: `.toolbar`
    // is itself `position: absolute`, so it never counts toward its parent's
    // intrinsic width, and the stage would collapse to ~0 instead of hugging
    // it — which then throws off every pixel computed from its box below.
    // Measure the toolbar directly instead (stable regardless of the stage's
    // own box, since its buttons are ordinary flex children of it) and give
    // the stage an explicit width that wraps it with the same inset its own
    // `right` uses, so the two line up.
    const toolbar = _stage.querySelector<HTMLElement>('.toolbar')
    const TOOLBAR_INSET_PX = 14 // must match `.toolbar { right: ... }` above
    const narrowWidth = (toolbar?.offsetWidth ?? 0) + TOOLBAR_INSET_PX * 2
    const rightEdge = rawFullLeft + fullWidth
    _stage.style.removeProperty('right')
    _stage.style.width = `${Math.round(narrowWidth)}px`
    _stage.style.left = `${Math.round(clamp(rightEdge - narrowWidth, 0, Math.max(0, boxWidth - narrowWidth)))}px`
  } else {
    _stage.style.removeProperty('right')
    _stage.style.width = `${Math.round(fullWidth)}px`
    _stage.style.left = `${Math.round(fullLeft)}px`
  }

  // Measured after the width is set: the height depends on how the text wraps
  // inside it, and that is what decides how far up the box may sit.
  const height = _stage.getBoundingClientRect().height
  const bottom = clamp(boxHeight * _position.yPct / 100, 0, Math.max(0, boxHeight - height))

  _stage.style.bottom = `${Math.round(bottom)}px`
  _stage.style.top = 'auto'
}

function onDragStart(e: PointerEvent): void {
  if (!_dragEnabled || !_stage || e.button !== 0) return
  if (isInteractive(e.composedPath())) return
  beginDrag(e)
}

/**
 * The actual grab-and-move logic, shared by a press on the stage's own
 * background (`onDragStart`, immediate) and a press on a toolbar button that
 * has crossed the drag threshold (`makeDraggableButton`, delayed).
 */
function beginDrag(e: PointerEvent): void {
  if (!_dragEnabled || !_stage) return

  const box = dragContainer()
  if (!box) return
  const stageRect = _stage.getBoundingClientRect()
  const boxRect = box.getBoundingClientRect()
  const grabX = e.clientX - stageRect.left
  const grabY = e.clientY - stageRect.top

  // The hidden state anchors from `right` with `width` auto (see
  // applyStripPosition) so the box hugs the toolbar instead of stretching to
  // the stylesheet's own `right`. `move` below only ever writes `left`, so
  // pin the width to what it already measured as and drop `right` up front —
  // otherwise dragging would leave `right` fighting the new `left` and the
  // box would stretch/shrink live as the pointer moves instead of sliding.
  _stage.style.width = `${Math.round(stageRect.width)}px`
  _stage.style.removeProperty('right')

  _dragging = true
  _stage.classList.add('dragging')
  _stage.setPointerCapture(e.pointerId)

  const move = (ev: PointerEvent) => {
    if (!_stage) return
    const left = clamp(ev.clientX - boxRect.left - grabX, 0, Math.max(0, boxRect.width - stageRect.width))
    const top = clamp(ev.clientY - boxRect.top - grabY, 0, Math.max(0, boxRect.height - stageRect.height))
    const bottom = boxRect.height - top - stageRect.height
    _stage.style.left = `${Math.round(left)}px`
    _stage.style.bottom = `${Math.round(bottom)}px`
    _stage.style.top = 'auto'

    // While hidden the box is shrunk to just the toolbar (see
    // applyStripPosition) — store the position as where the full-width strip's
    // centre would be for this same right edge, not the narrow box's own
    // centre, so the strip doesn't jump sideways once shown again.
    const rightEdge = left + stageRect.width
    const fullWidth = _subtitleHidden
      ? clamp(boxRect.width * _widthPct / 100, Math.min(MIN_STRIP_WIDTH_PX, boxRect.width), boxRect.width)
      : stageRect.width
    _position = {
      xPct: boxRect.width ? ((rightEdge - fullWidth / 2) / boxRect.width) * 100 : 50,
      yPct: boxRect.height ? (bottom / boxRect.height) * 100 : DEFAULT_STRIP_POSITION.yPct,
    }
  }

  const end = () => {
    _dragging = false
    _stage?.classList.remove('dragging')
    _stage?.removeEventListener('pointermove', move)
    _stage?.removeEventListener('pointerup', end)
    _stage?.removeEventListener('pointercancel', end)
    // Persisted on release rather than on every frame — a drag is one decision,
    // not a hundred.
    if (_position) _onGeometryChange?.({ position: _position, widthPct: _widthPct })
  }

  _stage.addEventListener('pointermove', move)
  _stage.addEventListener('pointerup', end)
  _stage.addEventListener('pointercancel', end)
  e.preventDefault()
}

/**
 * Wires a toolbar button so a plain press-and-release still fires `onClick`,
 * but a press that moves past `DRAG_CLICK_THRESHOLD_PX` first hands off to
 * `beginDrag` instead — the button becomes a second grab point for the panel,
 * needed because the toolbar's own padding around the buttons is too thin to
 * reliably grab on its own.
 */
function makeDraggableButton(btn: HTMLElement, onClick: (e: MouseEvent) => void): void {
  let downEvent: PointerEvent | null = null
  let dragging = false

  const stopTracking = () => {
    btn.removeEventListener('pointermove', onMove)
    btn.removeEventListener('pointerup', stopTracking)
    btn.removeEventListener('pointercancel', stopTracking)
    downEvent = null
  }

  const onMove = (ev: PointerEvent) => {
    if (!downEvent || dragging) return
    const moved = Math.hypot(ev.clientX - downEvent.clientX, ev.clientY - downEvent.clientY)
    if (moved < DRAG_CLICK_THRESHOLD_PX) return
    dragging = true
    const start = downEvent
    stopTracking()
    // Hand capture off to the stage before beginDrag re-captures the same
    // pointer there — without it, a fast press that's already left the
    // button's small hit-box would target whatever's now under the pointer,
    // not the button, and these listeners would never have fired at all.
    if (btn.hasPointerCapture(start.pointerId)) btn.releasePointerCapture(start.pointerId)
    beginDrag(start)
  }

  btn.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || !_dragEnabled) return
    downEvent = e
    dragging = false
    btn.setPointerCapture(e.pointerId)
    btn.addEventListener('pointermove', onMove)
    btn.addEventListener('pointerup', stopTracking)
    btn.addEventListener('pointercancel', stopTracking)
  })

  // A single listener, rather than the caller's own, so a press that turned
  // into a drag can veto the click it would otherwise still fire.
  btn.addEventListener('click', (e: MouseEvent) => {
    if (dragging) {
      dragging = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    onClick(e)
  })
}

function onResizeStart(e: PointerEvent, edge: 'left' | 'right'): void {
  if (!_dragEnabled || !_stage || e.button !== 0) return
  const box = dragContainer()
  if (!box) return

  const boxRect = box.getBoundingClientRect()
  const stageRect = _stage.getBoundingClientRect()
  // The edge that is not being dragged stays exactly where it is.
  const anchorX = edge === 'left' ? stageRect.right : stageRect.left

  _dragging = true
  _stage.classList.add('dragging')
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)

  const move = (ev: PointerEvent) => {
    if (!_stage) return
    const minWidth = Math.min(MIN_STRIP_WIDTH_PX, boxRect.width)
    const rawLeft = edge === 'left' ? ev.clientX : anchorX
    const rawRight = edge === 'left' ? anchorX : ev.clientX
    const left = clamp(rawLeft - boxRect.left, 0, boxRect.width - minWidth)
    const right = clamp(rawRight - boxRect.left, left + minWidth, boxRect.width)
    const width = right - left

    _stage.style.width = `${Math.round(width)}px`
    _stage.style.left = `${Math.round(left)}px`
    _widthPct = boxRect.width ? (width / boxRect.width) * 100 : DEFAULT_STRIP_WIDTH_PCT
    _position = {
      xPct: boxRect.width ? ((left + width / 2) / boxRect.width) * 100 : 50,
      yPct: _position?.yPct ?? DEFAULT_STRIP_POSITION.yPct,
    }
  }

  const end = () => {
    _dragging = false
    _stage?.classList.remove('dragging')
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    // Re-clamp: a narrower box wraps to more lines, which may push its top past
    // the picture now that it is anchored by the bottom.
    applyStripPosition()
    if (_position) _onGeometryChange?.({ position: _position, widthPct: _widthPct })
  }

  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
  e.preventDefault()
  e.stopPropagation()
}

/**
 * Turn dragging on or off, and set where the strip sits.
 *
 * Called by the layout that owns the strip: only the floating form supports it.
 */
export function setSubtitleCardDrag(opts: {
  enabled: boolean
  position?: StripPosition | null
  widthPct?: number
  onGeometryChange?: (geometry: { position: StripPosition; widthPct: number }) => void
}): void {
  // The layout re-asserts itself once a second, and the stored geometry only
  // catches up on release. Applying it mid-drag would snatch the strip back to
  // where it started, once per second, while the learner is still moving it.
  if (_dragging) return

  _dragEnabled = opts.enabled
  _onGeometryChange = opts.onGeometryChange ?? null
  if (typeof opts.widthPct === 'number') _widthPct = opts.widthPct
  if (opts.position !== undefined) {
    _position = opts.position ?? (opts.enabled ? { ...DEFAULT_STRIP_POSITION } : null)
  } else if (opts.enabled && !_position) {
    _position = { ...DEFAULT_STRIP_POSITION }
  }

  _stage?.classList.toggle('draggable', _dragEnabled)
  applyStripPosition()
}

/**
 * Persistent advisory shown above the line — used when the subtitle track can't
 * match the audio (a dubbed title), where the fix is one click away.
 */
export function showSubtitleNotice(opts: {
  text: string
  actionLabel?: string
  onAction?: () => void
}): void {
  const notice = shadow?.querySelector<HTMLElement>('.notice')
  if (!notice) return

  notice.innerHTML = ''
  const text = document.createElement('span')
  text.className = 'notice-text'
  text.textContent = opts.text
  notice.appendChild(text)

  if (opts.actionLabel && opts.onAction) {
    const btn = document.createElement('button')
    btn.className = 'notice-btn'
    btn.textContent = opts.actionLabel
    btn.addEventListener('click', () => {
      opts.onAction?.()
      notice.classList.remove('on')
    })
    notice.appendChild(btn)
  }

  const close = document.createElement('button')
  close.className = 'notice-close'
  close.textContent = '×'
  close.title = 'Dismiss'
  close.addEventListener('click', () => notice.classList.remove('on'))
  notice.appendChild(close)

  notice.classList.add('on')
}

/** Message to show while no cue is active. `null` hides the overlay instead. */
export function setSubtitleCardStatus(text: string | null): void {
  _status = text
  if (!_currentCue) renderIdle()
}

// No cue to show: either the status message, or a fully faded-out overlay.
function renderIdle(): void {
  if (!_stage || !_wordsRow || !_translationRowEl || !_statusEl) return
  _wordsRow.innerHTML = ''
  _translationRowEl.textContent = ''
  if (_status) {
    _stage.classList.remove('empty')
    _statusEl.style.display = ''
    _statusEl.textContent = _status
  } else {
    _stage.classList.add('empty')
    _statusEl.style.display = 'none'
  }
}

export function updateSubtitleCard(cue: SubtitleCue | null, savedItems: SavedItem[]): void {
  if (!_stage || !_wordsRow || !_translationRowEl) return

  // Rebuild saved-words index
  _savedColorsMap = new Map(savedItems.map(i => [i.text.toLowerCase(), i.color]))
  _savedItemsMap = new Map(savedItems.map(i => [i.text.toLowerCase(), i]))
  _dueWords = dueWordSet(savedItems)

  _currentCue = cue

  if (!cue) {
    renderIdle()
    return
  }

  _stage.classList.remove('empty')
  if (_statusEl) _statusEl.style.display = 'none'
  _stage.style.setProperty('--fs', `${_fontSize}px`)

  // Rebuild word units
  _wordsRow.innerHTML = ''
  const tokens = tokenize(cue.text)
  tokens.forEach((token, i) => {
    if (i > 0) _wordsRow!.appendChild(document.createTextNode(' '))
    _wordsRow!.appendChild(buildWordUnit(token, cue))
  })

  if (_phoneticsUnderWords && isEnglishLearningLang()) {
    const key = cue.text
    const words = tokens.map(strippedWord).filter(Boolean)
    if (words.length > 0) {
      void phoneticsForWords(words).then(result => {
        // The line has moved on by the time this resolves — the spans it would
        // fill no longer belong to what's on screen.
        if (_currentCue?.text !== key || !_wordsRow) return
        _wordsRow.querySelectorAll<HTMLElement>('.phonetics-text').forEach(span => {
          const entry = result.get(span.dataset.word ?? '')
          if (!entry) return
          span.textContent = entry.text
          // A reading borrowed from a fallback (plural's singular, one half
          // of a hyphenated compound...) rather than the word's own exact
          // entry — shown dimmer to signal "close, not guaranteed exact".
          span.style.opacity = entry.approximate ? '0.6' : ''
        })
      })
    }
  }

  // Translation
  if (_showTranslation) {
    _translationRowEl.style.display = ''
    const key = cue.text
    _translationRowEl.textContent = ''
    void translationFor(cue, _targetLang).then(text => {
      // Cues change faster than the network; drop a late answer for a line
      // that is no longer on screen.
      if (_currentCue?.text === key && _translationRowEl) _translationRowEl.textContent = text
    })
  } else {
    _translationRowEl.style.display = 'none'
  }
}

export function destroySubtitleCard(): void {
  host?.remove()
  host = null
  shadow = null
  _stage = null
  _wordsRow = null
  _translationRowEl = null
  _statusEl = null
  _status = null
  _currentCue = null
  _subtitleHidden = false
}

/**
 * Apply live setting changes (from the popup toggles). The overlay re-renders on
 * the next cue change, so callers wanting an immediate effect should follow up
 * with `updateSubtitleCard(currentCue, savedItems)`.
 */
export function applySubtitleCardSettings(opts: {
  showTranslation?: boolean
  fontSize?: number
  sidebarVisible?: boolean
  phoneticsUnderWords?: boolean
  learningLang?: string
}): void {
  if (opts.showTranslation !== undefined) _showTranslation = opts.showTranslation
  if (opts.fontSize !== undefined) _fontSize = opts.fontSize
  if (opts.phoneticsUnderWords !== undefined) _phoneticsUnderWords = opts.phoneticsUnderWords
  if (opts.learningLang !== undefined) _learningLang = opts.learningLang
  if (opts.sidebarVisible !== undefined) {
    _sidebarVisible = opts.sidebarVisible
    shadow?.querySelector('.sidebar-toggle')?.classList.toggle('on', _sidebarVisible)
  }
}

/** Show the indefinite end-of-line hold, which waits on the learner. */
export function showWaitingForResume(): void {
  const row = shadow?.querySelector<HTMLElement>('.gap-row')
  if (!row) return
  row.innerHTML = '<span>\u23F8 Paused \u2014 press Space to continue</span>'
  row.classList.add('on')
}

export function hideShadowingGap(): void {
  shadow?.querySelector<HTMLElement>('.gap-row')?.classList.remove('on')
}

export function getCurrentCue(): SubtitleCue | null {
  return _currentCue
}
