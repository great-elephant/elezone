import { useCallback, useEffect, useRef, useState } from 'react'
import StudyUI from '../options/StudyUI'
import { STUDY_MODES } from '../shared/studyModes'
import { STUDY_DARK, STUDY_LIGHT } from '../shared/studyTheme'
import { speak, stopSpeaking } from '../shared/speak'
import { speakFailureNotice } from '../shared/speakResult'
import { filterItemsForUrl } from '../shared/urlItems'
import { DEFAULT_SETTINGS, SavedItem, Settings, StudyMode } from '../shared/types'
import type { StudyTheme } from '../shared/studyTheme'

// Same glyph the study screen and the on-page dictionary use for read-aloud.
function SpeakerButton({ word, speaking, theme, onClick }: { word: string; speaking: boolean; theme: StudyTheme; onClick: () => void }) {
  const [hot, setHot] = useState(false)
  const [focused, setFocused] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Play pronunciation of ${word}`}
      aria-pressed={speaking}
      onClick={e => { e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={e => setFocused(e.currentTarget.matches(':focus-visible'))}
      onBlur={() => setFocused(false)}
      style={{
        flexShrink: 0, alignSelf: 'center', width: 36, height: 36, minWidth: 36, borderRadius: '50%', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, lineHeight: 1, padding: 0,
        background: speaking ? theme.primary : hot ? theme.inset : 'none',
        border: `1px solid ${speaking || focused ? theme.primary : 'transparent'}`,
        outline: focused ? `2px solid ${theme.primary}` : 'none', outlineOffset: 1,
        opacity: speaking || hot || focused ? 1 : 0.75,
      }}
    >
      🔊
    </button>
  )
}

// The tab this panel instance belongs to (set by openStudyPanel).
const tabId = Number(new URLSearchParams(location.search).get('tabId'))

// Padding around the study screen; it fills the rest of the panel height.
const PANEL_PADDING = 12

// Follows the OS/browser color scheme and updates when it changes.
function useColorScheme(): 'dark' | 'light' {
  const query = '(prefers-color-scheme: light)'
  const [scheme, setScheme] = useState<'dark' | 'light'>(() => (matchMedia(query).matches ? 'light' : 'dark'))
  useEffect(() => {
    const mq = matchMedia(query)
    const onChange = () => setScheme(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    onChange()
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return scheme
}

export default function SidePanel() {
  const [items, setItems] = useState<SavedItem[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [mode, setMode] = useState<StudyMode>('listening')
  // Snapshot taken when the user presses Start. StudyUI restarts its queue
  // whenever its items prop changes, so a live list must never be passed to a
  // running session: words saved meanwhile are picked up at the next Start.
  const [sessionItems, setSessionItems] = useState<SavedItem[] | null>(null)
  const scheme = useColorScheme()
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [speakError, setSpeakError] = useState<string | null>(null)
  // Identifies the latest speak attempt so a superseded one can't clear the active state.
  const speakSeq = useRef(0)
  // Utterances this panel has started and not yet seen finish. stopSpeaking()
  // is only sent while this is non-zero so it can't cut off page Read Aloud.
  const inFlight = useRef(0)
  const stopOwnSpeech = () => { if (inFlight.current > 0) stopSpeaking() }
  const urlRef = useRef<string | undefined>(undefined)

  const loadItems = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'GET_ITEMS' }, (list: SavedItem[]) => {
      if (chrome.runtime.lastError || !list) return
      const next = filterItemsForUrl(list, urlRef.current)
      setItems(next)
    })
  }, [])

  const applyUrl = useCallback((next: string | undefined) => {
    if (next === urlRef.current) return
    urlRef.current = next
    // The running session's words belong to the previous URL.
    setSessionItems(null)
    loadItems()
  }, [loadItems])

  useEffect(() => {
    // A hand-opened page has no ?tabId; stay in the neutral empty state.
    if (!Number.isInteger(tabId) || tabId <= 0) return
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s: Settings) => {
      if (chrome.runtime.lastError || !s) return
      setSettings(s)
      if (s.defaultStudyMode) setMode(s.defaultStudyMode)
    })
    chrome.tabs.get(tabId).then(t => applyUrl(t.url)).catch(() => { })

    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && (info.url || info.status === 'complete')) applyUrl(tab.url)
    }
    const onStorage = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'local') return
      if (changes['elezone_library']) loadItems()
      if (changes['settings']) setSettings(changes['settings'].newValue || DEFAULT_SETTINGS)
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.storage.onChanged.addListener(onStorage)
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.storage.onChanged.removeListener(onStorage)
    }
  }, [applyUrl, loadItems])

  useEffect(() => () => { if (inFlight.current > 0) stopSpeaking() }, [])

  function toggleSpeak(item: SavedItem) {
    if (speakingId === item.id) {
      speakSeq.current++
      setSpeakingId(null)
      stopOwnSpeech()
      return
    }
    const seq = ++speakSeq.current
    setSpeakError(null)
    setSpeakingId(item.id)
    inFlight.current++
    speak(item.text, { lang: item.sourceLang }).then(res => {
      inFlight.current--
      if (seq !== speakSeq.current) return
      setSpeakingId(null)
      if (!res.ok) setSpeakError(speakFailureNotice(res.error))
    })
  }

  const t = scheme === 'light' ? STUDY_LIGHT : STUDY_DARK

  // Page background and native controls (select, input, scrollbars) follow the palette.
  useEffect(() => {
    document.documentElement.style.colorScheme = t.scheme
    document.body.style.background = t.pageBg
    document.body.style.color = t.text
  }, [t])

  function changeMode(next: StudyMode) {
    setMode(next)
    if (!settings) return
    const updated = { ...settings, defaultStudyMode: next, updatedAt: Date.now() }
    setSettings(updated)
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: updated })
  }


  if (sessionItems) {
    return (
      <div style={{ padding: PANEL_PADDING }}>
        <StudyUI
          items={sessionItems}
          mode={mode}
          settings={settings}
          onClose={() => setSessionItems(null)}
          theme={t}
          compact
          viewportOffset={PANEL_PADDING * 2}
          backLabel="← Words"
        />
      </div>
    )
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.length === 0 ? (
        <div style={{ textAlign: 'center', color: t.muted, padding: '32px 8px', fontSize: 14 }}>
          No saved words for this page yet. Save words here and they will show up for study.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <select
            value={mode}
            onChange={e => changeMode(e.target.value as StudyMode)}
            aria-label="Study mode"
            style={{ flex: 1, minWidth: 0, height: 40, textOverflow: 'ellipsis', padding: '0 8px', borderRadius: 8, border: `1px solid ${t.border}`, background: t.inset, color: t.text, fontSize: 14 }}
          >
            {STUDY_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button
            onClick={() => { setSpeakingId(null); setSpeakError(null); speakSeq.current++; stopOwnSpeech(); setSessionItems(items) }}
            style={{ flexShrink: 0, width: 88, height: 40, padding: 0, borderRadius: 8, border: 'none', background: t.primary, color: t.primaryText, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
          >
            Start
          </button>
          </div>
          <div style={{ fontSize: 13, color: t.muted }}>
            {items.length} saved {items.length === 1 ? 'word' : 'words'}
          </div>
          {speakError && (
            <div role="alert" style={{ fontSize: 12, color: t.error, overflowWrap: 'anywhere' }}>{speakError}</div>
          )}
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map(i => (
              <li
                key={i.id}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', background: t.card, border: `1px solid ${t.borderSoft}`, borderRadius: 8, minWidth: 0 }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: t.strong, overflowWrap: 'anywhere' }}>{i.text}</span>
                    {i.phonetics && (
                      <span style={{ fontSize: 12, color: t.muted, overflowWrap: 'anywhere' }}>{i.phonetics}</span>
                    )}
                  </div>
                  {i.translation && (
                    <div style={{ fontSize: 13, color: t.muted, overflowWrap: 'anywhere', marginTop: 2 }}>{i.translation}</div>
                  )}
                </div>
                <SpeakerButton word={i.text} speaking={speakingId === i.id} theme={t} onClick={() => toggleSpeak(i)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
