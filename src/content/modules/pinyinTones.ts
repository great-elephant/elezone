// Tone colouring for Pinyin readings.
//
// Google's `dt=rm` romanization comes back with the tone written as a diacritic
// rather than a number (学习 → "Xuéxí"), which is all this needs: the mark over
// the vowel *is* the tone, so nothing has to be looked up to know it.
//
// Only ever applied to live on-screen readings (Read Aloud's word wraps, Video
// Mode's subtitle words). Saved items keep a plain string — SavedItem.phonetics
// is one flat field, and colour has no business being serialised into it.

/**
 * Tone of a single syllable, 1-4 from its diacritic and 5 (neutral) when it has
 * none.
 *
 * Decomposing to NFD turns "é" into "e" + a combining acute, so one lookup
 * table covers every vowel and both cases without listing ā á ǎ à ē é ě è … by
 * hand.
 */
export function parseToneNumber(syllable: string): 1 | 2 | 3 | 4 | 5 {
  for (const ch of syllable.normalize('NFD')) {
    if (ch === '̄') return 1 // macron
    if (ch === '́') return 2 // acute
    if (ch === '̌') return 3 // caron
    if (ch === '̀') return 4 // grave
  }
  return 5 // no mark at all — neutral, e.g. the "de" in "Wǒ de shū"
}

/** The widely used Pleco/Hanping tone palette, so it reads as familiar. */
const TONE_COLORS: Record<number, string> = {
  1: '#d32f2f',
  2: '#e08e00',
  3: '#2e7d32',
  4: '#1565c0',
  5: '#757575',
}

export function toneColor(tone: number): string {
  return TONE_COLORS[tone] ?? TONE_COLORS[5]
}

/** Base letter of `ch`, with any tone mark removed and case folded. */
function baseLetter(ch: string): string {
  return ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'ü', 'v'])

/**
 * Split a Pinyin word into syllables, keeping each one's diacritics.
 *
 * Every syllable has exactly one vowel cluster, so a new one starts at a
 * consonant that follows a completed cluster — except n/ng/r, which are also
 * the only codas, and so only begin a new syllable when a vowel follows them
 * ("nǐhǎo" splits at the h; the n of "hěn" does not).
 *
 * This cannot resolve genuinely ambiguous joins (the classic "xian" — one
 * syllable, or "xi" + "an"?), which is exactly why the caller checks the result
 * against the word's character count and skips colouring when they disagree,
 * rather than colouring something possibly wrong.
 */
export function splitPinyinSyllables(pinyin: string): string[] {
  const out: string[] = []
  let current = ''
  let seenVowel = false

  const flush = () => {
    if (current) out.push(current)
    current = ''
    seenVowel = false
  }

  for (let i = 0; i < pinyin.length; i++) {
    const ch = pinyin[i]
    const base = baseLetter(ch)

    if (!/[a-zü]/.test(base)) {
      // Spaces and apostrophes are syllable separators in their own right and
      // are not carried into the output.
      flush()
      continue
    }

    if (VOWELS.has(base)) {
      current += ch
      seenVowel = true
      continue
    }

    // A consonant. Before the syllable has a vowel it is part of the initial.
    if (!seenVowel) {
      current += ch
      continue
    }

    // After the vowel: a coda only if no vowel follows it.
    const nextBase = i + 1 < pinyin.length ? baseLetter(pinyin[i + 1]) : ''
    if (base === 'n' || base === 'r') {
      if (nextBase && VOWELS.has(nextBase)) {
        flush()
        current = ch
      } else {
        current += ch
      }
      continue
    }
    if (base === 'g' && current && baseLetter(current[current.length - 1]) === 'n') {
      // The g of an "ng" coda, unless a vowel follows and it opens the next one.
      if (nextBase && VOWELS.has(nextBase)) {
        flush()
        current = ch
      } else {
        current += ch
      }
      continue
    }

    flush()
    current = ch
  }
  flush()

  return out
}

/** Han characters in `word` — one per syllable, which is what verifies a split. */
export function hanCharCount(word: string): number {
  return (word.match(/[一-鿿]/gu) ?? []).length
}

/**
 * Per-syllable tone colours for `pinyin` as the reading of `word`, or null when
 * the split cannot be trusted.
 *
 * A Chinese character is always exactly one syllable, so if the split doesn't
 * produce one syllable per character the reading is something this doesn't
 * understand (a proper noun, a number, mixed Latin text) — the caller shows it
 * uncoloured rather than colouring it wrongly.
 */
export function toneSpans(word: string, pinyin: string): { text: string; tone: number }[] | null {
  const syllables = splitPinyinSyllables(pinyin)
  if (syllables.length === 0) return null
  if (syllables.length !== hanCharCount(word)) return null
  return syllables.map(s => ({ text: s, tone: parseToneNumber(s) }))
}
