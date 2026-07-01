import { useEffect, useId, useState } from 'react'
import { Settings, BookmarkColor, BOOKMARK_COLORS, DEFAULT_SETTINGS } from '../shared/types'
import { RoastIntensity, DEFAULT_ROAST_INTENSITY } from '../shared/roasts'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const ALL_COLORS: BookmarkColor[] = [
  'red', 'yellow', 'cyan', 'green', 'blue',
  'orange', 'purple', 'pink', 'teal', 'gray'
]

const TEST_TEXTS: Record<string, string> = {
  en: "The quick brown fox jumps over the lazy dog.",
  "zh-CN": "敏捷的棕色狐狸跳过懒狗。",
  zh: "敏捷的棕色狐狸跳过懒狗。",
  "zh-TW": "敏捷的棕色狐狸跳過懶狗。",
  ja: "素早い茶色のキツネはのろまな犬を飛び越える。",
  vi: "Con cáo nâu nhanh nhẹn nhảy qua con chó lười.",
  ko: "빠른 갈색 여우가 게으른 개를 뛰어넘습니다.",
  fr: "Le renard brun rapide saute par-dessus le chien paresseux.",
  es: "El rápido zorro marrón salta sobre el perro perezoso.",
  de: "Der schnelle braune Fuchs springt über den faulen Hund.",
  it: "La rapida volpe marrone salta oltre il cane pigro.",
  ru: "Быстрая коричневая лиса прыгает через ленивую собаку."
}

type TtsVoice = chrome.tts.TtsVoice

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
}

