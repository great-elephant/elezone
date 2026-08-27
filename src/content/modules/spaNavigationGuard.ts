/**
 * Shared SPA / soft-navigation detector.
 *
 * When a single-page app navigates via the History API (pushState/replaceState)
 * or the user hits back/forward (popstate), the URL changes without a page
 * load. Any feature that anchors state against the current DOM/URL (Read
 * Aloud's sentence ranges, Video Mode's per-episode cues) needs to know when
 * that happens so it can tear down/rebuild cleanly.
 *
 * Multiple independent features subscribe to the same guard rather than each
 * patching history.pushState/replaceState themselves — the patch is installed
 * once, idempotently, and every subscriber is notified on each real URL
 * change.
 *
 * The history patch is defensive and reversible: we keep the original methods,
 * always call through to them (so site routing is never broken), and only
 * notify subscribers when the resolved URL actually changed.
 */

type NavHandler = () => void

let installed = false
const subscribers = new Set<NavHandler>()
let lastUrl = ''

let originalPushState: History['pushState'] | null = null
let originalReplaceState: History['replaceState'] | null = null

function handlePotentialNavigation() {
  const now = location.href
  if (now === lastUrl) return
  lastUrl = now
  for (const handler of subscribers) {
    try {
      handler()
    } catch {
      // Never let one subscriber's throw stop the others, or bubble into the
      // site's own navigation call.
    }
  }
}

function patchedPushState(this: History, ...args: Parameters<History['pushState']>) {
  const ret = originalPushState!.apply(this, args)
  handlePotentialNavigation()
  return ret
}

function patchedReplaceState(this: History, ...args: Parameters<History['replaceState']>) {
  const ret = originalReplaceState!.apply(this, args)
  handlePotentialNavigation()
  return ret
}

function onPopState() {
  handlePotentialNavigation()
}

function ensureInstalled(): void {
  if (installed) return
  installed = true
  lastUrl = location.href

  originalPushState = history.pushState
  originalReplaceState = history.replaceState
  history.pushState = patchedPushState
  history.replaceState = patchedReplaceState
  window.addEventListener('popstate', onPopState)
}

/**
 * Subscribe to soft navigations. `handler` is invoked once per real URL
 * change, for as long as this subscription is active. Returns an unsubscribe
 * function. Installing the underlying history patch is idempotent regardless
 * of how many subscribers come and go.
 */
export function subscribeToSpaNavigation(handler: NavHandler): () => void {
  ensureInstalled()
  subscribers.add(handler)
  return () => {
    subscribers.delete(handler)
  }
}
