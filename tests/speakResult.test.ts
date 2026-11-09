import { test } from 'node:test'
import assert from 'node:assert/strict'
import { speakResultFrom, speakFailureNotice } from '../src/shared/speakResult.ts'

test('ok replies and unknown shapes are success', () => {
  assert.deepEqual(speakResultFrom({ ok: true }), { ok: true })
  assert.deepEqual(speakResultFrom(undefined), { ok: true })
})
test('failure keeps the reason when present', () => {
  assert.deepEqual(speakResultFrom({ ok: false, error: 'No voice' }), { ok: false, error: 'No voice' })
  assert.deepEqual(speakResultFrom({ ok: false }), { ok: false })
})
test('notice wording', () => {
  assert.equal(speakFailureNotice('No voice'), "Couldn't play audio: No voice. Check Settings > Read Aloud voice.")
  assert.equal(speakFailureNotice(), "Couldn't play audio. Check Settings > Read Aloud voice.")
})