export default function SettingsPanel({ settings, onChange }: Props) {
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [testingVoice, setTestingVoice] = useState<string | null>(null)
  const [aiStatus, setAiStatus] = useState<AiStatus>('checking')

  const deckOrder: BookmarkColor[] = settings.deckOrder?.length === ALL_COLORS.length
    ? settings.deckOrder
    : ALL_COLORS

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  useEffect(() => {
    function loadVoices() {
      chrome.tts.getVoices().then(v => {
        if (v.length) setVoices(v)
      }).catch(() => { })
    }
    loadVoices()
    return undefined
  }, [])

  function set<K extends 'readAloud' | 'translation' | 'sync' | 'srsNotifications' | 'ocr' | 'roast'>(section: K, key: keyof NonNullable<Settings[K]>, value: unknown) {
    const next = { ...settings, [section]: { ...settings[section], [key]: value } } as Settings
    if (section !== 'sync') {
      next.updatedAt = Date.now()
    }
    onChange(next)

    if (section === 'sync' && key === 'enabled' && value === true) {
      chrome.runtime.sendMessage({ type: 'SYNC_ITEMS', payload: { interactive: true } })
    }
  }

  function setPomodoro(key: keyof NonNullable<Settings['pomodoro']>, value: unknown) {
    const currentPomodoro = settings.pomodoro || DEFAULT_SETTINGS.pomodoro!
    const next = { ...settings, pomodoro: { ...currentPomodoro, [key]: value } } as Settings
    next.updatedAt = Date.now()
    onChange(next)
    chrome.runtime.sendMessage({ type: 'POMODORO_COMMAND', payload: { action: 'updateSettings', settings: next.pomodoro } })
  }

  function setGamification(key: keyof NonNullable<Settings['gamification']>, value: unknown) {
    const current = settings.gamification || DEFAULT_SETTINGS.gamification
    const next = { ...settings, gamification: { ...current, [key]: value } } as Settings
    next.updatedAt = Date.now()
    onChange(next)
  }

  function testVoice(langCode?: string, voiceName?: string) {
    chrome.tts.stop()
    const testId = langCode || 'default'
    if (testingVoice !== null) {
      setTestingVoice(null)
      if (testingVoice === testId) return
    }

    setTestingVoice(testId)
    const text = (langCode && TEST_TEXTS[langCode]) || TEST_TEXTS.en

    chrome.tts.speak(text, {
      onEvent: event => {
        if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
          setTestingVoice(prev => prev === testId ? null : prev)
        }
      },
      pitch: settings.readAloud.pitch,
      rate: settings.readAloud.speed,
      lang: langCode,
      voiceName: voiceName || settings.readAloud.voice || undefined,
      volume: settings.readAloud.volume,
    }, () => {
      if (chrome.runtime.lastError) {
        setTestingVoice(null)
      }
    })
  }

  function setDeckLabel(color: BookmarkColor, name: string) {
    const labels = { ...(settings.deckLabels || {}) }
    if (name.trim()) labels[color] = name
    else delete labels[color]
    onChange({ ...settings, deckLabels: labels, updatedAt: Date.now() })
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = deckOrder.indexOf(active.id as BookmarkColor)
    const to = deckOrder.indexOf(over.id as BookmarkColor)
    const next = arrayMove(deckOrder, from, to)
    onChange({ ...settings, deckOrder: next, updatedAt: Date.now() })
  }

  const ra = settings.readAloud
  const tr = settings.translation
  const pm = settings.pomodoro || DEFAULT_SETTINGS.pomodoro!
  // Undefined intensity (existing users) falls back to the friendly default.
  const roastIntensity: RoastIntensity = settings.gamification?.roastIntensity ?? DEFAULT_ROAST_INTENSITY

  return (
    <div style={styles.root}>

      <CollapsibleSection title="Cloud Sync" defaultOpen>

        <Field label="Auto-sync to Google Drive">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={settings.sync?.enabled ?? true}
              onChange={e => set('sync', 'enabled', e.target.checked)}
              style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
            />
            <span style={{ fontSize: 13, color: '#e0e0e0' }}>
              Automatically sync flashcards and progress in the background
            </span>
          </div>
        </Field>

        {(settings.sync?.enabled ?? true) && (
          <Field label={`Sync Debounce Delay: ${settings.sync?.debounceSeconds ?? 5} second${(settings.sync?.debounceSeconds ?? 5) !== 1 ? 's' : ''}`}>
            <input
              type="range" min={1} max={300} step={1}
              value={settings.sync?.debounceSeconds ?? 5}
              style={styles.range}
              onChange={e => set('sync', 'debounceSeconds', parseInt(e.target.value))}
            />
          </Field>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Study Session">

        <Field label="Always show hint initially">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={settings.showHintInitially ?? false}
              onChange={e => onChange({ ...settings, showHintInitially: e.target.checked })}
              style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
            />
            <span style={{ fontSize: 13, color: '#e0e0e0' }}>
              Automatically reveal the hint without needing to click "Show Hint"
            </span>
          </div>
        </Field>

        <Field label="Selection save chip">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={settings.selectionChipEnabled ?? true}
              onChange={e => onChange({ ...settings, selectionChipEnabled: e.target.checked, updatedAt: Date.now() })}
              style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
            />
            <span style={{ fontSize: 13, color: '#e0e0e0' }}>
              Show a floating "Save" chip when you highlight text on a page
            </span>
          </div>
        </Field>
      </CollapsibleSection>

      <CollapsibleSection title="Notifications">

        <Field label="Flashcard Notifications">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={settings.srsNotifications?.enabled ?? true}
              onChange={e => set('srsNotifications', 'enabled', e.target.checked)}
              style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
            />
            <span style={{ fontSize: 13, color: '#e0e0e0' }}>
              Push flashcards due for review as system notifications
            </span>
          </div>
        </Field>

        {(settings.srsNotifications?.enabled ?? true) && (
          <>
            <Field label={`Check Interval: ${settings.srsNotifications?.intervalMinutes ?? 15} minutes`}>
              <input
                type="range" min={1} max={120} step={1}
                value={settings.srsNotifications?.intervalMinutes ?? 15}
                style={styles.range}
                onChange={e => set('srsNotifications', 'intervalMinutes', parseInt(e.target.value))}
              />
            </Field>

            <Field label="Active Hours (Do Not Disturb outside these hours)">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <select
                  value={settings.srsNotifications?.activeHoursStart ?? 8}
                  style={{ ...styles.select, width: 'auto' }}
                  onChange={e => set('srsNotifications', 'activeHoursStart', parseInt(e.target.value))}
                >
                  {Array.from({ length: 24 }).map((_, i) => (
                    <option key={i} value={i} disabled={i >= (settings.srsNotifications?.activeHoursEnd ?? 22)}>
                      {String(i).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
                <span style={{ color: '#8888aa' }}>to</span>
                <select
                  value={settings.srsNotifications?.activeHoursEnd ?? 22}
                  style={{ ...styles.select, width: 'auto' }}
                  onChange={e => set('srsNotifications', 'activeHoursEnd', parseInt(e.target.value))}
                >
                  {Array.from({ length: 24 }).map((_, i) => (
                    <option key={i} value={i} disabled={i <= (settings.srsNotifications?.activeHoursStart ?? 8)}>
                      {String(i).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </>
        )}

        <button
          style={{ ...styles.testBtn, marginTop: 8, alignSelf: 'flex-start' }}
          onClick={() => chrome.runtime.sendMessage({ type: 'TEST_NOTIFICATION' })}
        >
          🔔 Test Notification
        </button>
      </CollapsibleSection>

      <CollapsibleSection title="Decks">
        <p style={{ fontSize: 13, color: '#8888aa', margin: '0 0 4px' }}>
          Give each color a name to turn it into a deck. Drag to reorder — the order applies
          to the Library filter chips and the right-click save menu.
        </p>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={deckOrder} strategy={verticalListSortingStrategy}>
            <div style={styles.deckList}>
              {deckOrder.map(color => (
                <SortableDeckItem
                  key={color}
                  color={color}
                  label={settings.deckLabels?.[color] ?? ''}
                  onLabelChange={name => setDeckLabel(color, name)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </CollapsibleSection>

      <CollapsibleSection title="Read Aloud">

        <Field label={`Speed: ${ra.speed.toFixed(1)}×`}>
          <input type="range" min={0.5} max={3} step={0.1} value={ra.speed}
            style={styles.range}
            onChange={e => set('readAloud', 'speed', parseFloat(e.target.value))} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Repeat each sentence">
            <input type="number" min={1} max={99} value={ra.repetition}
              style={styles.select}
              onChange={e => set('readAloud', 'repetition', Math.max(1, parseInt(e.target.value) || 1))} />
          </Field>

          <Field label="Repeat whole page">
            <input type="number" min={1} max={99} value={ra.pageRepetition ?? 1}
              style={styles.select}
              onChange={e => set('readAloud', 'pageRepetition', Math.max(1, parseInt(e.target.value) || 1))} />
          </Field>
        </div>

        <Field label="Default Voice (Fallback)">
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              style={styles.select}
              value={ra.voice}
              onChange={e => set('readAloud', 'voice', e.target.value)}
            >
              <option value="">System auto-detect</option>
              {voices.map(v => (
                <option key={v.voiceName} value={v.voiceName}>{v.voiceName} ({v.lang})</option>
              ))}
            </select>
            <button
              style={{ ...styles.testBtnSmall, ...(testingVoice === 'default' ? styles.testBtnActive : {}) }}
              onClick={() => testVoice()}
              title="Test default voice"
              aria-label={testingVoice === 'default' ? 'Stop testing default voice' : 'Test default voice'}
            >
              {testingVoice === 'default' ? '⏹' : '▶'}
            </button>
          </div>
        </Field>

        <Field label="Language-specific Voices">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.entries(ra.languageVoices || {}).map(([langCode, voiceName]) => (
              <div key={langCode} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ color: '#e8e8f5', fontSize: 13, minWidth: 60, fontWeight: 'bold' }}>{langCode}</span>
                <select
                  style={{ ...styles.select, flex: 1 }}
                  value={voiceName}
                  onChange={e => {
                    const newMap = { ...(ra.languageVoices || {}) }
                    if (e.target.value) newMap[langCode] = e.target.value
                    else delete newMap[langCode]
                    set('readAloud', 'languageVoices', newMap)
                  }}
                >
                  <option value="">Auto-detect</option>
                  {voices.map(v => (
                    <option key={v.voiceName} value={v.voiceName}>{v.voiceName} ({v.lang})</option>
                  ))}
                </select>
                <button
                  style={{ ...styles.testBtnSmall, ...(testingVoice === langCode ? styles.testBtnActive : {}) }}
                  onClick={() => testVoice(langCode, voiceName)}
                  title="Test voice"
                  aria-label={testingVoice === langCode ? `Stop testing ${langCode} voice` : `Test ${langCode} voice`}
                >
                  {testingVoice === langCode ? '⏹' : '▶'}
                </button>
                <button
                  style={{ background: 'transparent', border: 'none', color: '#ff6b6b', cursor: 'pointer', fontSize: 16 }}
                  onClick={() => {
                    const newMap = { ...(ra.languageVoices || {}) }
                    delete newMap[langCode]
                    set('readAloud', 'languageVoices', newMap)
                  }}
                  title="Remove override"
                  aria-label={`Remove ${langCode} voice override`}
                >
                  ✕
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                style={styles.select}
                value=""
                onChange={e => {
                  const val = e.target.value
                  if (val) {
                    set('readAloud', 'languageVoices', { ...(ra.languageVoices || {}), [val]: '' })
                  }
                }}
              >
                <option value="">+ Add language override...</option>
                <option value="en">English (en)</option>
                <option value="zh-CN">Chinese (zh-CN)</option>
                <option value="ja">Japanese (ja)</option>
                <option value="vi">Vietnamese (vi)</option>
                <option value="ko">Korean (ko)</option>
                <option value="fr">French (fr)</option>
                <option value="es">Spanish (es)</option>
                <option value="de">German (de)</option>
                <option value="it">Italian (it)</option>
                <option value="ru">Russian (ru)</option>
              </select>
            </div>
          </div>
        </Field>


        <Field label={`Pitch: ${ra.pitch.toFixed(1)}`}>
          <input type="range" min={0.5} max={2} step={0.1} value={ra.pitch}
            style={styles.range}
            onChange={e => set('readAloud', 'pitch', parseFloat(e.target.value))} />
        </Field>

        <Field label={`Volume: ${Math.round(ra.volume * 100)}%`}>
          <input type="range" min={0} max={1} step={0.05} value={ra.volume}
            style={styles.range}
            onChange={e => set('readAloud', 'volume', parseFloat(e.target.value))} />
        </Field>
      </CollapsibleSection>

      <CollapsibleSection title="Focus & Breathe">

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <Field label="Focus (min)">
            <input type="number" min={1} max={120} value={pm.focusTime}
              style={styles.select}
              onChange={e => setPomodoro('focusTime', parseInt(e.target.value) || 25)} />
          </Field>
          <Field label="Short Break (min)">
            <input type="number" min={0} max={60} value={pm.shortBreakTime}
              style={styles.select}
              onChange={e => { const v = parseInt(e.target.value); setPomodoro('shortBreakTime', isNaN(v) ? 5 : Math.max(0, v)); }} />
          </Field>
          <Field label="Long Break (min)">
            <input type="number" min={0} max={120} value={pm.longBreakTime}
              style={styles.select}
              onChange={e => { const v = parseInt(e.target.value); setPomodoro('longBreakTime', isNaN(v) ? 15 : Math.max(0, v)); }} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
          <Field label="Auto-start Focus">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={pm.autoStartPomodoro ?? false}
                onChange={e => setPomodoro('autoStartPomodoro', e.target.checked)}
                style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
              />
            </div>
          </Field>
          <Field label="Auto-start Break">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={pm.autoStartBreak ?? false}
                onChange={e => setPomodoro('autoStartBreak', e.target.checked)}
                style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
              />
            </div>
          </Field>
        </div>

        <h3 style={{ fontSize: 13, color: '#8888aa', marginTop: 12, marginBottom: 0 }}>Breathing Cycle (Seconds)</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
          <Field label="Inhale">
            <input type="number" min={0} max={30} value={pm.inhale}
              style={styles.select}
              onChange={e => setPomodoro('inhale', parseInt(e.target.value) || 0)} />
          </Field>
          <Field label="Hold">
            <input type="number" min={0} max={30} value={pm.hold1}
              style={styles.select}
              onChange={e => setPomodoro('hold1', parseInt(e.target.value) || 0)} />
          </Field>
          <Field label="Exhale">
            <input type="number" min={0} max={30} value={pm.exhale}
              style={styles.select}
              onChange={e => setPomodoro('exhale', parseInt(e.target.value) || 0)} />
          </Field>
          <Field label="Hold">
            <input type="number" min={0} max={30} value={pm.hold2}
              style={styles.select}
              onChange={e => setPomodoro('hold2', parseInt(e.target.value) || 0)} />
          </Field>
        </div>
        {(pm.inhale === 0 || pm.exhale === 0) && (
          <div style={{ fontSize: 13, color: '#facc15', marginTop: 12, padding: '8px 12px', background: 'rgba(250,204,21,0.1)', borderRadius: 6 }}>
            {pm.inhale === 0 && pm.exhale === 0
              ? "Not breathing at all? Ok fine, this app doesn't discriminate against aliens! 👽 Wellcome to the Earth🥳🙄🥳"
              : pm.inhale === 0
                ? "Only exhaling? Are you deflating like a balloon? 🎈"
                : "Only inhaling? Are you trying to inflate yourself and float away? 🐡"}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Translation">

        <Field label="Default target language">
          <select
            style={styles.select}
            value={tr.defaultTargetLanguage}
            onChange={e => set('translation', 'defaultTargetLanguage', e.target.value)}
          >
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </Field>

        <Field label="Translation mode">
          <select
            style={styles.select}
            value={tr.mode}
            onChange={e => set('translation', 'mode', e.target.value as 'paragraph' | 'sentence')}
          >
            <option value="paragraph">Whole paragraph</option>
            <option value="sentence">Sentence by sentence</option>
          </select>
        </Field>

        <Field label="Translation aside (read aloud overlay)">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={tr.asideForceGoogle ?? true}
              onChange={e => set('translation', 'asideForceGoogle', e.target.checked)}
              style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
            />
            <span style={{ fontSize: 13, color: '#e0e0e0' }}>
              Use Google Translate (uncheck to try on-device first)
            </span>
          </div>
        </Field>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 13, color: '#8888aa' }}>Word translation sources (tried in order, first hit wins)</label>
          {([
            ['disableAI', '🔒 On-device AI (Gemini Nano)'],
            ['disableGoogleContext', '🌐 Google · sentence context'],
            ['disableGoogleSenses', '🌐 Google · dictionary senses'],
          ] as const).map(([key, label]) => {
            const isAiSrc = key === 'disableAI';
            const isDisabled = isAiSrc && aiStatus !== 'available';
            const defaultDisabled = isAiSrc ? true : false;
            const isChecked = isAiSrc
              ? (aiStatus === 'available' && !(tr[key] ?? defaultDisabled))
              : !(tr[key] ?? defaultDisabled);

            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="checkbox"
                  id={`src-${key}`}
                  checked={isChecked}
                  disabled={isDisabled}
                  onChange={e => set('translation', key, !e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: '#4f6ef7', opacity: isDisabled ? 0.5 : 1 }}
                />
                <label htmlFor={`src-${key}`} style={{ fontSize: 13, color: '#e0e0e0', cursor: isDisabled ? 'not-allowed' : 'pointer', opacity: isDisabled ? 0.5 : 1 }}>
                  {label} {isDisabled && aiStatus !== 'checking' ? '(Needs Download)' : ''}
                </label>
              </div>
            )
          })}
          <span style={{ fontSize: 12, color: '#8a8ab0' }}>
            🌐 Google · plain translate is always the last resort
          </span>
        </div>

        <OnDeviceAi targetLang={tr.defaultTargetLanguage} onStatusChange={setAiStatus} onModelDownloaded={() => set('translation', 'disableAI', false)} />
      </CollapsibleSection>

      <CollapsibleSection title="OCR">
        <Field label="Language Model">
          <select
            style={styles.select}
            value={settings.ocr?.language || 'eng'}
            onChange={e => set('ocr', 'language', e.target.value)}
          >
            <option value="eng">English (eng)</option>
            <option value="chi_sim">Chinese Simplified (chi_sim)</option>
            <option value="chi_tra">Chinese Traditional (chi_tra)</option>
            <option value="jpn">Japanese (jpn)</option>
            <option value="kor">Korean (kor)</option>
            <option value="vie">Vietnamese (vie)</option>
            <option value="fra">French (fra)</option>
            <option value="spa">Spanish (spa)</option>
            <option value="deu">German (deu)</option>
            <option value="ita">Italian (ita)</option>
            <option value="rus">Russian (rus)</option>
          </select>
        </Field>


        <Field label="Auto-format to sentence case">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={settings.ocr?.sentenceCase ?? false}
              onChange={e => set('ocr', 'sentenceCase', e.target.checked)}
              style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
            />
            <span style={{ fontSize: 13, color: '#e0e0e0' }}>
              Only capitalize the first letter of sentences
            </span>
          </div>
        </Field>

        <Field label="Remove extra spaces and line breaks">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={settings.ocr?.removeExtraSpaces ?? true}
              onChange={e => set('ocr', 'removeExtraSpaces', e.target.checked)}
              style={{ width: 18, height: 18, accentColor: '#4f6ef7' }}
            />
            <span style={{ fontSize: 13, color: '#e0e0e0' }}>
              Normalize multiple spaces and newlines into a single space
            </span>
          </div>
        </Field>
      </CollapsibleSection>


      <CollapsibleSection title="Tough Love">
        <p style={{ fontSize: 13, color: '#8888aa', margin: '0 0 12px' }}>
          When you fall behind on your daily goal, EleZone can nudge you back with
          a little tough love. Pick the tone — or turn it off completely.
        </p>

        <Field label="Roast intensity">
          <div style={{ display: 'flex', gap: 6 }}>
            {ROAST_INTENSITIES.map(({ value, label }) => {
              const active = roastIntensity === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setGamification('roastIntensity', value)}
                  style={{
                    flex: 1,
                    padding: '7px 8px',
                    borderRadius: 6,
                    fontSize: 13,
                    cursor: 'pointer',
                    border: active ? '1px solid #4f6ef7' : '1px solid #2a2a4a',
                    background: active ? '#2a2a4a' : '#0f0f1a',
                    color: active ? '#e0e0ff' : '#8888aa',
                    fontWeight: active ? 600 : 400,
                    transition: 'all 0.15s ease',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </Field>
        <p style={{ fontSize: 12, color: '#8a8ab0', margin: '-8px 0 0' }}>
          {ROAST_INTENSITY_HINT[roastIntensity]}
        </p>

        <Field label={`Days behind goal before roasting: ${settings.roast?.noNewItemsDaysThreshold ?? 3} days`}>
          <input
            type="range" min={1} max={30} step={1}
            value={settings.roast?.noNewItemsDaysThreshold ?? 3}
            disabled={roastIntensity === 'off'}
            style={{ ...styles.range, opacity: roastIntensity === 'off' ? 0.5 : 1, cursor: roastIntensity === 'off' ? 'not-allowed' : 'pointer' }}
            onChange={e => set('roast', 'noNewItemsDaysThreshold', parseInt(e.target.value))}
          />
        </Field>
      </CollapsibleSection>
    </div>
  )
}

type AiStatus = 'checking' | 'unsupported' | 'downloadable' | 'downloading' | 'available'

function OnDeviceAi({ targetLang, onStatusChange, onModelDownloaded }: { targetLang: string, onStatusChange: (s: AiStatus) => void, onModelDownloaded?: () => void }) {
  const [status, setStatusInternal] = useState<AiStatus>('checking')
  const [progress, setProgress] = useState(0)

  const setStatus = (s: AiStatus) => {
    setStatusInternal(s);
    onStatusChange(s);
  };
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const needsTranslator = !targetLang.startsWith('en')

  async function refresh() {
    const LM = globalThis.LanguageModel
    if (!LM) { setStatus('unsupported'); return }
    try {
      const lm = await LM.availability({ expectedOutputs: [{ type: 'text', languages: ['en'] }] })
      if (lm === 'unavailable') { setStatus('unsupported'); return }

      let tr: AIAvailability = 'available'
      if (needsTranslator) {
        tr = globalThis.Translator
          ? await globalThis.Translator.availability({ sourceLanguage: 'en', targetLanguage: targetLang })
          : 'unavailable'
      }
      if (tr === 'unavailable') { setStatus('unsupported'); return }

      if (lm === 'available' && tr === 'available') setStatus('available')
      else if (lm === 'downloading' || tr === 'downloading') setStatus('downloading')
      else setStatus('downloadable')
    } catch {
      setStatus('unsupported')
    }
  }

  useEffect(() => { void refresh() }, [targetLang])

  async function enable() {
    const LM = globalThis.LanguageModel
    if (!LM) return
    setBusy(true)
    setError('')
    setProgress(0)
    setStatus('downloading')
    const onProgress = (m: AICreateMonitor) =>
      m.addEventListener('downloadprogress', e => setProgress(Math.round(e.loaded * 100)))
    try {
      const session = await LM.create({
        monitor: onProgress,
        expectedOutputs: [{ type: 'text', languages: ['en'] }]
      })
      session.destroy()
      if (needsTranslator && globalThis.Translator) {
        const t = await globalThis.Translator.create({
          sourceLanguage: 'en',
          targetLanguage: targetLang,
          monitor: onProgress,
        })
        t.destroy()
      }
      onModelDownloaded?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  return (
    <div style={aiStyles.box}>
      <div style={aiStyles.title}>On-device AI · context-aware word translation</div>
      <p style={aiStyles.desc}>
        Uses Chrome's built-in Gemini Nano to translate saved words by their meaning
        in the sentence (e.g. "bank" in "river bank"). Runs locally, no account.
        Without it, saving falls back to a list of dictionary senses to pick from.
      </p>

      {status === 'checking' && <div style={aiStyles.status}>Checking availability…</div>}

      {status === 'available' && (
        <div style={{ ...aiStyles.status, color: '#6bff9e' }}>✓ Ready — saved words use context-aware translation.</div>
      )}

      {status === 'unsupported' && (
        <div style={aiStyles.status}>
          Not available in this browser. Requires Chrome 138+ with built-in AI support
          {needsTranslator ? ` and an EN→${targetLang} on-device translator` : ''}. Saving uses the dictionary-senses fallback.
        </div>
      )}

      {status === 'downloadable' && (
        <button style={aiStyles.btn} disabled={busy} onClick={enable}>
          ⬇ Enable on-device AI (one-time model download)
        </button>
      )}

      {status === 'downloading' && (
        <div>
          <div style={aiStyles.status}>Downloading model… {progress}%</div>
          <div style={aiStyles.progressTrack}>
            <div style={{ ...aiStyles.progressBar, width: `${progress}%` }} />
          </div>
        </div>
      )}

      {error && <div style={{ ...aiStyles.status, color: '#ff8888' }}>{error}</div>}
    </div>
  )
}

const aiStyles: Record<string, React.CSSProperties> = {
  box: {
    background: '#0f0f1a',
    border: '1px solid #2a2a4a',
    borderRadius: 8,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  title: { fontSize: 13, fontWeight: 600, color: '#c0c0e0' },
  desc: { fontSize: 12, color: '#8888aa', margin: 0, lineHeight: 1.5 },
  status: { fontSize: 12, color: '#8888aa' },
  btn: {
    alignSelf: 'flex-start',
    background: '#2a2a4a',
    border: '1px solid #3a3a6a',
    color: '#c0c0e0',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
  progressTrack: {
    marginTop: 6,
    height: 6,
    background: '#1a1a2e',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    background: '#4f6ef7',
    transition: 'width 0.2s',
  },
}

function SortableDeckItem({
  color,
  label,
  onLabelChange,
}: {
  color: BookmarkColor
  label: string
  onLabelChange: (name: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: color })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 8,
    background: isDragging ? '#2a2a4a' : '#0f0f1a',
    border: isDragging ? '1px solid #6b8aff' : '1px solid #2a2a4a',
    boxShadow: isDragging ? '0 8px 20px rgba(0,0,0,0.5)' : 'none',
    zIndex: isDragging ? 10 : undefined,
    position: 'relative',
  }

  return (
    <div ref={setNodeRef} style={style}>
      <span
        {...attributes}
        {...listeners}
        style={itemStyles.handle}
        title="Drag to reorder"
        aria-label={`Drag to reorder ${color} deck`}
      >
        ⠿
      </span>
      <span style={{ ...itemStyles.swatch, background: BOOKMARK_COLORS[color] }} />
      <input
        type="text"
        value={label}
        placeholder={color}
        onChange={e => onLabelChange(e.target.value)}
        style={itemStyles.input}
      />
    </div>
  )
}

const itemStyles: Record<string, React.CSSProperties> = {
  handle: {
    color: '#5a5a8a',
    fontSize: 18,
    cursor: 'grab',
    userSelect: 'none',
    flexShrink: 0,
    lineHeight: 1,
    touchAction: 'none',
  },
  swatch: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    flexShrink: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: 'none',
    color: '#e0e0e0',
    padding: '2px 0',
    fontSize: 13,
    outline: 'none',
  },
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const contentId = useId()

  return (
    <section style={styles.section}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        style={collapsibleStyles.header}
      >
        <span style={styles.sectionTitle}>{title}</span>
        <span
          aria-hidden="true"
          style={{
            ...collapsibleStyles.chevron,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▶
        </span>
      </button>
      {open && (
        <div id={contentId} style={collapsibleStyles.content}>
          {children}
        </div>
      )}
    </section>
  )
}

const collapsibleStyles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    textAlign: 'left',
  },
  chevron: {
    color: '#8a8ab0',
    fontSize: 12,
    flexShrink: 0,
    transition: 'transform 0.2s ease',
    marginBottom: 4,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={fieldStyles.row}>
      <label style={fieldStyles.label}>{label}</label>
      <div style={fieldStyles.control}>{children}</div>
    </div>
  )
}

const ROAST_INTENSITIES: { value: RoastIntensity; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'gentle', label: 'Gentle' },
  { value: 'playful', label: 'Playful' },
  { value: 'savage', label: 'Savage' },
]

const ROAST_INTENSITY_HINT: Record<RoastIntensity, string> = {
  off: 'No roasting — the slacking banner and reminders stay hidden.',
  gentle: 'Soft, encouraging nudges to get you back on track.',
  playful: 'Cheeky teasing when you slack off (the friendly default).',
  savage: 'Over-the-top, dramatic tough love. You asked for it.',
}

const LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['vi', 'Vietnamese'],
  ['zh', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['fr', 'French'],
  ['de', 'German'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['ru', 'Russian'],
  ['ar', 'Arabic'],
  ['hi', 'Hindi'],
  ['th', 'Thai'],
  ['id', 'Indonesian'],
]

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 32, maxWidth: 600, margin: '0 auto' },
  section: {
    background: '#111122',
    borderRadius: 16,
    padding: '20px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    border: '1px solid #3a3a6a',
    boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
  },
  sectionTitle: { fontSize: 15, fontWeight: 600, color: '#c0c0e0', marginBottom: 4 },
  range: { width: '100%', accentColor: '#4f6ef7' },
  testBtn: {
    background: 'transparent',
    border: '1px solid #3a3a6a',
    color: '#8888cc',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  testBtnActive: {
    border: '1px solid #6a3a3a',
    color: '#ff8888',
  },
  select: {
    width: '100%',
    background: '#0f0f1a',
    border: '1px solid #2a2a4a',
    borderRadius: 6,
    color: '#e0e0e0',
    padding: '7px 10px',
    fontSize: 13,
  },
  deckList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
}

const fieldStyles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, color: '#8888aa' },
  control: {},
}
