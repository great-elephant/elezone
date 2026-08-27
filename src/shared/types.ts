import type { RoastIntensity } from './roasts'

export type BookmarkColor =
  | 'red' | 'yellow' | 'cyan' | 'green' | 'blue'
  | 'orange' | 'purple' | 'pink' | 'teal' | 'gray'

export type StudyMode = 'passive' | 'typing' | 'listening' | 'multiple_choice'

export interface DailyActivity {
  saved: number
  reviewed: number
  points: number
}

export type ActivityLog = Record<string, DailyActivity>

export interface SavedItem {
  id: string
  url: string
  text: string          // The word or paragraph
  prefix: string        // For anchoring
  suffix: string        // For anchoring
  occurrenceIndex: number // For anchoring
  color: BookmarkColor  // Used for semantics/filtering
  createdAt: number
  updatedAt?: number
  orphaned: boolean
  deleted?: boolean
  sourceLang?: string

  // Optional Dictionary fields
  phonetics?: string
  translation?: string

  // SRS fields
  nextReview?: number
  interval?: number
  ease?: number
  repetitions?: number

  // Video context (optional, only present when saved from a video subtitle)
  videoTimestamp?: number  // seconds into the video when the word appeared
  sourceContext?: string   // the full subtitle sentence containing the word
  // Where to go back to. Stored without a timestamp so a review screen can
  // append one in whatever form the platform wants ("&t=93s" on YouTube). Only
  // written for platforms that have a stable permalink — a Netflix watch URL
  // needs the right profile and can point at a title that has left the library,
  // so a dead link is worse than none.
  sourceUrl?: string
  sourceTitle?: string     // video / episode name, for showing the link
}

export interface ReadAloudSettings {
  speed: number
  repetition: number
  pageRepetition?: number
  voice: string
  languageVoices?: Record<string, string> // Maps language code to voiceName
  pitch: number
  volume: number
  // H29 — shadowing mode: insert an intentional silent gap between sentences so
  // the learner can repeat aloud. Persisted so the choice sticks across sessions.
  shadowing?: boolean
  // Only meaningful when `shadowing` is on. false/undefined (default): the old
  // behaviour — stop and repeat each CLAUSE (split at commas/other shadowing
  // stops) `repetition` times before moving to the next one. true: still stop
  // at every clause to shadow, but don't repeat there — only once the whole
  // original sentence has been read does it start repeating, and it repeats
  // the FULL sentence (not just the last clause) `repetition` times.
  repeatWholeSentence?: boolean
  // H32 — focus/spotlight mode: dim the rest of the page and highlight the current
  // sentence. Persisted so the choice sticks across sessions.
  focus?: boolean
  // IPA phonetics badge under the word currently being spoken (English pages
  // only). Persisted so the choice sticks across sessions.
  showPhonetics?: boolean
}

// Where a saved word's phonetic transcription comes from. 'dictionaryapi' is a
// real dictionary IPA lookup (Free Dictionary API, wraps Wiktionary);
// 'google-rm' reuses Google Translate's `dt=rm` romanization field — built for
// transliterating non-Latin scripts, not true IPA, but kept as an optional
// fallback since it covers words/phrases dictionaryapi.dev doesn't have.
export type PhoneticsSource = 'dictionaryapi' | 'google-rm'

export interface PhoneticsSourceSetting {
  source: PhoneticsSource
  enabled: boolean
}

export interface TranslationSettings {
  defaultTargetLanguage: string
  /**
   * The language being studied — the one subtitles, lookups and Read Aloud are
   * expected to be in. Everything before Video Mode simply assumed English,
   * which held on Netflix because the learner chose the film. It does not hold
   * on YouTube, where most of what turns up is in the learner's own language;
   * without this, Video Mode would light up on a Vietnamese vlog and offer to
   * "translate" it into Vietnamese.
   */
  learningLanguage?: string
  enabled: boolean
  mode: 'paragraph' | 'sentence'
  asideForceGoogle?: boolean   // translation overlay uses Google by default (skip on-device)
  disableAI?: boolean
  disableGoogleContext?: boolean
  disableGoogleSenses?: boolean
  // Order and on/off state of phonetic-transcription sources, tried in array
  // order — first enabled source that returns a result wins. Undefined/empty
  // falls back to DEFAULT_SETTINGS.translation.phoneticsSourceOrder.
  phoneticsSourceOrder?: PhoneticsSourceSetting[]
}

