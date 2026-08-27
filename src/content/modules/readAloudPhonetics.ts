// IPA under every word of the sentence being spoken, injected directly into
// the page's own text (subtitle-style) — a small span wraps each word
// (`display: inline-flex; flex-direction: column`), with the word text and
// its IPA stacked as the two flex children. Plain box layout does the
// centering (`align-items: center`) *and* reserves real vertical space for
// the IPA line, the same way Video Mode's `.word-unit` does — unlike
// `position: absolute`, which doesn't grow the line box and so the IPA text
// just overlapped whatever paragraph line came next. Direct DOM injection
// with inline styles, not a shadow-DOM layer, same as translation.ts's
// inline paragraph-translation overlay (`injectOverlay`).
//
// Wraps accumulate rather than being torn down between sentences — once a
// zone (a sentence, or a whole paragraph when reading in paragraph mode) has
// its IPA filled in, it stays as the reader moves on, instead of vanishing
// the moment the sentence is no longer the one being spoken. The caller
// (readAloud.ts) tracks which sentences have already been wrapped so it only
// asks this module to wrap a given stretch of text once.
//
// This does mutate the page's real DOM (splits the word's text node into the
// wrapper), which is why the caller rebuilds anchor.ts's word index
// immediately after wrapping — that index is what resolves a chrome.tts
// `'word'` event's charIndex back to a DOM position for the `cxt-word`
// karaoke highlight, and it holds direct Text node references that wrapping
// invalidates. anchor.ts also excludes `IPA_SELECTOR` content when building
// the `cxt-speaking` sentence highlight, so the highlight background stays on
// the original word — the IPA line underneath is meant to be read quietly,
// not be part of what "focus on this sentence" visually means.

import { phoneticsForWords, type PhoneticsResult } from './wordPhonetics'

export const WRAP_CLASS = 'elezone-word-wrap'
const IPA_CLASS = 'elezone-word-ipa'
export const IPA_SELECTOR = `.${IPA_CLASS}`

// Every wrapper span currently in the page, across every zone wrapped so
// far this session — accumulates until `unwrapAllPhoneticsWords()` tears the
// whole thing down (phonetics turned off, or the session/article ends).
let wrappedWords: HTMLElement[] = []

