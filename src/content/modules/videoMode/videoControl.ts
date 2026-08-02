// Playback commands for the video-mode UI.
//
// Netflix streams through Media Source Extensions, so assigning to
// `video.currentTime` desynchronises its buffer from its player state and the
// site aborts with "Pardon the interruption / Error Code M7375" — its
// extension-interference guard. Seeking has to go through Netflix's own player
// API, which only exists in the page's MAIN world, so commands are posted
// across and executed by `content/videoModeMainWorld.ts`.

export const VIDEO_COMMAND_MSG = 'ELEZONE_VIDEO_COMMAND'

type Action = 'seek' | 'play' | 'pause' | 'useCC'

// Sites where the MAIN-world bridge is injected (see manifest content_scripts).
// YouTube would tolerate a direct `video.currentTime` write, but the bridge is
// there anyway for caption capture, and going through the player API keeps the
// scrubber and the buffer in step with where playback actually is.
function hasBridge(): boolean {
  return /(^|\.)(netflix\.com|youtube\.com)$/.test(location.hostname)
}

function send(action: Action, timeMs?: number): void {
  window.postMessage({ type: VIDEO_COMMAND_MSG, action, timeMs }, '*')
}

/**
 * Jump to `seconds` — exactly, never a moment before.
 *
 * A lead-in to avoid clipping the first word sounds harmless but isn't: cues
 * run back to back, so any time before a cue's start belongs to the previous
 * one. The syncer picks the last cue that has started, so it would report the
 * line before the one asked for — off by one on every jump, and with an
 * end-of-line pause it would stop there too.
 */
export function seekToSeconds(seconds: number): void {
  const target = Math.max(0, seconds)
  if (hasBridge()) {
    send('seek', target * 1000)
    return
  }
  const video = document.querySelector<HTMLVideoElement>('video')
  if (video) video.currentTime = target
}

export function playVideo(): void {
  if (hasBridge()) {
    send('play')
    return
  }
  void document.querySelector<HTMLVideoElement>('video')?.play()
}

/**
 * Switch Netflix to the closed-caption track for the audio language. For a
 * dubbed title that is the only track whose wording follows the spoken lines.
 */
export function useClosedCaptions(): void {
  send('useCC')
}

export function pauseVideo(): void {
  if (hasBridge()) {
    send('pause')
    return
  }
  document.querySelector<HTMLVideoElement>('video')?.pause()
}
