// Parses Netflix subtitle tracks (WebVTT / TTML) into cues.
//
// The actual network hooking happens in `content/videoModeMainWorld.ts`, which
// runs in the page's MAIN world — a content script's `window.fetch` is a
// different object from the page's, so patching it here would never fire. That
// script posts the raw payload over `window.postMessage`; we parse it below.

export interface SubtitleCue {
  index: number
  startTime: number  // seconds
  endTime: number    // seconds
  text: string       // plain text, HTML stripped
}

type CuesCallback = (cues: SubtitleCue[]) => void

let _callback: CuesCallback | null = null
let _translationCallback: CuesCallback | null = null
let _bridgeListening = false
// Netflix fetches several tracks (forced narrative, full dialogue, other
// languages). We keep the richest one seen so a sparse "forced" track can't
// clobber a full dialogue list that arrived earlier.
let _bestCueCount = 0
// Set from the bridge payload; decides both how cues are grouped and whether the
// strip warns the learner that the text is machine-transcribed.
let _lastTrackWasAsr = false

// ── WebVTT parser ─────────────────────────────────────────────────────────────

/** `[HH:]MM:SS[.mmm]` → seconds. Returns NaN when the stamp is unparseable. */
function vttTime(raw: string): number {
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/)
  if (!m) return NaN
  const hours = m[1] ? parseInt(m[1], 10) : 0
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0
  return hours * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms / 1000
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseWebVTT(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  // Netflix serves CRLF. Splitting on /\n\n+/ never matched "\r\n\r\n", so the
  // whole file collapsed into a single block — one cue holding the entire script.
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
  let idx = 0

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    const timingIdx = lines.findIndex(l => l.includes('-->'))
    if (timingIdx === -1) continue

    const [rawStart, rawEnd] = lines[timingIdx].split('-->')
    if (rawEnd === undefined) continue

    const startTime = vttTime(rawStart)
    // Trailing cue settings ("line:90% align:middle") follow the end stamp.
    const endTime = vttTime(rawEnd.trim().split(/\s+/)[0])
    if (!isFinite(startTime) || !isFinite(endTime)) continue

    const body = stripHtml(lines.slice(timingIdx + 1).join(' '))
    if (!body) continue

    cues.push({ index: idx++, startTime, endTime, text: body })
  }

  return cues
}

// ── TTML / DFXP parser ────────────────────────────────────────────────────────

// Netflix's DFXP tracks express times in ticks ("93760000t") against a
// ttp:tickRate on the root element, not as clock stamps.
function ttmlTimeToSeconds(raw: string, tickRate: number): number {
  const t = raw.trim()
  if (!t) return NaN

  const ticks = t.match(/^([\d.]+)t$/)
  if (ticks) return parseFloat(ticks[1]) / tickRate

  const seconds = t.match(/^([\d.]+)s$/)
  if (seconds) return parseFloat(seconds[1])

  const ms = t.match(/^([\d.]+)ms$/)
  if (ms) return parseFloat(ms[1]) / 1000

  // HH:MM:SS[.mmm] or HH:MM:SS:frames
  const frames = t.match(/^(\d+):(\d+):(\d+):(\d+)$/)
  if (frames) {
    return parseInt(frames[1]) * 3600 + parseInt(frames[2]) * 60 +
      parseInt(frames[3]) + parseInt(frames[4]) / 30
  }
  const clock = t.match(/^(\d+):(\d+):(\d+)(?:[.,](\d+))?$/)
  if (clock) {
    return parseInt(clock[1]) * 3600 + parseInt(clock[2]) * 60 +
      parseInt(clock[3]) + (clock[4] ? parseFloat(`0.${clock[4]}`) : 0)
  }
  return NaN
}

// `textContent` ignores <br/>, so a two-line cue came out with the line break
// swallowed and the words either side jammed together ("the hellare you").
function ttmlText(node: Node): string {
  let out = ''
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue ?? ''
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      out += (child as Element).localName === 'br' ? ' ' : ttmlText(child)
    }
  })
  return out
}

