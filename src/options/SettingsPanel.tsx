import { useEffect, useState } from 'react'
import { Settings, BookmarkColor, BOOKMARK_COLORS } from '../shared/types'
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

const TEST_TEXT = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.'
type TtsVoice = chrome.tts.TtsVoice

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
}

export default function SettingsPanel({ settings, onChange }: Props) {
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [testing, setTesting] = useState(false)
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

  function testVoice() {
    chrome.tts.stop()
    if (testing) {
      setTesting(false)
      return
    }

    setTesting(true)
    chrome.tts.speak(TEST_TEXT, {
      onEvent: event => {
        if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
          setTesting(false)
        }
      },
      pitch: settings.readAloud.pitch,
      rate: settings.readAloud.speed,
      voiceName: settings.readAloud.voice || undefined,
      volume: settings.readAloud.volume,
    }, () => {
      if (chrome.runtime.lastError) {
        setTesting(false)
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

  return (
    <div style={styles.root}>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Cloud Sync</h2>

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
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Study Session</h2>

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
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Notifications</h2>

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
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Decks</h2>
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
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Read Aloud</h2>

        <Field label={`Speed: ${ra.speed.toFixed(1)}×`}>
          <input type="range" min={0.5} max={3} step={0.1} value={ra.speed}
            style={styles.range}
            onChange={e => set('readAloud', 'speed', parseFloat(e.target.value))} />
        </Field>

        <Field label={`Repeat each sentence: ${ra.repetition}×`}>
          <input type="range" min={1} max={5} step={1} value={ra.repetition}
            style={styles.range}
            onChange={e => set('readAloud', 'repetition', parseInt(e.target.value))} />
        </Field>

        <Field label="Voice">
          <select
            style={styles.select}
            value={ra.voice}
            onChange={e => set('readAloud', 'voice', e.target.value)}
          >
            <option value="">System default</option>
            {voices.map(v => (
              <option key={v.voiceName} value={v.voiceName}>{v.voiceName} ({v.lang})</option>
            ))}
          </select>
        </Field>

        <div style={styles.voiceTest}>
          <p style={styles.testText}>{TEST_TEXT}</p>
          <button style={{ ...styles.testBtn, ...(testing ? styles.testBtnActive : {}) }} onClick={testVoice}>
            {testing ? '⏹ Stop' : '▶ Test voice'}
          </button>
        </div>

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
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Translation</h2>

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
          <span style={{ fontSize: 12, color: '#556688' }}>
            🌐 Google · plain translate is always the last resort
          </span>
        </div>

        <OnDeviceAi targetLang={tr.defaultTargetLanguage} onStatusChange={setAiStatus} onModelDownloaded={() => set('translation', 'disableAI', false)} />
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>OCR</h2>

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
      </section>


      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Tough Love</h2>
        <p style={{ fontSize: 13, color: '#ff6b6b', margin: '0 0 12px' }}>
          * This feature is mandatory and cannot be disabled. We warned you😈!!!
        </p>

        <Field label="Enable Roasting">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={true}
              disabled={true}
              onChange={() => { }}
              style={{ width: 18, height: 18, accentColor: '#ff4444', opacity: 0.6, cursor: 'not-allowed' }}
            />
            <span style={{ fontSize: 13, color: '#aaaaaa' }}>
              Scold me if I start slacking off on my learning
            </span>
          </div>
        </Field>

        <Field label={`Days without reaching goal: ${settings.roast?.noNewItemsDaysThreshold ?? 3} days`}>
          <input
            type="range" min={1} max={30} step={1}
            value={settings.roast?.noNewItemsDaysThreshold ?? 3}
            disabled={true}
            style={{ ...styles.range, opacity: 0.6, cursor: 'not-allowed' }}
            onChange={() => { }}
          />
        </Field>

        {/* <button
          style={{ ...styles.testBtn, marginTop: 8, alignSelf: 'flex-start' }}
          onClick={() => chrome.runtime.sendMessage({ type: 'TEST_ROAST_NOTIFICATION' })}
        >
          🚨 Test Roast Notification
        </button> */}
      </section>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={fieldStyles.row}>
      <label style={fieldStyles.label}>{label}</label>
      <div style={fieldStyles.control}>{children}</div>
    </div>
  )
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
  voiceTest: {
    background: '#0f0f1a',
    border: '1px solid #2a2a4a',
    borderRadius: 8,
    padding: '10px 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  testText: {
    flex: 1,
    fontSize: 13,
    color: '#6688aa',
    fontStyle: 'italic',
    lineHeight: 1.5,
  },
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
