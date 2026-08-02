// Runs in the page's MAIN world on YouTube (see manifest content_scripts).
//
// Same reason as the Netflix bridge: a content script's `window.fetch` is a
// different object from the page's, and `ytInitialPlayerResponse` / the player
// API live on the page's `window`. Neither is reachable from the isolated world.
//
// It is a separate file from `videoModeMainWorld.ts` on purpose. The two share
// only the message protocol; everything else — how tracks are discovered, how
// playback is driven, what "the same video" means — is different, and folding
// them together would produce a third file harder to follow than either.
//
// Like its Netflix counterpart this script does no parsing and imports nothing,
// so crxjs keeps emitting it as one self-contained IIFE.

const BRIDGE_MSG = 'ELEZONE_SUBTITLE_PAYLOAD'
const REQUEST_MSG = 'ELEZONE_SUBTITLE_REQUEST'
const CMD_MSG = 'ELEZONE_VIDEO_COMMAND'
const STATE_MSG = 'ELEZONE_VIDEO_STATE'

type TrackRole = 'primary' | 'translation'

interface Payload {
  url: string
  text: string
  replace?: boolean
  role?: TrackRole
  /** Auto-generated captions are usable but rougher; the strip says so. */
  asr?: boolean
}

// document_start here, document_idle plus async setup over there: a track found
// in between would be posted to nobody, since postMessage has no queue. Keep
// what we found and replay it when the listener announces itself.
const captured: Payload[] = []
const seenUrls = new Set<string>()

// ── Bridge ────────────────────────────────────────────────────────────────────

// json3 is what we ask for, but the player's own responses may be srv3/ttml XML,
// and the plain `timedtext` default is XML too. Accept all of them: the isolated
// world sniffs the body again and picks a parser.
function looksLikeSubtitles(text: string): boolean {
  const head = text.slice(0, 4096)
  if (/^\s*\{\s*"wireMagic"/.test(head)) return true       // json3
  if (/^\s*\{[^}]*"events"\s*:\s*\[/.test(head)) return true
  if (/<transcript\b/i.test(head)) return true             // legacy timedtext XML
  if (/<timedtext\b/i.test(head)) return true              // srv3
  if (/<tt\b[^>]*\bxmlns/i.test(head)) return true         // TTML
  if (/^﻿?\s*WEBVTT/.test(head)) return true
  return false
}

function forward(url: string, text: string, opts: { replace?: boolean; role?: TrackRole; asr?: boolean } = {}) {
  const role: TrackRole = opts.role ?? 'primary'
  const replace = opts.replace ?? false
  if (!text || text.length < 32) return
  if (seenUrls.has(url) && !replace) return
  if (!looksLikeSubtitles(text)) return
  seenUrls.add(url)
  console.info(`[EleZone] captured ${role} caption track (${text.length} bytes)${opts.asr ? ' [auto-generated]' : ''}`)

  if (replace) {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i].role === role) captured.splice(i, 1)
    }
  }
  if (role === 'primary') {
    havePrimaryPayload = true
    needsCaptionReload = false
  }
  const payload: Payload = { url, text, replace, role, asr: opts.asr }
  captured.push(payload)
  if (captured.length > 6) captured.shift()
  window.postMessage({ type: BRIDGE_MSG, ...payload }, '*')
}

// ── Caption track list ────────────────────────────────────────────────────────

interface CaptionTrack {
  baseUrl?: string
  languageCode?: string
  /** "asr" for auto-generated; absent for a human-written track. */
  kind?: string
  vssId?: string
  isTranslatable?: boolean
  name?: { simpleText?: string; runs?: Array<{ text?: string }> }
}

let tracks: CaptionTrack[] = []
// Languages the learner cares about, handed over by the content script.
let learnLang = 'en'
let wantedLang = ''
let fetchedPrimaryUrl = ''
let fetchedTranslationUrl = ''
// A timedtext URL the player itself requested. It carries whatever session
// parameters YouTube currently demands, so when our own signed-URL fetch comes
// back empty this is the one request we know works.
let playerTimedTextUrl = ''
let noCaptionsReported = false
// Set once a usable study track has actually reached the content script; until
// then the repair path keeps trying.
let havePrimaryPayload = false
let needsCaptionReload = false
let reloadLang = ''
let captionReloadAttempts = 0