// The word text used to actually *look up* phonetics — distinct from the
// word's own wrap Range, which stays spanning the full visible token so the
// highlight/wrap still reads as one word. Only trims surrounding punctuation
// — a possessive/contraction suffix ("immigrant's", "it's") or a hyphenated
// compound ("sky-high") is sent through whole and handled server-side
// (aiTranslate.ts's fetchDictionaryApiWordStatus), which tries the word
// as-is *first* and only falls back to a stripped/split form if that has no
// entry of its own — some of these ("let's", "don't") have their own exact
// dictionary entry, which stripping here unconditionally would throw away
// before ever getting the chance to use it. Exported so readAloud.ts's
// look-ahead prefetch computes the exact same cache key for the same word.
export function lookupWord(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

const WRAPPER_CSS = [
  'display:inline-flex !important',
  'flex-direction:column !important',
  // Left- (not center-) aligns the word/gap text — a flex column's cross-axis
  // width is the *widest* child, and a word's IPA reading is frequently wider
  // than the word itself ("encyclopedia" vs "/ənˌsəɪ.kləˈpi.di.ə/"). Centering
  // would then shift the word text inward, away from this wrapper's own left
  // edge — which is exactly where the previous wrapper's text ends. The
  // sentence highlight follows the *word text's* own Range, not this
  // wrapper's box, so that inward shift opened up a gap with no background
  // between two words wherever one had a long IPA result (observed on nearly
  // every sentence with a link in it, e.g. "search engine and information
  // retrieval| |systems" — a visible unhighlighted notch at the join). The
  // IPA row itself still centers under the word via its own `align-self`
  // below, so this only changes the *word* row's alignment.
  'align-items:flex-start !important',
  // Matches how plain inline text sits on the line — without this the
  // flex box's own alignment shifts the content up relative to its
  // neighbours.
  'vertical-align:bottom !important',
  // anchor.ts's resolveSentenceWordRanges() extends each word's wrap forward
  // to swallow trailing space/punctuation (so the sentence highlight reads as
  // one strip, not per-word islands) — but a trailing space at the edge of a
  // flex item's anonymous text box gets collapsed to zero width same as at
  // the end of any block box, so without this the words visually run
  // together with no gap at all. pre-wrap keeps the space's width while
  // still letting the line wrap normally at it.
  'white-space:pre-wrap !important',
  // A flex item's default `min-width: auto` shrinks to min-content — normally
  // the width of the whole word, since unbreakable text can't get any
  // narrower. But word-break/overflow-wrap are inherited, and this wrapper
  // doesn't reset them, so a host page that sets either (break-word,
  // break-all, anywhere — common on narrow columns) lets min-content collapse
  // down to a single character, and the word gets split mid-way to fit
  // whatever space is left on the line ("architecture" → "archit"/"ecture").
  // Force both back to their non-breaking default so the word always wraps
  // as one atomic unit, same as it did before phonetics wrapped it.
  'word-break:normal !important',
  'overflow-wrap:normal !important',
].join(';')

const IPA_ROW_CSS = [
  'display:block !important',
  'min-height:13px !important',
  // Centers the IPA reading under the word specifically (not under this
  // wrapper's own box, which — per the `align-items:flex-start` above — can
  // be wider than the word when the IPA text itself is the wider of the two).
  'align-self:center !important',
  'color:#2f57d6 !important',
  'text-shadow:-1px -1px 0 #fff,1px -1px 0 #fff,-1px 1px 0 #fff,1px 1px 0 #fff !important',
  'font-size:12px !important',
  'font-weight:600 !important',
  'font-family:system-ui,sans-serif !important',
  'line-height:1.1 !important',
  'white-space:nowrap !important',
  'pointer-events:none !important',
  // Keeps the IPA text out of *any* selection — drag-select, triple-click
  // (including the paragraph-selection fix below, which otherwise has no way
  // to skip it: Chrome's Selection only ever holds one Range, so there's no
  // multi-range trick here like the `cxt-speaking` highlight uses), and
  // Ctrl+A/copy. The browser excludes `user-select:none` content from
  // selection at the rendering layer itself, so this is a hard exclusion,
  // not just a visual one.
  'user-select:none !important',
].join(';')

// The empty `.elezone-word-wrap` shell — no content yet, since
// surroundContents() (called right after this, in wrapWords/wrapGaps) wipes
// out any children the target already has before inserting the extracted
// text. The IPA row has to be appended *after* that call, not before, or it
// gets silently discarded the instant the word/gap text is wrapped in.
function makeWrapper(): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = WRAP_CLASS
  wrapper.style.cssText = WRAPPER_CSS
  return wrapper
}

// Appends the reserved IPA-height row — every wrapped span gets one,
// whether it ends up holding a real word or just a spacer (see wrapGaps).
function appendIpaRow(wrapper: HTMLElement): HTMLElement {
  const ipaRow = document.createElement('span')
  ipaRow.className = IPA_CLASS
  ipaRow.style.cssText = IPA_ROW_CSS
  wrapper.appendChild(ipaRow)
  return ipaRow
}

/**
 * Wrap each word's Range in a `<span>` so CSS can anchor the IPA under it.
 * Skips (rather than throws on) a word whose Range doesn't cleanly
 * `surroundContents()` — e.g. one that starts mid-way through a nested
 * `<b>`/`<a>` — that word just doesn't get phonetics rather than corrupting
 * the page's markup.
 */