export function parseTTML(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml')
    if (doc.querySelector('parsererror')) return cues

    const root = doc.documentElement
    const tickRate = parseFloat(
      root?.getAttribute('ttp:tickRate') || root?.getAttribute('tickRate') || '10000000'
    ) || 10000000

    let idx = 0
    doc.querySelectorAll('p[begin]').forEach(p => {
      const startTime = ttmlTimeToSeconds(p.getAttribute('begin') || '', tickRate)
      const end = p.getAttribute('end')
      const dur = p.getAttribute('dur')
      const endTime = end
        ? ttmlTimeToSeconds(end, tickRate)
        : startTime + ttmlTimeToSeconds(dur || '', tickRate)
      if (!isFinite(startTime) || !isFinite(endTime)) return

      const body = ttmlText(p).replace(/\s+/g, ' ').trim()
      if (!body) return
      cues.push({ index: idx++, startTime, endTime, text: body })
    })
  } catch {
    // parse error — return empty
  }
  return cues
}

// ── YouTube json3 parser ──────────────────────────────────────────────────────

// `fmt=json3` gives an event per cue, each holding word-level segments:
//   { tStartMs, dDurationMs, segs: [{ utf8, tOffsetMs }, ...] }
//
// Auto-generated tracks add "rolling" events that re-print the tail of the
// previous line so the on-screen caption can grow a word at a time. Those carry
// `aAppend: 1` and must be dropped, or every line appears two or three times.

interface Json3Segment {
  utf8?: string
  tOffsetMs?: number
}

interface Json3Event {
  tStartMs?: number
  dDurationMs?: number
  segs?: Json3Segment[]
  aAppend?: number
  /** Present on window-definition events, which carry no text. */
  id?: number
}

export function parseJson3(text: string): SubtitleCue[] {
  let parsed: { events?: Json3Event[] }
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const events = parsed?.events
  if (!Array.isArray(events)) return []

  const cues = collectJson3(events, true)
  // `aAppend` marking the rolling duplicates is an observed convention, not a
  // documented one. If honouring it throws the whole track away, it did not mean
  // here what it usually means — better a track with some repeated lines than no
  // track at all.
  if (cues.length === 0) return collectJson3(events, false)
  return cues
}

function collectJson3(events: Json3Event[], dropAppends: boolean): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let idx = 0
  for (const event of events) {
    if (dropAppends && event.aAppend) continue
    if (typeof event.tStartMs !== 'number' || !Array.isArray(event.segs)) continue

    const body = event.segs
      .map(s => s.utf8 ?? '')
      .join('')
      // Auto captions use a bare newline where a human track would use a space.
      .replace(/\s+/g, ' ')
      .trim()
    if (!body) continue

    const startTime = event.tStartMs / 1000
    // Duration is missing on the last event of some tracks; a short default is
    // better than NaN, and the endTime clamp below fixes it up anyway.
    const endTime = startTime + (typeof event.dDurationMs === 'number' ? event.dDurationMs : 2000) / 1000
    cues.push({ index: idx++, startTime, endTime, text: body })
  }

  return cues
}

// ── Legacy timedtext XML ──────────────────────────────────────────────────────

// What `/api/timedtext` returns without `fmt`: <transcript><text start dur>.
// Reached only when the json3 request was refused, but that is exactly the case
// where it is the one body we have.
export function parseTimedTextXml(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml')
    if (doc.querySelector('parsererror')) return cues

    let idx = 0
    doc.querySelectorAll('text').forEach(node => {
      const startTime = parseFloat(node.getAttribute('start') ?? '')
      const dur = parseFloat(node.getAttribute('dur') ?? '2')
      if (!isFinite(startTime)) return
      // Bodies are HTML-escaped twice ("&amp;#39;"), so decode via textContent
      // and then run the ordinary entity pass over what comes out.
      const body = stripHtml(node.textContent ?? '')
      if (!body) return
      cues.push({
        index: idx++,
        startTime,
        endTime: startTime + (isFinite(dur) ? dur : 2),
        text: body,
      })
    })
  } catch {
    // parse error — return empty
  }
  return cues
}

// ── Sentence merging ──────────────────────────────────────────────────────────

