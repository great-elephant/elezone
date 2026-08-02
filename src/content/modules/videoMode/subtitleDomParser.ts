// Fallback subtitle extraction when network interception misses the request.
// Watches the player's own subtitle container and builds cues from what is
// visible. Limitation: only cues that have already been displayed are captured,
// so this can never fill the sidebar ahead of playback — it is the last resort,
// and on Netflix it doubles as the reference for checking a downloaded track.

import type { SubtitleCue } from './subtitleInterceptor'

type DomCueCallback = (cue: SubtitleCue) => void

let _observer: MutationObserver | null = null
let _callback: DomCueCallback | null = null
let _domIndex = 0
let _lastText = ''
// Supplied by the platform: each site names its caption container differently,
// and both rename them between releases, so this is a list of guesses either way.
let _selectors: string[] = []

function findSubtitleContainer(): Element | null {
  for (const sel of _selectors) {
    const el = document.querySelector(sel)
    if (el) return el
  }
  return null
}

// Netflix nests its cue markup (container > div > span > span), so collecting
// every `span, p` counted the same words once per level — the cue came out
// duplicated ("There we go. There we go."). Only leaf elements hold text
// exactly once, so they partition the cue cleanly.
function extractText(container: Element): string {
  const leaves = Array.from(container.querySelectorAll('*'))
    .filter(el => el.children.length === 0)
    .map(el => el.textContent?.trim() ?? '')
    .filter(Boolean)

  const text = leaves.length > 0 ? leaves.join(' ') : (container.textContent ?? '')
  return text.replace(/\s+/g, ' ').trim()
}

function getVideoTime(): number {
  const video = document.querySelector<HTMLVideoElement>('video')
  return video ? video.currentTime : 0
}

function onMutation() {
  if (!_callback) return
  const container = findSubtitleContainer()
  if (!container) return

  const text = extractText(container)
  if (!text || text === _lastText) return
  _lastText = text

  const now = getVideoTime()
  // We don't know endTime from DOM, estimate 5 seconds
  const cue: SubtitleCue = {
    index: _domIndex++,
    startTime: now,
    endTime: now + 5,
    text,
  }
  _callback(cue)
}

export function installSubtitleDomParser(cb: DomCueCallback, selectors: string[]): void {
  _callback = cb
  _selectors = selectors
  _domIndex = 0
  _lastText = ''

  // Wait for the subtitle container to appear
  function tryAttach() {
    const container = findSubtitleContainer()
    if (!container) return false

    _observer = new MutationObserver(onMutation)
    _observer.observe(container, { childList: true, subtree: true, characterData: true })
    return true
  }

  if (!tryAttach()) {
    // Container not yet in DOM — watch body until it appears
    const bodyObserver = new MutationObserver(() => {
      if (tryAttach()) bodyObserver.disconnect()
    })
    bodyObserver.observe(document.body, { childList: true, subtree: true })
  }
}

export function uninstallSubtitleDomParser(): void {
  _observer?.disconnect()
  _observer = null
  _callback = null
}