function wrapWords(ranges: { text: string; range: Range }[]): { wrapper: HTMLElement; text: string }[] {
  // All these Ranges were resolved up front against the *original* DOM, and
  // consecutive words in plain text commonly share the same Text node.
  // Wrapping word 1 splits that node — a live Range boundary update Chrome
  // does automatically, but not in a way that keeps word 2's still-pending
  // Range pointed at the right characters, so word 2 (and everything after
  // it) would end up wrapping the wrong slice of text (observed: IPA showing
  // up under the wrong word once a sentence had more than a couple of them).
  // Wrapping from the end backwards means every surroundContents() call only
  // mutates text *after* the words still waiting their turn, so their
  // boundaries are never touched before they're used.
  const out: { wrapper: HTMLElement; text: string }[] = []
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { text, range } = ranges[i]
    try {
      const wrapper = makeWrapper()
      range.surroundContents(wrapper)
      // Reserve the IPA line's height on *every* word up front, filled in or
      // not — most common words ("is", "for", "and"...) never get a result
      // back from the dictionary. Without a same-size empty slot here, a
      // wrapped-but-empty word sits shorter than its neighbours that did get
      // one, and `vertical-align: bottom` pushes each to a different height,
      // reading as a wavy, uneven line instead of a straight one.
      appendIpaRow(wrapper)
      out.push({ wrapper, text })
    } catch {
      // Range spans a partial element boundary — leave this word alone.
    }
  }
  out.reverse() // restore left-to-right order for callers (e.g. wrappers[0]/[last])
  return out
}

/**
 * Whatever text is *left over* between/around the just-wrapped words — a
 * comma right after a `</b>`, a "(" before a link, the plain spaces between
 * two words that didn't share a text node — still sits at the page's normal
 * baseline while its now-wrapped neighbours got raised to make room for
 * their IPA line. Left alone, the `cxt-speaking` highlight painted over it
 * visibly drops down into the gap. There's no word here to look up, so this
 * just gives each leftover run the same empty two-row shell as a real word
 * (no IPA slot ever gets filled in) purely so it sits at the same height.
 */
function wrapGaps(wrapped: { wrapper: HTMLElement }[]): HTMLElement[] {
  if (wrapped.length === 0) return []
  const outer = document.createRange()
  outer.setStartBefore(wrapped[0].wrapper)
  outer.setEndAfter(wrapped[wrapped.length - 1].wrapper)

  const root = outer.commonAncestorContainer
  const scope = root.nodeType === Node.ELEMENT_NODE ? root as Element : root.parentElement
  if (!scope) return []

  const gapNodes: Text[] = []
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!outer.intersectsNode(node)) return NodeFilter.FILTER_REJECT
      if ((node as Text).parentElement?.closest(`.${WRAP_CLASS}`)) return NodeFilter.FILTER_REJECT
      return (node.nodeValue ?? '').length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  let n: Node | null
  while ((n = walker.nextNode())) gapNodes.push(n as Text)

  const spacers: HTMLElement[] = []
  // Same reasoning as wrapWords: process the DOM back-to-front so wrapping
  // one gap can't shift the (node, offset) of another one still waiting.
  for (let i = gapNodes.length - 1; i >= 0; i--) {
    try {
      const wrapper = makeWrapper()
      const gapRange = document.createRange()
      gapRange.selectNode(gapNodes[i])
      gapRange.surroundContents(wrapper)
      // A gap that's pure whitespace (the common case — the single space
      // left over between two words that don't share a text node, e.g. on
      // either side of a wiki link) is, per the flexbox spec, a "collapsible
      // whitespace run at the start/end of a flex container" — and gets
      // trimmed away entirely, same as at the edge of a block box, even
      // though `white-space: pre-wrap` is set. That collapse doesn't touch
      // interior whitespace mixed with real text (a word's own wrap always
      // has non-whitespace content, so it isn't affected) — only a wrap
      // whose *entire* content is whitespace. Rehoming that text one level
      // deeper, inside a plain non-flex `<span>`, keeps it out of the flex
      // container's own collapsible-whitespace-trimming pass, so the space
      // actually renders instead of silently vanishing (observed: words on
      // either side of a link running together with no gap at all).
      const inner = document.createElement('span')
      while (wrapper.firstChild) inner.appendChild(wrapper.firstChild)
      wrapper.appendChild(inner)
      appendIpaRow(wrapper)
      spacers.push(wrapper)
    } catch {
      // Leave this run alone rather than corrupt the page.
    }
  }
  return spacers
}