// Cues are stitched into study-sized blocks for two separate reasons.
//
// 1. Netflix splits one sentence across consecutive cues to keep each on screen
//    long enough to read ("What the hell" / "are you made of?"). Left alone
//    those become half-sentence rows highlighted for under a second.
//
// 2. Short complete sentences delivered in the same breath ("Yes." / "Who are
//    you?") are separate cues but a single moment on screen. Punctuation says
//    leave them apart; the clock says they belong together, and the clock is
//    right — a row that is current for half a second is no use whether or not
//    it ends in a full stop. So a block keeps absorbing the next cue until it
//    holds enough text to be worth a row of its own.

const SENTENCE_END = /[.!?…]["'”’)\]]?\s*$/
// Sound descriptions and lyrics are standalone, never a continuation.
const STANDALONE = /^\s*[[(♪]/
// A leading dash introduces a second speaker sharing the cue.
const NEW_SPEAKER = /^\s*[-–—]\s/

// A block holding less than this reads as a fragment, so it keeps taking in the
// next cue until it clears the bar. Measured in characters, not seconds: Netflix
// times a cue by how long it takes to *read*, not to say — its own guide sets a
// 5/6s floor and a 7s ceiling — so a two-word line still occupies two seconds,
// and cue duration cannot tell a short line from a long one. Netflix caps a
// subtitle line at 42 characters, so this is about two full lines.
const MIN_BLOCK_CHARS = 80
// Silence that may sit between two cues joined for being one moment.
const MAX_JOIN_GAP_SECONDS = 0.6
// Silence a split sentence may bridge.
const MAX_GAP_SECONDS = 2
const MAX_MERGED_CHARS = 220

// Auto-generated captions invert the assumption above: their cue boundaries
// come from the recogniser's buffer, and a cue's duration really is how long the
// line took to say. So for those the clock is the better ruler and the character
// count is the wrong one — a block keeps growing until it holds enough *speech*.
const MIN_BLOCK_SECONDS = 2.5
const MAX_MERGED_SECONDS = 9
// Recognisers emit back-to-back cues with no silence between them, so the gap
// thresholds have to be tighter than a human track's.
const ASR_JOIN_GAP_SECONDS = 0.4
const ASR_MAX_GAP_SECONDS = 1

/** How cue timings should be read — see the two blocks of constants above. */
export type CueTiming = 'reading' | 'spoken'

function isContinuation(prev: SubtitleCue, next: SubtitleCue, timing: CueTiming): boolean {
  // Sound effects and lyrics always stand alone.
  if (STANDALONE.test(prev.text) || STANDALONE.test(next.text)) return false
  if (prev.text.length + next.text.length > MAX_MERGED_CHARS) return false

  const gap = next.startTime - prev.endTime

  if (timing === 'spoken') {
    if (next.endTime - prev.startTime > MAX_MERGED_SECONDS) return false
    // The block so far is barely a breath — take the next cue whatever the
    // punctuation says.
    if (prev.endTime - prev.startTime < MIN_BLOCK_SECONDS && gap <= ASR_JOIN_GAP_SECONDS) return true
    if (SENTENCE_END.test(prev.text)) return false
    if (NEW_SPEAKER.test(next.text)) return false
    return gap <= ASR_MAX_GAP_SECONDS
  }

  // Reason 2: the block so far is a fragment and the next cue follows straight
  // on, so the two are really one moment on screen.
  if (
    prev.text.length + next.text.length <= MIN_BLOCK_CHARS &&
    gap <= MAX_JOIN_GAP_SECONDS
  ) return true

  // Reason 1: a sentence split for reading pace.
  if (SENTENCE_END.test(prev.text)) return false
  if (NEW_SPEAKER.test(next.text)) return false
  if (gap > MAX_GAP_SECONDS) return false
  return true
}

export function mergeSentenceCues(cues: SubtitleCue[], timing: CueTiming = 'reading'): SubtitleCue[] {
  const merged: SubtitleCue[] = []
  for (const cue of cues) {
    const prev = merged[merged.length - 1]
    // A recogniser re-printing the line it just emitted is not a repetition in
    // the dialogue; two identical, overlapping cues are always an artefact.
    if (prev && prev.text === cue.text && cue.startTime < prev.endTime) {
      prev.endTime = Math.max(prev.endTime, cue.endTime)
      continue
    }
    if (prev && isContinuation(prev, cue, timing)) {
      prev.text = `${prev.text} ${cue.text}`
      prev.endTime = cue.endTime  // the row now spans the whole sentence
      continue
    }
    merged.push({ ...cue })
  }
  // Netflix can overlap cues (two speakers positioned separately). The syncer
  // treats the current cue as "the last one that started", so an overlap would
  // hand the next cue the current slot before this one's end is ever reached —
  // and its end drives repeat and the shadowing gap. Clamp so they never do.
  for (let i = 0; i < merged.length - 1; i++) {
    merged[i].endTime = Math.min(merged[i].endTime, merged[i + 1].startTime)
  }

  // Indices are positional; the syncer and the sidebar both rely on that.
  return merged.map((cue, index) => ({ ...cue, index }))
}

// ── Sound descriptions ────────────────────────────────────────────────────────

/**
 * Whether a cue is a sound description rather than dialogue.
 *
 * Nothing in WebVTT or TTML marks these structurally — Netflix's style guide
 * just wraps them in square brackets ("[door opens]"). The same guide puts
 * speaker labels in brackets too ("[Esther] Martin?"), so the test has to be
 * that the *whole* cue is bracketed, not that it contains a bracket.
 */
export function isSoundDescription(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/^\[[^\]]*\]$/.test(trimmed)) return true
  if (/^\([^)]*\)$/.test(trimmed)) return true
  // A cue of nothing but music symbols marks a passage of song with no lyrics
  // transcribed. Lyrics that do have words are language, so they stay.
  if (/^[♪♫\s]+$/.test(trimmed)) return true
  return false
}

