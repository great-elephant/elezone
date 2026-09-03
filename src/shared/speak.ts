import { Message } from './types'

export interface SpeakOptions {
  lang?: string
  /**
   * Speak with this exact voice instead of the one resolved from settings.
   * Only the settings page needs it, to audition a voice before committing to
   * it — everywhere else must leave this alone so the user's configured voice
   * (and its language fallbacks) is what actually gets used.
   */
  voiceName?: string
}

/**
 * Speak `text`, and resolve once it has finished.
 *
 * All one-off speech goes through the background's SPEAK_TEXT handler rather
 * than each caller reaching for `chrome.tts` (or `window.speechSynthesis`) on
 * its own. Voice resolution is the reason: settings hold a default voice plus
 * per-language overrides, and every call site that resolved them by hand had
 * drifted into its own slightly different subset of the rules. The background
 * resolver is the only one that applies all of them — and it is also where the
 * audio keepalive, the retry for a voice that isn't installed, and pausing and
 * resuming the page reader live.
 *
 * Callers drive their own "speaking" indicator off this promise: it resolves
 * on the utterance ending, being interrupted, or failing to start at all.
 */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'SPEAK_TEXT',
      payload: { text, lang: opts.lang, voiceName: opts.voiceName },
    } as Message)
  } catch {
    // The service worker went away mid-utterance, so the reply never came.
    // Callers only use this to clear an indicator, and leaving one stuck on is
    // worse than clearing it a little early.
  }
}

/** Stop whatever one-off utterance is speaking. Safe to call when none is. */
export function stopSpeaking(): void {
  chrome.runtime.sendMessage({ type: 'STOP_SPEAKING' } as Message).catch(() => {
    // No background listening — nothing is speaking either.
  })
}
