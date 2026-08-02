// Dialogue sidebar — fixed right panel showing all subtitle cues in order.
// Highlights the current cue and scrolls it into view.
// Clicking a cue seeks the video to that time.
// Clicking a word opens the dictionary popup.

import type { SubtitleCue } from './subtitleInterceptor'
import type { SavedItem, BookmarkColor } from '../../../shared/types'
import { translationFor, nativeTranslationFor } from './cueTranslation'
import { dueWordSet } from './subtitleCard'
import type { SeekTarget } from './subtitleCard'
import { seekToSeconds } from './videoControl'

type LookupCallback = (word: string, cue: SubtitleCue) => void
type SaveCallback = (word: string, cue: SubtitleCue) => void

let _host: HTMLElement | null = null
let _shadow: ShadowRoot | null = null
let _listEl: HTMLElement | null = null
let _cueEls: HTMLElement[] = []
let _onLookup: LookupCallback | null = null
let _onSave: SaveCallback | null = null
let _isCollapsed = false
let _savedColorsMap: Map<string, BookmarkColor> = new Map()
let _dueWords: Set<string> = new Set()
let _showTranslation = true
let _targetLang = 'vi'
// A feature-length film is 1000–2000 cues. Translating them all on init would
// fire that many Google requests at once and get us rate-limited, so each cue
// is translated only once it scrolls into the sidebar's viewport.
let _translationObserver: IntersectionObserver | null = null
// Fired when the panel's width changes, so the player inset can follow it.
let _onLayoutChange: (() => void) | null = null
// Told before any seek so the pacing engine can drop the current repeat tally.
let _onSeek: (() => void) | null = null
let _onUnsave: ((word: string) => void) | null = null
let _onSeekLine: ((target: SeekTarget) => void) | null = null
let _onOpenSettings: ((anchor: HTMLElement) => void) | null = null
let _activeIndex = -1
// Auto-scroll fights the user: clicking a line makes the player seek, which
// immediately scrolls the list out from under them. Back off briefly after any
// manual scroll.
let _userScrolledAt = 0

const BOOKMARK_COLOR_HEX: Record<string, string> = {
  red: '#ff6b6b', yellow: '#ffd93d', cyan: '#6bcfff', green: '#6bff9e',
  blue: '#6b9eff', orange: '#ffb36b', purple: '#c06bff', pink: '#ff6bc0',
  teal: '#6bffd9', gray: '#c0c0c0',
}

