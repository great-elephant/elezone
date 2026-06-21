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
  return (raw.split('\n')[0] ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.\s]+$/, '')
    .trim()
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

  const masked = sentence
    .replace(new RegExp(`\\b${escapeRegex(word)}\\b`, 'gi'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (masked === sentence) return null // word not in sentence (shouldn't happen)

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

  const { senses, sourceLang, phonetics } = await sensesPromise

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