const origFetch = window.fetch

function trackName(t: CaptionTrack): string {
  return t.name?.simpleText ?? t.name?.runs?.map(r => r.text ?? '').join('') ?? t.languageCode ?? '?'
}

function isAsr(t: CaptionTrack): boolean {
  return t.kind === 'asr' || (t.vssId ?? '').startsWith('a.')
}

function baseLang(tag?: string): string {
  return (tag ?? '').toLowerCase().split('-')[0]
}

/**
 * Pull the caption list out of anything shaped like a player response.
 *
 * Walked rather than read at a fixed path because the same structure arrives by
 * three routes — the bootstrap `ytInitialPlayerResponse`, the `/youtubei/v1/player`
 * response on SPA navigation, and `get_transcript` — and only the first has a
 * shape we could rely on.
 */
function collectTracks(node: unknown, out: CaptionTrack[], depth = 0): void {
  if (depth > 12 || !node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) collectTracks(n, out, depth + 1)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'captionTracks' && Array.isArray(value)) out.push(...(value as CaptionTrack[]))
    else collectTracks(value, out, depth + 1)
  }
}

function handlePlayerResponse(json: unknown): void {
  const found: CaptionTrack[] = []
  collectTracks(json, found)
  const usable = found.filter(t => typeof t.baseUrl === 'string' && t.baseUrl)
  if (usable.length === 0) return

  // The bootstrap response and the navigation response describe the same video;
  // whichever arrives second must not halve the list.
  const known = new Set(tracks.map(t => t.baseUrl))
  const merged = [...tracks, ...usable.filter(t => !known.has(t.baseUrl))]
  if (merged.length === tracks.length) return
  tracks = merged

  console.info('[EleZone] caption tracks:', tracks.map(t =>
    `${t.languageCode}${isAsr(t) ? '(auto)' : ''}`).join(', '))
  syncPrimaryTrack()
  syncTranslationTrack()
}

// ── Choosing tracks ───────────────────────────────────────────────────────────

/**
 * The track to study from: a human-written one in the language being learnt,
 * else the auto-generated one. Anything else is not this learner's video, and
 * we return null rather than putting up a strip of dialogue they can't use.
 */
function pickPrimary(): CaptionTrack | null {
  const want = baseLang(learnLang) || 'en'
  const sameLang = tracks.filter(t => baseLang(t.languageCode) === want)
  return sameLang.find(t => !isAsr(t)) ?? sameLang.find(isAsr) ?? null
}

/**
 * Fetch a caption URL, asking for json3 and optionally a server-side translation.
 *
 * The awkward part: a signed `baseUrl` replayed by us can come back HTTP 200
 * with an empty body — the response YouTube gives when the request lacks the
 * session proof its own player carries. That is indistinguishable from "this
 * video has no captions" unless we check the length, so we do, and fall back.
 */
async function fetchCaptions(url: string, opts: { tlang?: string } = {}): Promise<string | null> {
  const variants: string[] = []
  const withFmt = `${url}${url.includes('?') ? '&' : '?'}fmt=json3`
  if (opts.tlang) {
    variants.push(`${withFmt}&tlang=${encodeURIComponent(opts.tlang)}`)
  } else {
    variants.push(withFmt, url)
  }

  for (const variant of variants) {
    try {
      const res = await origFetch.call(window, variant, { credentials: 'include' })
      if (!res.ok) continue
      const text = await res.text()
      if (text && text.length > 32) return text
      console.info('[EleZone] caption request returned an empty body; trying another form')
    } catch {
      // network error — try the next variant
    }
  }
  return null
}

