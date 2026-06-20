import { SavedItem, BOOKMARK_COLORS, Settings, BookmarkColor, StudyMode } from '../shared/types'
import { useMemo, useState } from 'react'
import StudyUI from './StudyUI'

const ALL_COLORS: BookmarkColor[] = [
  'red', 'yellow', 'cyan', 'green', 'blue',
  'orange', 'purple', 'pink', 'teal', 'gray'
]

const STUDY_MODES: { value: StudyMode; label: string }[] = [
  { value: 'passive', label: 'Passive Flashcard' },
  { value: 'typing', label: 'Typing (Active Recall)' },
  { value: 'listening', label: 'Listening (Dictation)' },
  { value: 'multiple_choice', label: 'Multiple Choice' },
]

type GroupBy = 'none' | 'source' | 'deck'
type SortBy = 'newest' | 'oldest' | 'az'
type OpenPicker = { kind: 'row'; id: string } | { kind: 'bulk' } | null

const isWord = (item: SavedItem) => !!item.translation

export default function Library({
  items,
  settings,
  onDelete,
  onUpdateColor,
  onUpdateSettings
}: {
  items: SavedItem[]
  settings: Settings
  onDelete: (id: string) => void
  onUpdateColor: (id: string, color: BookmarkColor) => void
  onUpdateSettings: (settings: Settings) => void
}) {
  // Study session
  const [sessionActive, setSessionActive] = useState(false)
  const [sessionItems, setSessionItems] = useState<SavedItem[]>([])
  const [studyMode, setStudyMode] = useState<StudyMode>(settings.defaultStudyMode || 'listening')

  // Browse controls
  const [search, setSearch] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('source')
  const [sortBy, setSortBy] = useState<SortBy>('newest')
  const [activeDeck, setActiveDeck] = useState<BookmarkColor | 'all'>('all')

  // Interaction
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [expandedUrls, setExpandedUrls] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openPicker, setOpenPicker] = useState<OpenPicker>(null)
  const [pickerRect, setPickerRect] = useState<DOMRect | null>(null)

  const deckLabels = settings?.deckLabels || {}
  const deckName = (color: BookmarkColor) => deckLabels[color] || color
  const deckOrder: BookmarkColor[] = settings?.deckOrder?.length === ALL_COLORS.length
    ? settings.deckOrder
    : ALL_COLORS

  function playAudio(text: string) {
    if (!settings?.readAloud) return
    const r = settings.readAloud
    chrome.tts.stop()
    if (r.voice) {
      chrome.tts.speak(text, { pitch: r.pitch, rate: r.speed, voiceName: r.voice || undefined, volume: r.volume })
    } else {
      chrome.tts.speak(text)
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

  function moveToDeck(ids: string[], color: BookmarkColor) {
    ids.forEach(id => onUpdateColor(id, color))
  }

  // Per-color counts across the whole library (for the chip badges)
  const colorCounts = useMemo(() => {
    const counts: Partial<Record<BookmarkColor, number>> = {}
    for (const item of items) counts[item.color] = (counts[item.color] || 0) + 1
    return counts
  }, [items])

  // The current view: deck + type + search, then sorted.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const result = items.filter(item => {
      if (activeDeck !== 'all' && item.color !== activeDeck) return false
      if (q) {
        const hay = (item.text + ' ' + (item.translation || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    result.sort((a, b) => {
      if (sortBy === 'az') return a.text.localeCompare(b.text)
      if (sortBy === 'oldest') return a.createdAt - b.createdAt
      return b.createdAt - a.createdAt
    })
    return result
  }, [items, activeDeck, search, sortBy])

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

  const selectedItems = filtered.filter(i => selectedIds.has(i.id))

  return (
    <div style={styles.container}>
      {openPicker && (
        <div style={styles.overlay} onClick={() => { setOpenPicker(null); setPickerRect(null) }} />
      )}

      {openPicker?.kind === 'row' && pickerRect && (() => {
        const item = filtered.find(i => i.id === openPicker.id)
        if (!item) return null
        return (
          <DeckPicker
            anchor={pickerRect}
            current={item.color}
            deckName={deckName}
            order={deckOrder}
            onPick={(c) => { onUpdateColor(item.id, c); setOpenPicker(null); setPickerRect(null) }}
          />
        )
      })()}

      {openPicker?.kind === 'bulk' && pickerRect && (
        <DeckPicker
          anchor={pickerRect}
          deckName={deckName}
          order={deckOrder}
          onPick={(c) => { moveToDeck(selectedItems.map(i => i.id), c); setSelectedIds(new Set()); setOpenPicker(null); setPickerRect(null) }}
        />
      )}

      {/* Header: title + study launcher (mode + trigger together) */}
      <div style={styles.headerArea}>
        <h2 style={styles.title}>My Library</h2>
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
            style={{ ...styles.studyBtn, ...(filtered.length === 0 ? styles.btnDisabled : {}) }}
            disabled={filtered.length === 0}
            onClick={() => startStudySession(filtered)}
          >
            ▶ Study {filtered.length}
          </button>
        </div>
      </div>

      {/* Toolbar: search + filters + sort */}
      <div style={styles.toolbar}>
        <input
          style={styles.search}
          placeholder="🔍  Search word or translation…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <Labeled label="Group by">
          <select style={styles.select} value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)}>
            <option value="none">None</option>
            <option value="source">Source</option>
            <option value="deck">Deck</option>
          </select>
        </Labeled>
        <Labeled label="Sort">
          <select style={styles.select} value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="az">A – Z</option>
          </select>
        </Labeled>
      </div>

      {/* Deck chips: navigation + filter */}
      <div style={styles.chipRow}>
        <button
          style={{ ...styles.chip, ...(activeDeck === 'all' ? styles.chipActive : {}) }}
          onClick={() => setActiveDeck('all')}
        >
          All <span style={styles.chipCount}>{items.length}</span>
        </button>
        {deckOrder.filter(c => (colorCounts[c] || 0) > 0).map(c => {
          const named = !!deckLabels[c]
          const active = activeDeck === c
          return (
            <button
              key={c}
              style={{ ...styles.chip, ...(active ? styles.chipActive : {}) }}
              onClick={() => setActiveDeck(active ? 'all' : c)}
            >
              <span style={{ ...styles.chipDot, background: BOOKMARK_COLORS[c] }} />
              <span style={{ color: named ? undefined : '#7a7aa0', textTransform: named ? undefined : 'capitalize' }}>
                {deckName(c)}
              </span>
              <span style={styles.chipCount}>{colorCounts[c]}</span>
            </button>
          )
        })}
        <span style={styles.nameHint}>Name your decks in Settings →</span>
      </div>

      {/* Bulk action bar (only when something is selected) */}
      {selectedItems.length > 0 && (
        <div style={styles.bulkBar}>
          <span style={styles.bulkCount}>{selectedItems.length} selected</span>
          <button
            style={styles.bulkBtn}
            onClick={e => {
              setPickerRect((e.currentTarget as HTMLElement).getBoundingClientRect())
              setOpenPicker({ kind: 'bulk' })
            }}
          >Move to deck ▾</button>
          <button style={styles.bulkBtnPrimary} onClick={() => startStudySession(selectedItems)}>▶ Study {selectedItems.length}</button>
          <button
            style={styles.bulkBtnDanger}
            onClick={() => { selectedItems.forEach(i => onDelete(i.id)); setSelectedIds(new Set()) }}
          >
            🗑 Delete {selectedItems.length}
          </button>
          <button style={styles.bulkClear} onClick={() => setSelectedIds(new Set())}>Clear</button>
        </div>
      )}

      {/* The list */}
      {filtered.length === 0 ? (
        <div style={styles.noResults}>
          {search.trim()
            ? <>No matches for “{search.trim()}”. <button style={styles.linkBtn} onClick={() => setSearch('')}>Clear search</button></>
            : activeDeck !== 'all'
              ? <>No items in <strong>{deckName(activeDeck as BookmarkColor)}</strong> yet.</>
              : 'No items match these filters.'}
        </div>
      ) : groupBy === 'source' ? (
        renderSourceGroups()
      ) : groupBy === 'deck' ? (
        renderDeckGroups()
      ) : (
        <div style={styles.list}>{filtered.map(renderRow)}</div>
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
          <span style={{ ...styles.rowDot, background: BOOKMARK_COLORS[item.color] }} title={deckName(item.color)} />

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
            title="Read aloud"
            onClick={e => { e.stopPropagation(); playAudio(item.text) }}
          >
            🔊
          </button>
        </div>

        {expanded && (
          <div style={styles.rowExpanded}>
            {word && hasContext && (
              <div style={styles.context}>
                {item.prefix}<strong style={{ color: '#e8e8f5' }}>{item.text}</strong>{item.suffix}
                <button
                  style={styles.iconBtnSmall}
                  title="Read sentence"
                  onClick={() => playAudio((item.prefix || '') + item.text + (item.suffix || ''))}
                >
                  🔊
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
                <span style={{ ...styles.chipDot, background: BOOKMARK_COLORS[item.color] }} /> Move to deck ▾
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

  function renderSourceGroups() {
    const groups: Record<string, SavedItem[]> = {}
    for (const item of filtered) {
      const url = item.url || 'Dictionary (No URL)'
        ; (groups[url] ||= []).push(item)
    }
    const urls = Object.keys(groups).sort((a, b) =>
      Math.max(...groups[b].map(i => i.createdAt)) - Math.max(...groups[a].map(i => i.createdAt))
    )
    return (
      <div style={styles.list}>
        {urls.map(url => {
          const groupItems = groups[url]
          const open = expandedUrls.has(url)
          return (
            <div key={url} style={styles.group}>
              <div style={styles.groupHeader} onClick={() => setExpandedUrls(toggleSet(expandedUrls, url))}>
                <span style={styles.expander}>{open ? '▼' : '▶'}</span>
                <span style={styles.groupTitle}>{url}</span>
                <span style={styles.chipCount}>{groupItems.length}</span>
                <button
                  style={styles.groupStudyBtn}
                  onClick={e => { e.stopPropagation(); startStudySession(groupItems) }}
                >
                  ▶ Study
                </button>
              </div>
              {open && <div style={styles.groupBody}>{groupItems.map(renderRow)}</div>}
            </div>
          )
        })}
      </div>
    )
  }

  function renderDeckGroups() {
    return (
      <div style={styles.list}>
        {deckOrder.filter(c => filtered.some(i => i.color === c)).map(c => {
          const groupItems = filtered.filter(i => i.color === c)
          const named = !!deckLabels[c]
          return (
            <div key={c} style={styles.group}>
              <div style={styles.groupHeader}>
                <span style={{ ...styles.chipDot, background: BOOKMARK_COLORS[c] }} />
                <span style={{ ...styles.groupTitle, color: named ? undefined : '#7a7aa0', textTransform: named ? undefined : 'capitalize' }}>
                  {deckName(c)}
                </span>
                <span style={styles.chipCount}>{groupItems.length}</span>
                <button style={styles.groupStudyBtn} onClick={() => startStudySession(groupItems)}>▶ Study</button>
              </div>
              <div style={styles.groupBody}>{groupItems.map(renderRow)}</div>
            </div>
          )
        })}
      </div>
    )
  }
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, color: '#9a9ac0' }}>{label}</span>
      {children}
    </label>
  )
}

function DeckPicker({ current, deckName, order, onPick, anchor }: {
  current?: BookmarkColor
  deckName: (c: BookmarkColor) => string
  order: BookmarkColor[]
  onPick: (c: BookmarkColor) => void
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
      // Explicitly set both top and bottom so the absolute-positioned base style
      // (top: calc(100% + 4px)) doesn't bleed through after the spread merge.
      top: showAbove ? 'auto' : anchor.bottom + 4,
      bottom: showAbove ? window.innerHeight - anchor.top + 4 : 'auto',
      zIndex: 1000,
      maxHeight,
      overflowY: 'auto',
    }
  })()
  return (
    <div style={{ ...styles.deckPicker, ...posStyle }}>
      {order.map(c => (
        <button
          key={c}
          style={{ ...styles.deckPickerItem, ...(current === c ? styles.deckPickerItemActive : {}) }}
          onClick={() => onPick(c)}
        >
          <span style={{ ...styles.chipDot, background: BOOKMARK_COLORS[c] }} />
          <span style={{ textTransform: deckName(c) === c ? 'capitalize' : undefined }}>{deckName(c)}</span>
          {current === c && <span style={{ marginLeft: 'auto', color: '#6b8aff' }}>✓</span>}
        </button>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: '100%' },
  overlay: { position: 'fixed', inset: 0, zIndex: 9 },
  empty: {
    textAlign: 'center', padding: '60px 20px', color: '#9a9ac0',
    background: '#181830', borderRadius: 12,
  },
  headerArea: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 16, gap: 16, flexWrap: 'wrap',
  },
  title: { margin: 0, fontSize: 22, color: '#e8e8f5' },
  studyLauncher: { display: 'flex', alignItems: 'center', gap: 8 },
  modeSelect: {
    background: '#15152a', color: '#e8e8f5', border: '1px solid #2a2a4a',
    borderRadius: 8, padding: '8px 10px', fontSize: 13,
  },
  studyBtn: {
    background: '#6b8aff', color: '#0d0d1a', border: 'none', borderRadius: 8,
    padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
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
  chipRow: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 18,
  },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 7, background: '#15152a',
    border: '1px solid #2a2a4a', borderRadius: 999, padding: '6px 12px',
    color: '#c8c8e0', fontSize: 13, cursor: 'pointer',
  },
  chipActive: { background: '#23234a', borderColor: '#6b8aff', color: '#e8e8f5' },
  chipDot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0, display: 'inline-block' },
  chipCount: {
    background: 'rgba(255,255,255,0.08)', borderRadius: 999, padding: '1px 7px',
    fontSize: 11, fontWeight: 700, color: '#c8c8e0',
  },
  nameHint: { fontSize: 12, color: '#7a7aa0', marginLeft: 4 },
  bulkBar: {
    position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: 10, zIndex: 200,
    background: '#23234a', border: '1px solid #6b8aff', borderRadius: 10, padding: '10px 14px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    whiteSpace: 'nowrap',
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
  typeIcon: { fontSize: 13, opacity: 0.7, width: 18, textAlign: 'center', flexShrink: 0 },
  rowText: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  wordText: { color: '#e8e8f5', fontSize: 15 },
  phonetics: { color: '#9a9ac0', fontSize: 13 },
  translation: { color: '#6bcfff', fontSize: 14 },
  quoteText: { color: '#d0d0e8', fontStyle: 'italic', fontSize: 14, display: 'block' },
  iconBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, opacity: 0.7, flexShrink: 0 },
  iconBtnSmall: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, opacity: 0.7, marginLeft: 6 },
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
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 10,
    background: '#181830', border: '1px solid #3a3a6a', borderRadius: 8, padding: 6,
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 160,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  deckPickerItem: {
    display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none',
    borderRadius: 6, padding: '6px 8px', color: '#c8c8e0', fontSize: 13, cursor: 'pointer', textAlign: 'left',
  },
  deckPickerItemActive: { background: '#23234a' },
  group: { background: '#13132a', borderRadius: 10, border: '1px solid #20203a', overflow: 'hidden' },
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', cursor: 'pointer',
  },
  expander: { color: '#7a7aa0', fontSize: 11, flexShrink: 0 },
  groupTitle: {
    color: '#e0e0ff', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420,
  },
  groupStudyBtn: {
    marginLeft: 'auto', background: '#23234a', color: '#cdd6ff', border: '1px solid #3a3a6a',
    borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  groupBody: {
    padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 6,
  },
}
