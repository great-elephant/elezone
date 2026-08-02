// Runs in the page's MAIN world on video sites (see manifest content_scripts).
//
// Why this file exists: content scripts execute in an isolated world with their
// own `window`, so hooking `window.fetch` / `XMLHttpRequest` there never sees
// the requests the Netflix player itself makes. To capture the subtitle track we
// have to patch the page's own globals, which is only possible from MAIN world.
//
// This script does no parsing — it forwards the raw payload to the isolated
// world via postMessage, where subtitleInterceptor.ts parses it. Keeping it
// dependency-free means it stays a single self-contained bundle even after
// crxjs processes it.

const BRIDGE_MSG = 'ELEZONE_SUBTITLE_PAYLOAD'
const REQUEST_MSG = 'ELEZONE_SUBTITLE_REQUEST'

// This script runs at document_start; the content script that consumes these
// payloads only starts at document_idle and then waits on async setup. A track
// captured in between would be posted to nobody — postMessage has no queue — so
// keep what we found and replay it when the listener announces itself.
const captured: Array<{ url: string; text: string; replace?: boolean; role?: string }> = []

// Netflix ships one track per language; a full movie's payload is a few hundred
// KB, and it can be re-requested on every seek/track switch. Skip anything we
// already forwarded so the isolated world isn't re-parsing the same file.
const seenUrls = new Set<string>()

// Netflix does NOT serve subtitles from tidy `.vtt` / `.ttml` URLs — they come
// off `*.nflxvideo.net` as opaque CDN links whose path carries no extension and
// whose type is often `application/octet-stream`. Sniffing the URL therefore
// finds nothing, so we identify tracks by their content instead.
function looksLikeSubtitles(text: string): boolean {
  const head = text.slice(0, 4096)
  if (/^﻿?\s*WEBVTT/.test(head)) return true          // WebVTT
  if (/<tt\b[^>]*\bxmlns/i.test(head)) return true         // TTML / DFXP
  if (/<tt:tt\b/i.test(head)) return true                  // namespaced TTML
  // SRT-ish / generic cue timing
  if (head.includes('-->') && /\d{1,2}:\d{2}:\d{2}/.test(head)) return true
  return false
}

// Media segments are large and binary; never clone those into a string.
const TEXTUAL_CT = /(text\/|xml|json|vtt|ttml|dfxp|octet-stream)/i
const MAX_SNIFF_BYTES = 4 * 1024 * 1024

type TrackRole = 'primary' | 'translation'

function forward(url: string, text: string, opts: { replace?: boolean; role?: TrackRole } = {}) {
  const role: TrackRole = opts.role ?? 'primary'
  const replace = opts.replace ?? false
  if (!text || text.length < 32) return
  if (seenUrls.has(url) && !replace) return
  if (!looksLikeSubtitles(text)) return
  seenUrls.add(url)
  console.info(`[EleZone] captured ${role} track (${text.length} bytes)`)
  // A deliberate pick supersedes anything sniffed for the same role; sniffed
  // tracks may belong to a selection the viewer has since changed.
  if (replace) {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i].role === role) captured.splice(i, 1)
    }
  }
  captured.push({ url, text, replace, role })
  if (captured.length > 6) captured.shift()
  window.postMessage({ type: BRIDGE_MSG, url, text, replace, role }, '*')
}

// Every text-ish response goes through here: it's either a subtitle track or,
// far more usefully, the manifest that lists where the tracks live.
function handleBody(url: string, text: string) {
  forward(url, text)
  maybeManifest(text)
}

// ── Manifest → full track ─────────────────────────────────────────────────────

// Sniffing raw responses only ever catches the track Netflix happens to be
// streaming, which is why the sidebar could never show more than the lines
// already played. The playback manifest lists every timed-text track up front,
// so we read it and fetch the whole file ourselves.

const manifestSeen = new Set<string>()

interface TimedTextTrack {
  id?: string
  new_track_id?: string
  language?: string
  languageDescription?: string
  trackType?: string
  isForcedNarrative?: boolean
  isNoneTrack?: boolean
  ttDownloadables?: Record<string, { downloadUrls?: Record<string, string> }>
}

