import { useEffect, useState } from 'react'
import { Settings } from '../shared/types'

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
}

export default function SettingsPanel({ settings, onChange }: Props) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])

  useEffect(() => {
    function loadVoices() {
      const v = speechSynthesis.getVoices()
      if (v.length) setVoices(v)
    }
    loadVoices()
    speechSynthesis.addEventListener('voiceschanged', loadVoices)
    return () => speechSynthesis.removeEventListener('voiceschanged', loadVoices)
  }, [])

  function set<K extends keyof Settings>(section: K, key: keyof Settings[K], value: unknown) {
    onChange({
      ...settings,
      [section]: { ...settings[section], [key]: value },
    })
  }

  const ra = settings.readAloud
  const tr = settings.translation

  return (
    <div style={styles.root}>
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
              <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
            ))}
          </select>
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
      </section>
    </div>
  )
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
  root: { display: 'flex', flexDirection: 'column', gap: 32, maxWidth: 540 },
  section: {
    background: '#1a1a2e',
    borderRadius: 10,
    padding: '20px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  sectionTitle: { fontSize: 15, fontWeight: 600, color: '#c0c0e0', marginBottom: 4 },
  range: { width: '100%', accentColor: '#4f6ef7' },
  select: {
    width: '100%',
    background: '#0f0f1a',
    border: '1px solid #2a2a4a',
    borderRadius: 6,
    color: '#e0e0e0',
    padding: '7px 10px',
    fontSize: 13,
  },
}

const fieldStyles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, color: '#8888aa' },
  control: {},
}
