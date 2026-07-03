import { Readability } from '@mozilla/readability'
import { CONTENT_BLOCK_SELECTORS, getContentRoot, getSiteProfile, getTitleElement } from './siteProfiles'

type ReadableArticle = {
  title: string
  textContent: string
}

function removeNoisyDescendants(root: HTMLElement): void {
  root.querySelectorAll(
    'script, style, noscript, form, input, select, textarea, button, [role="button"], [data-cxt-translation]'
  ).forEach(el => el.remove())

  root.querySelectorAll<HTMLElement>('a').forEach(link => {
    const attrs = `${link.className} ${link.id} ${link.getAttribute('aria-label') ?? ''}`.toLowerCase()
    const text = link.innerText.replace(/\s+/g, ' ').trim()
    const isButtonLike = /\b(btn|button|share|social|follow|subscribe|signup|sign-up|login|register|comment|banner|advert|promo)\b/.test(attrs)
    const isGraphicCta = Boolean(link.querySelector('img, svg, picture')) && text.length > 20
    if (isButtonLike || isGraphicCta) {
      link.remove()
    }
  })
}

function getSanitizedText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  removeNoisyDescendants(clone)
  return clone.innerText.replace(/\s+/g, ' ').trim()
}

export function getElementContentText(el: HTMLElement): string {
  return getSanitizedText(el)
}

const CONTENT_BLOCK_QUERY = CONTENT_BLOCK_SELECTORS.join(', ')

function getNestedContentBlockCount(el: HTMLElement): number {
  const ownCount = el.matches(CONTENT_BLOCK_QUERY) ? 1 : 0
  return ownCount + el.querySelectorAll(CONTENT_BLOCK_QUERY).length
}

function getCandidateContentBlocks(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(CONTENT_BLOCK_QUERY)]
}

// "Related/recommended articles" widgets are the most common way main-content
// detection goes wrong in practice: many sites embed them INSIDE the same
// content root as the article (sometimes even inline in the article's own
// paragraph flow, e.g. VnExpress's "tin_xemthem" placeholder), so a
// content-root selector or Readability's own parse alone won't exclude them —
// structurally they can look just like real paragraphs/headings once
// rendered. This is a best-effort list of the class/id/attribute patterns
// those widgets commonly use across sites; `[data-component-type="tin_xemthem"]`
// is VnExpress's specific marker for its inline "read more" widget.
const NOISE_CONTAINER_SELECTOR = [
  '[class*="related" i]', '[id*="related" i]',
  // VnExpress's hydrated "tin_xemthem" widget lands in a `box-news-relative`
  // div ("relative" meaning "related" here) — matched by exact class prefix
  // rather than a bare `*="relative"` substring, since "relative" alone is a
  // common Tailwind/utility-CSS class (`position: relative`) that would
  // otherwise false-positive on unrelated content across many sites.
  '[class*="news-relative" i]', '[class*="box-news-relative" i]', '[class*="relative-news" i]', '[class*="relative_news" i]',
  '[class*="recommend" i]', '[id*="recommend" i]',
  '[class*="more-stor" i]', '[class*="morestories" i]',
  '[class*="read-next" i]', '[class*="readnext" i]',
  '[class*="you-may-like" i]', '[class*="youmaylike" i]',
  '[class*="also-read" i]', '[class*="alsoread" i]',
  '[class*="similar-post" i]', '[class*="similarpost" i]',
  '[class*="trending-post" i]', '[class*="popular-post" i]',
  '[class*="sponsor" i]',
  '[class*="outbrain" i]', '[class*="taboola" i]', '[class*="zergnet" i]',
  '[data-component-type="tin_xemthem"]',
  // Byline/timestamp/dateline metadata blocks ("By X, Y and Z", "Updated ...
  // Published ...") aren't article prose — reading them is at best pointless
  // and at worst a run-on nonsense "sentence" when the block has no terminal
  // punctuation for Intl.Segmenter to split on (seen live on CNN, where the
  // author names and update/publish timestamps sit in one containing div).
  '[class*="byline" i]', '[class*="dateline" i]', '[class*="timestamp" i]',
  '[data-component-name="byline"]', '[data-component-name="timestamp"]',
].join(', ')

