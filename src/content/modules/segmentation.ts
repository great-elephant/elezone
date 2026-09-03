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
 * Cheap synchronous fallback for when `detectContentLangAsync`'s real
 * detector is unavailable or too unsure to answer — chrome.i18n.detectLanguage
 * needs a certain amount of text to build a reliable statistical signal, so a
 * short selection ("半天", two characters) routinely comes back unreliable.
 *
 * Han characters in `text` are trusted ahead of `<html lang>` on purpose, not
 * the other way around: `<html lang>` describes the whole page (or, worse,
 * some unrelated element found on the way to it — see
 * detectContentLangAsync's own comment), which is exactly wrong for a short
 * foreign-language selection sitting inside a page mostly written in some
 * other language — an English article's blog quoting a Chinese sentence, for
 * one. The one exception is a page that specifically declares itself
 * Japanese, which also writes Han (Kanji) — bare Kanji looks identical in
 * both scripts, so that claim is worth more than the characters alone.
 */
export function detectContentLangSync(text: string): string | undefined {
  const htmlLang = document.documentElement.lang?.split('-')[0]?.trim()
  if (hasCjk(text)) return htmlLang?.toLowerCase() === 'ja' ? htmlLang : 'zh'
  return htmlLang || undefined
}

/**
 * The language of `text`, judged from the text itself via `chrome.i18n.
 * detectLanguage` (not exposed to content scripts — proxied through the
 * background, same DETECT_CONTENT_LANGUAGE call Video Mode uses once per
 * session and Read Aloud uses to correct its own initial guess).
 *
 * This is the trustworthy version: an `<html lang>`/ancestor `lang` attribute
 * describes what a page *claims*, which is wrong exactly when it matters most
 * — a page (or an ancestor element on it) declaring one language while the
 * selected passage is actually written in another, e.g. an English article
 * quoting a Chinese sentence with no markup of its own, or an unrelated
 * `lang="en-GB"` on some nearby nav chrome that happens to be the nearest
 * ancestor. Falls back to the cheap sync heuristic only when the detector is
 * unavailable or unsure (e.g. a selection too short to carry a statistical
 * signal) — never to an attribute that might describe something else on the
 * page.
 */
export async function detectContentLangAsync(text: string): Promise<string | undefined> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'DETECT_CONTENT_LANGUAGE',
      payload: { text },
    }) as { lang?: string } | undefined
    if (res?.lang) return res.lang
  } catch {
    // Message channel unavailable (service worker recycled mid-flight) — fall
    // through to the sync heuristic below.
  }
  return detectContentLangSync(text)
}