function unwrapWord(wrapper: HTMLElement): void {
  const parent = wrapper.parentNode
  if (!parent) return
  wrapper.querySelector(`.${IPA_CLASS}`)?.remove()
  while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper)
  parent.removeChild(wrapper)
  parent.normalize() // merges the restored text back with its neighbours
}

/** Undo every wrap made so far this session, restoring plain text. */
export function unwrapAllPhoneticsWords(): void {
  for (const wrapper of wrappedWords) unwrapWord(wrapper)
  wrappedWords = []
}

/**
 * Wrap every word of the given stretch of text (one sentence, or a whole
 * paragraph's worth in paragraph mode) and fill in IPA as each lookup
 * resolves. Doesn't touch any *other* zone's existing wraps — the caller is
 * responsible for only calling this once per zone (readAloud.ts tracks which
 * sentences have already been wrapped).
 *
 * Wrapping itself is synchronous (no network wait) — returns the wrapped
 * elements right away so the caller can rebuild its word index against the
 * now-mutated DOM before anything else touches it; the IPA text for each
 * word pops in separately once its lookup resolves.
 */
export function wrapAndShowPhoneticsForWords(
  ranges: { text: string; range: Range }[],
  priority: 'high' | 'low' = 'high',
): { wrappers: HTMLElement[]; ready: Promise<void> } {
  if (ranges.length === 0) return { wrappers: [], ready: Promise.resolve() }

  const wrapped = wrapWords(ranges)
  wrappedWords.push(...wrapped.map(w => w.wrapper))
  // Gap-wrapping runs *after* every word in this batch is already wrapped —
  // it needs the words' final positions to find what's left over between them.
  wrappedWords.push(...wrapGaps(wrapped))
  const cleanWords = wrapped.map(w => lookupWord(w.text).toLowerCase())

  // A word's own wrapper(s) — the same word can appear more than once in a
  // sentence ("the", "and"...), and every occurrence fills in together the
  // moment that one word's lookup resolves, not just the first.
  const wrappersByWord = new Map<string, HTMLElement[]>()
  wrapped.forEach((w, i) => {
    const list = wrappersByWord.get(cleanWords[i])
    if (list) list.push(w.wrapper)
    else wrappersByWord.set(cleanWords[i], [w.wrapper])
  })

  const fillWord = (word: string, entry: PhoneticsResult): void => {
    if (!entry) return // leave the reserved empty slot as-is
    for (const wrapper of wrappersByWord.get(word) ?? []) {
      // The wrapper can only have left the document via
      // unwrapAllPhoneticsWords() (phonetics turned off, or the session
      // ended) — never as a side effect of a *different* zone being wrapped,
      // since zones accumulate instead of replacing each other. Skipping a
      // detached wrapper here just avoids pointless work, not a real bug.
      if (!wrapper.isConnected) continue
      const ipa = wrapper.querySelector<HTMLElement>(`.${IPA_CLASS}`)
      if (!ipa || ipa.textContent) continue
      ipa.textContent = entry.text
      // A reading borrowed from a fallback (plural's singular, one half of a
      // hyphenated compound...) rather than the word's own exact dictionary
      // entry — dimmed to signal "close, not guaranteed exact".
      if (entry.approximate) ipa.style.opacity = '0.6'
    }
  }

  // A word can come back without a result for reasons that have nothing to
  // do with whether it *has* phonetics — the background's own dictionary
  // fetch queue paces/retries against rate limits, and a word needing a
  // fallback (a hyphenated compound needs its own recursive sub-lookups) is
  // one or more *extra* round trips through that same queue, so it can still
  // be waiting behind everything else a big paragraph's worth of words
  // dispatched all at once. Missing here is indistinguishable from "still
  // being looked up", so retry on a growing delay (cheap: `phoneticsForWords`
  // skips anything already resolved, cached even as "no phonetics", so a
  // retry only ever does real work for words still actually missing) instead
  // of leaving stragglers permanently blank after just one attempt.
  //
  // The sentence actually being read (`'high'`) fills progressively — each
  // word's slot the instant *that* word resolves, instead of every word
  // waiting on whichever one happens to be slowest (a fallback's own
  // recursive sub-lookups can turn one word into several round trips). A
  // look-ahead sentence (`'low'`) is the opposite on purpose: it isn't on
  // screen being read yet, so there's no responsiveness to protect, and
  // words popping in one at a time while nobody's looking just means the
  // sentence reads as unfinished/flickering for however long it takes —
  // fill it in one clean reveal once every word in it has settled instead.
  const RETRY_DELAYS_MS = [5000, 12000]
  const attempt = (attemptIndex: number): Promise<void> =>
    phoneticsForWords(cleanWords, priority, priority === 'high' ? fillWord : undefined).then(result => {
      if (priority === 'low') for (const [word, entry] of result) fillWord(word, entry)
      const stillMissing = wrapped.some((w, i) => w.wrapper.isConnected && !result.get(cleanWords[i])
        && !w.wrapper.querySelector(`.${IPA_CLASS}`)?.textContent)
      if (stillMissing && attemptIndex < RETRY_DELAYS_MS.length) {
        return new Promise<void>(resolve => {
          setTimeout(() => resolve(attempt(attemptIndex + 1)), RETRY_DELAYS_MS[attemptIndex])
        })
      }
    })

  return { wrappers: wrapped.map(w => w.wrapper), ready: attempt(0) }
}

