/**
 * F25 — handle SPA / soft navigation cleanly while reading.
 *
 * When a single-page app navigates via the History API (pushState/replaceState)
 * or the user hits back/forward (popstate), the URL changes but our sentence
 * ranges were built against the *old* DOM and are now stale. Continuing to read
 * would highlight the wrong content, so we stop read-aloud cleanly and save the
 * position (so Resume works when the user comes back).
 *
 * We deliberately do NOT try to auto-continue on the new page — re-anchoring
 * across an arbitrary SPA transition is fragile. A clean stop plus a saved
 * position is the safe, predictable behaviour.
 *
 * The history patch is defensive and reversible: we keep the original methods,
 * always call through to them (so site routing is never broken), and only react
 * when the resolved URL actually changed.
 */

type NavHandler = () => void

let installed = false
let onNavigate: NavHandler = () => {}
let lastUrl = ''

let originalPushState: History['pushState'] | null = null
let originalReplaceState: History['replaceState'] | null = null

function handlePotentialNavigation() {
  const now = location.href
  if (now === lastUrl) return
  lastUrl = now
  try {
    onNavigate()
  } catch {
    // Never let our handler throw into the site's navigation call.
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

/**
 * Start watching for soft navigations. `handler` is invoked (once per real URL
 * change) so the caller can stop reading + save the position. Idempotent.
 */
export function installSpaNavigationGuard(handler: NavHandler): void {
  if (installed) {
    onNavigate = handler
    return
  }
  installed = true
  onNavigate = handler
  lastUrl = location.href

  originalPushState = history.pushState
  originalReplaceState = history.replaceState
  history.pushState = patchedPushState
  history.replaceState = patchedReplaceState
  window.addEventListener('popstate', onPopState)
}

/** Restore the original history methods (reversible patch). Mostly for safety. */
export function uninstallSpaNavigationGuard(): void {
  if (!installed) return
  installed = false
  if (originalPushState) history.pushState = originalPushState
  if (originalReplaceState) history.replaceState = originalReplaceState
  window.removeEventListener('popstate', onPopState)
  originalPushState = null
  originalReplaceState = null
}