export type ReadAloudState = 'idle' | 'playing' | 'paused'

// A chrome.tts voice as surfaced to content scripts via GET_TTS_VOICES.
export interface TtsVoiceInfo {
  voiceName: string
  lang: string
  remote: boolean
}

export interface GamificationSettings {
  dailyGoalPoints: number
  pointsPerSave: number
  pointsPerReview: number
  // Controls the tone/harshness of the slacking "roast" messages.
  // 'off' fully suppresses the roast banner and notifications.
  // Undefined is treated as the default (see DEFAULT_SETTINGS), not as 'off'.
  roastIntensity?: RoastIntensity
}

export interface OcrSettings {
  sentenceCase: boolean
  removeExtraSpaces: boolean
  language?: string
}

/**
 * What happens when a subtitle line finishes. These three are mutually
 * exclusive — pausing to wait for a keypress and pausing for a timed shadowing
 * gap are two answers to the same question, so they are one setting, not two
 * toggles that could both be on.
 */
export type EndOfLinePause = 'off' | 'manual' | 'shadowing'

export type VideoTranslationSource = 'auto' | 'machine'

export interface VideoModeSettings {
  enabled: boolean

  showTranslation: boolean
  endOfLinePause: EndOfLinePause
  pauseOnSavedWord: boolean
  sidebarVisible: boolean
  repeat: number               // times each line plays, 1 = no repeat
  // Auto-fetched IPA under every English word of the line being spoken (not the
  // sidebar transcript). Off by default: unlike the other toggles this fires a
  // lookup per word with no click, so a viewer who never wanted it shouldn't pay
  // for it silently.
  phoneticsUnderWords: boolean

  // ── Advanced ──
  hideSoundEffects: boolean    // drop "[door opens]" style cues
  subtitleFontSize: number     // px
  translationSource: VideoTranslationSource
  shadowGapFactor: number      // gap = cue duration × this
  keyboardShortcuts: boolean

  /**
   * Where the learner dragged the subtitle overlay to, as a percentage of the
   * player box — percentages rather than pixels so it survives a resize, going
   * fullscreen, and a different screen tomorrow. Null means the default spot.
   *
   * `xPct` is the box's centre, so it stays put when the width changes. `yPct`
   * is the gap between the bottom of the player and the bottom of the box:
   * the box is anchored by its lower edge and grows upward, so a long line
   * never pushes the dialogue down over the picture it belongs to.
   *
   * Only used where the strip floats over the picture (YouTube). On Netflix it
   * is a band below a shrunken player and has nowhere to go.
   */
  stripPosition?: { xPct: number; yPct: number } | null
  /** Width of that overlay as a percentage of the player. */
  stripWidthPct?: number
}

export interface RoastSettings {
  enabled: boolean
  noNewItemsDaysThreshold: number
}

export interface TodoTask {
  id: string;
  text: string;
  createdAt: number;
  timeSpentSeconds?: number;
  completedAt?: number;
  actualStartTime?: number;
}

export interface PomodoroSettings {
  focusTime: number; // minutes
  shortBreakTime: number; // minutes
  longBreakTime: number; // minutes
  longBreakInterval: number; // after how many focus sessions
  inhale: number; // seconds
  hold1: number; // seconds
  exhale: number; // seconds
  hold2: number; // seconds
  breathingEnabled?: boolean; // whether to show/play the breathing circle and audio
  volume?: number; // volume for breathing and success sound
  autoStartPomodoro?: boolean;
  autoStartBreak?: boolean;
}


export interface Settings {
  /**
   * Newest of the per-section clocks below, excluding `sync`. Kept only so a
   * device still running a build that compares one flat timestamp reads a sane
   * value out of the shared file; nothing in this build merges on it.
   */
  updatedAt?: number
  /**
   * When each section last actually changed, so sync can merge section by
   * section instead of picking one whole settings document over the other.
   * Absent on data written before per-section sync existed — readers seed it
   * from `updatedAt`.
   */
  sectionUpdatedAt?: Partial<Record<SettingsSection, number>>
  defaultStudyMode?: StudyMode
  showHintInitially?: boolean
  // Show a floating "Save" chip near the selection to save a word (default enabled).
  selectionChipEnabled?: boolean
  readAloud: ReadAloudSettings
  translation: TranslationSettings
  sync: { enabled: boolean; debounceSeconds: number }
  gamification: GamificationSettings
  ocr: OcrSettings
  // User-given names for each bookmark color, turning colors into named decks.
  deckLabels?: Partial<Record<BookmarkColor, string>>
  // User-defined display order for deck colors (persisted as an array of BookmarkColor).
  deckOrder?: BookmarkColor[]