// Tracks from the manifest for the title currently on screen.
let manifestTracks: TimedTextTrack[] = []
let fetchedTrackUrl = ''
// The learner's target language, sent over by the content script. When Netflix
// has a subtitle track in it, that human translation beats machine translation.
let wantedLang = ''
let fetchedTranslationUrl = ''

function collectTracks(node: unknown, out: TimedTextTrack[], depth = 0): void {
  if (depth > 12 || !node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) collectTracks(n, out, depth + 1)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'timedtexttracks' && Array.isArray(value)) out.push(...value)
    else collectTracks(value, out, depth + 1)
  }
}

// Prefer WebVTT: our TTML parser is the fallback, not the good path.
function firstDownloadUrl(downloadables: Record<string, { downloadUrls?: Record<string, string> }>): string | null {
  const keys = Object.keys(downloadables)
    .sort((a, b) => Number(b.includes('webvtt')) - Number(a.includes('webvtt')))
  for (const key of keys) {
    const urls = downloadables[key]?.downloadUrls
    const first = urls && Object.values(urls)[0]
    if (typeof first === 'string' && first) return first
  }
  return null
}

function maybeManifest(text: string) {
  if (!text.includes('timedtexttracks')) return
  try {
    handleManifestJson(JSON.parse(text))
  } catch {
    // not JSON after all
  }
}

// Which title a manifest describes. Netflix prefetches the *next* episode's
// manifest while you watch, so this has to be checked — taking whichever
// manifest arrived last silently swaps in another episode's subtitles.
function manifestTitleIds(json: unknown): string[] {
  const ids: string[] = []
  const walk = (node: unknown, depth = 0) => {
    if (depth > 10 || !node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return }
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'movieId' || k === 'viewableId') && (typeof v === 'number' || typeof v === 'string')) {
        ids.push(String(v))
      } else walk(v, depth + 1)
    }
  }
  walk(json)
  return ids
}

// A prefetched manifest is the only copy we will ever see of that episode's
// track list — once the viewer navigates to it, it is never re-fetched. So keep
// it keyed by title instead of discarding it.
const tracksByTitle = new Map<string, TimedTextTrack[]>()

function handleManifestJson(json: unknown) {
  const tracks: TimedTextTrack[] = []
  collectTracks(json, tracks)

  const usable = tracks.filter(t => t?.ttDownloadables && !t.isForcedNarrative && !t.isNoneTrack)
  if (usable.length === 0) return

  const ids = manifestTitleIds(json)
  const current = location.pathname.match(/\/watch\/(\d+)/)?.[1] ?? ''
  for (const id of ids) tracksByTitle.set(id, usable)

  // No id at all → can't tell which title it is; don't discard on a guess.
  if (current && ids.length > 0 && !ids.includes(current)) {
    console.info(`[EleZone] stored ${usable.length} tracks for title ${ids[0]} (prefetch, not the one playing)`)
    return
  }

  adoptTracks(usable)
}

function adoptTracks(usable: TimedTextTrack[]) {
  manifestTracks = usable
  console.info(`[EleZone] manifest lists ${usable.length} subtitle tracks:`,
    usable.map(t => `${t.language}${t.trackType ? `/${t.trackType}` : ''}`).join(', '))
  syncSelectedTrack()
  syncTranslationTrack()
}

// ── Follow the track the viewer actually picked ───────────────────────────────

// Choosing "the first English track" is wrong for dubbed titles: Netflix ships
// both a translation of the original dialogue and a CC track matching the dub,
// with different wording and timing. Whatever the viewer selected in the player
// is by definition the one that matches what they hear.
interface SelectedTrack {
  trackId?: string
  bcp47?: string
  trackType?: string
  displayName?: string
}

function selectedTrack(): SelectedTrack | null {
  try {
    const player = netflixPlayer() as (NetflixPlayer & {
      getTimedTextTrack?: () => SelectedTrack
    }) | null
    return player?.getTimedTextTrack?.() ?? null
  } catch {
    return null
  }
}

