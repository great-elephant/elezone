import { useState, useMemo } from 'react'
import { Bookmark, BOOKMARK_COLORS, BookmarkColor } from '../shared/types'

interface Props {
  bookmarks: Bookmark[]
  onDelete: (id: string) => void
}

export default function BookmarkList({ bookmarks, onDelete }: Props) {
  const [search, setSearch] = useState('')
  const [filterColor, setFilterColor] = useState<BookmarkColor | ''>('')
  const [filterUrl, setFilterUrl] = useState('')

  const filtered = useMemo(() => {
    return bookmarks.filter(b => {
      if (filterColor && b.color !== filterColor) return false
      if (filterUrl && !b.url.includes(filterUrl)) return false
      if (search && !b.text.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [bookmarks, search, filterColor, filterUrl])

  function openBookmark(b: Bookmark) {
    // Append hash param so the content script knows to scroll to and flash this bookmark
    const url = b.url + (b.url.includes('#') ? '&' : '#') + `cxt-bookmark=${b.id}`
    chrome.tabs.create({ url })
  }

  if (bookmarks.length === 0) {
    return (
      <div style={styles.empty}>
        <p>No bookmarks yet.</p>
        <p style={styles.hint}>Select text on any page, right-click, and choose Bookmark.</p>
      </div>
    )
  }

  return (
    <div>
      <div style={styles.filters}>
        <input
          style={styles.input}
          placeholder="Search text…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <input
          style={styles.input}
          placeholder="Filter by URL…"
          value={filterUrl}
          onChange={e => setFilterUrl(e.target.value)}
        />
        <select
          style={styles.select}
          value={filterColor}
          onChange={e => setFilterColor(e.target.value as BookmarkColor | '')}
        >
          <option value="">All colors</option>
          {(Object.keys(BOOKMARK_COLORS) as BookmarkColor[]).map(c => (
            <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
          ))}
        </select>
      </div>

      <div style={styles.count}>{filtered.length} bookmark{filtered.length !== 1 ? 's' : ''}</div>

      <div style={styles.list}>
        {filtered.map(b => (
          <div
            key={b.id}
            style={{
              ...styles.card,
              ...(b.orphaned ? styles.cardOrphaned : {}),
              borderLeft: `4px solid ${BOOKMARK_COLORS[b.color]}`,
            }}
          >
            <div style={styles.cardText}>
              <span style={styles.excerpt}>"{b.text}"</span>
              {b.orphaned && <span style={styles.orphanedBadge}>Orphaned</span>}
            </div>
            <div style={styles.cardMeta}>
              <span
                style={styles.urlLink}
                onClick={() => openBookmark(b)}
                title={b.url}
              >
                {new URL(b.url).hostname}
              </span>
              <span style={styles.date}>{new Date(b.createdAt).toLocaleDateString()}</span>
            </div>
            <button
              style={styles.deleteBtn}
              onClick={() => onDelete(b.id)}
              title="Delete bookmark"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  empty: { textAlign: 'center', paddingTop: 80, color: '#666' },
  hint: { marginTop: 8, fontSize: 13, color: '#444' },
  filters: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' },
  input: {
    flex: 1,
    minWidth: 160,
    background: '#1a1a2e',
    border: '1px solid #2a2a4a',
    borderRadius: 6,
    color: '#e0e0e0',
    padding: '7px 12px',
    fontSize: 13,
    outline: 'none',
  },
  select: {
    background: '#1a1a2e',
    border: '1px solid #2a2a4a',
    borderRadius: 6,
    color: '#e0e0e0',
    padding: '7px 12px',
    fontSize: 13,
    cursor: 'pointer',
  },
  count: { fontSize: 12, color: '#666', marginBottom: 12 },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  card: {
    position: 'relative',
    background: '#1a1a2e',
    borderRadius: 8,
    padding: '12px 40px 12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  cardOrphaned: { opacity: 0.6 },
  cardText: { display: 'flex', alignItems: 'center', gap: 8 },
  excerpt: { fontSize: 14, color: '#e0e0e0', fontStyle: 'italic' },
  orphanedBadge: {
    fontSize: 10,
    background: '#3a1a1a',
    color: '#ff8888',
    borderRadius: 4,
    padding: '2px 6px',
    flexShrink: 0,
  },
  cardMeta: { display: 'flex', gap: 12, alignItems: 'center' },
  urlLink: {
    fontSize: 12,
    color: '#6888cc',
    cursor: 'pointer',
    textDecoration: 'underline',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 300,
  },
  date: { fontSize: 12, color: '#555', flexShrink: 0 },
  deleteBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    background: 'transparent',
    border: 'none',
    color: '#555',
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
    padding: 4,
    borderRadius: 4,
  },
}
