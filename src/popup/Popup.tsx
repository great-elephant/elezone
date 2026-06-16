import { useEffect, useState } from 'react'
import { Settings, DEFAULT_SETTINGS } from '../shared/types'

type ReadAloudState = 'idle' | 'playing' | 'paused'

export default function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [onDevice, setOnDevice] = useState<boolean | null>(null) // null = checking
  const [readable, setReadable] = useState<boolean | null>(null)
  const [readAloudState, setReadAloudState] = useState<ReadAloudState>('idle')

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s: Settings) => {
      if (s) setSettings(s)
    })

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) return
      chrome.tabs.sendMessage(tab.id, { type: 'CHECK_TRANSLATOR_AVAILABLE' }, (res: boolean | null) => {
        void chrome.runtime.lastError
        setOnDevice(res ?? false)
      })
      chrome.tabs.sendMessage(tab.id, { type: 'CHECK_READABLE' }, (res: { readable: boolean } | null) => {
        void chrome.runtime.lastError // suppress "no receiving end" errors
        setReadable(res?.readable ?? true) // if unreachable, assume readable and let user try
      })
    })

    const listener = (msg: { type: string; payload?: unknown }) => {
      if (msg.type === 'READ_ALOUD_STATE') {
        setReadAloudState(msg.payload as ReadAloudState)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  async function toggleTranslation() {
    const next: Settings = {
      ...settings,
      translation: { ...settings.translation, enabled: !settings.translation.enabled },
    }
    setSettings(next)
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: next })
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_TRANSLATION',
        payload: { enabled: next.translation.enabled },
      }).catch(() => {})
    }
  }

  async function startReadAloud() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'START_READ_ALOUD' }).catch(() => {})
    window.close()
  }

  async function openDashboard() {
    await chrome.runtime.openOptionsPage()
    window.close()
  }

  const startDisabled = readable === false

  // Translation source hint shown next to the toggle
  const translationHint =
    onDevice === null ? '' :
    onDevice ? '🔒 on-device' : '🌐 Google'

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <span style={styles.logo}>📖</span>
        <span style={styles.title}>CXT English</span>
      </header>

      <div style={styles.body}>
        <button
          style={{
            ...styles.primaryBtn,
            ...(readAloudState !== 'idle' ? styles.primaryBtnActive : {}),
            ...(startDisabled ? styles.btnDisabled : {}),
          }}
          onClick={startReadAloud}
          disabled={startDisabled || readAloudState !== 'idle'}
          title={startDisabled ? 'No readable content found on this page' : ''}
        >
          {readAloudState === 'idle' ? '▶  Start Reading' : '▶  Reading…'}
        </button>

        <div style={styles.toggleRow}>
          <div style={styles.toggleLabelGroup}>
            <span style={styles.toggleLabel}>Translation Aside</span>
            {translationHint && (
              <span style={styles.sourceChip}>{translationHint}</span>
            )}
          </div>
          <button
            style={{
              ...styles.toggle,
              ...(settings.translation.enabled ? styles.toggleOn : {}),
            }}
            onClick={toggleTranslation}
            aria-pressed={settings.translation.enabled}
          >
            <span style={{
              ...styles.toggleThumb,
              ...(settings.translation.enabled ? styles.toggleThumbOn : {}),
            }} />
          </button>
        </div>

        <button style={styles.dashboardBtn} onClick={openDashboard}>
          Open Dashboard ↗
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', minHeight: 160 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px 10px',
    borderBottom: '1px solid #2a2a4a',
  },
  logo: { fontSize: 20 },
  title: { fontSize: 15, fontWeight: 600, letterSpacing: 0.3 },
  body: { display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px 16px' },
  primaryBtn: {
    background: '#4f6ef7',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '9px 0',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
  },
  primaryBtnActive: { background: '#2d4fd4' },
  btnDisabled: { opacity: 0.4, cursor: 'not-allowed', background: '#3a3a6a' },
  toggleRow: { display: 'flex', alignItems: 'center', gap: 10 },
  toggleLabelGroup: { flex: 1, display: 'flex', alignItems: 'center', gap: 6 },
  toggleLabel: { fontSize: 13, color: '#c0c0d0' },
  sourceChip: {
    fontSize: 10,
    color: '#6688aa',
    background: '#1a2030',
    borderRadius: 4,
    padding: '2px 5px',
  },
  toggle: {
    position: 'relative',
    width: 38,
    height: 22,
    borderRadius: 11,
    background: '#3a3a5a',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
    transition: 'background 0.2s',
  },
  toggleOn: { background: '#4f6ef7' },
  toggleThumb: {
    position: 'absolute',
    top: 3,
    left: 3,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 0.2s',
  },
  toggleThumbOn: { left: 19 },
  dashboardBtn: {
    background: 'transparent',
    border: '1px solid #3a3a5a',
    color: '#8888cc',
    borderRadius: 8,
    padding: '7px 0',
    fontSize: 13,
    cursor: 'pointer',
    width: '100%',
  },
}