function syncPrimaryTrack(): void {
  const pick = pickPrimary()
  if (!pick?.baseUrl) {
    // Nothing to study from. Say so rather than staying silent: on YouTube this
    // is the common case, not a failure, and the content script needs to take
    // its UI back down instead of leaving an empty strip over the page.
    if (tracks.length > 0 && !noCaptionsReported) {
      noCaptionsReported = true
      console.info(`[EleZone] no ${learnLang} captions on this video; leaving it alone`)
      window.postMessage({ type: STATE_MSG, noCaptions: true }, '*')
    }
    return
  }
  noCaptionsReported = false
  if (pick.baseUrl === fetchedPrimaryUrl) return
  fetchedPrimaryUrl = pick.baseUrl

  console.info(`[EleZone] loading captions "${trackName(pick)}"${isAsr(pick) ? ' (auto-generated)' : ''}`)
  void fetchCaptions(pick.baseUrl).then(async text => {
    // Our own request may be refused where the player's is not, so retry with a
    // URL the player has already used successfully before giving up on it.
    const body = text ?? (playerTimedTextUrl ? await fetchCaptions(playerTimedTextUrl) : null)
    if (body) {
      forward(pick.baseUrl!, body, { replace: true, role: 'primary', asr: isAsr(pick) })
      return
    }
    console.warn('[EleZone] could not download the caption track directly; asking the player to load it')
    needsCaptionReload = true
    reloadLang = pick.languageCode ?? learnLang
    forceCaptionReload()
  })
}

function syncTranslationTrack(): void {
  if (!wantedLang) return
  const want = baseLang(wantedLang)
  if (!want || want === baseLang(learnLang)) return

  // A human-written track in the learner's own language beats a machine one.
  const manual = tracks.find(t => baseLang(t.languageCode) === want && !isAsr(t))
  if (manual?.baseUrl && manual.baseUrl !== fetchedTranslationUrl) {
    fetchedTranslationUrl = manual.baseUrl
    console.info(`[EleZone] using the video's own "${trackName(manual)}" captions as the translation`)
    void fetchCaptions(manual.baseUrl).then(text => {
      if (text) forward(manual.baseUrl!, text, { replace: true, role: 'translation' })
    })
    return
  }

  // Otherwise have YouTube translate the study track. Unlike Netflix — where the
  // two tracks are independent scripts that have to be matched up by overlapping
  // timecodes — this comes back with the same cue boundaries, so the lines pair
  // off exactly.
  const primary = pickPrimary()
  if (!primary?.baseUrl || primary.isTranslatable === false) return
  const key = `${primary.baseUrl}#${want}`
  if (key === fetchedTranslationUrl) return
  fetchedTranslationUrl = key

  console.info(`[EleZone] asking YouTube for a ${want} translation of the captions`)
  void fetchCaptions(primary.baseUrl, { tlang: want }).then(async text => {
    const body = text ?? (playerTimedTextUrl ? await fetchCaptions(playerTimedTextUrl, { tlang: want }) : null)
    if (body) forward(key, body, { replace: true, role: 'translation' })
    else console.warn('[EleZone] no server-side translation available; falling back to machine translation')
  })
}

// ── Player API ────────────────────────────────────────────────────────────────

interface YtPlayer {
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void
  playVideo?: () => void
  pauseVideo?: () => void
  getAdState?: () => number
  loadModule?: (name: string) => void
  setOption?: (module: string, option: string, value: unknown) => void
  getVideoData?: () => { video_id?: string; title?: string; isLive?: boolean }
}

function ytPlayer(): YtPlayer | null {
  const el = document.getElementById('movie_player') as (HTMLElement & YtPlayer) | null
  return el && typeof el.seekTo === 'function' ? el : null
}

/**
 * Make the player fetch the caption track itself, so the response hook can read
 * a body our own request is not allowed to have.
 *
 * Selecting the track is not enough. With captions already on — which they
 * usually are, since that is why the learner turned Video Mode on — asking for
 * the track that is already selected changes nothing, and a player with nothing
 * to change sends no request. That is exactly why turning captions off and on by
 * hand worked when this did not. So the switch is genuinely flipped: off, then
 * back on.
 *
 * Retried rather than done once: at the moment the track list first appears the
 * player element may not exist yet, and a single silent attempt into an empty
 * page would leave Video Mode waiting for ever.
 */
