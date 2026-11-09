import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOneOffTracker } from '../src/background/oneOffSpeech.ts'

type S = { token: number, state: 'playing' | 'paused' }

function setup(initial: S | null = { token: 1, state: 'playing' }) {
  let session: S | null = initial
  const log: string[] = []
  const t = createOneOffTracker({
    getSession: () => session,
    pauseSession: () => { if (session) session.state = 'paused'; log.push('pause') },
    resumeSession: (token) => { if (session) session.state = 'playing'; log.push(`resume:${token}`) },
    stopTts: () => log.push('tts.stop'),
  })
  return { t, log, setSession: (s: S | null) => { session = s }, get session() { return session } }
}

test('happy path: one-off during playing session resumes same session once', () => {
  const h = setup()
  const a = h.t.begin()
  a.end()
  a.end() // duplicate terminal events must not double-resume
  assert.deepEqual(h.log, ['pause', 'resume:1'])
})

test('user-paused session is not resumed', () => {
  const h = setup({ token: 1, state: 'paused' })
  h.t.begin().end()
  assert.deepEqual(h.log, [])
})

test('user pausing during a one-off keeps it paused afterwards', () => {
  const h = setup()
  const a = h.t.begin()
  h.t.userPaused()
  a.end()
  assert.deepEqual(h.log, ['pause'])
})

test('stopped session is not resumed', () => {
  const h = setup()
  const a = h.t.begin()
  h.setSession(null)
  a.end()
  assert.deepEqual(h.log, ['pause'])
})

test('a new session with a different token is not resumed', () => {
  const h = setup()
  const a = h.t.begin()
  h.setSession({ token: 2, state: 'paused' })
  a.end()
  assert.deepEqual(h.log, ['pause'])
})

test('H1: STOP_SPEAKING with no one-off in flight never touches tts', () => {
  const h = setup()
  h.t.stop()
  assert.deepEqual(h.log, [])
})

test('STOP_SPEAKING with a one-off in flight stops tts', () => {
  const h = setup()
  h.t.begin()
  h.t.stop()
  assert.deepEqual(h.log, ['pause', 'tts.stop'])
})

test('H2: overlapping one-offs resume only after the last finishes', () => {
  const h = setup()
  const a = h.t.begin()
  const b = h.t.begin()
  a.end() // A interrupted by B
  assert.deepEqual(h.log, ['pause'])
  b.end()
  assert.deepEqual(h.log, ['pause', 'resume:1'])
})

test('H2: overlapping one-offs, newer finishing first, still resume once', () => {
  const h = setup()
  const a = h.t.begin()
  const b = h.t.begin()
  b.end()
  a.end()
  assert.deepEqual(h.log, ['pause', 'resume:1'])
})

test('one-off with no session never resumes anything', () => {
  const h = setup(null)
  h.t.begin().end()
  assert.deepEqual(h.log, [])
})
