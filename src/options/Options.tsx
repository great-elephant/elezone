import { useEffect, useState } from 'react'
import { Bookmark, Settings, DEFAULT_SETTINGS, BOOKMARK_COLORS, BookmarkColor } from '../shared/types'
import BookmarkList from './BookmarkList'
import SettingsPanel from './SettingsPanel'

type Tab = 'settings' | 'bookmarks'

export default function Options() {
  const [tab, setTab] = useState<Tab>('bookmarks')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s: Settings) => {
      if (s) setSettings(s)
    })
    loadBookmarks()
  }, [])

  function loadBookmarks() {
    chrome.runtime.sendMessage({ type: 'GET_BOOKMARKS' }, (list: Bookmark[]) => {
      if (list) setBookmarks(list)
    })
  }

  async function saveSettings(next: Settings) {
    setSettings(next)
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: next })
  }

  async function deleteBookmark(id: string) {
    await chrome.runtime.sendMessage({ type: 'DELETE_BOOKMARK', payload: id })
    setBookmarks(prev => prev.filter(b => b.id !== id))
  }

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.logo}>📖 CXT English</span>
        <nav style={styles.nav}>
          <button
            style={{ ...styles.navBtn, ...(tab === 'bookmarks' ? styles.navBtnActive : {}) }}
            onClick={() => setTab('bookmarks')}
          >
            My Bookmarks
          </button>
          <button
            style={{ ...styles.navBtn, ...(tab === 'settings' ? styles.navBtnActive : {}) }}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </nav>
      </header>

      <main style={styles.main}>
        {tab === 'bookmarks' ? (
          <BookmarkList
            bookmarks={bookmarks}
            onDelete={deleteBookmark}
          />
        ) : (
          <SettingsPanel settings={settings} onChange={saveSettings} />
        )}
      </main>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', minHeight: '100vh' },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 32px',
    height: 56,
    background: '#1a1a2e',
    borderBottom: '1px solid #2a2a4a',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  logo: { fontSize: 18, fontWeight: 700 },
  nav: { display: 'flex', gap: 4 },
  navBtn: {
    background: 'transparent',
    border: 'none',
    color: '#8888aa',
    padding: '6px 16px',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    fontWeight: 500,
  },
  navBtnActive: {
    background: '#2a2a4a',
    color: '#e0e0ff',
  },
  main: { flex: 1, padding: '28px 32px', maxWidth: 900, width: '100%', margin: '0 auto' },
}

export type { BookmarkColor }
export { BOOKMARK_COLORS }
