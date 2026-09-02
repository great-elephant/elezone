import { SavedItem, Settings, BookmarkColor, StudyMode, colorHex, UNCATEGORIZED_COLOR } from '../shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import StudyUI from './StudyUI'

const ALL_COLORS: BookmarkColor[] = [
  'red', 'yellow', 'cyan', 'green', 'blue',
  'orange', 'purple', 'pink', 'teal', 'gray'
]

// UNCATEGORIZED_COLOR (imported above): reserved bucket a deleted deck's
// items fall back into — always present in `deckOrder`, never
// renamable/deletable itself (see `deleteDeck`). A plain color string like
// any other deck, not a special data shape, so nothing else in this file
// needs to special-case "no deck" as a separate concept. Exported from
// shared/types.ts so other consumers of `deckOrder` (e.g. the save-text
// deck picker in dictionary.ts) can recognize and label it consistently.

// getAllItems() already backfills a missing/NaN createdAt with a real
// timestamp (updatedAt, or 0) before it ever reaches this component — this
// is a second layer of defense, not the fix itself: Array.sort's behavior is
// unspecified once its comparator ever returns NaN (a single bad item's
// Math.max/subtraction going NaN can silently corrupt the ordering of the
// WHOLE list, not just that one item), so every comparator here reads
// createdAt through this instead of the raw field directly.
function safeCreatedAt(item: SavedItem): number {
  return typeof item.createdAt === 'number' && !isNaN(item.createdAt) ? item.createdAt : 0
}

const STUDY_MODES: { value: StudyMode; label: string }[] = [
  { value: 'passive', label: 'Passive Flashcard' },
  { value: 'typing', label: 'Typing (Active Recall)' },
  { value: 'listening', label: 'Listening (Dictation)' },
  { value: 'multiple_choice', label: 'Multiple Choice' },
]

type ViewMode = 'decks' | 'source'
type SortBy = 'newest' | 'oldest' | 'az'
type OpenPicker = { kind: 'row'; id: string } | { kind: 'bulk' } | null
type DetailPanel = { kind: 'deck'; color: string } | { kind: 'source'; url: string }

const isWord = (item: SavedItem) => !!item.translation

// An item counts as due once its FSRS `due` (preferred) or legacy SM-2
// `nextReview` has passed — same convention as background/index.ts's
// notification alarm.
function isDue(item: SavedItem): boolean {
  const due = item.due ?? item.nextReview
  return typeof due === 'number' && due <= Date.now()
}

