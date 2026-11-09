// Bookkeeping for one-off utterances (SPEAK_TEXT) that borrow the shared TTS
// slot from a running Read Aloud session.
//
// Two invariants live here instead of in per-call closures:
//  - chrome.tts.stop() is only issued while a one-off is actually in flight,
//    otherwise it would kill the session's own utterance and the resulting
//    'interrupted' event would tear the session down.
//  - A one-off interrupted by a newer one must not resume the session: only the
//    last in-flight one-off resumes it, and only if it is still the same
//    session and the user has not paused or stopped it in the meantime.

interface SessionView { token: number, state: string }

interface Deps {
  getSession: () => SessionView | null | undefined
  pauseSession: () => void
  resumeSession: (token: number) => void
  stopTts: () => void
}

export function createOneOffTracker(d: Deps) {
  let depth = 0
  // Token of the session this group of one-offs paused; undefined when none.
  let pausedToken: number | undefined

  return {
    /** Number of one-offs currently in flight (diagnostics). */
    get depth() { return depth },
    /** Register a one-off about to speak; pauses a playing session. */
    begin() {
      const s = d.getSession()
      if (s?.state === 'playing') {
        d.pauseSession()
        pausedToken = s.token
      }
      depth++
      let ended = false
      return {
        /** Call on any terminal event (end/interrupted/cancelled/error/start failure). Idempotent. */
        end() {
          if (ended) return
          ended = true
          depth--
          if (depth > 0) return
          const token = pausedToken
          pausedToken = undefined
          const cur = d.getSession()
          if (token !== undefined && cur && cur.token === token && cur.state === 'paused') {
            d.resumeSession(token)
          }
        },
      }
    },
    /** STOP_SPEAKING: stop only a one-off, never the session's own speech. */
    stop() {
      if (depth > 0) d.stopTts()
    },
    /** The user explicitly paused the session: do not auto-resume it. */
    userPaused() {
      pausedToken = undefined
    },
  }
}
