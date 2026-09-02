/**
 * Word segmentation and cheap content-language detection, shared by everything
 * that needs to split a line into study-sized units: the dictionary popup's
 * selection guard, Read Aloud's per-word IPA/Pinyin wraps, and Video Mode's
 * clickable subtitle tokens.
 *
 * Chinese has no spaces, so the `\S+` split every caller used to do returns the
 * whole line as a single "word" — the length guards never fire and a subtitle
 * line renders as one unclickable block. `Intl.Segmenter` knows the word
 * boundaries; nothing else here is worth a dependency.
 */

/** Han characters. Unambiguous evidence of CJK — no other script uses them. */
const CJK_RANGE = /[一-鿿]/

export function hasCjk(text: string): boolean {
  return CJK_RANGE.test(text)
}

/**
 * Split `text` into words for `lang`.
 *
 * Non-Chinese keeps the exact `\S+` behaviour every caller had before this
 * module existed — punctuation stays attached to the word before it, which the
 * callers' own trimming relies on. Only `zh` takes the segmenter path.
 */
export function segmentWords(text: string, lang: string): string[] {
  if (!lang.toLowerCase().startsWith('zh')) return text.match(/\S+/g) ?? []

  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const out: string[] = []
  for (const s of segmenter.segment(text)) {
    // Drops whitespace and punctuation between words; a Chinese line is mostly
    // these once the words are taken out.
    if (s.isWordLike) out.push(s.segment)
  }
  return out
}

/**
 * The language of a piece of on-page text, resolved synchronously.
 *
 * Callers pass text they already hold (a selection, a subtitle line). Used
 * where an async `chrome.i18n.detectLanguage` round trip would be wrong: the
 * dictionary popup needs a language *before* it decides whether to spend a
 * dictionaryapi.dev lookup on the word.
 *
 * `<html lang>` is trusted ahead of the script test on purpose — Japanese also
 * writes Han characters, so a page that declares itself is a better witness
 * than the characters are. The script test is the last resort, for pages that
 * declare nothing at all.
 */
export function detectContentLangSync(text: string): string | undefined {
  const htmlLang = document.documentElement.lang?.split('-')[0]?.trim()
  if (htmlLang) return htmlLang
  return hasCjk(text) ? 'zh' : undefined
}