export default function Library({
  items,
  settings,
  onDelete,
  onUpdateColor,
  onUpdateSettings,
}: {
  items: SavedItem[]
  settings: Settings
  onDelete: (id: string) => void
  onUpdateColor: (id: string, color: string) => void
  onUpdateSettings: (settings: Settings) => void
}) {
  // Study session
  const [sessionActive, setSessionActive] = useState(false)
  const [sessionItems, setSessionItems] = useState<SavedItem[]>([])
  const [studyMode, setStudyMode] = useState<StudyMode>(settings.defaultStudyMode || 'listening')

  // "Deck" is a freeform color string (a hex from the picker, or one of the
  // 10 legacy `BookmarkColor` names — both are valid CSS values, see
  // `colorHex()`) + `Settings.deckLabels`/`deckOrder`, keyed by that same
  // string. No new entity/storage: every item already has a `color` —
  // nothing is ever "unclassified" at the data level (the closest thing,
  // `UNCATEGORIZED_COLOR`, is just another color string). `deckOrder` starts
  // from whatever's saved, falling back to the 10 presets on a fresh
  // install, and always includes every color actually in use (or named) —
  // plus the reserved bucket — even if it hasn't been explicitly ordered
  // yet, so nothing is ever missing from the table until the next drag.
  const deckLabels = settings.deckLabels || {}
  const storedDeckOrder = settings.deckOrder?.length ? settings.deckOrder : ALL_COLORS
  const deckOrder = useMemo(() => {
    const known = new Set(storedDeckOrder)
    const extra: string[] = []
    items.forEach(i => { if (!known.has(i.color)) { known.add(i.color); extra.push(i.color) } })
    Object.keys(deckLabels).forEach(c => { if (!known.has(c)) { known.add(c); extra.push(c) } })
    if (!known.has(UNCATEGORIZED_COLOR)) extra.push(UNCATEGORIZED_COLOR)
    return extra.length ? [...storedDeckOrder, ...extra] : storedDeckOrder
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedDeckOrder, items, deckLabels])
  const deckName = (color: string) => color === UNCATEGORIZED_COLOR ? 'Uncategorized' : (deckLabels[color] || color)

  // Adds `color` to `order` if it's not already there. New decks default to
  // the bottom of the list, but always above the reserved Uncategorized
  // bucket — Uncategorized isn't a "real" deck the user made, it should stay
  // last no matter what gets added after it.
  function withDeckColor(order: string[], color: string): string[] {
    if (order.includes(color)) return order
    const idx = order.indexOf(UNCATEGORIZED_COLOR)
    return idx === -1 ? [...order, color] : [...order.slice(0, idx), color, ...order.slice(idx)]
  }

  function setDeckLabel(color: string, name: string) {
    const labels = { ...deckLabels }
    if (name.trim()) labels[color] = name
    else delete labels[color]
    // Persist deckOrder too, not just deckLabels. This page's own `deckOrder`
    // above is derived fresh every render, so a brand-new deck shows up here
    // immediately regardless — but other surfaces (background's context
    // menu, dictionary.ts's save-text deck picker) read `Settings.deckOrder`
    // straight from storage. Without this, a newly created deck was invisible
    // there until the next drag-reorder happened to persist the full order.
    onUpdateSettings({ ...settings, deckLabels: labels, deckOrder: withDeckColor(deckOrder, color), updatedAt: Date.now() })
  }

  // Delete a deck: every item in it falls back to the reserved Uncategorized
  // bucket, its name is forgotten, and it drops out of `deckOrder`. The
  // reserved bucket itself can't be deleted (there'd be nowhere left for its
  // own items to go).
  function deleteDeck(color: string) {
    if (color === UNCATEGORIZED_COLOR) return
    const stats = deckStats.get(color)
    const count = stats?.total ?? 0
    const ok = window.confirm(
      count > 0
        ? `Delete "${deckName(color)}"? ${count} item(s) will move to Uncategorized.`
        : `Delete "${deckName(color)}"?`
    )
    if (!ok) return
    items.filter(i => i.color === color).forEach(i => onUpdateColor(i.id, UNCATEGORIZED_COLOR))
    const labels = { ...deckLabels }
    delete labels[color]
    onUpdateSettings({
      ...settings,
      deckLabels: labels,
      deckOrder: deckOrder.filter(c => c !== color),
      updatedAt: Date.now(),
    })
    if (detailPanel?.kind === 'deck' && detailPanel.color === color) closePanel()
  }

  // Drag-to-reorder the deck table — sets `Settings.deckOrder`, which both
  // this table's sort AND the right-click save menu's ordering read
  // (background/index.ts's setupContextMenus/colorMenuTitle). Moved here
  // from SettingsPanel's old "Decks" section.
  const dndSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  function handleDeckDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = deckOrder.indexOf(active.id as string)
    const to = deckOrder.indexOf(over.id as string)
    if (from === -1 || to === -1) return
    onUpdateSettings({ ...settings, deckOrder: arrayMove(deckOrder, from, to), updatedAt: Date.now() })
  }

  // Deck modal — name + color picker, shared by "edit an existing row" and
  // "+ New deck". `sourceColor` is the row that was clicked (its current
  // identity); `null` means opened via "+ New deck" (no row yet). Picking a
  // DIFFERENT color than `sourceColor` in the edit flow means "recolor this
  // deck": the name transfers to the new color and every item currently in
  // `sourceColor` moves with it — color is the deck's identity, so changing
  // it is a bulk move, not a cosmetic swap. Color itself is a real
  // `<input type="color">` (freeform hex output).
  const [deckModal, setDeckModal] = useState<{ sourceColor: string | null } | null>(null)
  const [modalName, setModalName] = useState('')
  const [modalColor, setModalColor] = useState<string | undefined>(undefined)

  function openEditDeckModal(color: string) {
    setModalName(deckLabels[color] ?? '')
    setModalColor(color)
    setDeckModal({ sourceColor: color })
  }
  function openNewDeckModal() {
    setModalName('')
    // A native `<input type="color">` always has a value — default to the
    // app's own accent rather than leaving it undefined, so the swatch and
    // the Save button both start in a sane, immediately-usable state.
    setModalColor('#6b8aff')
    setDeckModal({ sourceColor: null })
  }
  function confirmDeckModal() {
    const name = modalName.trim()
    if (!deckModal || !modalColor || !name) return
    const source = deckModal.sourceColor

    if (source && source !== modalColor) {
      const targetStats = deckStats.get(modalColor)
      const targetHasStuff = (targetStats?.total ?? 0) > 0 || !!deckLabels[modalColor]
      if (targetHasStuff) {
        const targetName = deckName(modalColor)
        const ok = window.confirm(
          `"${targetName}" already has ${targetStats?.total ?? 0} item(s) and/or a name. ` +
          `Continuing will merge this deck into it — all items move over and the name is overwritten. Continue?`
        )
        if (!ok) return
      }
      const labels = { ...deckLabels }
      delete labels[source]
      labels[modalColor] = name
      // Same deckOrder-persistence reasoning as setDeckLabel above — modalColor
      // may be a brand-new custom color, not yet in stored deckOrder.
      onUpdateSettings({ ...settings, deckLabels: labels, deckOrder: withDeckColor(deckOrder, modalColor), updatedAt: Date.now() })
      items.filter(i => i.color === source).forEach(i => onUpdateColor(i.id, modalColor!))
    } else {
      setDeckLabel(modalColor, name)
    }
    setDeckModal(null)
  }

  // ── View: Decks landing vs. "View by Source" ──────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('decks')
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set())
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set())
  // Selection doesn't carry across tabs — ticking decks, switching to "By
  // Source", and finding them still ticked (invisibly, since decks aren't
  // even on screen there) was more confusing than useful. applyFocus doesn't
  // need cross-tab combining to work: focusing sources alone already mutes
  // every deck too (see applyFocus's comment), so there's nothing lost.
  function switchView(mode: ViewMode) {
    setViewMode(mode)
    setSelectedColors(new Set())
    setSelectedSources(new Set())
  }

  // ── Background notification opt-out lists ──────────────────────────────────
  // Two ways to edit the same two lists: an individual bell icon per deck/
  // source row (toggleDeckMute/toggleSourceMute), or the bulk "Focus" action
  // (applyFocus — ticks several rows via the existing selectedColors/
  // selectedSources selection, then sets the list to everything EXCEPT
  // what's ticked). Neither list exists yet for a fresh install, hence the
  // `?? []` everywhere below.
  const mutedDecks = new Set(settings.mutedNotificationDecks ?? [])
  const mutedSources = new Set(settings.mutedNotificationSources ?? [])

  // Transient confirmation for mute/Focus actions — a persistent banner here
  // was tried first and felt heavy-handed for something that can stay true
  // for weeks (a deliberately-muted deck isn't a "warning" that needs
  // permanent screen space). The per-row bell icon is already the durable
  // "what's muted right now" indicator; this toast is just "yes, that click
  // did something", and goes away on its own.
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showToast(message: string) {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  function toggleDeckMute(color: string) {
    const next = new Set(mutedDecks)
    if (next.has(color)) { next.delete(color); showToast(`🔔 Unmuted ${deckName(color)}`) }
    else { next.add(color); showToast(`🔕 Muted ${deckName(color)}`) }
    onUpdateSettings({ ...settings, mutedNotificationDecks: [...next], updatedAt: Date.now() })
  }
  function toggleSourceMute(url: string) {
    const next = new Set(mutedSources)
    const label = url.startsWith('http') ? url.replace(/^https?:\/\//, '') : url
    if (next.has(url)) { next.delete(url); showToast(`🔔 Unmuted ${label}`) }
    else { next.add(url); showToast(`🔕 Muted ${label}`) }
    onUpdateSettings({ ...settings, mutedNotificationSources: [...next], updatedAt: Date.now() })
  }
  // "Focus" acts on BOTH axes at once, always — whichever tab you're on when
  // you click it, and even if one axis has NOTHING ticked. That last part
  // matters: a deck and a source aren't independent — the same item can be
  // in muted deck "English" AND unmuted source "A" at once, and would then
  // wrongly still notify if only the source axis got restricted. Ticking
  // only source "A" and hitting Focus must ALSO mute every deck (English
  // included), not just leave the deck list untouched, or English's bell
  // would misleadingly still show "on" while none of its items outside
  // source A could ever actually notify anyway. `!selectedX.has(c)` already
  // means "everything" when selectedX is empty, so no special-casing needed
  // — just always run both filters. The tradeoff: ticking every deck no
  // longer doubles as "reset sources too" (it can't, sources weren't
  // touched) — resetAllMutes below is the explicit way back to "notify
  // about everything" now.
  function applyFocus() {
    if (selectedColors.size === 0 && selectedSources.size === 0) return
    const excludedDecks = deckOrder.filter(c => !selectedColors.has(c))
    const excludedSources = Object.keys(sourceGroups).filter(u => !selectedSources.has(u))
    onUpdateSettings({
      ...settings,
      mutedNotificationDecks: excludedDecks,
      mutedNotificationSources: excludedSources,
      updatedAt: Date.now(),
    })
    const deckPart = selectedColors.size > 0
      ? `${selectedColors.size} deck${selectedColors.size === 1 ? '' : 's'}`
      : 'no decks'
    const sourcePart = selectedSources.size > 0
      ? `${selectedSources.size} source${selectedSources.size === 1 ? '' : 's'}`
      : 'no sources'
    showToast(`🎯 Focused on ${deckPart} and ${sourcePart} — everything else muted`)
  }
  function resetAllMutes() {
    onUpdateSettings({ ...settings, mutedNotificationDecks: [], mutedNotificationSources: [], updatedAt: Date.now() })
    showToast('🔔 Notifications restored for everything')
  }

  // Detail panel — a slide-over drawer shared by BOTH "click a deck" and
  // "click a source", instead of two different interaction patterns. Only
  // one is ever open at a time (they're opened from different tabs), so
  // there's no stacking/nesting to worry about, unlike an earlier version of
  // this file that briefly had drawers-inside-drawers and was worse for it.
  const [detailPanel, setDetailPanel] = useState<DetailPanel | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)

  function openDeckPanel(color: string) {
    setSelectedIds(new Set())
    setSearch('')
    setDetailPanel({ kind: 'deck', color })
  }
  function openSourcePanel(url: string) {
    setSelectedIds(new Set())
    setSearch('')
    setDetailPanel({ kind: 'source', url })
  }
  function closePanel() {
    setPanelOpen(false)
    // Keep rendering the (now-closing) panel's content for the duration of
    // the slide-out transition, instead of unmounting it mid-animation.
    window.setTimeout(() => setDetailPanel(null), 200)
  }

  useEffect(() => {
    if (!detailPanel) return
    const raf = requestAnimationFrame(() => setPanelOpen(true))
    return () => cancelAnimationFrame(raf)
  }, [detailPanel])

  useEffect(() => {
    if (!detailPanel) return
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') closePanel() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailPanel])

  // Lock the page's own scroll while the drawer is mounted (open or closing),
  // so scrolling with the drawer up moves the drawer's list, not the Library
  // page underneath it. Actually hides the outer scrollbar (via the
  // data-scroll-lock attribute Options.tsx's `html[data-scroll-lock]` rule
  // targets) rather than leaving it visible-but-dead next to the drawer's
  // own scrollbar — two scrollbars on screen at once reads as broken.
  // overflow: hidden preserves the page's current scroll offset on its own
  // (browsers restore it once overflow goes back to scroll), so there's no
  // need to manually save/restore scrollY like a position:fixed lock would.
  // The width hiding it reclaims is compensated with a matching
  // padding-right on body, computed from the real scrollbar width, so
  // nothing shifts.
  useEffect(() => {
    if (!detailPanel) return
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    const prevPaddingRight = document.body.style.paddingRight
    document.documentElement.setAttribute('data-scroll-lock', 'true')
    document.body.style.paddingRight = `${scrollbarWidth}px`
    return () => {
      document.documentElement.removeAttribute('data-scroll-lock')
      document.body.style.paddingRight = prevPaddingRight
    }
  }, [detailPanel])

  // Browse controls (used both by source view and inside the detail panel)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('newest')

  // Interaction (item-level, scoped to whichever list is on screen)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openPicker, setOpenPicker] = useState<OpenPicker>(null)
  const [pickerRect, setPickerRect] = useState<DOMRect | null>(null)
  // Which 🔊 button (identified by a caller-chosen key, e.g. an item id or
  // `${id}-sentence`) is the one currently playing — drives showing a ⏹ on
  // that specific button instead of 🔊, and lets clicking it again act as
  // Stop rather than restarting the same audio from the top.
  const [speakingKey, setSpeakingKey] = useState<string | null>(null)

  function playAudio(key: string, text: string, lang?: string) {
    if (speakingKey === key) {
      chrome.tts.stop()
      setSpeakingKey(null)
      return
    }
    if (!settings?.readAloud) return
    const r = settings.readAloud
    chrome.tts.stop()
    const onEvent = (event: chrome.tts.TtsEvent) => {
      if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
        setSpeakingKey(k => (k === key ? null : k))
      }
    }
    setSpeakingKey(key)
    if (lang && r.languageVoices?.[lang]) {
      chrome.tts.speak(text, { pitch: r.pitch, rate: r.speed, lang, voiceName: r.languageVoices[lang], volume: r.volume, onEvent })
    } else if (r.voice) {
      chrome.tts.speak(text, { pitch: r.pitch, rate: r.speed, lang, voiceName: r.voice || undefined, volume: r.volume, onEvent })
    } else {
      chrome.tts.speak(text, { lang, onEvent })
    }
  }

  function startStudySession(itemsToStudy: SavedItem[]) {
    if (itemsToStudy.length === 0) return
    setSessionItems(itemsToStudy)
    setSessionActive(true)
  }

  function toggleSet<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  function moveToDeck(ids: string[], color: string) {
    ids.forEach(id => onUpdateColor(id, color))
  }

  // Per-color item counts + due counts across the whole library.
  const deckStats = useMemo(() => {
    const map = new Map<string, { total: number; due: number }>()
    for (const c of deckOrder) map.set(c, { total: 0, due: 0 })
    for (const item of items) {
      const s = map.get(item.color) ?? { total: 0, due: 0 }
      s.total += 1
      if (isDue(item)) s.due += 1
      map.set(item.color, s)
    }
    return map
  }, [items, deckOrder])

  const totalDueAllDecks = useMemo(() => [...deckStats.values()].reduce((n, s) => n + s.due, 0), [deckStats])
  const totalItemsAllDecks = items.length

  // With NO deck/source ticked, "Study now" means exactly what its card says
  // — "Study all DUE" — across the whole library, so it doesn't dump the
  // entire (possibly multi-hundred-word) library on you with no scoping at
  // all. But once you've explicitly ticked specific decks/sources, that tick
  // IS the scoping — matching the drawer's own "▶ Study N" button (which
  // studies everything currently in view, not just what's due) rather than
  // filtering further by due-ness on top of an already-deliberate selection.
  function studyAllDueFromSelectedDecks() {
    const selected = selectedColors.size > 0
      ? items.filter(i => selectedColors.has(i.color))
      : items.filter(isDue)
    startStudySession(selected)
  }
  function studyAllDueFromSelectedSources() {
    const selected = selectedSources.size > 0
      ? items.filter(i => selectedSources.has(i.url || 'Dictionary (No URL)'))
      : items.filter(isDue)
    startStudySession(selected)
  }

  function applySearchSort(list: SavedItem[]): SavedItem[] {
    const q = search.trim().toLowerCase()
    const result = q
      ? list.filter(item => (item.text + ' ' + (item.translation || '')).toLowerCase().includes(q))
      : list.slice()
    result.sort((a, b) => {
      if (sortBy === 'az') return a.text.localeCompare(b.text)
      if (sortBy === 'oldest') return safeCreatedAt(a) - safeCreatedAt(b)
      return safeCreatedAt(b) - safeCreatedAt(a)
    })
    return result
  }

  const sourceViewItems = useMemo(() => applySearchSort(items), [items, search, sortBy])
  // Grouped from sourceViewItems (already search-filtered + sorted), not raw
  // `items` — grouping from raw items silently ignored both the search box
  // and the sort dropdown on this tab (they were computed into
  // sourceViewItems but nothing ever read it for the actual rendered list).
  const sourceGroups = useMemo(() => {
    const byUrl: Record<string, SavedItem[]> = {}
    for (const item of sourceViewItems) {
      const url = item.url || 'Dictionary (No URL)'
      ;(byUrl[url] ||= []).push(item)
    }
    return byUrl
  }, [sourceViewItems])

  const panelItems = useMemo(() => {
    if (!detailPanel) return []
    const filtered = detailPanel.kind === 'deck'
      ? items.filter(i => i.color === detailPanel.color)
      : items.filter(i => (i.url || 'Dictionary (No URL)') === detailPanel.url)
    return applySearchSort(filtered)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, detailPanel, search, sortBy])

  if (sessionActive) {
    return (
      <StudyUI
        items={sessionItems}
        mode={studyMode}
        settings={settings}
        onClose={() => setSessionActive(false)}
      />
    )
  }

  if (items.length === 0) {
    return (
      <div style={styles.empty}>
        <h3 style={{ margin: '0 0 8px' }}>Your library is empty</h3>
        <p style={{ margin: 0 }}>Highlight text and right-click to save sentences, or double-click words to save flashcards.</p>
      </div>
    )
  }

  // Deck modal — computed once so both the landing table (edit trigger per
  // row + "+ New deck") and the detail panel (edit trigger in its header)
  // can render it without duplicating markup.
  const deckModalEl = deckModal && (
    <div style={styles.modalOverlay} onClick={() => setDeckModal(null)}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        {/* `<input type="color">`'s actual swatch is a UA shadow-DOM
            pseudo-element (`::-webkit-color-swatch`/`::-moz-color-swatch`),
            not the input box itself — `border-radius`/`border` set on the
            element only shape its outer hit-box, not what's visibly
            painted. Pseudo-elements can only be targeted via a real
            stylesheet rule, not the inline `style` prop, hence this scoped
            tag (same pattern StudyUI.tsx already uses for its @keyframes). */}
        <style>{`
          .cxt-deck-color-input { -webkit-appearance: none; appearance: none; border: none; padding: 0; background: none; cursor: pointer; }
          .cxt-deck-color-input::-webkit-color-swatch-wrapper { padding: 0; }
          .cxt-deck-color-input::-webkit-color-swatch { border: 1px solid #3a3a6a; border-radius: 8px; }
          .cxt-deck-color-input::-moz-color-swatch { border: 1px solid #3a3a6a; border-radius: 8px; }
        `}</style>
        <h3 style={{ margin: '0 0 14px', color: '#e8e8f5' }}>
          {deckModal.sourceColor ? 'Edit deck' : 'New deck'}
        </h3>
        {/* Swatch + name side by side, like a colored avatar next to a
            title. flex-start (not center): the right column is taller than
            the name input alone (name input + hex caption below it), so
            centering against the whole column would push the swatch below
            the input's own vertical middle instead of sitting flush with it. */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <input
            type="color"
            className="cxt-deck-color-input"
            title="Pick any color"
            value={modalColor ? colorHex(modalColor) : '#6b8aff'}
            onChange={e => setModalColor(e.target.value)}
            style={styles.colorInput}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              autoFocus
              style={styles.search}
              placeholder="Deck name…"
              value={modalName}
              onChange={e => setModalName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmDeckModal() }}
            />
            <div style={styles.hexCaption}>{modalColor ? colorHex(modalColor) : ''}</div>
          </div>
        </div>
        {deckModal.sourceColor && modalColor && modalColor !== deckModal.sourceColor && (
          <p style={{ fontSize: 12, color: '#6b6f8a', margin: '10px 0 0' }}>
            Picking a different color moves every item in this deck over to it.
          </p>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button style={styles.bulkClear} onClick={() => setDeckModal(null)}>Cancel</button>
          <button
            style={{ ...styles.bulkBtnPrimary, ...(!modalName.trim() ? styles.btnDisabled : {}) }}
            disabled={!modalName.trim()}
            onClick={confirmDeckModal}
          >
            {deckModal.sourceColor ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )

  // Detail drawer — deck or source, whichever `detailPanel` says. Content is
  // read from `panelItems`/`panelGroupId`-equivalent computed above; the
  // drawer mounts as soon as `detailPanel` is set and unmounts ~200ms after
  // `closePanel()` clears it, so the slide-out transition has time to play.
  const panelSelected = panelItems.filter(i => selectedIds.has(i.id))
  const detailDrawerEl = detailPanel && (
    <>
      <div style={{ ...styles.drawerOverlay, ...(panelOpen ? styles.drawerOverlayOpen : {}) }} onClick={closePanel} />
      <div style={{ ...styles.drawer, ...(panelOpen ? styles.drawerOpenState : {}) }}>
        {openPicker && (
          <div style={styles.pickerOverlay} onClick={() => { setOpenPicker(null); setPickerRect(null) }} />
        )}
        {openPicker?.kind === 'row' && pickerRect && (() => {
          const item = panelItems.find(i => i.id === openPicker.id)
          if (!item) return null
          return (
            <DeckPicker
              anchor={pickerRect}
              deckName={deckName}
              order={deckOrder}
              current={item.color}
              onPick={(c) => { onUpdateColor(item.id, c); setOpenPicker(null); setPickerRect(null) }}
            />
          )
        })()}
        {openPicker?.kind === 'bulk' && pickerRect && (
          <DeckPicker
            anchor={pickerRect}
            deckName={deckName}
            order={deckOrder}
            onPick={(c) => { moveToDeck(panelSelected.map(i => i.id), c); setSelectedIds(new Set()); setOpenPicker(null); setPickerRect(null) }}
          />
        )}

        <div style={styles.drawerHeader}>
          <div style={{ minWidth: 0 }}>
            <h2 style={styles.drawerTitle}>
              {detailPanel.kind === 'deck' ? (
                <>
                  <span style={{ ...styles.chipDot, background: colorHex(detailPanel.color), marginRight: 8 }} />
                  {deckName(detailPanel.color)}
                </>
              ) : (
                <>
                  <span style={styles.drawerTitleText}>
                    {detailPanel.url.startsWith('http') ? detailPanel.url.replace(/^https?:\/\//, '') : detailPanel.url}
                  </span>
                  {detailPanel.url.startsWith('http') && (
                    <a
                      style={styles.drawerOpenBtn}
                      href={detailPanel.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open source page"
                    >
                      <ExternalLinkIcon />
                    </a>
                  )}
                </>
              )}
            </h2>
            <div style={styles.drawerSub}>{panelItems.length} item{panelItems.length === 1 ? '' : 's'}</div>
          </div>
          <button style={styles.drawerClose} title="Close" onClick={closePanel}>✕</button>
        </div>

        <div style={styles.drawerBody}>
          <div style={styles.studyLauncher}>
            <select
              style={styles.modeSelect}
              value={studyMode}
              onChange={e => {
                const newMode = e.target.value as StudyMode
                setStudyMode(newMode)
                onUpdateSettings({ ...settings, defaultStudyMode: newMode, updatedAt: Date.now() })
              }}
            >
              {STUDY_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <button
              style={{ ...styles.studyBtn, ...(panelItems.length === 0 ? styles.btnDisabled : {}) }}
              disabled={panelItems.length === 0}
              onClick={() => startStudySession(panelItems)}
            >
              ▶ Study {panelItems.length}
            </button>
          </div>

          <div style={styles.toolbar}>
            <input
              style={styles.search}
              placeholder="🔍  Search word or translation…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <Labeled label="Sort">
              <select style={styles.select} value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="az">A – Z</option>
              </select>
            </Labeled>
          </div>

          {panelSelected.length > 0 && (
            <div style={styles.bulkBarInline}>
              <span style={styles.bulkCount}>{panelSelected.length} selected</span>
              <button
                style={styles.bulkBtn}
                onClick={e => {
                  setPickerRect((e.currentTarget as HTMLElement).getBoundingClientRect())
                  setOpenPicker({ kind: 'bulk' })
                }}
              >Move to deck ▾</button>
              <button style={styles.bulkBtnPrimary} onClick={() => startStudySession(panelSelected)}>▶ Study {panelSelected.length}</button>
              <button
                style={styles.bulkBtnDanger}
                onClick={() => { panelSelected.forEach(i => onDelete(i.id)); setSelectedIds(new Set()) }}
              >
                🗑 Delete {panelSelected.length}
              </button>
              <button style={styles.bulkClear} onClick={() => setSelectedIds(new Set())}>Clear</button>
            </div>
          )}

          {panelItems.length === 0 ? (
            <div style={styles.noResults}>
              {search.trim()
                ? <>No matches for “{search.trim()}”. <button style={styles.linkBtn} onClick={() => setSearch('')}>Clear search</button></>
                : detailPanel.kind === 'deck' ? 'No items in this deck yet.' : 'No items from this source.'}
            </div>
          ) : (
            <div style={styles.list}>{panelItems.map(item => renderRow(item))}</div>
          )}
        </div>
      </div>
    </>
  )

  // ── Decks landing / source view ───────────────────────────────────────────
  return (
    <div style={styles.container}>
      {deckModalEl}
      {detailDrawerEl}
      {toast && (
        <>
          <style>{`
            @keyframes cxt-toast-in {
              0%   { opacity: 0; transform: translate(-50%, 8px); }
              12%  { opacity: 1; transform: translate(-50%, 0); }
              88%  { opacity: 1; transform: translate(-50%, 0); }
              100% { opacity: 0; transform: translate(-50%, 8px); }
            }
          `}</style>
          <div style={styles.toast}>{toast}</div>
        </>
      )}

      <div style={styles.headerArea}>
        <h2 style={styles.title}>My Library</h2>
      </div>

      {/* Stat row: due/total counters + "Study all due" as its own action card */}
      <div style={styles.statRow}>
        <div style={styles.statCard}>
          <div style={styles.statLabel}>Due today</div>
          <div style={styles.statFigure}>{totalDueAllDecks}</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statLabel}>Total items</div>
          <div style={styles.statFigure}>{totalItemsAllDecks}</div>
        </div>
        {/* Reacts to whichever tab is active — selectedColors on "By Deck",
            selectedSources on "By Source" — same card, same 2 buttons, just
            wired to a different selection. Was a separate bar that popped up
            inside the source list instead; that was a second, inconsistent
            pattern for the exact same "act on my ticked rows" action the
            deck tab already had here. */}
        <div style={{ ...styles.statCard, ...styles.statCardAction }}>
          <div>
            <div style={styles.statLabel}>Study all due</div>
            <div style={styles.statHint}>
              {viewMode === 'decks'
                ? (selectedColors.size > 0 ? `${selectedColors.size} deck(s) selected` : 'No deck selected → entire Library')
                : (selectedSources.size > 0 ? `${selectedSources.size} source(s) selected` : 'No source selected → entire Library')}
            </div>
          </div>
          <div style={{ ...styles.studyLauncher, marginBottom: 0 }}>
            {/* Same studyMode/setStudyMode state the per-deck/per-source drawer's
                launcher uses — starting a session from here (skipping the
                drawer entirely) silently reused whatever mode was last picked
                there with no way to see or change it. Picking it here now
                persists to defaultStudyMode the same way. */}
            <select
              style={styles.modeSelect}
              value={studyMode}
              onChange={e => {
                const newMode = e.target.value as StudyMode
                setStudyMode(newMode)
                onUpdateSettings({ ...settings, defaultStudyMode: newMode, updatedAt: Date.now() })
              }}
            >
              {STUDY_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {viewMode === 'decks' ? (
              <button style={styles.studyBtn} onClick={studyAllDueFromSelectedDecks}>
                Study now ({selectedColors.size > 0
                  ? [...selectedColors].reduce((n, c) => n + (deckStats.get(c)?.total ?? 0), 0)
                  : totalDueAllDecks})
              </button>
            ) : (
              <button style={styles.studyBtn} onClick={studyAllDueFromSelectedSources}>
                Study now ({selectedSources.size > 0
                  ? items.filter(i => selectedSources.has(i.url || 'Dictionary (No URL)')).length
                  : totalDueAllDecks})
              </button>
            )}
          </div>
          {/* Secondary row, below the primary Study action — notification
              controls are a different concern from studying, and cramming
              Focus + the reset link into the same inline row as the study
              button made 4 differently-styled controls fight for space in a
              card that used to hold 2. `height` (not `minHeight`, and not
              conditionally rendering the row itself) fixes the row's own box
              to a constant size regardless of what's inside — the row never
              changes height no matter which of the two buttons are mounted.
              Unlike keeping both buttons permanently mounted with
              `visibility: hidden` (tried that right before this): an unmounted
              button takes no width either, so the single visible one still
              sits flush at the row's start instead of being shoved rightward
              by an invisible sibling's reserved space. */}
          <div style={styles.focusRow}>
            {(selectedColors.size > 0 || selectedSources.size > 0) && (
              <button
                style={styles.focusBtn}
                title="Only notify me about what's ticked (mutes everything else on BOTH axes)"
                onClick={applyFocus}
              >
                🎯 Focus
              </button>
            )}
            {/* Ticking every deck (or every source) used to double as "reset
                that axis" — Focus now always sets both axes together, so
                that trick no longer resets the OTHER axis. This is the
                explicit way back. */}
            {(mutedDecks.size > 0 || mutedSources.size > 0) && (
              <button style={styles.focusResetLink} onClick={resetAllMutes}>
                Notify me about everything
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={styles.viewToggle}>
        <button
          style={{ ...styles.viewToggleBtn, ...(viewMode === 'decks' ? styles.viewToggleBtnActive : {}) }}
          onClick={() => switchView('decks')}
        >
          By Deck
        </button>
        <button
          style={{ ...styles.viewToggleBtn, ...(viewMode === 'source' ? styles.viewToggleBtnActive : {}) }}
          onClick={() => switchView('source')}
        >
          By Source
        </button>
      </div>

      {viewMode === 'decks' ? (
        <>
          <div style={styles.sectionRow}>
            <div>
              <span style={styles.sectionTitle}>Decks</span>
              <span style={styles.sectionHint}>&nbsp;· Tick to select multiple decks for a study session · drag ⠿ to reorder</span>
            </div>
            <button style={styles.newDeckBtn} onClick={openNewDeckModal}>+ New deck</button>
          </div>
          <div style={styles.deckList}>
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDeckDragEnd}>
              <SortableContext items={deckOrder} strategy={verticalListSortingStrategy}>
                {deckOrder.map((color, i) => (
                  <SortableDeckRow
                    key={color}
                    color={color}
                    name={deckName(color)}
                    named={color === UNCATEGORIZED_COLOR || !!deckLabels[color]}
                    isUncategorized={color === UNCATEGORIZED_COLOR}
                    stats={deckStats.get(color) ?? { total: 0, due: 0 }}
                    selected={selectedColors.has(color)}
                    muted={mutedDecks.has(color)}
                    isLast={i === deckOrder.length - 1}
                    onToggleSelect={() => setSelectedColors(toggleSet(selectedColors, color))}
                    onToggleMute={() => toggleDeckMute(color)}
                    onOpen={() => openDeckPanel(color)}
                    onEdit={() => openEditDeckModal(color)}
                    onDeleteDeck={() => deleteDeck(color)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        </>
      ) : (
        <>
          <div style={styles.toolbar}>
            <input
              style={styles.search}
              placeholder="🔍  Search word or translation…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <Labeled label="Sort">
              <select style={styles.select} value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="az">A – Z</option>
              </select>
            </Labeled>
          </div>
          {sourceViewItems.length === 0 ? (
            <div style={styles.noResults}>
              {search.trim()
                ? <>No matches for “{search.trim()}”. <button style={styles.linkBtn} onClick={() => setSearch('')}>Clear search</button></>
                : 'No items match these filters.'}
            </div>
          ) : renderSourceList()}
        </>
      )}
    </div>
  )

  // ---- Renderers ----

  function renderRow(item: SavedItem) {
    const expanded = expandedIds.has(item.id)
    const selected = selectedIds.has(item.id)
    const word = isWord(item)
    const hasContext = !!(item.prefix || item.suffix)

    return (
      <div key={item.id} style={{ ...styles.row, ...(selected ? styles.rowSelected : {}) }}>
        <div style={styles.rowMain} onClick={() => setExpandedIds(toggleSet(expandedIds, item.id))}>
          <input
            type="checkbox"
            checked={selected}
            onClick={e => e.stopPropagation()}
            onChange={() => setSelectedIds(toggleSet(selectedIds, item.id))}
            style={styles.checkbox}
          />
          <span style={{ ...styles.rowDot, background: colorHex(item.color) }} title={deckName(item.color)} />

          {word ? (
            <span style={styles.rowText}>
              <strong style={styles.wordText}>{item.text}</strong>
              {item.phonetics && <span style={styles.phonetics}>{item.phonetics}</span>}
              {item.translation && <span style={styles.translation}>— {item.translation}</span>}
            </span>
          ) : (
            <span style={{ ...styles.rowText, ...styles.quoteText }}>{item.text}</span>
          )}

          <button
            style={styles.iconBtn}
            title={speakingKey === item.id ? 'Stop' : 'Read aloud'}
            onClick={e => { e.stopPropagation(); playAudio(item.id, item.text, item.sourceLang) }}
          >
            {speakingKey === item.id ? <StopIcon /> : <SpeakerIcon />}
          </button>
        </div>

        {expanded && (
          <div style={styles.rowExpanded}>
            {word && hasContext && (
              <div style={styles.context}>
                {item.prefix}<strong style={{ color: '#e8e8f5' }}>{item.text}</strong>{item.suffix}
                <button
                  style={styles.iconBtnSmall}
                  title={speakingKey === `${item.id}-sentence` ? 'Stop' : 'Read sentence'}
                  onClick={() => playAudio(`${item.id}-sentence`, (item.prefix || '') + item.text + (item.suffix || ''), item.sourceLang)}
                >
                  {speakingKey === `${item.id}-sentence` ? <StopIcon /> : <SpeakerIcon />}
                </button>
              </div>
            )}
            <div style={styles.rowActions}>
              <span style={styles.date}>{new Date(item.createdAt).toLocaleDateString()}</span>
              <button
                style={styles.actionBtn}
                onClick={e => {
                  setPickerRect((e.currentTarget as HTMLElement).getBoundingClientRect())
                  setOpenPicker({ kind: 'row', id: item.id })
                }}
              >
                <span style={{ ...styles.chipDot, background: colorHex(item.color) }} /> Move to deck ▾
              </button>
              {item.url && (
                <a href={item.url} target="_blank" rel="noreferrer" style={styles.actionBtn}>↗ Open source</a>
              )}
              <button style={{ ...styles.actionBtn, color: '#ff8a8a' }} onClick={() => onDelete(item.id)}>🗑 Delete</button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Landing list for "By Source" — a summary row per source URL (title,
  // count, Study action). Clicking a row opens the detail drawer (same one
  // deck rows use) instead of expanding inline, so item lists always live in
  // exactly one place regardless of which tab got you there.
  function renderSourceList() {
    // Order the source groups themselves by the same sortBy the toolbar's
    // dropdown offers, not a hard-coded "most recent activity" comparator
    // that ignored it. Each group's own items are already in sortBy order
    // via sourceGroups (built from sourceViewItems), so 'az' here only needs
    // to order the groups by their URL text, not re-sort within a group.
    const displayName = (u: string) => u.startsWith('http') ? u.replace(/^https?:\/\//, '') : u
    const urls = Object.keys(sourceGroups).sort((a, b) => {
      if (sortBy === 'az') return displayName(a).localeCompare(displayName(b))
      if (sortBy === 'oldest') return Math.min(...sourceGroups[a].map(safeCreatedAt)) - Math.min(...sourceGroups[b].map(safeCreatedAt))
      return Math.max(...sourceGroups[b].map(safeCreatedAt)) - Math.max(...sourceGroups[a].map(safeCreatedAt))
    })
    return (
      <div style={styles.list}>
        {urls.map(url => {
            const groupItems = sourceGroups[url]
            const muted = mutedSources.has(url)
            return (
              <div key={url} style={styles.group} onClick={() => openSourcePanel(url)}>
                <div style={styles.groupHeader}>
                  <input
                    type="checkbox"
                    checked={selectedSources.has(url)}
                    onClick={e => e.stopPropagation()}
                    onChange={() => setSelectedSources(toggleSet(selectedSources, url))}
                    style={styles.checkbox}
                  />
                  <span style={styles.groupTitle}>{url.startsWith('http') ? url.replace(/^https?:\/\//, '') : url}</span>
                  <span style={styles.chipCount}>{groupItems.length}</span>
                  <button
                    style={styles.groupOpenBtn}
                    title={muted ? 'Notifications muted for this source — click to unmute' : 'Mute notifications for this source'}
                    onClick={e => { e.stopPropagation(); toggleSourceMute(url) }}
                  >
                    {muted ? <BellOffIcon /> : <BellIcon />}
                  </button>
                  {url.startsWith('http') && (
                    <a
                      style={styles.groupOpenBtn}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open source page"
                      onClick={e => e.stopPropagation()}
                    >
                      <ExternalLinkIcon />
                    </a>
                  )}
                  <button
                    style={styles.groupStudyBtn}
                    onClick={e => { e.stopPropagation(); startStudySession(groupItems.filter(isDue).length ? groupItems.filter(isDue) : groupItems) }}
                  >
                    ▶ Study
                  </button>
                </div>
              </div>
            )
          })}
        </div>
    )
  }
}

// Plain SVG line icons (Feather-style: 24x24 viewBox, 2px stroke, no fill)
// instead of the ✎/🗑 text glyphs used before — those render inconsistently
// across platforms (some fonts show them as tiny monochrome text glyphs
// with almost no visible shape instead of a proper icon), which is exactly
// what looked broken/illegible in the deck row. `stroke="currentColor"`
// picks up the button's own `color`, so no separate color prop is needed.
function EditIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}
// Speaker/Stop pair for the read-aloud buttons — plain SVG instead of the
// 🔊/⏹ emoji pair, which render in visibly different colors (🔊 is a color
// emoji glyph, ⏹ is a plain black/white one) even sitting right next to each
// other on the same button. `stroke="currentColor"` ties both to the
// button's own text color, so toggling between them never changes color.
function SpeakerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )
}
function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  )
}
function BellIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}
function BellOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.7 3A6 6 0 0 1 18 8c0 2.8.5 4.8 1.1 6.3" />
      <path d="M17 17H3s3-2 3-9c0-.5.06-1 .17-1.4" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}
function ExternalLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}
function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, color: '#9a9ac0' }}>{label}</span>
      {children}
    </label>
  )
}

// Deck table row + drag handle. Own component (not inlined in the `.map`)
// because `useSortable` is a hook and must run at a component's top level.
function SortableDeckRow({ color, name, named, isUncategorized, stats, selected, muted, isLast, onToggleSelect, onToggleMute, onOpen, onEdit, onDeleteDeck }: {
  color: string
  name: string
  named: boolean
  isUncategorized: boolean
  stats: { total: number; due: number }
  selected: boolean
  muted: boolean
  isLast: boolean
  onToggleSelect: () => void
  onToggleMute: () => void
  onOpen: () => void
  onEdit: () => void
  onDeleteDeck: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: color })

  const style: React.CSSProperties = {
    ...styles.deckRow,
    ...(isLast ? styles.deckRowLast : {}),
    transform: CSS.Transform.toString(transform),
    transition,
    background: isDragging ? '#1a1a35' : styles.deckRow.background,
    position: 'relative',
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div ref={setNodeRef} style={style}>
      <span {...attributes} {...listeners} style={styles.deckDragHandle} title="Drag to reorder" aria-label={`Drag to reorder ${color} deck`}>
        ⠿
      </span>
      <input type="checkbox" checked={selected} onChange={onToggleSelect} style={styles.checkbox} />
      {/* Name/dot area is plain display now — opening the detail panel
          happens from the due-count button on the right instead, not from
          clicking the label. */}
      <div style={styles.deckRowMain}>
        <span style={{ ...styles.chipDot, background: colorHex(color) }} />
        <span style={styles.deckRowText}>
          {/* Icons live INSIDE this row, right after the name text — not as
              a sibling positioned after the whole name+count column below.
              That column's box is as wide as its widest line ("247 items"
              can be wider than "Red"), so anything placed after the column
              itself lands past the longer line's width, not snug against
              the shorter name above it. Being a flex sibling of just the
              name (this line only) means the icons hug the name's actual
              rendered width instead. */}
          <span style={styles.deckRowNameLine}>
            <span style={{ ...styles.deckRowName, ...(named ? {} : { color: '#7a7aa0', textTransform: 'capitalize' }) }}>{name}</span>
            <span style={styles.deckRowActions}>
              {!isUncategorized && (
                <>
                  <button style={styles.editBtnSmall} title="Rename deck" onClick={e => { e.stopPropagation(); onEdit() }}>
                    <EditIcon />
                  </button>
                  <button style={styles.editBtnSmall} title="Delete deck" onClick={e => { e.stopPropagation(); onDeleteDeck() }}>
                    <TrashIcon />
                  </button>
                </>
              )}
              {/* Unlike rename/delete, muting notifications for Uncategorized
                  is legitimate (it can still have due items), so this button
                  is NOT gated by isUncategorized. */}
              <button
                style={styles.editBtnSmall}
                title={muted ? 'Notifications muted for this deck — click to unmute' : 'Mute notifications for this deck'}
                onClick={e => { e.stopPropagation(); onToggleMute() }}
              >
                {muted ? <BellOffIcon /> : <BellIcon />}
              </button>
            </span>
          </span>
          <span style={styles.deckRowCount}>{stats.total} item{stats.total === 1 ? '' : 's'}</span>
        </span>
      </div>
      <span style={styles.deckRowSpacer} />
      <button
        style={{ ...styles.deckRowDueBtn, ...(stats.due > 0 ? styles.deckRowDueActive : {}) }}
        title="View deck"
        onClick={onOpen}
      >
        {stats.due}
        <ChevronRightIcon />
      </button>
    </div>
  )
}

function DeckPicker({ current, deckName, order, onPick, anchor }: {
  current?: string
  deckName: (c: string) => string
  order: string[]
  onPick: (c: string) => void
  anchor?: DOMRect
}) {
  const posStyle: React.CSSProperties = (() => {
    if (!anchor) return {}
    const spaceBelow = window.innerHeight - anchor.bottom - 8
    const spaceAbove = anchor.top - 8
    const showAbove = spaceAbove > spaceBelow
    const maxHeight = Math.min(320, showAbove ? spaceAbove : spaceBelow)
    return {
      position: 'fixed',
      left: anchor.left,
      top: showAbove ? 'auto' : anchor.bottom + 4,
      bottom: showAbove ? window.innerHeight - anchor.top + 4 : 'auto',
      zIndex: 1000,
      maxHeight,
      overflowY: 'auto',
    }
  })()
  // Portal to `document.body` — `anchor` is already viewport-relative
  // (`getBoundingClientRect()`), but this picker can be opened from a row
  // inside the drawer, and `.drawer` animates via `transform:translateX(...)`.
  // CSS spec: a `transform` on an ancestor becomes the containing block for
  // any `position:fixed` descendant, so without the portal this would get
  // positioned relative to the drawer's own box instead of the viewport,
  // and clipped by the drawer's own bounds — invisible in practice, not just
  // misplaced. Rendering outside the whole component tree sidesteps that
  // entirely; `anchor`'s coordinates stay correct either way.
  return createPortal(
    <div style={{ ...styles.deckPicker, ...posStyle }}>
      {order.map(c => (
        <button
          key={c}
          style={{ ...styles.deckPickerItem, ...(current === c ? styles.deckPickerItemActive : {}) }}
          onClick={() => onPick(c)}
        >
          <span style={{ ...styles.chipDot, background: colorHex(c) }} />
          <span style={{ textTransform: deckName(c) === c ? 'capitalize' : undefined }}>{deckName(c)}</span>
          {current === c && <span style={{ marginLeft: 'auto', color: '#6b8aff' }}>✓</span>}
        </button>
      ))}
    </div>,
    document.body
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: '100%' },
  overlay: { position: 'fixed', inset: 0, zIndex: 9 },
  modalOverlay: { position: 'fixed', inset: 0, zIndex: 299, background: 'rgba(5,5,16,0.5)' },
  modal: {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    zIndex: 300, background: '#181830', border: '1px solid #3a3a6a', borderRadius: 10,
    padding: 20, width: 340, maxWidth: '90vw', boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
  },
  // Only sizing/layout here — the visible border/radius/background all live
  // on the `::-webkit-color-swatch` pseudo-element instead (see the scoped
  // `<style>` next to this input's call site), since that's what's actually
  // painted, not this box itself. Rounded-rect (8px), matching `.search`/
  // every other control in this file — not a circle. Height matches
  // `.search`'s own rendered height so the two sit flush in the row.
  colorInput: { width: 38, height: 38, flexShrink: 0 },
  hexCaption: {
    fontFamily: 'monospace', fontSize: 11.5, color: '#6b6f8a', marginTop: 6, marginLeft: 2,
  },
  newDeckBtn: {
    flexShrink: 0, background: '#15152a', color: '#e8e8f5', border: '1px solid #3a3a6a',
    borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  empty: {
    textAlign: 'center', padding: '60px 20px', color: '#9a9ac0',
    background: '#181830', borderRadius: 12,
  },
  headerArea: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 16, gap: 16, flexWrap: 'wrap',
  },
  title: { margin: 0, fontSize: 22, color: '#e8e8f5', display: 'flex', alignItems: 'center' },
  editBtn: {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 15,
    marginLeft: 10, opacity: 0.7, color: '#9a9ac0',
  },
  // A real small square button (background + border), not a bare glyph
  // floating next to the name — gives the icon a consistent box to sit in
  // regardless of the SVG's own metrics, and reads as an actual clickable
  // control instead of stray punctuation.
  // flex-start so this group's own top edge (= the name's top edge) is what
  // gets aligned against, instead of `deckRow`'s outer `alignItems:center`
  // centering the icons against the full 2-line name+count block.
  // The name text's own row — icons are flex siblings of the name HERE, so
  // they hug its actual rendered width instead of the wider "N items" line.
  deckRowNameLine: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 },
  deckRowActions: { display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 },
  // Ghost buttons — no background/border, just the icon at reduced opacity —
  // sitting snug against the name instead of the boxed/bordered look before,
  // which read as too heavy for a secondary, always-visible action.
  editBtnSmall: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 20, flexShrink: 0, padding: 0,
    background: 'none', border: 'none',
    color: '#7a7aa0', opacity: 0.8, cursor: 'pointer',
  },
  studyLauncher: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
  modeSelect: {
    background: '#15152a', color: '#e8e8f5', border: '1px solid #2a2a4a',
    borderRadius: 8, padding: '8px 10px', fontSize: 13,
  },
  studyBtn: {
    background: '#6b8aff', color: '#0d0d1a', border: 'none', borderRadius: 8,
    padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  // Own row below the primary Study action (see the comment at its call
  // site) — smaller/quieter than studyBtn since it's a secondary, occasional
  // action, not competing for the same visual weight as "Study now".
  // minHeight matches focusBtn's own rendered height (padding + line-height +
  // border) so this row holds its space even with zero children — see the
  // comment at its call site for why that matters.
  // `height` (not `minHeight`) so the row's box is fixed regardless of
  // which/how many of its (conditionally-mounted) children are present —
  // see the comment at its call site. `overflow: hidden` is the fallback for
  // the one case that could still exceed it (both buttons mounted on a card
  // narrow enough to wrap them to 2 lines) — silently clipping there beats
  // letting that edge case reintroduce the exact shift this exists to avoid.
  // focusBtn's own border-box measures exactly 24px, but pinning this row to
  // that exact number clipped its top/bottom border — sub-pixel rounding
  // between the row's box and the button's border can go either way
  // depending on zoom/DPI, and overflow: hidden has zero tolerance for that.
  // A couple px of headroom fixes it without reintroducing the shift.
  focusRow: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, height: 28, overflow: 'hidden' },
  focusBtn: {
    background: '#15152a', color: '#cdd6ff', border: '1px solid #3a3a6a',
    borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  // Plain text link, not a boxed button — only shown while mute is active,
  // deliberately low-key since it's a "just in case" escape hatch, not a
  // primary action competing with Study now/Focus for attention.
  focusResetLink: {
    background: 'none', border: 'none', color: '#8888aa', fontSize: 12,
    textDecoration: 'underline', cursor: 'pointer', whiteSpace: 'nowrap', padding: 0,
  },
  btnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  statRow: { display: 'flex', gap: 12, marginBottom: 24 },
  statCard: {
    flex: 1, border: '1px solid #20203a', borderRadius: 10, padding: '16px 18px',
    background: '#13132a',
  },
  statCardAction: { flex: 2, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 },
  statLabel: { fontSize: 12, color: '#9a9ac0', marginBottom: 6 },
  statFigure: { fontSize: 26, fontWeight: 650, letterSpacing: '-0.02em', color: '#e8e8f5' },
  statHint: { fontSize: 12, color: '#6b6f8a', marginTop: 3 },
  // Fixed to the viewport (not the page), bottom-center, above everything
  // else including the drawer — animation handles its own fade in/out/hold,
  // timed to match the 3s setTimeout that clears the `toast` state.
  toast: {
    position: 'fixed', bottom: 28, left: '50%', zIndex: 200,
    background: '#23203a', border: '1px solid #4a3a6a', borderRadius: 10,
    padding: '10px 18px', fontSize: 13, fontWeight: 600, color: '#e8e0ff',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)', whiteSpace: 'nowrap',
    animation: 'cxt-toast-in 3s ease forwards',
    pointerEvents: 'none',
  },
  viewToggle: {
    display: 'inline-flex', gap: 2, padding: 3, background: '#15152a',
    border: '1px solid #20203a', borderRadius: 8, marginBottom: 20,
  },
  viewToggleBtn: {
    border: 'none', background: 'transparent', color: '#9a9ac0',
    padding: '6px 14px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  },
  viewToggleBtnActive: { background: '#23234a', color: '#e8e8f5', boxShadow: '0 1px 3px rgba(0,0,0,0.35)' },
  sectionRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 12, fontWeight: 650, color: '#9a9ac0', textTransform: 'uppercase', letterSpacing: '0.05em' },
  sectionHint: { fontSize: 12.5, color: '#6b6f8a' },
  deckList: {
    display: 'flex', flexDirection: 'column',
    border: '1px solid #262645', borderRadius: 10, overflow: 'hidden', marginBottom: 14,
  },
  deckRow: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
    background: '#13132a', borderBottom: '1px solid #262645',
  },
  deckRowLast: { borderBottom: 'none' },
  deckDragHandle: { cursor: 'grab', color: '#4a4a6a', fontSize: 15, flexShrink: 0, touchAction: 'none' },
  // No `flex:1` here anymore — that lived on the old single click-to-open
  // block that used to span the whole row. Now it only wraps the dot+name+
  // count, so it hugs its own content instead of swallowing the space where
  // the edit/delete icons and the due count sit.
  deckRowMain: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  deckRowText: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 },
  deckRowName: {
    color: '#e8e8f5', fontSize: 14, fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  deckRowCount: { color: '#6b6f8a', fontSize: 11.5 },
  deckRowSpacer: { flex: 1 },
  // The number + chevron are the deck row's ONLY way to open the detail
  // panel now (the name/dot area is plain display) — a real button with its
  // own background/border, not bare text, so it reads as clickable.
  deckRowDueBtn: {
    display: 'flex', alignItems: 'center', gap: 4, minWidth: 40, justifyContent: 'flex-end',
    background: '#1c1c38', border: '1px solid #2a2a4a', borderRadius: 7,
    padding: '5px 8px', color: '#6b6f8a', fontSize: 15, fontWeight: 650, cursor: 'pointer',
  },
  deckRowDueActive: { color: '#6b8aff', borderColor: '#3a3a6a' },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14,
  },
  search: {
    flex: 1, minWidth: 200, background: '#15152a', border: '1px solid #2a2a4a',
    borderRadius: 8, color: '#e8e8f5', padding: '9px 12px', fontSize: 14,
  },
  select: {
    background: '#15152a', color: '#e8e8f5', border: '1px solid #2a2a4a',
    borderRadius: 8, padding: '7px 10px', fontSize: 13,
  },
  chipDot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0, display: 'inline-block' },
  chipCount: {
    background: 'rgba(255,255,255,0.08)', borderRadius: 999, padding: '1px 7px',
    fontSize: 11, fontWeight: 700, color: '#c8c8e0',
  },
  // Bulk bar now lives inline inside the drawer body (was a fixed floating
  // bar before there was a drawer to put it in).
  bulkBarInline: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    background: '#23234a', border: '1px solid #6b8aff', borderRadius: 10, padding: '10px 14px',
    marginBottom: 14,
  },
  bulkCount: { fontSize: 13, fontWeight: 700, color: '#e8e8f5', marginRight: 'auto' },
  bulkBtn: {
    background: '#15152a', color: '#e8e8f5', border: '1px solid #3a3a6a',
    borderRadius: 7, padding: '6px 12px', fontSize: 13, cursor: 'pointer',
  },
  bulkBtnPrimary: {
    background: '#6b8aff', color: '#0d0d1a', border: 'none', borderRadius: 7,
    padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
  },
  bulkBtnDanger: {
    background: 'transparent', color: '#ff8a8a', border: '1px solid #6a3a3a',
    borderRadius: 7, padding: '6px 12px', fontSize: 13, cursor: 'pointer',
  },
  bulkClear: { background: 'none', border: 'none', color: '#9a9ac0', fontSize: 13, cursor: 'pointer' },
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  noResults: { textAlign: 'center', padding: '40px 20px', color: '#9a9ac0' },
  linkBtn: { background: 'none', border: 'none', color: '#6b8aff', cursor: 'pointer', fontSize: 'inherit', padding: 0 },
  row: {
    background: '#15152a', borderRadius: 10, border: '1px solid #20203a', overflow: 'hidden',
  },
  rowSelected: { borderColor: '#6b8aff', background: '#1a1a35' },
  rowMain: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer',
  },
  checkbox: { width: 16, height: 16, accentColor: '#6b8aff', cursor: 'pointer', flexShrink: 0 },
  rowDot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  rowText: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  wordText: { color: '#e8e8f5', fontSize: 15 },
  phonetics: { color: '#9a9ac0', fontSize: 13 },
  translation: { color: '#6bcfff', fontSize: 14 },
  quoteText: { color: '#d0d0e8', fontStyle: 'italic', fontSize: 14, display: 'block' },
  iconBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#cdd6ff', opacity: 0.7, flexShrink: 0 },
  iconBtnSmall: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#cdd6ff', opacity: 0.7, marginLeft: 6 },
  rowExpanded: { padding: '0 14px 12px 48px', display: 'flex', flexDirection: 'column', gap: 10 },
  context: {
    fontSize: 13, color: '#9a9ac0', fontStyle: 'italic', lineHeight: 1.5,
    borderLeft: '3px solid #2a2a4a', paddingLeft: 10,
  },
  rowActions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  date: { color: '#7a7aa0', fontSize: 12 },
  actionBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6, background: '#1c1c38',
    border: '1px solid #2a2a4a', borderRadius: 7, padding: '5px 10px',
    color: '#c8c8e0', fontSize: 12, cursor: 'pointer', textDecoration: 'none',
  },
  deckPicker: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 1000,
    background: '#181830', border: '1px solid #3a3a6a', borderRadius: 8, padding: 6,
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 160,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  deckPickerItem: {
    display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none',
    borderRadius: 6, padding: '6px 8px', color: '#c8c8e0', fontSize: 13, cursor: 'pointer', textAlign: 'left',
  },
  deckPickerItemActive: { background: '#23234a' },
  group: {
    background: '#13132a', borderRadius: 10, border: '1px solid #20203a', overflow: 'hidden', cursor: 'pointer',
  },
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
  },
  groupTitle: {
    flex: 1, minWidth: 0,
    color: '#e0e0ff', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis',
  },
  groupStudyBtn: {
    background: '#23234a', color: '#cdd6ff', border: '1px solid #3a3a6a',
    borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  // Same background/border/radius as groupStudyBtn next to it, just icon-only
  // width — a bare ghost icon here read as visually disconnected from that
  // button instead of like a sibling action. An <a>, not a <button>, so it's
  // a real link (middle-click/ctrl-click to open in background both work as
  // expected, not just a plain onClick).
  groupOpenBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 30, height: 28, flexShrink: 0,
    background: '#23234a', color: '#cdd6ff', border: '1px solid #3a3a6a',
    borderRadius: 7, textDecoration: 'none', cursor: 'pointer',
  },
  // ── Detail drawer (deck or source) ────────────────────────────────────────
  drawerOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(5,5,16,0.5)',
    opacity: 0, pointerEvents: 'none', transition: 'opacity 160ms ease', zIndex: 60,
  },
  drawerOverlayOpen: { opacity: 1, pointerEvents: 'auto' },
  drawer: {
    position: 'fixed', top: 0, right: 0, bottom: 0, width: 740, maxWidth: '92vw',
    background: '#0d0d1a', borderLeft: '1px solid #20203a',
    boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
    transform: 'translateX(100%)', transition: 'transform 200ms ease',
    zIndex: 61, display: 'flex', flexDirection: 'column',
  },
  drawerOpenState: { transform: 'translateX(0)' },
  // Closes any open DeckPicker dropdown on outside click — sits above the
  // drawer's own z-index (61) but below DeckPicker's (1000).
  pickerOverlay: { position: 'fixed', inset: 0, zIndex: 62 },
  drawerHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
    padding: '20px 22px 16px', borderBottom: '1px solid #20203a', flexShrink: 0,
  },
  drawerTitle: { fontSize: 17, margin: '0 0 3px', color: '#e8e8f5', display: 'flex', alignItems: 'center', gap: 8 },
  drawerTitleText: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // Same boxed look as groupOpenBtn in the source list row, so the "open
  // source" action reads the same wherever it appears.
  drawerOpenBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 26, flexShrink: 0,
    background: '#23234a', color: '#cdd6ff', border: '1px solid #3a3a6a',
    borderRadius: 7, textDecoration: 'none', cursor: 'pointer',
  },
  drawerSub: { fontSize: 12.5, color: '#9a9ac0' },
  drawerClose: {
    border: '1px solid transparent', background: 'transparent', color: '#6b6f8a',
    width: 28, height: 28, borderRadius: 4, cursor: 'pointer', fontSize: 15,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  drawerBody: { flex: 1, overflowY: 'auto', padding: '18px 22px 22px' },
}