function getMinimumContentLength(el: HTMLElement): number {
  if (el.matches('li, dt, dd')) return 6
  if (el.matches('h2, h3, h4, h5, h6')) return 8
  if (el.matches('blockquote, figcaption, time, address')) return 10
  if (el.matches('div, span') && el.querySelector('time, address')) return 10
  return 20
}

// Class/id names are useless on sites that build with CSS-in-JS or CSS
// modules (React/Next.js apps — common on big news sites like the NYT or
// Bloomberg) since the build hashes them into something like `css-1a2b3c`.
// aria-label/data-testid and the VISIBLE heading text of a section are much
// more durable signals for "this is a related/recommended-content widget"
// because they're user- or screen-reader-facing and rarely get obfuscated.
const RELATED_CONTENT_TEXT_RE = /\b(related(?:\s+(?:articles?|stories|topics|content|coverage))?|recommended|more on this story|more from|you may (?:also )?like|read more|read next|up next|also read|(?:also\s+)?worth reading|further reading|what to read next|trending now|most read|most popular|editor'?s picks?|sponsored|promoted content|what to check out next)\b/i

// Walk up a few ancestor levels looking for an aria-label/data-testid/data-title
// match, or a heading (or role="heading") among the ancestor's earlier
// siblings whose own text matches — sections are commonly authored as
// `<h2>Related articles</h2><div>...cards...</div>` (siblings, not nested).
// `data-title` specifically catches CMS-templated widgets (e.g. Drupal "view"
// blocks) that stamp the human-authored section title onto a data attribute
// even when the visible heading text is templated/duplicated elsewhere.
function hasRelatedContentSignal(el: HTMLElement): boolean {
  let node: HTMLElement | null = el
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const label = `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('data-testid') ?? ''} ${node.getAttribute('data-title') ?? ''}`
    if (RELATED_CONTENT_TEXT_RE.test(label)) return true

    let sib = node.previousElementSibling
    for (let i = 0; sib && i < 3; i++, sib = sib.previousElementSibling) {
      if (sib.matches('h1, h2, h3, h4, h5, h6, [role="heading"]') && RELATED_CONTENT_TEXT_RE.test(sib.textContent ?? '')) {
        return true
      }
    }
  }
  return false
}

// A block that's essentially just a wrapped link — a teaser card's heading or
// blurb, e.g. `<h3><a>Full article title</a></h3>` — reads as "prose" by
// length alone but isn't; real article text only occasionally links a few
// words inline. This mirrors the link-density signal Readability's own
// scoring uses, applied locally to a single candidate block.
function isMostlyLinkText(el: HTMLElement): boolean {
  if (el.tagName === 'A') return true
  const totalLen = getElementContentText(el).length
  if (totalLen === 0) return false
  const linkLen = [...el.querySelectorAll('a')].reduce((sum, a) => sum + (a.textContent?.length ?? 0), 0)
  return linkLen / totalLen > 0.8
}