  srsNotifications?: {
    enabled: boolean;
    intervalMinutes: number;
    activeHoursStart: number;
    activeHoursEnd: number;
  }
  roast?: RoastSettings
  pomodoro?: PomodoroSettings
  tasks?: TodoTask[]
  doneTasks?: TodoTask[]
  dailyTasks?: TodoTask[]
  videoMode?: VideoModeSettings
  // Deck colour the learner last saved with, reused as the default next time.
  lastBookmarkColor?: BookmarkColor
}

/**
 * One independently synced slice of the settings: every top-level field except
 * the clocks themselves. Sync compares and merges one section at a time, so a
 * change to the reading voice on one machine can no longer discard a change to
 * the translation language made on another.
 */
export type SettingsSection = Exclude<keyof Settings, 'updatedAt' | 'sectionUpdatedAt'>

/**
 * Spelled out as a Record rather than an array so the compiler rejects this the
 * moment a field is added to Settings without deciding how it syncs — a section
 * missing here would silently never be compared, and so never travel between
 * machines.
 */
const SETTINGS_SECTION_KEYS: Record<SettingsSection, true> = {
  defaultStudyMode: true,
  showHintInitially: true,
  selectionChipEnabled: true,
  readAloud: true,
  translation: true,
  sync: true,
  gamification: true,
  ocr: true,
  deckLabels: true,
  deckOrder: true,
  srsNotifications: true,
  roast: true,
  pomodoro: true,
  tasks: true,
  doneTasks: true,
  dailyTasks: true,
  videoMode: true,
  lastBookmarkColor: true,
}

export const SETTINGS_SECTIONS = Object.keys(SETTINGS_SECTION_KEYS) as SettingsSection[]

export const DEFAULT_VIDEO_MODE_SETTINGS: VideoModeSettings = {
  enabled: true,
  showTranslation: true,
  endOfLinePause: 'off',
  pauseOnSavedWord: false,
  sidebarVisible: true,
  repeat: 1,
  phoneticsUnderWords: false,
  hideSoundEffects: true,
  subtitleFontSize: 28,
  translationSource: 'auto',
  shadowGapFactor: 1,
  keyboardShortcuts: true,
  stripPosition: null,
  stripWidthPct: 90,
}

/**
 * Merge stored Video Mode settings over the defaults, dropping fields from
 * older shapes.
 *
 * Settings saved while the preset system existed can carry
 * `showTranslation: false` — the old "Listening practice" preset turned it off.
 * With presets gone there is no longer any way to tell that was deliberate, and
 * a missing translation line reads as a bug, so that era's value is discarded.
 */
export function normaliseVideoModeSettings(
  stored: (Partial<VideoModeSettings> & { preset?: string; maxLineChars?: number }) | undefined,
): VideoModeSettings {
  const raw = { ...(stored ?? {}) } as Record<string, unknown>
  const fromPresetEra = 'preset' in raw
  delete raw.preset
  delete raw.maxLineChars

  const merged: VideoModeSettings = { ...DEFAULT_VIDEO_MODE_SETTINGS, ...(raw as Partial<VideoModeSettings>) }
  if (fromPresetEra) merged.showTranslation = DEFAULT_VIDEO_MODE_SETTINGS.showTranslation

  // A stored position from a narrower window, or simply corrupt, would put the
  // overlay somewhere it cannot be dragged back from.
  const pos = merged.stripPosition
  const sane = (n: unknown) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100
  merged.stripPosition = pos && sane(pos.xPct) && sane(pos.yPct) ? pos : null

  // A width below this is too narrow to read a sentence in, and one above 100
  // would hang off the picture.
  const width = merged.stripWidthPct
  merged.stripWidthPct = typeof width === 'number' && isFinite(width)
    ? Math.min(100, Math.max(25, width))
    : DEFAULT_VIDEO_MODE_SETTINGS.stripWidthPct

  return merged
}

