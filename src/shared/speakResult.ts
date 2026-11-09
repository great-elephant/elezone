export interface SpeakResult {
  ok: boolean
  error?: string
}

/** Normalise the background's SPEAK_TEXT reply; anything unrecognised counts as success. */
export function speakResultFrom(res: unknown): SpeakResult {
  if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === false) {
    const error = (res as { error?: unknown }).error
    return typeof error === 'string' && error ? { ok: false, error } : { ok: false }
  }
  return { ok: true }
}

/** One plain-English line for a failed utterance. */
export function speakFailureNotice(error?: string): string {
  return `Couldn't play audio${error ? `: ${error}` : ''}. Check Settings > Read Aloud voice.`
}
