// Context-aware word translation for the "save word" flow.
//
// Problem: translating a selected word in isolation loses its sentence meaning
// ("bank" → ngân hàng instead of bờ sông). We fix this with a two-step hybrid:
//
//   1. Disambiguate (on-device Gemini Nano via LanguageModel, ENGLISH only):
//      pick the shortest unambiguous English equivalent of the word as used in
//      the sentence. 
//      REASON: Chrome's LanguageModel API (Gemini Nano) currently enforces strict safety checks
//      and ONLY allows outputting specific supported languages (en, fr, de, es, ja). If we prompt
//      it to output an unsupported language like Vietnamese, Chrome throws a 
//      "No output language was specified" error and blocks the response.
//      Therefore, we must configure `expectedOutputs: ['en']` and instruct the AI to return 
//      an English synonym instead.
//
//   2. Translate that equivalent to the target language with the on-device
//      Translator (high quality), falling back to Google translate.
//      REASON: Chrome's Translator API (which is specifically built for translation) and 
//      Google Translate do not have these strict language output limits. Thus, we use them 
//      to translate the English synonym (obtained in Step 1) into the user's target language.
//
// Fallback when no on-device model is available: Google's dictionary endpoint
// (dt=bd) returns multiple candidate senses for the user to pick from.
//
// Runs in the background service worker, where the built-in AI globals are
// available (they are typically NOT exposed in content-script isolated worlds).

import { DEFAULT_SETTINGS, PhoneticsSourceSetting } from '../shared/types'

export type TranslateSource =
  | 'ai+on-device'    // Gemini Nano disambiguated → on-device Translator
  | 'ai+google'       // Gemini Nano disambiguated → Google Translate
  | 'google-context'  // Google sentence diff (translate with/without word, extract delta)
  | 'google-senses'   // Google dictionary senses (no on-device model)
  | 'google-basic'    // Google plain translate (last resort)

export type ContextTranslateResult =
  | { mode: 'context'; translation: string; senses: string[]; source: TranslateSource; sourceLang?: string; phonetics?: string }
  | { mode: 'senses'; senses: string[]; source: TranslateSource; sourceLang?: string; phonetics?: string }

export interface ContextTranslateRequest {
  word: string
  sentence: string
  targetLang: string
  disableAI?: boolean
  disableGoogleContext?: boolean
  disableGoogleSenses?: boolean
  // Language of `word` itself (not the translation target), read from the
  // page's `lang` attribute at lookup time — used to gate dictionaryapi.dev,
  // which only covers a fixed set of languages and would mislabel e.g. a
  // French word that happens to spell like an English one.
  sourceLang?: string
  // Falls back to this when `sourceLang` isn't available for the lookup.
  learningLanguage?: string
  phoneticsSourceOrder?: PhoneticsSourceSetting[]
}


// ── On-device AI: direct context-aware translation (single prompt) ────────────



let lmSession: LanguageModelSession | null = null

async function getLmSession(): Promise<LanguageModelSession | null> {
  const LM = globalThis.LanguageModel
  if (!LM) return null
  try {
    if ((await LM.availability({ expectedOutputs: [{ type: 'text', languages: ['en'] }] })) !== 'available') return null
  } catch {
    return null
  }
  if (lmSession) return lmSession
  try {
    // Force Chrome to recognize that this session will only output English.
    // This prevents the security error that blocks output for unsupported languages like Vietnamese.
    lmSession = await LM.create({
      expectedOutputs: [{ type: 'text', languages: ['en'] }]
    })
    return lmSession
  } catch {
    lmSession = null
    return null
  }
}

function cleanTranslation(raw: string): string {
  let s = (raw.split('\n')[0] ?? '').trim()
  // Strip quotes/backticks and trailing punctuation/whitespace repeatedly until
  // stable — a single pass leaves quotes stranded when a trailing period comes
  // after them (e.g. `"bank".` → stripping quotes first sees a trailing `.`,
  // not a quote, so the quote around "bank" survives as `bank"`).
  let prev: string
  do {
    prev = s
    s = s
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[.\s]+$/, '')
      .trim()
  } while (s !== prev)
  return s
}

