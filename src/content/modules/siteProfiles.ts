export interface SiteProfile {
  id: string
  hostnames: string[]
  contentRootSelectors: string[]
  titleSelectors: string[]
}

export const CONTENT_BLOCK_SELECTORS = [
  'p',
  'li',
  'blockquote',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'code',
  'dt',
  'dd',
  'figcaption',
]

const DEFAULT_SITE_PROFILE: SiteProfile = {
  id: 'default',
  hostnames: [],
  contentRootSelectors: [
    '[itemprop="articleBody"]',
    '.post-content',
    '.article-body',
    '.entry-content',
    'article',
    '[role="main"]',
    'main',
    '#content',
    '#main',
  ],
  titleSelectors: ['h1'],
}

const SITE_PROFILES: SiteProfile[] = [
  {
    id: 'vnexpress',
    hostnames: ['e.vnexpress.net', 'vnexpress.net'],
    contentRootSelectors: ['.main_fck_detail', '.fck_detail', ...DEFAULT_SITE_PROFILE.contentRootSelectors],
    titleSelectors: ['.title_post', 'h1'],
  },
]

function matchesHostname(hostname: string, candidate: string): boolean {
  return hostname === candidate || hostname.endsWith(`.${candidate}`)
}

export function getSiteProfile(hostname = window.location.hostname): SiteProfile {
  return SITE_PROFILES.find(profile =>
    profile.hostnames.some(candidate => matchesHostname(hostname, candidate))
  ) ?? DEFAULT_SITE_PROFILE
}

function queryFirst(selectors: string[], root: ParentNode): HTMLElement | null {
  for (const selector of selectors) {
    const el = root.querySelector<HTMLElement>(selector)
    if (el) return el
  }
  return null
}

function queryAllUnique(selectors: string[], root: ParentNode): HTMLElement[] {
  const seen = new Set<HTMLElement>()
  const result: HTMLElement[] = []

  for (const selector of selectors) {
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      if (seen.has(el)) continue
      seen.add(el)
      result.push(el)
    }
  }

  return result
}

export function getTitleElement(profile = getSiteProfile(), root?: ParentNode): HTMLElement | null {
  return (root ? queryFirst(profile.titleSelectors, root) : null) ?? queryFirst(profile.titleSelectors, document)
}

export function getContentRootCandidates(profile = getSiteProfile()): HTMLElement[] {
  return queryAllUnique(profile.contentRootSelectors, document)
}