function forceCaptionReload(): void {
  if (havePrimaryPayload || !needsCaptionReload) return
  if (captionReloadAttempts >= 5) return

  const player = ytPlayer()
  // Not ready. Deliberately no attempt counted — this is not a failed try.
  if (!player?.setOption) return

  captionReloadAttempts++
  const languageCode = reloadLang || learnLang
  try {
    player.setOption('captions', 'track', {})
    player.loadModule?.('captions')
    player.setOption('captions', 'track', { languageCode })
  } catch {
    // the player exposes no stable contract here; failing is expected
  }

  // Some builds only answer the button. Left until the API has had a couple of
  // goes, since clicking it can just as easily switch captions off.
  if (captionReloadAttempts >= 3) {
    const btn = document.querySelector<HTMLElement>('.ytp-subtitles-button')
    if (btn?.getAttribute('aria-pressed') === 'false') btn.click()
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return
  const data = e.data as { type?: string; action?: string; timeMs?: number } | null
  if (!data || data.type !== CMD_MSG) return

  const player = ytPlayer()
  const video = document.querySelector<HTMLVideoElement>('video')

  try {
    switch (data.action) {
      case 'seek':
        if (typeof data.timeMs !== 'number') return
        // Through the player API rather than `video.currentTime` so the scrubber
        // and buffer follow along; YouTube has no tamper guard, but a seek its
        // own UI doesn't know about still leaves the progress bar lying.
        if (player?.seekTo) {
          player.seekTo(data.timeMs / 1000, true)
          player.playVideo?.()
        } else if (video) {
          video.currentTime = data.timeMs / 1000
        }
        break
      case 'pause':
        if (player?.pauseVideo) player.pauseVideo()
        else video?.pause()
        break
      case 'play':
        if (player?.playVideo) player.playVideo()
        else void video?.play()
        break
      // 'useCC' is Netflix-only (dubbed titles); nothing to do here.
    }
  } catch {
    console.warn('[EleZone] playback command failed')
  }
})

// ── Ads ───────────────────────────────────────────────────────────────────────

// During an ad the same <video> element keeps playing, but `currentTime` now
// belongs to the ad. Left alone the syncer would show minute-one dialogue and
// the pacing engine would pause, or seek, inside the advert. We report the state
// and the isolated world freezes; we never skip or block anything.
let adShowing = false

function detectAd(): boolean {
  const el = document.getElementById('movie_player')
  if (el?.classList.contains('ad-showing') || el?.classList.contains('ad-interrupting')) return true
  try {
    const state = (el as (HTMLElement & YtPlayer) | null)?.getAdState?.()
    if (typeof state === 'number' && state > 0) return true
  } catch {
    // no such API on this build
  }
  return false
}

function publishAdState(): void {
  const now = detectAd()
  if (now === adShowing) return
  adShowing = now
  console.info(`[EleZone] ${now ? 'ad started — pausing subtitle sync' : 'ad finished — resuming'}`)
  window.postMessage({ type: STATE_MSG, ad: now }, '*')
}

// ── Per-video state ───────────────────────────────────────────────────────────

function currentVideoId(): string {
  try {
    return new URL(location.href).searchParams.get('v') ?? ''
  } catch {
    return ''
  }
}

let videoId = currentVideoId()

function resetForNewVideo(id: string): void {
  console.info(`[EleZone] video changed to ${id}; clearing cached caption tracks`)
  videoId = id
  tracks = []
  fetchedPrimaryUrl = ''
  fetchedTranslationUrl = ''
  playerTimedTextUrl = ''
  noCaptionsReported = false
  havePrimaryPayload = false
  needsCaptionReload = false
  reloadLang = ''
  captionReloadAttempts = 0
  captured.length = 0
  seenUrls.clear()
  readBootstrap()
}

let tick = 0