async function aiTranslateInContext(word: string, sentence: string): Promise<string | null> {
  // Workaround prompt: We only request an English synonym so that Nano produces valid, supported output.
  const prompt =
    `Original sentence: ${sentence}\n\n` +
    `What is the shortest, simplest English synonym or equivalent of the word "${word}" as used in that sentence? ` +
    `Reply with ONLY the synonym itself, no explanation, no quotes.`

  for (let attempt = 0; attempt < 2; attempt++) {
    const base = await getLmSession()
    if (!base) return null

    // Clone per call so concurrent lookups don't bleed context into each other.
    let session: LanguageModelSession | null = null
    try {
      session = await base.clone().catch(() => base)
      const out = await session.prompt(prompt)
      return cleanTranslation(out) || null
    } catch {
      lmSession = null // session invalidated (SW recycled) — retry once
    } finally {
      if (session && session !== base) session.destroy()
    }
  }
  return null
}

// ── Google fallback (free, no key, no account) ─────────────────────────────────

const GT_BASE = 'https://translate.googleapis.com/translate_a/single?client=gtx'

async function googleTranslate(text: string, tgt: string): Promise<string | null> {
  try {
    const url = `${GT_BASE}&sl=auto&tl=${encodeURIComponent(tgt)}&dt=t&q=${encodeURIComponent(text)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as [Array<[string, ...unknown[]]>, ...unknown[]]
    return json[0].map(chunk => chunk[0]).join('')
  } catch {
    return null
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Translate the sentence with and without the word, then diff to find the word's
// translation in context. E.g. "scorching summer" → "mùa hè thiêu đốt"; remove
// "scorching" → "mùa hè"; diff → "thiêu đốt". Works without any AI model.
async function googleContextTranslate(word: string, sentence: string, tgt: string): Promise<string | null> {
  if (!sentence || sentence === word) return null

  // \b is \w-based (ASCII letter/digit/_ only), so it fails to bound words like
  // "C++" or "C#" whose edges sit next to other non-word characters. Use
  // unicode-aware lookaround boundaries instead so any word actually present
  // in the sentence gets masked.
  const masked = sentence
    .replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'giu'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (masked === sentence) return null // word not in sentence

  const [full, maskedTr] = await Promise.all([
    googleTranslate(sentence, tgt),
    googleTranslate(masked, tgt),
  ])
  if (!full || !maskedTr) return null

  // Count token frequencies in the masked translation.
  const maskedCount = new Map<string, number>()
  for (const t of maskedTr.toLowerCase().split(/\s+/).filter(Boolean)) {
    maskedCount.set(t, (maskedCount.get(t) ?? 0) + 1)
  }

  // Collect tokens in the full translation that don't appear (or appear more
  // times) than in the masked translation — these are the "added" words from
  // translating the target word in its sentence context.
  const newTokens: string[] = []
  for (const t of full.split(/\s+/).filter(Boolean)) {
    const lower = t.toLowerCase()
    const cnt = maskedCount.get(lower) ?? 0
    if (cnt > 0) {
      maskedCount.set(lower, cnt - 1)
    } else {
      newTokens.push(t)
    }
  }

  if (newTokens.length === 0) return null
  // Reject if the diff is suspiciously long (sentence restructuring, not a word diff).
  if (newTokens.length > 4) return null

  return newTokens.join(' ')
}

async function googleSenses(word: string, tgt: string): Promise<{ senses: string[]; sourceLang?: string; phonetics?: string }> {
  try {
    const url =
      `${GT_BASE}&sl=auto&tl=${encodeURIComponent(tgt)}&dt=t&dt=bd&dt=rm&q=${encodeURIComponent(word)}`
    const res = await fetch(url)
    if (!res.ok) return { senses: [] }
    const json = (await res.json()) as [
      Array<[string | null, string | null, ...unknown[]]> | null,
      Array<[string, string[], ...unknown[]]> | null,
      string,
      ...unknown[],
    ]

    const sourceLang = typeof json[2] === 'string' ? json[2] : undefined
    let phonetics: string | undefined
    
    if (Array.isArray(json[0]) && json[0].length > 0) {
      const lastChunk = json[0][json[0].length - 1]
      // Romanization/Phonetics usually appears at the end of the chunks array with nulls for texts.
      if (lastChunk && lastChunk.length >= 4 && typeof lastChunk[3] === 'string' && lastChunk[3].trim()) {
        phonetics = lastChunk[3].trim()
      }
    }

    // Plain translation goes FIRST — it's the most reliable sense and avoids
    // slang/rare dictionary entries landing as the auto-filled default.
    const plain = Array.isArray(json[0])
      ? json[0].map(chunk => chunk[0] || '').join('').trim()
      : ''

    const dictSenses: string[] = []
    const dict = json[1]
    if (Array.isArray(dict)) {
      for (const entry of dict) {
        const terms = entry?.[1]
        if (Array.isArray(terms)) {
          for (const term of terms) if (typeof term === 'string') dictSenses.push(term)
        }
      }
    }

    // Deduplicate keeping plain first, then dict senses (skip ones already in plain).
    const seen = new Set<string>()
    const result: string[] = []
    for (const s of [plain, ...dictSenses]) {
      const t = s.trim()
      if (t && !seen.has(t)) { seen.add(t); result.push(t) }
    }
    return { senses: result.slice(0, 6), sourceLang, phonetics }
  } catch {
    return { senses: [] }
  }
}

// ── Free Dictionary API (dictionaryapi.dev): real dictionary IPA ──────────────
//
// Community-run, free, no key — but no SLA, so every call gets a timeout and a
// per-word cache. The cache lives only as long as this service worker instance
// (Chrome unloads it after ~30s idle, sometimes sooner), so it can't grow
// across a long-lived process — the size cap below is a defensive backstop for
// the rare case a worker stays alive longer (open DevTools, active ports).
const PHONETICS_CACHE_MAX = 500
// `approximate: true` means `value` isn't this exact word's own dictionary
// entry — it's a reading borrowed from a fallback (the singular of a plural,
// one half of a hyphenated compound, etc. — see the fallback chain below).
// Still meaningfully useful, but the content script dims it to signal
// "close, not guaranteed exact" rather than showing it with the same
// confidence as a word's own real entry.
const phoneticsCache = new Map<string, { value: string | null; approximate: boolean }>()

function cachePhonetics(word: string, value: string | null, approximate: boolean) {
  if (phoneticsCache.size >= PHONETICS_CACHE_MAX && !phoneticsCache.has(word)) {
    const oldestKey = phoneticsCache.keys().next().value
    if (oldestKey !== undefined) phoneticsCache.delete(oldestKey)
  }
  phoneticsCache.set(word, { value, approximate })
}

// Read Aloud's paragraph mode wraps every sentence in a paragraph up front,
// each firing its own word batch — a several-sentence paragraph can mean 50+
// words all wanting a lookup in the same instant. Without a cap, that's 50+
// concurrent requests at once to a free, unauthenticated, no-SLA API — the
// observed result was most of them timing out or getting throttled and
// coming back non-definitive (only a word or two in a whole sentence ever
// got a real result). Funneling every dictionaryapi.dev call through one
// small queue keeps only a handful in flight at a time regardless of how
// many words asked at once, so the API sees the same request pattern a
// normal user reading one word at a time would.
const MAX_CONCURRENT_DICT_FETCHES = 6
let activeDictFetches = 0
// Two separate waiting lines, not one — a word from the sentence actually on
// screen right now and a word from Read Aloud's look-ahead prefetch (up to 4
// sentences not on screen yet) used to queue FIFO together, so a big
// paragraph's prefetch could sit ahead of and delay the very sentence the
// user is looking at right now waiting for its own reading. `high` always
// drains before `low` regardless of arrival order — prefetch only ever uses
// a slot the current sentence didn't want yet.
const dictFetchQueueHigh: Array<() => void> = []
const dictFetchQueueLow: Array<() => void> = []

// Capping *concurrency* alone turned out not to be enough on its own: a run
// of 429s comes back in single-digit milliseconds (there's no real work
// happening server-side to wait on), so 6-at-a-time still let a big batch
// cycle through all 150+ words in well under a second — plenty fast to blow
// past dictionaryapi.dev's per-IP rate limit, at which point *most* of the
// batch comes back 429 instead of a real answer. This paces the actual
// dispatch rate independently of concurrency, so a burst can't out-race the
// limit just because responses happen to come back fast.
const MIN_DISPATCH_GAP_MS = 120
let nextAllowedDispatchTime = 0

async function acquireDictFetchSlot(priority: 'high' | 'low' = 'high'): Promise<void> {
  if (activeDictFetches >= MAX_CONCURRENT_DICT_FETCHES) {
    const queue = priority === 'high' ? dictFetchQueueHigh : dictFetchQueueLow
    await new Promise<void>(resolve => queue.push(resolve))
  }
  activeDictFetches++

  const now = Date.now()
  const waitUntil = Math.max(now, nextAllowedDispatchTime)
  nextAllowedDispatchTime = waitUntil + MIN_DISPATCH_GAP_MS
  if (waitUntil > now) await new Promise(resolve => setTimeout(resolve, waitUntil - now))
}

function releaseDictFetchSlot(): void {
  activeDictFetches--
  // High-priority waiters always get the freed slot first — a low-priority
  // (prefetch) request already in flight isn't preempted, only *future*
  // slot grants are reordered, so this never cancels work already dispatched.
  ;(dictFetchQueueHigh.shift() ?? dictFetchQueueLow.shift())?.()
}

/**
 * `definitive: true` means the API actually answered the question — there is
 * (or isn't) a phonetic transcription for this word — so it's safe to
 * remember. `false` means the request itself didn't get an answer (network
 * error, timeout, a 5xx/429 from the API): that's not evidence the word has
 * no phonetics, just that this attempt failed, so it must not be cached —
 * caching it would permanently mistake "the request failed once" for "this
 * word has no phonetics".
 */
type DictStatus = { value: string | null; definitive: boolean; approximate: boolean }

// Concurrent callers asking for the *same* word before the first lookup has
// finished caching it — common with a shared word ("the", "and"...) appearing
// in several sentences a big paragraph batch fires off in the same instant —
// otherwise each independently misses the cache and dispatches its own
// redundant fetch. Sharing the in-flight Promise means only the first caller
// actually hits the network; everyone else just awaits the same result.
const dictInFlight = new Map<string, Promise<DictStatus>>()

async function fetchDictionaryApiWordStatus(
  rawWord: string,
  priority: 'high' | 'low' = 'high',
): Promise<DictStatus> {
  const word = rawWord.toLowerCase()
  const cached = phoneticsCache.get(word)
  if (cached !== undefined) return { ...cached, definitive: true }

  const pending = dictInFlight.get(word)
  if (pending) return pending

  const request = fetchDictionaryApiWordStatusUncached(word, priority)
  dictInFlight.set(word, request)
  try {
    return await request
  } finally {
    dictInFlight.delete(word)
  }
}

async function fetchDictionaryApiWordStatusUncached(word: string, priority: 'high' | 'low'): Promise<DictStatus> {
  let value: string | null = null
  let approximate = false
  let definitive = false
  // A 429 specifically gets a couple of short-backoff retries — the pacing
  // above should mean this is rare, but a second paragraph's batch starting
  // while the first is still draining can still overlap. Anything else
  // (network error, our own 3s abort, 5xx) is left to the caller's normal
  // "not definitive, try again whenever this word next comes up" path
  // instead of retried here.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Wait for a free slot *before* starting the timeout clock — starting it
    // while still queued behind other words would abort this one for having
    // taken "too long" without it ever having gotten a request out the door.
    await acquireDictFetchSlot(priority)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 3000)
    let status = 0
    try {
      const res = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
        { signal: controller.signal },
      )
      status = res.status
      if (res.ok) {
        definitive = true
        const entries = (await res.json()) as Array<{
          phonetic?: string
          phonetics?: Array<{ text?: string }>
        }>
        for (const entry of entries) {
          const text = entry.phonetic?.trim() || entry.phonetics?.find(p => p.text?.trim())?.text?.trim()
          if (text) { value = text; break }
        }
      } else if (res.status === 404) {
        // "No Definitions Found" — a real, final answer, not a fluke.
        definitive = true
      }
      // Any other non-ok status (5xx, 429...) falls through as non-definitive.
    } catch {
      // Network error or our own 3s abort — non-definitive.
    } finally {
      clearTimeout(timeoutId)
      releaseDictFetchSlot()
    }
    if (status !== 429) break
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
  }

  // A handful of English word-formation patterns dictionaryapi.dev's flat,
  // one-entry-per-headword dataset doesn't compose on its own — all handled
  // as *fallbacks after* the direct lookup, tried in this order, so a word
  // that genuinely has its own entry (like "let's" /lɛts/, "don't" /dəʊnt/,
  // or "cats" /kæts/ — inflected forms are inconsistently but often present
  // on their own) always gets that exact reading first, never a synthesized
  // approximation:
  //
  // - A possessive/contraction suffix ("immigrant's", "it's" with no entry
  //   of its own) — retry stripped of the trailing 's ("immigrant", "it").
  // - A hyphenated compound ("sky-high" has an entry with no `phonetic`
  //   field, even though "sky" /skaɪ/ and "high" /haɪ/ each do on their
  //   own) — split on "-", look up every half, join with a space. Only
  //   accepted if *every* half resolved to a real value; one unresolvable
  //   half still falls through rather than showing a partial reading.
  // - A plural/3rd-person-singular noun or verb with no entry of its own
  //   even though the singular/base form does ("ambitions" has none,
  //   "ambition" /æmˈbɪ.ʃən/ does; same for "patients", "appointments",
  //   "nurses"...) — retry stripped of a trailing "es" then, if that also
  //   comes up empty, a trailing "s".
  //
  // All three recurse into this same function, reusing its cache, pacing/
  // concurrency queue, and 429 retry — and all naturally terminate, since
  // none of these conditions can still be true of the already-stripped/split
  // result they each recurse on.
  //
  // A fallback's *own* recursive lookup can itself come back non-definitive
  // (its own 429 retries exhausted, a timeout under a busy batch...) — that's
  // exactly the "this attempt failed, not proof there's no phonetics" case
  // `definitive` exists to guard against in the first place, just one level
  // deeper. Letting it fall through as if the fallback had definitively
  // found nothing would `cachePhonetics(word, null)` this word *permanently*
  // over what's really a transient failure of one recursive sub-lookup —
  // observed as "sky-high" having real phonetics most of the time but
  // occasionally, irreversibly, showing nothing for the rest of the session.
  // So: downgrade `definitive` back to false (skip caching, try again next
  // time this word comes up) whenever a fallback both found no value *and*
  // its own recursive lookup wasn't definitive either.
  if (definitive && value === null) {
    const possessiveMatch = word.match(/^(.+)['’]s?$/i)
    if (possessiveMatch && possessiveMatch[1]) {
      const base = await fetchDictionaryApiWordStatus(possessiveMatch[1], priority)
      if (base.value) { value = base.value; approximate = true }
      else if (!base.definitive) definitive = false
    }
  }

  if (definitive && value === null && word.includes('-')) {
    const parts = word.split('-').filter(Boolean)
    if (parts.length > 1) {
      const partResults = await Promise.all(parts.map(p => fetchDictionaryApiWordStatus(p, priority)))
      if (partResults.every(r => r.value)) { value = partResults.map(r => r.value).join(' '); approximate = true }
      else if (partResults.some(r => !r.definitive)) definitive = false
    }
  }

  if (definitive && value === null) {
    const pluralCandidates: string[] = []
    if (word.endsWith('es') && word.length > 3) pluralCandidates.push(word.slice(0, -2))
    if (word.endsWith('s') && word.length > 2) pluralCandidates.push(word.slice(0, -1))
    for (const candidate of pluralCandidates) {
      const base = await fetchDictionaryApiWordStatus(candidate, priority)
      if (base.value) { value = base.value; approximate = true; break }
      if (!base.definitive) { definitive = false; break }
    }
  }

  // dictionaryapi.dev is a small crowd-sourced dataset — it flat-out doesn't
  // have an entry for plenty of everyday words ("has", "for") and proper
  // nouns, and plenty of entries it does have skip the `phonetic` field
  // entirely. Read Aloud's whole pitch is a reading under *every* word, so a
  // dictionary miss falls through to the same Google romanization fallback
  // the on-demand dictionary popover already uses, rather than just leaving
  // the word blank.
  if (definitive && value === null) {
    await acquireDictFetchSlot(priority)
    try {
      const { phonetics } = await googleSenses(word, 'en')
      if (phonetics) { value = phonetics; approximate = true }
    } finally {
      releaseDictFetchSlot()
    }
  }

  if (definitive) cachePhonetics(word, value, approximate)
  return { value, definitive, approximate }
}

export async function fetchDictionaryApiWord(rawWord: string): Promise<string | null> {
  return (await fetchDictionaryApiWordStatus(rawWord)).value
}

/**
 * Video Mode's auto phonetics: one message per subtitle line instead of one
 * per word, so a line of ten words costs one round trip through the
 * extension's messaging layer instead of ten. Each word still goes through
 * `fetchDictionaryApiWord`'s own cache, so repeats across lines cost nothing.
 *
 * A word whose lookup failed (see `fetchDictionaryApiWordStatus`) is left out
 * of the returned object entirely, rather than included as `null` — that lets
 * the content-script cache tell "definitely no phonetics" apart from "ask
 * again later" without a third value threaded through every caller.
 */
export async function fetchPhoneticsForWords(
  words: string[],
  priority: 'high' | 'low' = 'high',
): Promise<Record<string, { text: string | null; approximate: boolean }>> {
  const unique = [...new Set(words.map(w => w.toLowerCase()).filter(Boolean))]
  const results = await Promise.all(unique.map(w => fetchDictionaryApiWordStatus(w, priority)))
  const out: Record<string, { text: string | null; approximate: boolean }> = {}
  unique.forEach((w, i) => {
    if (results[i].definitive) out[w] = { text: results[i].value, approximate: results[i].approximate }
  })
  return out
}

// dictionaryapi.dev has no phrase endpoint — split, look up each word, and
// join with a space. A phrase with any word missing is dropped as a whole
// (returning null) rather than shown half-transcribed, so the caller falls
// through to a source that natively handles the full phrase instead.
async function fetchDictionaryApiPhonetics(text: string): Promise<string | null> {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  if (words.length === 1) return fetchDictionaryApiWord(words[0])
  const results = await Promise.all(words.map(fetchDictionaryApiWord))
  if (results.some(r => !r)) return null
  return results.join(' ')
}

function isEnglish(lang: string | undefined): boolean {
  return !lang || lang.toLowerCase().startsWith('en')
}

// ── Public entry point ─────────────────────────────────────────────────────────

export async function translateInContext(
  req: ContextTranslateRequest,
): Promise<ContextTranslateResult> {
  const word = req.word.trim()
  const sentence = req.sentence.trim() || word
  const targetLang = req.targetLang || 'en'

  // Always fetch dictionary senses in parallel — shown as chips regardless of source.
  const sensesPromise = !req.disableGoogleSenses
    ? googleSenses(word, targetLang)
    : Promise.resolve({ senses: [] as string[], sourceLang: undefined as string | undefined, phonetics: undefined as string | undefined })

  // Phonetics: try each enabled source in the user's configured order, first
  // hit wins. 'google-rm' piggybacks on the senses call above (it's the same
  // Google request, `dt=rm`) at no extra cost; 'dictionaryapi' is fetched here
  // in parallel so it adds no latency over the old Google-only path.
  const phoneticsOrder = req.phoneticsSourceOrder?.length
    ? req.phoneticsSourceOrder
    : DEFAULT_SETTINGS.translation.phoneticsSourceOrder!
  const enabledPhoneticsSources = phoneticsOrder.filter(s => s.enabled).map(s => s.source)
  const dictApiPromise = enabledPhoneticsSources.includes('dictionaryapi') && isEnglish(req.sourceLang || req.learningLanguage)
    ? fetchDictionaryApiPhonetics(word)
    : Promise.resolve(null as string | null)

  // Primary: on-device AI — single prompt with the full sentence as context.
  let contextResult: { translation: string; source: TranslateSource } | null = null
  if (!req.disableAI) {
    // Step 1: Get the English synonym (bypassing Chrome's language censorship barrier)
    const aiSynonym = await aiTranslateInContext(word, sentence)
    
    if (aiSynonym) {
      if (targetLang === 'en') {
        // If the user's target language is English, we don't need Step 2
        contextResult = { translation: aiSynonym, source: 'ai+on-device' }
      } else {
        // Step 2: Translate that English synonym into the target language
        let finalTr: string | null = null
        let source: TranslateSource = 'ai+google'
        
        // Try to use the Chrome Translator API (runs locally, fast, supports translation freely)
        const api = globalThis.Translator
        if (api) {
          try {
            if ((await api.availability({ sourceLanguage: 'en', targetLanguage: targetLang })) === 'available') {
              const t = await api.create({ sourceLanguage: 'en', targetLanguage: targetLang })
              finalTr = await t.translate(aiSynonym)
              t.destroy()
              source = 'ai+on-device'
            }
          } catch {
            // fallback to google
          }
        }
        if (!finalTr) {
          finalTr = await googleTranslate(aiSynonym, targetLang)
        }
        if (finalTr) {
          contextResult = { translation: finalTr, source }
        }
      }
    }
  }

  // Fallback 1: sentence diff.
  if (!contextResult && !req.disableGoogleContext && sentence && sentence !== word) {
    const contextTr = await googleContextTranslate(word, sentence, targetLang)
    if (contextTr) contextResult = { translation: contextTr, source: 'google-context' }
  }

  const [{ senses, sourceLang, phonetics: googleRmPhonetics }, dictApiPhonetics] = await Promise.all([
    sensesPromise,
    dictApiPromise,
  ])

  let phonetics: string | undefined
  for (const src of enabledPhoneticsSources) {
    if (src === 'dictionaryapi' && dictApiPhonetics) { phonetics = dictApiPhonetics; break }
    if (src === 'google-rm' && googleRmPhonetics) { phonetics = googleRmPhonetics; break }
  }

  let result: ContextTranslateResult

  if (contextResult) {
    result = { mode: 'context', translation: contextResult.translation, senses, source: contextResult.source, sourceLang, phonetics }
  } else if (senses.length > 0) {
    result = { mode: 'senses', senses, source: 'google-senses', sourceLang, phonetics }
  } else {
    // Last resort: plain translation.
    const basic = await googleTranslate(word, targetLang)
    result = { mode: 'senses', senses: basic ? [basic] : [], source: 'google-basic', sourceLang, phonetics }
  }

  console.debug('[aiTranslate]', { word, sentence, targetLang, result })
  return result
}