export const DEFAULT_SETTINGS: Settings = {
  defaultStudyMode: 'listening',
  showHintInitially: false,
  selectionChipEnabled: true,
  readAloud: {
    speed: 1,
    repetition: 1,
    pageRepetition: 1,
    voice: '',
    pitch: 1,
    volume: 1,
    focus: false,
    showPhonetics: false,
  },
  translation: {
    defaultTargetLanguage: 'vi',
    learningLanguage: 'en',
    enabled: true,
    mode: 'paragraph',
    disableAI: true,
    phoneticsSourceOrder: [
      { source: 'dictionaryapi', enabled: true },
      { source: 'google-rm', enabled: true },
    ],
  },
  sync: {
    enabled: false,
    debounceSeconds: 30
  },
  gamification: {
    dailyGoalPoints: 100,
    pointsPerSave: 1,
    pointsPerReview: 2,
    roastIntensity: 'playful'
  },
  ocr: {
    sentenceCase: false,
    removeExtraSpaces: true,
    language: 'eng'
  },
  deckLabels: {},
  srsNotifications: {
    enabled: true,
    intervalMinutes: 15,
    activeHoursStart: 8,
    activeHoursEnd: 22
  },
  roast: {
    enabled: true,
    noNewItemsDaysThreshold: 3
  },
  pomodoro: {
    focusTime: 25,
    shortBreakTime: 5,
    longBreakTime: 15,
    longBreakInterval: 4,
    inhale: 8,
    hold1: 4,
    exhale: 8,
    hold2: 4,
    breathingEnabled: true,
    volume: 1,
    autoStartPomodoro: false,
    autoStartBreak: false
  },
  tasks: [],
  doneTasks: [],
  dailyTasks: []
}

export const BOOKMARK_COLORS: Record<BookmarkColor, string> = {
  red: '#ff6b6b',
  yellow: '#ffd93d',
  cyan: '#6bcfff',
  green: '#6bff9e',
  blue: '#6b9eff',
  orange: '#ffb36b',
  purple: '#c06bff',
  pink: '#ff6bc0',
  teal: '#6bffd9',
  gray: '#c0c0c0',
}

export type MessageType =
  | 'SAVE_ITEM'
  | 'GET_ITEMS'
  | 'TOGGLE_VIDEO_MODE'
  | 'APPLY_VIDEO_MODE_SETTINGS'
  | 'SAVE_VIDEO_MODE_SETTINGS'
  | 'SAVE_LAST_BOOKMARK_COLOR'
  | 'GET_VIDEO_MODE_STATE'
  | 'DELETE_ITEM'
  | 'UPDATE_ITEM'
  | 'SYNC_ITEMS'
  | 'GET_SETTINGS'
  | 'SAVE_SETTINGS'
  | 'REANCHOR'
  | 'MARK_ORPHANED'
  | 'START_READ_ALOUD'
  | 'STOP_READ_ALOUD'
  | 'READ_ALOUD_STATE'
  | 'GET_READ_ALOUD_STATE'
  | 'START_READ_ALOUD_SESSION'
  | 'CONTROL_READ_ALOUD'
  | 'GET_TTS_VOICES'
  | 'SPEAK_TEXT'
  | 'READ_ALOUD_UPDATE'
  | 'READ_ALOUD_WORD'
  | 'TOGGLE_TRANSLATION'
  | 'TRANSLATE_IN_CONTEXT'
  | 'FETCH_PHONETICS'
  | 'GET_TRANSLATION_API_AVAILABLE'
  | 'GET_TRANSLATOR_STATUS'
  | 'SHOW_DICTIONARY_POPOVER'
  | 'GET_SELECTION_CONTEXT'
  | 'START_READ_ALOUD_FROM'
  | 'HIGHLIGHT_BOOKMARK'
  | 'TEST_NOTIFICATION'
  | 'TEST_ROAST_NOTIFICATION'
  | 'POMODORO_COMMAND'
  | 'GET_POMODORO_STATE'
  | 'POMODORO_STATE_UPDATE'
  | 'START_OCR'
  | 'OCR_WINDOW_PROGRESS'
  | 'OCR_WINDOW_RESULT'
  | 'FORWARD_RECOGNIZE_TEXT'
  | 'RECOGNIZE_TEXT'
  | 'OCR_PROGRESS'

export interface Message {
  type: MessageType
  payload?: unknown
}

export type PomodoroPhase = 'idle' | 'focus' | 'shortBreak' | 'longBreak';
export type PomodoroStatus = 'stopped' | 'running' | 'paused';

export interface PomodoroState {
  phase: PomodoroPhase;
  status: PomodoroStatus;
  timeRemaining: number;
  completedFocusSessions: number;
  breathStartTime?: number;
  activeTaskId?: string | null;
}