function pickTrack(): TimedTextTrack | null {
  if (manifestTracks.length === 0) return null

  const sel = selectedTrack()
  if (sel) {
    const byId = manifestTracks.find(
      t => (t.new_track_id && t.new_track_id === sel.trackId) || (t.id && t.id === sel.trackId)
    )
    if (byId) return byId

    const lang = (sel.bcp47 ?? '').toLowerCase()
    if (lang) {
      const byLang = manifestTracks.filter(t => (t.language ?? '').toLowerCase() === lang)
      const exact = byLang.find(t => !sel.trackType || t.trackType === sel.trackType)
      if (exact ?? byLang[0]) return exact ?? byLang[0]
    }
  }

  // Player not ready / subtitles off — fall back to English, then anything.
  return manifestTracks.find(t => (t.language ?? '').toLowerCase().startsWith('en'))
    ?? manifestTracks[0]
}

// Netflix's own translation for the learner's language, if the title has one.
function syncTranslationTrack() {
  if (!wantedLang || manifestTracks.length === 0) return

  const base = wantedLang.toLowerCase().split('-')[0]
  const candidates = manifestTracks.filter(
    t => (t.language ?? '').toLowerCase().split('-')[0] === base
  )
  const pick = candidates.find(t => t.trackType === 'PRIMARY') ?? candidates[0]
  if (!pick?.ttDownloadables) return

  const url = firstDownloadUrl(pick.ttDownloadables)
  // Same track as the study line means the viewer is already watching in their
  // own language — there is nothing to translate.
  if (!url || url === fetchedTranslationUrl || url === fetchedTrackUrl) return
  fetchedTranslationUrl = url

  console.info(`[EleZone] using Netflix's own "${pick.languageDescription ?? pick.language}" subtitles as the translation`)
  origFetch.call(window, url)
    .then(r => r.text())
    .then(body => forward(url, body, { replace: true, role: 'translation' }))
    .catch(() => {
      console.warn('[EleZone] could not download the translation track; falling back to machine translation')
    })
}

function syncSelectedTrack() {
  const pick = pickTrack()
  if (!pick?.ttDownloadables) return

  const url = firstDownloadUrl(pick.ttDownloadables)
  if (!url || url === fetchedTrackUrl) return
  fetchedTrackUrl = url
  manifestSeen.add(url)

  console.info(`[EleZone] loading subtitle track "${pick.languageDescription ?? pick.language}"`)
  origFetch.call(window, url)
    .then(r => r.text())
    // `replace` tells the content script to take this track even if it has
    // fewer cues than one seen earlier — the viewer's choice always wins.
    .then(body => forward(url, body, { replace: true, role: 'primary' }))
    .catch(() => {
      console.warn('[EleZone] could not download the subtitle track listed in the manifest')
    })
}

// ── JSON.parse hook ───────────────────────────────────────────────────────────

// Netflix fetches its playback manifest over MSL, so the response body on the
// wire is encrypted — reading it off fetch/XHR yields ciphertext and the track
// list never appears. The manifest only becomes plaintext when the player
// decrypts it and hands the string to JSON.parse, which is where we read it.
//
// The guard is a plain substring test on the raw string, so every other
// JSON.parse in the app pays only for that scan.
const origJsonParse = JSON.parse

JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
  const result = origJsonParse.call(JSON, text, reviver as never)
  try {
    if (typeof text === 'string' && text.length > 200 && text.includes('timedtexttracks')) {
      handleManifestJson(result)
    }
  } catch {
    // never let instrumentation break the player's own parsing
  }
  return result
} as typeof JSON.parse

// ── Replay for a late listener ────────────────────────────────────────────────

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return
  const req = e.data as { type?: string; targetLang?: string } | null
  if (req?.type !== REQUEST_MSG) return

  if (req.targetLang && req.targetLang !== wantedLang) {
    wantedLang = req.targetLang
    syncTranslationTrack()
  }
  if (captured.length === 0) return
  console.info(`[EleZone] replaying ${captured.length} captured track(s) to the content script`)
  for (const payload of captured) {
    window.postMessage({ type: BRIDGE_MSG, ...payload }, '*')
  }
})

// ── Playback commands from the isolated world ─────────────────────────────────

// Netflix's player owns the MSE buffer. Writing `video.currentTime` behind its
// back trips its tamper guard ("Error Code M7375"), so seeks are handed to the
// player API instead. It lives on the page's `netflix` global, hence here.
const CMD_MSG = 'ELEZONE_VIDEO_COMMAND'

interface NetflixPlayer {
  seek?: (ms: number) => void
  play?: () => void
  pause?: () => void
}