// Triple-click-to-select-paragraph is a *browser* behaviour, not something
// content scripts implement — and Chrome's implementation of it bails out
// the instant the paragraph contains any element with a block-level nested
// child (confirmed: `inline-flex` and plain `inline-block` both trigger it
// identically, so it's not about flex specifically — it's about the word
// wrapper containing the IPA row as a `display:block` child, which is what
// actually stacks the IPA under the word). Once a paragraph has any
// phonetics wraps in it, triple-click inside it silently stops at the first
// wrapped word instead of selecting the whole paragraph, with no way to opt
// out via CSS (`user-select` doesn't affect *which* text gets auto-selected,
// only whether it can be). So: catch the triple-click ourselves, before the
// browser's own (broken) selection logic runs, and build the paragraph
// selection by hand from the nearest paragraph-like ancestor.
//
// Deliberately tag-name-based rather than "walk up to the first
// computed-`display:block` ancestor": on a real site (tried on Wikipedia)
// that first block-ish ancestor by computed style is often a *layout*
// wrapper (a heading's flex row pairing it with edit-section tools, a
// content column) rather than the actual paragraph — climbing to it grabs
// half the page instead of one paragraph. Tag names are what readAloud's own
// sentence planner groups content by in the first place, so matching them
// here lands on the same unit a real triple-click would have meant.
const PARAGRAPH_TAGS = new Set([
  'P', 'LI', 'DD', 'DT', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
])

// Not every site puts paragraph text in one of PARAGRAPH_TAGS — plenty use a
// bare `<div>` per paragraph instead. Accepting `DIV`/`SPAN` too, but only
// when their *own* computed display is actually block-level, keeps the "grab
// half the page" failure mode from before: a layout wrapper (flex/grid row)
// still gets skipped since its display isn't 'block'/'flow-root', so the
// climb continues past it to whatever real paragraph container is next.
function isParagraphLike(el: Element): boolean {
  if (PARAGRAPH_TAGS.has(el.tagName)) return true
  if (el.tagName !== 'DIV' && el.tagName !== 'SPAN') return false
  const display = getComputedStyle(el).display
  return display === 'block' || display === 'flow-root'
}

function handleTripleClick(e: MouseEvent): void {
  if (e.detail < 3 || wrappedWords.length === 0) return
  const target = e.target
  if (!(target instanceof Element)) return
  if (target.closest('input, textarea, [contenteditable="true"]')) return

  let block: Element | null = target
  while (block && !isParagraphLike(block)) block = block.parentElement
  if (!block || !block.querySelector(`.${WRAP_CLASS}`)) return

  e.preventDefault()
  const range = document.createRange()
  range.selectNodeContents(block)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

document.addEventListener('mousedown', handleTripleClick, true)
