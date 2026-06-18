export type BookmarkColor =
  | 'red' | 'yellow' | 'cyan' | 'green' | 'blue'
  | 'orange' | 'purple' | 'pink' | 'teal' | 'gray'

export type StudyMode = 'passive' | 'typing' | 'speaking' | 'listening' | 'multiple_choice'

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

  // Optional SRS/Dictionary fields
  phonetics?: string
  translation?: string
  nextReview?: number
  interval?: number
  ease?: number
  repetitions?: number
}

export interface ReadAloudSettings {
  speed: number
  repetition: number
  voice: string
  pitch: number
  volume: number
}

export interface TranslationSettings {
  defaultTargetLanguage: string
  enabled: boolean
  mode: 'paragraph' | 'sentence'
}

export type ReadAloudState = 'idle' | 'playing' | 'paused'

export interface SrsSettings {
  initialInterval: number
  secondInterval: number
  easeMultiplier: number
}

export interface GamificationSettings {
  dailyGoalPoints: number
  pointsPerSave: number
  pointsPerReview: number
}

export interface Settings {
  updatedAt?: number
  showHintInitially?: boolean
  readAloud: ReadAloudSettings
  translation: TranslationSettings
  srs: SrsSettings
  sync: { enabled: boolean; debounceSeconds: number }
  gamification: GamificationSettings
}

export const DEFAULT_SETTINGS: Settings = {
  showHintInitially: false,
  readAloud: {
    speed: 1,
    repetition: 1,
    voice: '',
    pitch: 1,
    volume: 1,
  },
  translation: {
    defaultTargetLanguage: 'vi',
    enabled: false,
    mode: 'paragraph',
  },
  srs: {
    initialInterval: 1,
    secondInterval: 6,
    easeMultiplier: 2.5,
  },
  sync: {
    enabled: false,
    debounceSeconds: 30
  },
  gamification: {
    dailyGoalPoints: 100,
    pointsPerSave: 1,
    pointsPerReview: 2
  }
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
  | 'DELETE_ITEM'
  | 'UPDATE_ITEM'
  | 'REVIEW_ITEM'
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
  | 'READ_ALOUD_UPDATE'
  | 'TOGGLE_TRANSLATION'
  | 'GET_TRANSLATION_API_AVAILABLE'
  | 'SHOW_DICTIONARY_POPOVER'
  | 'GET_SELECTION_CONTEXT'
  | 'START_READ_ALOUD_FROM'
  | 'HIGHLIGHT_BOOKMARK'

export interface Message {
  type: MessageType
  payload?: unknown
}