setInterval(() => {
  const id = currentVideoId()
  if (id && id !== videoId) resetForNewVideo(id)
  publishAdState()
  // The player response can land before this script's hooks are in place on a
  // hard load, and the track list is otherwise never re-fetched.
  if (tracks.length === 0) readBootstrap()
  // Spaced out: each attempt visibly flickers the player's own captions, and
  // the player needs a moment to answer the previous one.
  if (++tick % 6 === 0) forceCaptionReload()
}, 500)

function readBootstrap(): void {
  try {
    const boot = (window as unknown as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse
    if (boot) handlePlayerResponse(boot)
  } catch {
    // not there yet
  }
}

// ── Replay for a late listener ────────────────────────────────────────────────

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return
  const req = e.data as { type?: string; targetLang?: string; learningLang?: string } | null
  if (req?.type !== REQUEST_MSG) return

  if (req.learningLang && req.learningLang !== learnLang) {
    learnLang = req.learningLang
    syncPrimaryTrack()
  }
  if (req.targetLang && req.targetLang !== wantedLang) {
    wantedLang = req.targetLang
    syncTranslationTrack()
  }
  // State is edge-triggered, so a listener that attached mid-ad would never
  // hear about it.
  if (adShowing) window.postMessage({ type: STATE_MSG, ad: true }, '*')
  if (captured.length === 0) return
  console.info(`[EleZone] replaying ${captured.length} captured track(s) to the content script`)
  for (const payload of captured) {
    window.postMessage({ type: BRIDGE_MSG, ...payload }, '*')
  }
})

// ── Response hooks ────────────────────────────────────────────────────────────

const TEXTUAL_CT = /(text\/|xml|json|vtt)/i
const MAX_SNIFF_BYTES = 4 * 1024 * 1024

function handleBody(url: string, text: string): void {
  // A caption body the player fetched itself: the fallback that works when our
  // own signed-URL request is refused.
  if (url.includes('/api/timedtext')) {
    const first = playerTimedTextUrl === ''
    playerTimedTextUrl = url
    // Only adopt it as the study track if we have nothing better. It is whatever
    // the viewer had switched on, which may not be the language being learnt.
    forward(url, text, { replace: fetchedPrimaryUrl === '' })
    // A URL that demonstrably works may make a translation reachable that our
    // own signed-URL attempt could not get.
    if (first) {
      fetchedTranslationUrl = ''
      syncTranslationTrack()
    }
    return
  }
  if (!text.includes('captionTracks')) return
  try {
    handlePlayerResponse(JSON.parse(text))
  } catch {
    // not JSON after all
  }
}

// `/youtubei/v1/player` and `get_transcript` come back as plain JSON, so unlike
// Netflix's MSL manifests they are readable straight off the response. The
// JSON.parse hook stays anyway: it is the only thing that catches a response the
// page decoded by some other route, and the substring guard makes it cheap.
const origJsonParse = JSON.parse

JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
  const result = origJsonParse.call(JSON, text, reviver as never)
  try {
    if (typeof text === 'string' && text.length > 200 && text.includes('captionTracks')) {
      handlePlayerResponse(result)
    }
  } catch {
    // never let instrumentation break the page's own parsing
  }
  return result
} as typeof JSON.parse

window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const response = await origFetch.call(this, input as RequestInfo, init)
  try {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : (input as Request).url
    const ct = response.headers.get('content-type') ?? ''
    const len = Number(response.headers.get('content-length') ?? '0')
    const interesting = url.includes('/api/timedtext') || url.includes('/youtubei/v1/')
    if (interesting && (!ct || TEXTUAL_CT.test(ct)) && len <= MAX_SNIFF_BYTES && !seenUrls.has(url)) {
      response.clone().text().then(text => handleBody(url, text)).catch(() => { })
    }
  } catch {
    // never let instrumentation break the page's own request
  }
  return response
}

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
  if (url && !seenUrls.has(url) && (url.includes('/api/timedtext') || url.includes('/youtubei/v1/'))) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          const text = this.responseText
          if (text && text.length <= MAX_SNIFF_BYTES) handleBody(url, text)
        }
      } catch {
        // unreadable response
      }
    })
  }
  return (origSend as (...a: unknown[]) => void).call(this, ...args)
}

readBootstrap()
