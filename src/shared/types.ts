export type BookmarkColor =
  | 'red' | 'yellow' | 'cyan' | 'green' | 'blue'
  | 'orange' | 'purple' | 'pink' | 'teal' | 'gray'

export interface Bookmark {
  id: string
  url: string
  text: string
  prefix: string
  suffix: string
  occurrenceIndex: number
  color: BookmarkColor
  createdAt: number
  orphaned: boolean
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
}

export interface Settings {
  readAloud: ReadAloudSettings
  translation: TranslationSettings
}

export const DEFAULT_SETTINGS: Settings = {
  readAloud: {
    speed: 1,
    repetition: 1,
    voice: '',
    pitch: 1,
    volume: 1,
  },
  translation: {
    defaultTargetLanguage: 'en',
    enabled: false,
  },
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
  | 'SAVE_BOOKMARK'
  | 'GET_BOOKMARKS'
  | 'DELETE_BOOKMARK'
  | 'GET_SETTINGS'
  | 'SAVE_SETTINGS'
  | 'REANCHOR'
  | 'START_READ_ALOUD'
  | 'STOP_READ_ALOUD'
  | 'TOGGLE_TRANSLATION'
  | 'GET_TRANSLATION_API_AVAILABLE'

export interface Message {
  type: MessageType
  payload?: unknown
}
