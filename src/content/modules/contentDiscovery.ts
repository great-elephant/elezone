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

function getMinimumContentLength(el: HTMLElement): number {
  if (el.matches('li, dt, dd')) return 6
  if (el.matches('h2, h3, h4, h5, h6')) return 8
  if (el.matches('blockquote, figcaption, time, address')) return 10
  if (el.matches('div, span') && el.querySelector('time, address')) return 10
  return 20
}

function isVisibleContentElement(el: HTMLElement): boolean {
  const text = getElementContentText(el)
  if (text.length < getMinimumContentLength(el)) return false
  if (el.closest('[data-cxt-translation]')) return false
  if (el.closest('nav, header, footer, aside')) return false
  if (el.querySelector('[data-cxt-translation]')) return false
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
      if ((el.tagName === 'DIV' || el.tagName === 'ARTICLE') && (contentBlockCount > 3 || text.length > 1500)) break

      if (
        text.length >= getMinimumContentLength(el) &&
        !el.getAttribute('data-cxt-translation') &&
        !el.closest('nav, header, footer, aside')
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

  return getCandidateContentBlocks(root).filter(el => {
    if (!isVisibleContentElement(el)) return false

    if (readableArticleText) {
      const normalized = getElementContentText(el)
      if (!isLikelyArticleLead(el) && !readableArticleText.includes(normalized)) return false
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