function netflixPlayer(): NetflixPlayer | null {
  try {
    const nf = (window as unknown as {
      netflix?: { appContext?: { state?: { playerApp?: { getAPI?: () => unknown } } } }
    }).netflix
    const api = nf?.appContext?.state?.playerApp?.getAPI?.() as {
      videoPlayer?: {
        getAllPlayerSessionIds?: () => string[]
        getVideoPlayerBySessionId?: (id: string) => NetflixPlayer
      }
    } | undefined

    const vp = api?.videoPlayer
    const ids = vp?.getAllPlayerSessionIds?.() ?? []
    // Playback sessions are prefixed "watch-"; anything else is a preview/trailer.
    const id = ids.find(s => s.startsWith('watch')) ?? ids[0]
    if (!id || !vp?.getVideoPlayerBySessionId) return null
    return vp.getVideoPlayerBySessionId(id) ?? null
  } catch {
    return null
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return
  const data = e.data as { type?: string; action?: string; timeMs?: number } | null
  if (!data || data.type !== CMD_MSG) return

  const player = netflixPlayer()
  const video = document.querySelector<HTMLVideoElement>('video')

  try {
    switch (data.action) {
      case 'seek':
        if (typeof data.timeMs !== 'number') return
        if (player?.seek) {
          player.seek(Math.round(data.timeMs))
          player.play?.()
        } else if (video) {
          // Non-Netflix players are plain enough for a direct write.
          video.currentTime = data.timeMs / 1000
        }
        break
      case 'pause':
        if (player?.pause) player.pause()
        else video?.pause()
        break
      case 'play':
        if (player?.play) player.play()
        else void video?.play()
        break
      case 'useCC': {
        const withTracks = player as PlayerWithTracks | null
        const cc = closedCaptionTrackForAudio(withTracks)
        if (cc && withTracks?.setTimedTextTrack) {
          console.info(`[EleZone] switching Netflix to "${cc.displayName}"`)
          withTracks.setTimedTextTrack(cc)
        }
        break
      }
    }
  } catch {
    console.warn('[EleZone] playback command failed')
  }
})

// ── Dub / subtitle mismatch ───────────────────────────────────────────────────
//
// For a title watched in dub, the audio and the ordinary subtitle track are two
// independent translations: same meaning, different wording throughout. Reading
// along is then useless for study. The CC ("ASSISTIVE") track for that language
// transcribes the dub itself, so it is the one that matches what is spoken.

const HINT_MSG = 'ELEZONE_SUBTITLE_HINT'
let hintSent = false

interface PlayerTrack {
  bcp47?: string
  displayName?: string
  trackType?: string
  isForcedNarrative?: boolean
}

type PlayerWithTracks = NetflixPlayer & {
  getAudioTrack?: () => PlayerTrack
  getTimedTextTrack?: () => PlayerTrack
  getTimedTextTrackList?: () => PlayerTrack[]
  setTimedTextTrack?: (track: PlayerTrack) => void
}

function baseLang(tag?: string): string {
  return (tag ?? '').toLowerCase().split('-')[0]
}

function closedCaptionTrackForAudio(player: PlayerWithTracks | null): PlayerTrack | null {
  const audioLang = baseLang(player?.getAudioTrack?.()?.bcp47)
  if (!audioLang) return null
  const list = player?.getTimedTextTrackList?.() ?? []
  return list.find(
    t => baseLang(t.bcp47) === audioLang && t.trackType === 'ASSISTIVE' && !t.isForcedNarrative
  ) ?? null
}

function detectDubMismatch() {
  if (hintSent) return
  const player = netflixPlayer() as PlayerWithTracks | null
  const audio = player?.getAudioTrack?.()
  const sub = player?.getTimedTextTrack?.()
  if (!audio || !sub) return

  // Only a concern when audio and subtitles are the same language: that is the
  // dub case. A genuine foreign-language subtitle is meant to differ.
  if (!baseLang(audio.bcp47) || baseLang(audio.bcp47) !== baseLang(sub.bcp47)) return
  if (sub.trackType === 'ASSISTIVE') return

  const cc = closedCaptionTrackForAudio(player)
  if (!cc) return

  hintSent = true
  console.info(`[EleZone] audio and subtitles are both ${audio.bcp47} but the subtitle track is a separate translation; "${cc.displayName}" would match the spoken dialogue`)
  window.postMessage({ type: HINT_MSG, ccName: cc.displayName ?? 'CC' }, '*')
}

