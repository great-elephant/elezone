// Keyboard shortcuts for Video Mode.
//
// Every binding is a single letter neither player already uses, and none
// collide with EleZone's own Alt+R / Alt+O commands.
//
// Netflix's player owns Space/Enter/K (play-pause), F, M, P, T and the arrows;
// `S` is avoided too, since Netflix binds it to "skip intro" on some titles.
// YouTube claims considerably more — K play-pause, J/L ±10s, F fullscreen,
// C captions, M mute, 0-9 to jump by percentage — but none of A, D, R or Z,
// which is why those survived the move.
//
// Space is the exception: it is passed through untouched *unless* playback is
// parked at the end of a line, where resuming is exactly what Space means
// anyway. Left unclaimed there, YouTube's own handler would toggle play
// straight back off again and the key would appear to do nothing.

export interface KeyActions {
  prevLine: () => void
  nextLine: () => void
  replayLine: () => void
  toggleTranslation: () => void
  /** Returns true if it consumed the key (i.e. we were waiting to resume). */
  resume: () => boolean
}

let _actions: KeyActions | null = null
let _installed = false
let _enabled = true

// Never steal a key the learner is typing into — the dictionary popover has a
// translation field, and both sites have their own search box.
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  )
}

function onKeyDown(e: KeyboardEvent) {
  if (!_enabled || !_actions) return
  if (e.altKey || e.ctrlKey || e.metaKey) return

  // Shadow DOM retargets `e.target` to the host, so check the real path.
  if (e.composedPath().some(isTyping)) return

  let handled = true
  switch (e.key.toLowerCase()) {
    case 'a': _actions.prevLine(); break
    case 'd': _actions.nextLine(); break
    case 'r': _actions.replayLine(); break
    case 'z': _actions.toggleTranslation(); break
    case ' ': handled = _actions.resume(); break
    default: handled = false
  }

  if (handled) {
    e.preventDefault()
    e.stopPropagation()
  }
}

export function installVideoModeKeys(actions: KeyActions): void {
  _actions = actions
  if (_installed) return
  // Capture phase: both sites put their own handlers on the document, and we
  // need to win for the keys we claim — and only for those.
  document.addEventListener('keydown', onKeyDown, { capture: true })
  _installed = true
}

export function setVideoModeKeysEnabled(enabled: boolean): void {
  _enabled = enabled
}

export function uninstallVideoModeKeys(): void {
  document.removeEventListener('keydown', onKeyDown, { capture: true })
  _installed = false
  _actions = null
}
