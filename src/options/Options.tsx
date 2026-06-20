import { useEffect, useState } from 'react'
import { SavedItem, Settings, DEFAULT_SETTINGS, BookmarkColor, BOOKMARK_COLORS } from '../shared/types'
import Library from './Library'
import SettingsPanel from './SettingsPanel'
import Dashboard from './Dashboard'

type Tab = 'dashboard' | 'library' | 'settings'

export default function Options() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [items, setItems] = useState<SavedItem[]>([])
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success'>('idle')

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s: Settings) => {
      if (s) setSettings(s)
    })
    loadItems()

    const handleMessage = (msg: any) => {
      if (msg.type === 'SYNC_STATUS_UPDATE') {
        if (msg.payload === 'error') {
          // Keep it brief, just revert to idle
          setSyncStatus('idle')
        } else {
          setSyncStatus(msg.payload)
          if (msg.payload === 'success') {
            loadItems()
          }
        }
      }
    }
    chrome.runtime.onMessage.addListener(handleMessage)

    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local') {
        if (changes['settings']) {
          setSettings(changes['settings'].newValue || DEFAULT_SETTINGS)
        }
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadItems()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
      chrome.storage.onChanged.removeListener(handleStorageChange)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (tab === 'library' || tab === 'dashboard') {
      loadItems()
    }
  }, [tab])

  function loadItems() {
    chrome.runtime.sendMessage({ type: 'GET_ITEMS' }, (list: SavedItem[]) => {
      if (list) setItems(list)
    })
  }

  async function saveSettings(next: Settings) {
    setSettings(next)
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: next })
  }

  function handleSync() {
    if (syncStatus === 'syncing') return
    setSyncStatus('syncing')
    chrome.runtime.sendMessage({ type: 'SYNC_ITEMS', payload: { interactive: true } }, (res) => {
      if (chrome.runtime.lastError || !res) {
        setSyncStatus('idle')
        alert('Failed to connect to background script.')
        return
      }
      if (res.ok) {
        setSyncStatus('success')
        loadItems()
        setTimeout(() => setSyncStatus('idle'), 2500)
      } else {
        setSyncStatus('idle')
        alert('❌ Failed to sync to Google Drive.\nReason: ' + (res.error || 'Unknown error'))
      }
    })
  }

  async function deleteItem(id: string) {
    await chrome.runtime.sendMessage({ type: 'DELETE_ITEM', payload: id })
    setItems(prev => prev.filter(i => i.id !== id))
  }

  async function updateItemColor(id: string, color: BookmarkColor) {
    const item = items.find(i => i.id === id)
    if (!item) return
    const updated = { ...item, color }
    await chrome.runtime.sendMessage({ type: 'UPDATE_ITEM', payload: updated })
    setItems(prev => prev.map(i => i.id === id ? updated : i))
  }

  return (
    <div style={styles.root}>
      <style>{`
        body {
          background-color: #0d0d1a !important;
          background-image: radial-gradient(rgba(255, 255, 255, 0.07) 1.5px, transparent 1.5px) !important;
          background-size: 24px 24px !important;
        }
      `}</style>
      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <span style={styles.logo}>📖 HZone - Learning</span>
          <button 
            title={!(settings?.sync?.enabled ?? false) ? "Go to Settings to enable Cloud Sync" : ""}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: 'none',
              background: !(settings?.sync?.enabled ?? false) ? '#2a2a3a' : '#4a5a9a',
              color: !(settings?.sync?.enabled ?? false) ? '#666' : 'white',
              cursor: (!(settings?.sync?.enabled ?? false) || syncStatus === 'syncing') ? 'not-allowed' : 'pointer',
              opacity: syncStatus === 'syncing' ? 0.7 : 1,
              fontWeight: 'bold',
              fontSize: '13px',
              transition: 'all 0.2s ease',
              minWidth: '130px'
            }}
            onClick={(e) => {
              if (!(settings?.sync?.enabled ?? false)) {
                e.preventDefault();
                alert('Cloud sync is disabled. Please go to Settings to enable it.');
                return;
              }
              handleSync();
            }}
            disabled={syncStatus === 'syncing'}
          >
            {!(settings?.sync?.enabled ?? false) ? '☁️ Sync Disabled' : syncStatus === 'syncing' ? '⏳ Syncing...' : syncStatus === 'success' ? '✅ Synced!' : '☁️ Sync to Drive'}
          </button>
        </div>
        <nav style={styles.nav}>
          <button
            style={{ ...styles.navBtn, ...(tab === 'dashboard' ? styles.navBtnActive : {}) }}
            onClick={() => setTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            style={{ ...styles.navBtn, ...(tab === 'library' ? styles.navBtnActive : {}) }}
            onClick={() => setTab('library')}
          >
            Library
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
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'library' && (
          <Library
            items={items}
            settings={settings}
            onDelete={deleteItem}
            onUpdateColor={updateItemColor}
            onUpdateSettings={saveSettings}
          />
        )}

        {tab === 'settings' && <SettingsPanel settings={settings} onChange={saveSettings} />}
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