// ── Per-title state ───────────────────────────────────────────────────────────

// Netflix is a single-page app: moving to the next episode changes the URL but
// never reloads this script. Everything above is scoped to one title, so
// without an explicit reset the previous episode's tracks stay cached and get
// replayed to the content script — subtitles that have nothing to do with what
// is on screen.
let currentTitleId = location.pathname.match(/\/watch\/(\d+)/)?.[1] ?? ''

function resetForNewTitle(titleId: string) {
  console.info(`[EleZone] title changed to ${titleId}; clearing cached subtitle tracks`)
  currentTitleId = titleId
  manifestTracks = []
  fetchedTrackUrl = ''
  fetchedTranslationUrl = ''
  captured.length = 0
  seenUrls.clear()
  manifestSeen.clear()

  // The manifest for this episode may already have gone past as a prefetch.
  const known = tracksByTitle.get(titleId)
  if (known) adoptTracks(known)
}

setInterval(() => {
  const id = location.pathname.match(/\/watch\/(\d+)/)?.[1] ?? ''
  if (id && id !== currentTitleId) resetForNewTitle(id)
}, 1000)

// ── Fallback: ask the player directly ─────────────────────────────────────────

// If the manifest was parsed before our hook was in place, the player still
// holds the track list. Poll briefly after load, then give up — the DOM scraper
// covers whatever is left.
let probeReported = false

setInterval(() => {
  try {
    detectDubMismatch()
    if (manifestTracks.length > 0) {
      // Picks up the viewer switching subtitle language mid-playback.
      syncSelectedTrack()
      syncTranslationTrack()
      return
    }
    const player = netflixPlayer() as (NetflixPlayer & {
      getTimedTextTrackList?: () => TimedTextTrack[]
    }) | null
    const list = player?.getTimedTextTrackList?.()
    if (Array.isArray(list) && list.length > 0) {
      // The player's own track objects usually carry no download URLs, so this
      // often yields nothing. Say so once instead of every two seconds.
      if (!probeReported) {
        probeReported = true
        console.info(`[EleZone] player API lists ${list.length} tracks; checking for download URLs`)
      }
      handleManifestJson({ timedtexttracks: list })
    }
  } catch {
    // player not ready yet
  }
}, 2000)

// ── fetch hook ────────────────────────────────────────────────────────────────

const origFetch = window.fetch
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const response = await origFetch.call(this, input as RequestInfo, init)
  try {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : (input as Request).url
    const ct = response.headers.get('content-type') ?? ''
    const len = Number(response.headers.get('content-length') ?? '0')
    if ((!ct || TEXTUAL_CT.test(ct)) && len <= MAX_SNIFF_BYTES && !seenUrls.has(url)) {
      response.clone().text().then(text => handleBody(url, text)).catch(() => { })
    }
  } catch {
    // never let instrumentation break the player's own request
  }
  return response
}

// ── XMLHttpRequest hook ───────────────────────────────────────────────────────

const origOpen = XMLHttpRequest.prototype.open
const origSend = XMLHttpRequest.prototype.send
const urlKey = Symbol('elezoneUrl')

type TaggedXhr = XMLHttpRequest & { [urlKey]?: string }

XMLHttpRequest.prototype.open = function (
  this: TaggedXhr,
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  this[urlKey] = typeof url === 'string' ? url : url.href
  return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
}

XMLHttpRequest.prototype.send = function (this: TaggedXhr, ...args: unknown[]) {
  const url = this[urlKey]
  if (url && !seenUrls.has(url)) {
    this.addEventListener('load', () => {
      try {
        // Video/audio segments come back as 'arraybuffer' through MSE and are
        // far too large to stringify — only text-typed responses are sniffed.
        if (this.responseType === '' || this.responseType === 'text') {
          const text = this.responseText
          if (text && text.length <= MAX_SNIFF_BYTES) handleBody(url, text)
        }
      } catch {
        // ignore — unreadable response
      }
    })
  }
  return (origSend as (...a: unknown[]) => void).call(this, ...args)
}
