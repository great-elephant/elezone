// Colors StudyUI uses. The dashboard renders StudyUI without a theme, which
// selects STUDY_DARK (the colors StudyUI always had); the side panel passes a
// palette that follows the OS color scheme.
export interface StudyTheme {
  scheme: 'dark' | 'light'
  pageBg: string
  card: string
  inset: string
  border: string
  borderSoft: string
  text: string
  strong: string
  muted: string
  btnBg: string
  btnText: string
  primary: string
  primaryText: string
  choiceBg: string
  choiceText: string
  correctBg: string
  correctText: string
  wrongBg: string
  wrongText: string
  cloze: string
  warn: string
  error: string
  link: string
  grade: { again: [string, string]; hard: [string, string]; good: [string, string]; easy: [string, string] }
  reward: [string, string, string, string] // combo <2, >=2, >=4, >=6
  summaryBg: string
  summaryBorder: string
  ringTrack: string
  summaryShadow: string
  rewardShadow: string
  pillBg: string
  rank: { done: string; perfect: string; great: string; nice: string; keep: string }
  pill: { correct: string; streak: string; sparks: string }
}

export const STUDY_DARK: StudyTheme = {
  scheme: 'dark',
  pageBg: '#0f0f1a',
  card: '#1a1a2e',
  inset: '#111122',
  border: '#3a3a5a',
  borderSoft: '#2a2a4a',
  text: '#e0e0e0',
  strong: '#ffffff',
  muted: '#8888aa',
  btnBg: '#3a3a5a',
  btnText: '#ffffff',
  primary: '#4a5a9a',
  primaryText: '#ffffff',
  choiceBg: '#2a2a4a',
  choiceText: '#ffffff',
  correctBg: '#6bff9e',
  correctText: '#112211',
  wrongBg: '#ff6b6b',
  wrongText: '#ffffff',
  cloze: '#6bcfff',
  warn: '#ffb36b',
  error: '#ff6b6b',
  link: '#8888cc',
  grade: {
    again: ['#5a2a2a', '#ff8080'],
    hard: ['#5a4420', '#ffb36b'],
    good: ['#22406b', '#6bcfff'],
    easy: ['#1f4a30', '#6bff9e'],
  },
  reward: ['#4ade80', '#facc15', '#ff9d3d', '#ff5a36'],
  summaryBg: 'linear-gradient(135deg, #1e1e32 0%, #111122 100%)',
  summaryBorder: '#3a3a6a',
  ringTrack: '#161b22',
  summaryShadow: '0 12px 40px rgba(0,0,0,0.4)',
  rewardShadow: '0 1px 6px rgba(0,0,0,0.6)',
  pillBg: '#1a1a2e',
  rank: { done: '#6bcfff', perfect: '#ffd93d', great: '#4ade80', nice: '#6bcfff', keep: '#ffb36b' },
  pill: { correct: '#6bff9e', streak: '#ffb36b', sparks: '#ffd93d' },
}

export const STUDY_LIGHT: StudyTheme = {
  scheme: 'light',
  pageBg: '#f4f5fb',
  card: '#ffffff',
  inset: '#eceef8',
  border: '#9ea5c8',
  borderSoft: '#d3d7ea',
  text: '#1f2233',
  strong: '#0b0d1a',
  muted: '#555a7c',
  btnBg: '#4a5a9a',
  btnText: '#ffffff',
  primary: '#3f4f8f',
  primaryText: '#ffffff',
  choiceBg: '#e3e6f5',
  choiceText: '#1f2233',
  correctBg: '#a8efc2',
  correctText: '#0b2b16',
  wrongBg: '#c62828',
  wrongText: '#ffffff',
  cloze: '#0b62a0',
  warn: '#8f4600',
  error: '#b42318',
  link: '#3f4f8f',
  grade: {
    again: ['#fde4e4', '#9b1c1c'],
    hard: ['#fdebd0', '#80420a'],
    good: ['#dbeafe', '#1e40af'],
    easy: ['#d9f5e3', '#14532d'],
  },
  reward: ['#15803d', '#8a6500', '#b45309', '#c2410c'],
  summaryBg: 'linear-gradient(135deg, #ffffff 0%, #eceef8 100%)',
  summaryBorder: '#b9bfdc',
  ringTrack: '#d3d7ea',
  summaryShadow: '0 4px 12px rgba(31,34,51,0.10)',
  rewardShadow: 'none',
  pillBg: '#ffffff',
  rank: { done: '#0b62a0', perfect: '#8a6500', great: '#15803d', nice: '#0b62a0', keep: '#8f4600' },
  pill: { correct: '#15803d', streak: '#8f4600', sparks: '#8a6500' },
}
