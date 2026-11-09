import type { StudyMode } from './types'

export const STUDY_MODES: { value: StudyMode; label: string }[] = [
  { value: 'passive', label: 'Passive Flashcard' },
  { value: 'typing', label: 'Typing (Active Recall)' },
  { value: 'listening', label: 'Listening (Dictation)' },
  { value: 'multiple_choice', label: 'Multiple Choice' },
]