function isVisibleContentElement(el: HTMLElement): boolean {
  const text = getElementContentText(el)
  if (text.length < getMinimumContentLength(el)) return false
  if (el.closest('[data-cxt-translation]')) return false
  if (el.closest('nav, header, footer, aside')) return false
  if (el.closest(NOISE_CONTAINER_SELECTOR)) return false
  // The candidate itself can also be a generic wrapper (picked up via the
  // article-lead fallback, which isn't limited to real content-block tags)
  // that merely CONTAINS a noise marker as a descendant — e.g. a
  // `<div class="headline__footer">` wrapping a `data-component-name="byline"`
  // child and a separate timestamp child. `closest()` alone only looks
  // upward, so it won't catch that.
  if (el.querySelector(NOISE_CONTAINER_SELECTOR)) return false
  if (el.querySelector('[data-cxt-translation]')) return false
  if (isMostlyLinkText(el)) return false
  if (hasRelatedContentSignal(el)) return false
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function isLikelyArticleLead(el: HTMLElement): boolean {
  const text = getElementContentText(el)
  if (text.length < 30 || text.length > 420) return false
  if (el.matches('li, dt, dd, pre, code')) return false

  const nestedBlockCount = getNestedContentBlockCount(el)
  if (nestedBlockCount > 1) return false

  return true
}

function isLikelyTitleContextElement(el: HTMLElement): boolean {
  if (el.closest('nav, header, footer, aside')) return false
  if (el.getAttribute('data-cxt-translation')) return false
  // This walks the title's own following siblings looking for a subtitle/dek —
  // but a byline/timestamp footer sitting right next to the headline (very
  // common markup: <h1>/<div class="headline__footer">byline+timestamp</div>)
  // matches that same "short text right after the title" shape. None of the
  // other noise checks (class-based widget patterns, byline/timestamp
  // markers, link-density) were wired in here, so it slipped through even
  // after they were added everywhere else.
  if (el.closest(NOISE_CONTAINER_SELECTOR) || el.querySelector(NOISE_CONTAINER_SELECTOR)) return false
  if (isMostlyLinkText(el)) return false
  if (hasRelatedContentSignal(el)) return false

  const text = getSanitizedText(el)
  if (text.length < 10 || text.length > 280) return false

  const paragraphishCount = getNestedContentBlockCount(el)
  if (paragraphishCount > 2) return false

  return true
}

export function extractReadableArticle(): ReadableArticle | null {
  const docClone = document.cloneNode(true) as Document
  docClone.querySelectorAll('[data-cxt-translation]').forEach(el => el.remove())
  const article = new Readability(docClone).parse()
  if (!article) return null

  const tmp = document.createElement('div')
  tmp.innerHTML = article.content
  const contentText = tmp.innerText.replace(/\s+/g, ' ').trim()
  const excerpt = (article.excerpt ?? '').replace(/\s+/g, ' ').trim()

  return {
    title: article.title,
    textContent: excerpt ? `${contentText} ${excerpt}` : contentText,
  }
}

export function getPrimaryTitleElement(): HTMLElement | null {
  const profile = getSiteProfile()
  const root = getContentRoot(profile)
  return getTitleElement(profile, root)
}

export function getTitleContextElements(): HTMLElement[] {
  const title = getPrimaryTitleElement()
  if (!title) return []

  const seen = new Set<HTMLElement>()
  const result: HTMLElement[] = []
  let anchor: HTMLElement | null = title

  for (let depth = 0; anchor && depth < 4; depth++) {
    const parent: HTMLElement | null = anchor.parentElement
    if (!parent) break

    const siblings = [...parent.children] as HTMLElement[]
    const anchorIndex = siblings.indexOf(anchor)
    if (anchorIndex === -1) break

    for (let i = anchorIndex + 1; i < siblings.length; i++) {
      const sibling = siblings[i]
      const contentBlockCount = getNestedContentBlockCount(sibling)
      const textLength = getElementContentText(sibling).length

      if (contentBlockCount > 2 || textLength > 500) break
      if (!isLikelyTitleContextElement(sibling) || seen.has(sibling)) continue

      seen.add(sibling)
      result.push(sibling)
    }

    anchor = parent
  }

  return result
}

export function getArticleLeadElements(): HTMLElement[] {
  const profile = getSiteProfile()
  const root = getContentRoot(profile)
  const title = getPrimaryTitleElement()
  const titleTop = title ? window.scrollY + title.getBoundingClientRect().top : null
  const blocks = getCandidateContentBlocks(root).filter(el =>
    isVisibleContentElement(el) &&
    !el.closest('[data-cxt-translation]')
  )

  const structuralLeads = blocks.filter((el, index) => {
    if (!isLikelyArticleLead(el)) return false
    if (index > 2) return false

    if (titleTop == null) return true

    const top = window.scrollY + el.getBoundingClientRect().top
    return top >= titleTop - 40 && top <= titleTop + 700
  })

  if (structuralLeads.length > 0) return structuralLeads

  const h1 = title ?? document.querySelector('h1')
  if (!h1?.parentElement) return []

  let h1Ancestor: HTMLElement = h1.parentElement

  while (h1Ancestor.parentElement && h1Ancestor.parentElement !== document.body) {
    const parent = h1Ancestor.parentElement
    const result: HTMLElement[] = []
    let pastAncestor = false

    for (const child of parent.children) {
      const el = child as HTMLElement
      if (el === h1Ancestor) {
        pastAncestor = true
        continue
      }
      if (!pastAncestor) continue

      const text = getElementContentText(el)
      const contentBlockCount = getNestedContentBlockCount(el)
      // Bail out once a sibling is clearly a generic wrapper around the whole
      // article body rather than a short lead blurb. This used to only check
      // DIV/ARTICLE tag names, but plenty of sites wrap their content in a
      // <section> (or other container) instead — that slipped through the
      // check entirely, so a lead-element search could pick up the ENTIRE
      // article as "the lead" and hand buildSentencePlan one giant element
      // instead of each paragraph/list item individually. Segmenting that much
      // text as one blob means any non-terminal punctuation (e.g. a colon
      // ending a list intro) merges everything up to the next real sentence
      // end into a single "sentence" spanning multiple original paragraphs —
      // which is exactly what broke read-aloud's per-sentence highlighting.
      if (contentBlockCount > 3 || text.length > 1500) break

      if (
        text.length >= getMinimumContentLength(el) &&
        !el.getAttribute('data-cxt-translation') &&
        !el.closest('nav, header, footer, aside') &&
        !el.closest(NOISE_CONTAINER_SELECTOR) &&
        !el.querySelector(NOISE_CONTAINER_SELECTOR) &&
        !isMostlyLinkText(el) &&
        !hasRelatedContentSignal(el)
      ) {
        result.push(el)
      }
    }

    if (result.length > 0) return result
    h1Ancestor = parent
  }

  return []
}

export function getContentParagraphs(readableArticleText = ''): HTMLElement[] {
  const profile = getSiteProfile()
  const root = getContentRoot(profile)

  return getCandidateContentBlocks(root).filter((el, index) => {
    if (!isVisibleContentElement(el)) return false

    if (readableArticleText) {
      const normalized = getElementContentText(el)
      // The isLikelyArticleLead bypass exists for the case where Readability's
      // own parse drops a genuine short lead/subtitle paragraph near the
      // article's top. Without the `index <= 2` restriction (matching
      // getArticleLeadElements' own cutoff), it would let ANY short,
      // single-block blurb ANYWHERE on the page through unconditionally —
      // including "related articles" teaser headings/blurbs deep in the page,
      // which Readability correctly excludes but this bypass would readmit.
      const looksLikeLead = index <= 2 && isLikelyArticleLead(el)
      if (!looksLikeLead && !readableArticleText.includes(normalized)) return false
    }

    return true
  })
}

export function getContentElements(readableArticleText = ''): HTMLElement[] {
  const seen = new Set<HTMLElement>()
  const result: HTMLElement[] = []
  const add = (el: HTMLElement) => {
    if (!seen.has(el)) {
      seen.add(el)
      result.push(el)
    }
  }

  const title = getPrimaryTitleElement()
  if (title) add(title)

  for (const el of getTitleContextElements()) add(el)
  for (const el of getArticleLeadElements()) add(el)
  for (const el of getContentParagraphs(readableArticleText)) add(el)

  return result
}