// ── Generic parse dispatch ────────────────────────────────────────────────────

function parseSubtitleText(url: string, text: string, timing: CueTiming = 'reading'): SubtitleCue[] {
  const head = text.slice(0, 512)

  // Sniff the body before the URL: YouTube's caption URLs say nothing about
  // format, and Netflix's CDN links say nothing at all.
  if (/^\s*\{/.test(head)) {
    const json3 = parseJson3(text)
    if (json3.length > 0) return mergeSentenceCues(json3, timing)
  }
  if (/<(transcript|timedtext)\b/i.test(head)) {
    const xml = parseTimedTextXml(text)
    if (xml.length > 0) return mergeSentenceCues(xml, timing)
  }

  const lower = url.toLowerCase()
  if (lower.includes('ttml') || lower.includes('dfxp') || lower.endsWith('.ttml') || lower.endsWith('.dfxp')) {
    const cues = parseTTML(text)
    if (cues.length > 0) return mergeSentenceCues(cues, timing)
  }
  const vttCues = parseWebVTT(text)
  if (vttCues.length > 0) return mergeSentenceCues(vttCues, timing)

  const ttml = parseTTML(text)
  if (ttml.length > 0) return mergeSentenceCues(ttml, timing)
  // Last resort: <transcript> without a recognisable head (a stray BOM, say).
  return mergeSentenceCues(parseTimedTextXml(text), timing)
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

// The target-language track feeds the translation line, not the study line, so
// it bypasses the cue-count watermark entirely.
function dispatchTranslation(url: string, text: string, timing: CueTiming) {
  if (!_translationCallback) return
  try {
    const cues = parseSubtitleText(url, text, timing)
    console.info(`[EleZone] parsed ${cues.length} translation cues`)
    if (cues.length > 0) _translationCallback(cues)
  } catch (err) {
    console.warn('[EleZone] translation track parse failed', err)
  }
}

function maybeDispatch(url: string, text: string, replace = false, timing: CueTiming = 'reading') {
  if (!_callback) {
    console.warn('[EleZone] subtitle payload arrived before Video Mode was listening')
    return
  }
  try {
    const cues = parseSubtitleText(url, text, timing)
    console.info(
      `[EleZone] parsed ${cues.length} cues (sentence-merged) from ${text.length} bytes` +
      (cues.length > 0 ? `, first at ${cues[0].startTime.toFixed(1)}s: "${cues[0].text.slice(0, 60)}"` : '')
    )
    // One cue for a whole file means the block splitting failed; zero means the
    // format wasn't recognised. Either way the payload head identifies it.
    if (cues.length <= 1) {
      console.warn('[EleZone] subtitle payload not understood, first 300 chars:',
        JSON.stringify(text.slice(0, 300)))
    }
    // `replace` marks the track the viewer selected in the player — it wins
    // outright, since a longer track is not necessarily the right one.
    if (replace ? cues.length > 0 : cues.length > _bestCueCount) {
      warnIfTrackDoesNotFitVideo(cues)
      _bestCueCount = cues.length
      _callback(cues)
    }
  } catch (err) {
    console.warn('[EleZone] subtitle parse failed', err)
  }
}

// A track belonging to another episode is the one failure that looks like
// everything is working — full sidebar, sensible sentences, wrong dialogue.
// Its span won't fit this video's runtime, which is cheap to check.
function warnIfTrackDoesNotFitVideo(cues: SubtitleCue[]): void {
  const duration = document.querySelector<HTMLVideoElement>('video')?.duration
  if (!duration || !isFinite(duration) || cues.length === 0) return

  const lastCueEnd = cues[cues.length - 1].endTime
  if (lastCueEnd > duration + 120 || lastCueEnd < duration * 0.5) {
    console.warn(
      `[EleZone] subtitle track spans ${Math.round(lastCueEnd)}s but the video runs ` +
      `${Math.round(duration)}s — this track probably belongs to a different episode`
    )
  }
}

// ── MAIN-world bridge ─────────────────────────────────────────────────────────

const BRIDGE_MSG = 'ELEZONE_SUBTITLE_PAYLOAD'
const REQUEST_MSG = 'ELEZONE_SUBTITLE_REQUEST'

function onBridgeMessage(e: MessageEvent) {
  if (e.source !== window) return
  const data = e.data as {
    type?: string; url?: string; text?: string; replace?: boolean; role?: string; asr?: boolean
  } | null
  if (!data || data.type !== BRIDGE_MSG || typeof data.text !== 'string') return

  if (data.role === 'translation') {
    // A server-side translation follows the study track's own boundaries, so it
    // has to be grouped the same way or the two lists stop lining up.
    dispatchTranslation(data.url ?? '', data.text, _lastTrackWasAsr ? 'spoken' : 'reading')
    return
  }
  console.info(`[EleZone] received subtitle payload (${data.text.length} bytes)`)
  _lastTrackWasAsr = data.asr === true
  maybeDispatch(data.url ?? '', data.text, data.replace === true, _lastTrackWasAsr ? 'spoken' : 'reading')
}

/** Whether the cues currently in play came from auto-generated captions. */
export function isAutoGeneratedTrack(): boolean {
  return _lastTrackWasAsr
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start listening for subtitle payloads.
 *
 * `targetLang` is passed to the MAIN world so it can also grab Netflix's own
 * subtitles in that language, which are handed to `onTranslationCues`.
 */
export function installSubtitleInterceptor(
  cb: CuesCallback,
  opts: { targetLang?: string; learningLang?: string; onTranslationCues?: CuesCallback } = {},
): void {
  _callback = cb
  _translationCallback = opts.onTranslationCues ?? null
  if (!_bridgeListening) {
    window.addEventListener('message', onBridgeMessage)
    _bridgeListening = true
  }
  // Ask for anything captured before we were listening.
  window.postMessage({
    type: REQUEST_MSG,
    targetLang: opts.targetLang,
    learningLang: opts.learningLang,
  }, '*')
}

/**
 * Stop dispatching cues. The message listener stays attached so a track that
 * arrives while video mode is off is still picked up when it's turned back on.
 */
export function uninstallSubtitleInterceptor(): void {
  _callback = null
  _translationCallback = null
}

/** Re-ask the MAIN world for the current title's tracks. */
export function requestSubtitleReplay(targetLang?: string, learningLang?: string): void {
  window.postMessage({ type: REQUEST_MSG, targetLang, learningLang }, '*')
}

/**
 * Forget the best-track watermark. Required when moving to another title or
 * episode, whose track may legitimately have fewer cues than the last one.
 */
export function resetSubtitleInterceptor(): void {
  _bestCueCount = 0
  _lastTrackWasAsr = false
}
