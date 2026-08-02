// What Video Mode has to know about each video site, and nothing more.
//
// The interface is deliberately narrow. Most of Video Mode — the subtitle strip,
// the dialogue sidebar, the syncer, pacing, keys, settings — never learns which
// site it is running on, because none of it depends on that. Only these seven
// things genuinely differ, so only these are abstracted; anything else that
// varies between the two is a Netflix-specific repair (dub detection, verifying
// a track against the on-screen subtitles) and stays where it is.

import { installNetflixLayout, removeNetflixLayout, setNetflixLayoutMetrics } from './videoModeLayout'
import { installYouTubeLayout, removeYouTubeLayout, setYouTubeLayoutMetrics } from './youtubeLayout'

export interface VideoPlatform {
  id: 'netflix' | 'youtube'
  /** Human name, for messages the learner reads. */
  label: string

  /** Whether this URL is a page that plays something (not browse/search/home). */
  isPlaybackPage(url: string): boolean

  installLayout(): void
  removeLayout(): void
  /** Publish how much room our UI needs; the layout decides what to do with it. */
  setLayoutMetrics(sidebarWidth: number, stripHeight: number): void

  hideNativeSubtitles(): void
  showNativeSubtitles(): void

  /** Selectors the DOM-scraping fallback watches for on-screen subtitles. */
  nativeSubtitleSelectors: string[]

  /**
   * Whether the on-screen subtitles can be trusted as a reference for checking
   * that the downloaded track belongs to this video.
   *
   * True only on Netflix, where a track can silently be the next episode's: it
   * is fetched from a manifest that carries no reliable link to what is playing.
   * YouTube tracks are addressed by video id, so there is nothing to verify and
   * a mismatch would only ever be a false alarm.
   */
  verifiesAgainstNative: boolean

  /** A stable id for what is playing, or null when it can't be determined. */
  mediaKey(): string | null

  /**
   * A permalink to come back to, or null when the site has none worth storing.
   * Returned without a timestamp — callers append one in the site's own form.
   */
  permalink(): string | null

  /** The title of what is playing, for showing next to a saved word. */
  mediaTitle(): string | null
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const HIDE_NATIVE_CSS_ID = 'elezone-hide-native-subs'

function hideWith(selectors: string[]): void {
  if (document.getElementById(HIDE_NATIVE_CSS_ID)) return
  const style = document.createElement('style')
  style.id = HIDE_NATIVE_CSS_ID
  style.textContent = selectors.map(s => `${s}{display:none!important;}`).join('\n')
  document.head.appendChild(style)
}

function showNative(): void {
  document.getElementById(HIDE_NATIVE_CSS_ID)?.remove()
}

// ── Netflix ───────────────────────────────────────────────────────────────────

const NETFLIX_SUB_SELECTORS = [
  '.player-timedtext',
  '.nf-subtitle-track',
  '[data-uia="player-timedtext"]',
]

const netflix: VideoPlatform = {
  id: 'netflix',
  label: 'Netflix',

  isPlaybackPage(url) {
    try {
      return /^\/watch\/\d+/.test(new URL(url).pathname)
    } catch {
      return false
    }
  },

  installLayout: installNetflixLayout,
  removeLayout: removeNetflixLayout,
  setLayoutMetrics: setNetflixLayoutMetrics,

  hideNativeSubtitles: () => hideWith(NETFLIX_SUB_SELECTORS),
  showNativeSubtitles: showNative,
  nativeSubtitleSelectors: NETFLIX_SUB_SELECTORS,
  verifiesAgainstNative: true,

  mediaKey() {
    return location.pathname.match(/\/watch\/(\d+)/)?.[1] ?? null
  },

  // A Netflix watch URL needs the right profile, and points at a title that may
  // have left the library. A link that fails later is worse than no link, so we
  // store none and the review screen shows the timestamp as plain text.
  permalink: () => null,

  mediaTitle() {
    const el = document.querySelector('[data-uia="video-title"]')
    return el?.textContent?.replace(/\s+/g, ' ').trim() || null
  },
}

// ── YouTube ───────────────────────────────────────────────────────────────────

const YOUTUBE_SUB_SELECTORS = [
  '.ytp-caption-window-container',
  '.caption-window',
  '.ytp-caption-segment',
]

const youtube: VideoPlatform = {
  id: 'youtube',
  label: 'YouTube',

  isPlaybackPage(url) {
    try {
      const parsed = new URL(url)
      // Shorts and embeds are deliberately excluded: neither has room for the
      // sidebar, and a Short's captions are too fragmentary to study from.
      return parsed.pathname === '/watch' && !!parsed.searchParams.get('v')
    } catch {
      return false
    }
  },

  installLayout: installYouTubeLayout,
  removeLayout: removeYouTubeLayout,
  setLayoutMetrics: setYouTubeLayoutMetrics,

  hideNativeSubtitles: () => hideWith(YOUTUBE_SUB_SELECTORS),
  showNativeSubtitles: showNative,
  nativeSubtitleSelectors: YOUTUBE_SUB_SELECTORS,
  verifiesAgainstNative: false,

  mediaKey() {
    try {
      return new URL(location.href).searchParams.get('v')
    } catch {
      return null
    }
  },

  permalink() {
    const id = youtube.mediaKey()
    return id ? `https://www.youtube.com/watch?v=${id}` : null
  },

  mediaTitle() {
    const el =
      document.querySelector('#title h1 yt-formatted-string') ??
      document.querySelector('h1.ytd-watch-metadata') ??
      document.querySelector('meta[name="title"]')
    const text = el instanceof HTMLMetaElement ? el.content : el?.textContent
    return text?.replace(/\s+/g, ' ').trim() || null
  },
}

// ── Lookup ────────────────────────────────────────────────────────────────────

const PLATFORMS: Array<{ hosts: string[]; platform: VideoPlatform }> = [
  { hosts: ['netflix.com'], platform: netflix },
  { hosts: ['youtube.com', 'youtube-nocookie.com'], platform: youtube },
]

export function platformFor(hostname = window.location.hostname): VideoPlatform | null {
  for (const { hosts, platform } of PLATFORMS) {
    if (hosts.some(h => hostname === h || hostname.endsWith(`.${h}`))) return platform
  }
  return null
}