function formatTs(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const sec = Math.floor(seconds % 60)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

function strippedWord(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

const SIDEBAR_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }

  /* See the note in subtitleCard.ts: positioned through custom properties so
     YouTube can drop it into the recommendations column instead of floating it
     over the page. */
  .sidebar {
    position: var(--elezone-side-position, fixed);
    top: var(--elezone-side-top, 0);
    right: var(--elezone-side-right, 0);
    bottom: var(--elezone-side-bottom, 0);
    height: var(--elezone-side-height, auto);
    border-radius: var(--elezone-side-radius, 0);
    z-index: 2147483639;
    width: var(--elezone-side-width, 340px);
    background: rgba(12, 14, 20, 0.94);
    backdrop-filter: blur(14px);
    border-left: 1px solid rgba(255,255,255,0.10);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: 'Netflix Sans', Roboto, 'Segoe UI', system-ui, -apple-system, sans-serif;
    box-shadow: -6px 0 40px rgba(0,0,0,0.55);
    transition: width 0.18s;
  }
  /* Hidden means gone: the strip's own button is what brings it back, so there
     is nothing left on screen that needs to stay reachable. */
  .sidebar.collapsed { display: none; }

  .sidebar-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 12px 10px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
    color: rgba(255,255,255,0.92);
    font-size: 13px;
    font-weight: 600;
    user-select: none;
  }
  .sidebar-title { flex: 1; white-space: nowrap; overflow: hidden; }

  /* Fixed at the foot of the sidebar. It used to sit on the subtitle strip,
     where it moved every time a line changed length — and once the strip became
     a draggable overlay, a row of buttons under the grab area was worse still.
     Here it is the one part of the UI that never moves. */
  .sidebar-toolbar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 8px 12px;
    border-top: 1px solid rgba(255,255,255,0.08);
    background: rgba(0,0,0,0.25);
  }
  .tool-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: rgba(255,255,255,0.10);
    color: rgba(255,255,255,0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s, color 0.12s;
  }
  .tool-btn:hover { background: rgba(255,255,255,0.28); color: #fff; }
  .tool-sep {
    width: 1px;
    height: 18px;
    background: rgba(255,255,255,0.15);
    margin: 0 4px;
  }
  .cue-count {
    font-size: 11px;
    font-weight: 500;
    color: rgba(255,255,255,0.4);
    font-variant-numeric: tabular-nums;
  }


  .cue-list {
    overflow-y: auto;
    flex: 1;
    padding: 4px 0 40vh;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.18) transparent;
  }
  .cue-list::-webkit-scrollbar { width: 8px; }
  .cue-list::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.16);
    border-radius: 4px;
  }

  .cue-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 10px 9px 14px;
    cursor: pointer;
    transition: background 0.12s;
  }
  .cue-item:hover { background: rgba(255,255,255,0.07); }
  .cue-item.active { background: #2f6fed; }

  .cue-body { flex: 1; min-width: 0; }

  .cue-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
  }
  .cue-ts {
    font-size: 10.5px;
    color: rgba(255,255,255,0.42);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.3px;
  }
  .cue-item.active .cue-ts { color: rgba(255,255,255,0.75); }

  .cue-play {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    border: none;
    padding: 0;
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.75);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .cue-play:hover { background: #2f6fed; color: #fff; }
  .cue-item.active .cue-play { background: rgba(255,255,255,0.25); color: #fff; }

  .cue-text {
    font-size: 13.5px;
    line-height: 1.45;
    color: rgba(255,255,255,0.88);
  }
  .cue-item.active .cue-text { color: #fff; font-weight: 500; }

  .cue-translation {
    font-size: 12px;
    color: rgba(140,175,245,0.85);
    margin-top: 3px;
    line-height: 1.4;
  }
  .cue-item.active .cue-translation { color: rgba(255,255,255,0.82); }

  .word-span {
    position: relative;
    cursor: pointer;
    border-radius: 3px;
    padding: 0 1px;
    transition: background 0.12s;
  }
  .word-span:hover { background: rgba(255,255,255,0.22); }
  .word-span.saved { border-bottom: 2px solid var(--wc, #ffd93d); }
  .word-span.due {
    background: rgba(255,217,61,0.22);
    box-shadow: 0 0 0 1px rgba(255,217,61,0.4);
  }

  /* Only saved words carry one, and only while pointed at, so the list stays
     readable. */
  .unsave {
    display: none;
    position: absolute;
    top: -8px;
    right: -8px;
    width: 15px;
    height: 15px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: #d84a4a;
    color: #fff;
    font-size: 10px;
    line-height: 15px;
    text-align: center;
    cursor: pointer;
    z-index: 1;
  }
  .unsave:hover { background: #ff6b6b; }
  .word-span.saved:hover .unsave { display: block; }

`

// Time-based lookup needs the cue itself, not just its text.
const _cueByElement = new WeakMap<HTMLElement, SubtitleCue>()

function translateCueItem(item: HTMLElement) {
  const el = item.querySelector<HTMLElement>('.cue-translation')
  const cue = _cueByElement.get(item)
  if (!el || !cue || el.dataset.done === '1') return
  el.dataset.done = '1'

  const native = nativeTranslationFor(cue)
  if (native) {
    el.textContent = native
    keepActiveRowVisible(item)
    return
  }

  el.textContent = '…'
  void translationFor(cue, _targetLang).then(text => {
    el.textContent = text
    // Let it retry next time it scrolls into view.
    if (!text) el.dataset.done = ''
    keepActiveRowVisible(item)
  })
}

/**
 * Re-align after a row grew.
 *
 * Translations arrive after the row is already on screen and already scrolled
 * to, and a paragraph of them can double a row's height. The scroll position
 * that framed the row a moment ago then leaves its lower half below the fold —
 * which looks exactly like auto-scroll being wrong, but is the row moving after
 * the scroll, not the scroll going to the wrong place.
 */
function keepActiveRowVisible(item: HTMLElement): void {
  if (item !== _cueEls[_activeIndex]) return
  if (Date.now() - _userScrolledAt < 4000) return
  scrollRowIntoView(item)
}

// Paint (or un-paint) a word according to the library, including its remove
// button. Shared so a refresh produces exactly what a rebuild would.
function applySavedState(span: HTMLElement, clean: string): void {
  const key = clean.toLowerCase()
  const color = _savedColorsMap.get(key)

  span.classList.toggle('saved', !!color)
  span.classList.toggle('due', !!color && _dueWords.has(key))
  span.querySelector('.unsave')?.remove()

  if (!color) return
  span.style.setProperty('--wc', BOOKMARK_COLOR_HEX[color] ?? '#ffd93d')
  span.title = _dueWords.has(key) ? 'Due for review' : ''

  const remove = document.createElement('button')
  remove.className = 'unsave'
  remove.textContent = '×'
  remove.title = `Remove "${clean}" from your library`
  remove.addEventListener('click', (e) => {
    e.stopPropagation()  // don't seek, don't look up
    _onUnsave?.(clean)
  })
  span.appendChild(remove)
}

function buildCueItem(cue: SubtitleCue): HTMLElement {
  const item = document.createElement('div')
  item.className = 'cue-item'
  item.dataset.index = String(cue.index)
  _cueByElement.set(item, cue)

  const meta = document.createElement('div')
  meta.className = 'cue-meta'

  const play = document.createElement('button')
  play.className = 'cue-play'
  play.title = 'Jump to this line'
  play.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 21 12 6 21"/></svg>'
  play.addEventListener('click', (e) => {
    e.stopPropagation()
    _onSeek?.()
    seekToSeconds(cue.startTime)
  })

  const ts = document.createElement('span')
  ts.className = 'cue-ts'
  ts.textContent = formatTs(cue.startTime)

  meta.append(play, ts)

  const textRow = document.createElement('div')
  textRow.className = 'cue-text'

  // Word-by-word spans for lookup
  const tokens = (cue.text.match(/\S+/g) ?? [])
  tokens.forEach((token, i) => {
    // A real space between words, for the same reason as the subtitle strip.
    if (i > 0) textRow.appendChild(document.createTextNode(' '))
    const clean = strippedWord(token)
    const span = document.createElement('span')
    span.className = 'word-span'
    span.textContent = token
    applySavedState(span, clean)
    span.addEventListener('click', (e) => {
      e.stopPropagation()
      if (clean) _onLookup?.(clean, cue)
    })
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      if (clean) _onSave?.(clean, cue)
    })
    textRow.appendChild(span)
  })

  const translationEl = document.createElement('div')
  translationEl.className = 'cue-translation'
  translationEl.dataset.source = cue.text

  const body = document.createElement('div')
  body.className = 'cue-body'
  body.append(meta, textRow, translationEl)

  item.appendChild(body)

  // Click anywhere else on the row → seek as well
  item.addEventListener('click', () => { _onSeek?.(); seekToSeconds(cue.startTime) })

  return item
}

const TOOLBAR_ICONS: Record<SeekTarget, string> = {
  prev: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4"/><rect x="4" y="4" width="2.5" height="16" rx="1"/></svg>',
  replay: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
  next: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20"/><rect x="17.5" y="4" width="2.5" height="16" rx="1"/></svg>',
}

const TOOLBAR_GEAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'

function buildToolbar(): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'sidebar-toolbar'

  const HINTS: Record<SeekTarget, string> = {
    prev: 'Previous line  (A)',
    replay: 'Replay this line  (R)',
    next: 'Next line  (D)',
  }
  for (const target of ['prev', 'replay', 'next'] as SeekTarget[]) {
    const btn = document.createElement('button')
    btn.className = 'tool-btn'
    btn.innerHTML = TOOLBAR_ICONS[target]
    btn.title = HINTS[target]
    btn.addEventListener('click', () => _onSeekLine?.(target))
    bar.appendChild(btn)
  }

  const sep = document.createElement('div')
  sep.className = 'tool-sep'
  bar.appendChild(sep)

  const gear = document.createElement('button')
  gear.className = 'tool-btn'
  gear.title = 'Video Mode settings'
  gear.innerHTML = TOOLBAR_GEAR
  gear.addEventListener('click', (e) => {
    e.stopPropagation()
    _onOpenSettings?.(gear)
  })
  bar.appendChild(gear)

  return bar
}

export function initDialogueSidebar(opts: {
  cues: SubtitleCue[]
  savedItems: SavedItem[]
  onLookup: LookupCallback
  onSave: SaveCallback
  showTranslation: boolean
  targetLang: string
  collapsed?: boolean
  onLayoutChange?: () => void
  onSeek?: () => void
  onUnsave?: (word: string) => void
  /** Toolbar: jump a line back / replay / forward. */
  onSeekLine?: (target: SeekTarget) => void
  onOpenSettings?: (anchor: HTMLElement) => void
}): void {
  _onLookup = opts.onLookup
  _onSave = opts.onSave
  _showTranslation = opts.showTranslation
  _targetLang = opts.targetLang
  _isCollapsed = opts.collapsed ?? false
  _onLayoutChange = opts.onLayoutChange ?? null
  _onSeek = opts.onSeek ?? null
  _onUnsave = opts.onUnsave ?? null
  _onSeekLine = opts.onSeekLine ?? null
  _onOpenSettings = opts.onOpenSettings ?? null
  _savedColorsMap = new Map(opts.savedItems.map(i => [i.text.toLowerCase(), i.color]))
  _dueWords = dueWordSet(opts.savedItems)

  _host = document.createElement('div')
  _host.id = 'elezone-dialogue-sidebar'
  _shadow = _host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = SIDEBAR_CSS
  _shadow.appendChild(style)

  const sidebar = document.createElement('div')
  sidebar.className = `sidebar${_isCollapsed ? ' collapsed' : ''}`

  // Header (click to collapse/expand)
  const header = document.createElement('div')
  header.className = 'sidebar-header'
  header.innerHTML = `
    <span class="sidebar-title">Subtitles</span>
    <span class="cue-count"></span>
  `

  // List
  _listEl = document.createElement('div')
  _listEl.className = 'cue-list'
  _activeIndex = -1
  const noteScroll = () => { _userScrolledAt = Date.now() }
  _listEl.addEventListener('wheel', noteScroll, { passive: true })
  _listEl.addEventListener('touchmove', noteScroll, { passive: true })

  // Build cue items
  _cueEls = []
  for (const cue of opts.cues) {
    const el = buildCueItem(cue)
    _listEl.appendChild(el)
    _cueEls.push(el)
  }

  updateCueCount()

  sidebar.append(header, _listEl, buildToolbar())
  _shadow.appendChild(sidebar)
  document.body.appendChild(_host)

  // Translate cues lazily, as they scroll into the list's viewport.
  if (_showTranslation) {
    _translationObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) translateCueItem(entry.target as HTMLElement)
      }
    }, { root: _listEl, rootMargin: '200px 0px' })
    for (const el of _cueEls) _translationObserver.observe(el)
  }
}

/**
 * Append a single cue. Used by the DOM-parser fallback, which discovers cues
 * one at a time as they appear on screen rather than up front.
 */
export function appendDialogueSidebarCue(cue: SubtitleCue): void {
  if (!_listEl) return
  const el = buildCueItem(cue)
  _listEl.appendChild(el)
  _cueEls.push(el)
  _translationObserver?.observe(el)
  updateCueCount()
}

function updateCueCount(): void {
  const el = _shadow?.querySelector('.cue-count')
  if (el) el.textContent = _cueEls.length > 0 ? String(_cueEls.length) : ''
}

/**
 * Bring a row into view.
 *
 * Smooth scrolling suits following along line by line, but not arriving from far
 * away — after a reload Netflix resumes mid-film, so the active row can be a
 * thousand rows down. A smooth scroll over that distance animates for seconds,
 * and the next line's scroll cancels it before it lands, so the list creeps
 * along a line at a time and never catches up. Long jumps go instantly.
 */
function scrollRowIntoView(el: HTMLElement): void {
  if (!_listEl) return
  const list = _listEl.getBoundingClientRect()
  if (list.height === 0) return  // collapsed; re-run when it reopens

  // Deliberately not `el.scrollIntoView()`. That scrolls every scrollable
  // ancestor, and once the sidebar sits in the page's own flow rather than
  // floating over it, the page is one of them: every new line of dialogue
  // scrolled the whole of YouTube. Moving the list's own scrollTop touches
  // nothing outside the list.
  // Measured as a delta between two rects rather than through offsetTop, which
  // is relative to whichever ancestor happens to be positioned — and inside a
  // shadow root that is not reliably the list.
  const row = el.getBoundingClientRect()

  // Centring is right for an ordinary line, and wrong for a long one: a block
  // taller than the list would be centred with both its beginning and its end
  // off-screen. When it cannot all fit, show it from the top, so at least it is
  // read from the start.
  const delta = row.height >= list.height
    ? row.top - list.top - 8
    : (row.top + row.height / 2) - (list.top + list.height / 2)
  const maxTop = Math.max(0, _listEl.scrollHeight - _listEl.clientHeight)
  const top = Math.max(0, Math.min(_listEl.scrollTop + delta, maxTop))

  // A long jump — after a reload, or when the learner clicks far down the list —
  // is made instantly: a smooth scroll over that distance is still travelling
  // when the next line arrives and cancels it, so it never actually arrives.
  const distance = Math.abs(top - _listEl.scrollTop)
  _listEl.scrollTo({ top, behavior: distance > list.height * 1.5 ? 'auto' : 'smooth' })
}

export function updateDialogueSidebarCue(currentIndex: number): void {
  if (!_listEl || currentIndex === _activeIndex) return

  // Touch only the two rows that change — a feature film has ~1500 of them.
  _cueEls[_activeIndex]?.classList.remove('active')
  _activeIndex = currentIndex

  const el = _cueEls[currentIndex]
  if (!el) return
  el.classList.add('active')

  if (Date.now() - _userScrolledAt > 4000) scrollRowIntoView(el)
}

/**
 * Put the line being spoken back in the middle of the list.
 *
 * For when the panel itself changed shape — going fullscreen swaps a column as
 * tall as the picture for one as tall as the screen. Restoring the scroll offset
 * across that is not enough: the same number of pixels keeps the same row at the
 * top, so the row that was centred no longer is, and the highlight ends up
 * somewhere off to the side of where the eye expects it.
 *
 * Deliberately ignores the manual-scroll backoff. The learner did not scroll —
 * the panel resized under them — and the answer to that is to put things back
 * where they were looking.
 */
export function recentreActiveCue(): void {
  const el = _cueEls[_activeIndex]
  if (el) scrollRowIntoView(el)
}

export function updateDialogueSidebarSavedItems(savedItems: SavedItem[]): void {
  _savedColorsMap = new Map(savedItems.map(i => [i.text.toLowerCase(), i.color]))
  _dueWords = dueWordSet(savedItems)
  // Refresh saved highlighting on all word spans
  if (!_shadow) return
  _shadow.querySelectorAll<HTMLElement>('.word-span').forEach(span => {
    // The × is a child of the span, so read the word from the text node alone.
    const raw = span.firstChild?.textContent ?? span.textContent ?? ''
    applySavedState(span, strippedWord(raw))
  })
}

export function destroyDialogueSidebar(): void {
  _translationObserver?.disconnect()
  _translationObserver = null
  _host?.remove()
  _host = null
  _shadow = null
  _listEl = null
  _cueEls = []
  _activeIndex = -1
}

/**
 * Scroll position of the cue list.
 *
 * Re-parenting the sidebar (which fullscreen requires) detaches it from the
 * document, and a detached element loses the scroll offset of everything
 * inside it — so the caller has to carry it across the move by hand.
 */
export function getSidebarScrollTop(): number {
  return _listEl?.scrollTop ?? 0
}

export function setSidebarScrollTop(px: number): void {
  if (_listEl) _listEl.scrollTop = px
}

/** Width the sidebar currently occupies, so the overlay can centre beside it. */
export function getSidebarWidth(): number {
  const sidebar = _shadow?.querySelector<HTMLElement>('.sidebar')
  return sidebar ? sidebar.getBoundingClientRect().width : 0
}

/** Expand (true) or collapse to the narrow strip (false). */
export function setSidebarVisible(visible: boolean): void {
  if (!_shadow) return
  const sidebar = _shadow.querySelector<HTMLElement>('.sidebar')
  if (!sidebar) return
  _isCollapsed = !visible
  sidebar.classList.toggle('collapsed', _isCollapsed)
  setTimeout(() => {
    _onLayoutChange?.()
    // The list has no size while collapsed, so any scroll issued then was a
    // no-op — put the active row back in view now that it does.
    if (visible && _activeIndex >= 0) {
      const el = _cueEls[_activeIndex]
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'center' })
    }
  }, 220)
}
