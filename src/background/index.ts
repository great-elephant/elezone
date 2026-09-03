import {
  saveItem,
  getAllItems,
  deleteItem,
  getItemsForUrl,
  getSettings,
  saveSettings,
  markOrphaned,
  syncToDrive,
  logActivity,
  getActivityLog,
  updateFsrsMetrics,
  Rating,
  getLocalYMD
} from '../shared/library'
import {
  SavedItem,
  BookmarkColor,
  VideoModeSettings,
  BOOKMARK_COLORS,
  ReadAloudSettings,
  ReadAloudState,
  Settings,
  PomodoroStatus,
  PomodoroPhase,
  PomodoroState,
  UNCATEGORIZED_COLOR,
} from '../shared/types'
import { translateInContext, ContextTranslateRequest, fetchPhoneticsForWords, fetchPinyinForWords } from './aiTranslate'
import { getRandomRoast, RoastLevel, RoastIntensity, DEFAULT_ROAST_INTENSITY } from '../shared/roasts'

let creatingOffscreen: Promise<void> | null = null;

async function setupOffscreenDocument(path: string) {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: path,
      reasons: [
        chrome.offscreen.Reason.AUDIO_PLAYBACK,
        chrome.offscreen.Reason.DOM_PARSER
      ],
      justification: 'Run Pomodoro timer accurately and generate animated badge icon',
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
}

// ---------------------------------------------------------------------------
// Bluetooth audio keepalive
//
// A Bluetooth earbud that powers its amplifier down between playbacks swallows
// the first few hundred milliseconds of the next one — the whole first word of
// a sentence. The offscreen document holds an inaudible tone to stop that from
// ever happening; see `startAudioKeepalive` there for the measurements and for
// why the obvious cheaper tricks (a one-shot beep, a near-silent priming
// utterance) do not work.
//
// Every speak path goes through `holdAudioAwake()` so no call site can forget.

// How long the offscreen document keeps the tone running on its own. Read Aloud
// speaks again within seconds — the next sentence, or a shadowing repeat — and
// dropping the tone in the gaps would re-arm the very wake-up this prevents.
// Also the deadline that stops a tone outliving a killed service worker.
const KEEPALIVE_TTL_MS = 30_000

// The tone has to be playing *before* speech starts, or the amplifier wakes up
// during the first word exactly as it did without it. Only the first utterance
// after a cold start pays this; once the tone is up, later speaks wait 0 ms.
const KEEPALIVE_WARMUP_MS = 400

// When the tone was last armed, and when it last started from cold. They are
// tracked separately so a long reading session doesn't pay the warmup wait
// again every time the arm timestamp drifts past some threshold: the tone is
// still running, so there is nothing to wait for.
let keepaliveArmedAt = 0
let keepaliveRunningSince = 0

async function holdAudioAwake(settings: ReadAloudSettings): Promise<void> {
  if (!settings.audioKeepalive) return
  try {
    await setupOffscreenDocument('src/offscreen/index.html')
    const running = keepaliveArmedAt !== 0 && Date.now() - keepaliveArmedAt < KEEPALIVE_TTL_MS
    if (!running) keepaliveRunningSince = Date.now()
    keepaliveArmedAt = Date.now()
    await chrome.runtime.sendMessage({
      type: 'AUDIO_KEEPALIVE',
      payload: { on: true, ttlMs: KEEPALIVE_TTL_MS },
    })
    const warmedFor = Date.now() - keepaliveRunningSince
    if (warmedFor < KEEPALIVE_WARMUP_MS) {
      await new Promise(resolve => setTimeout(resolve, KEEPALIVE_WARMUP_MS - warmedFor))
    }
  } catch {
    // The keepalive is an optimisation. If the offscreen document can't be
    // reached, speech still has to happen — just with the clipped first word
    // it had before.
  }
}

// Drop the tone as soon as we know no more speech is coming, rather than
// waiting out the TTL. Safe to call when no keepalive is running.
function releaseAudioAwake() {
  keepaliveArmedAt = 0
  keepaliveRunningSince = 0
  chrome.runtime
    .sendMessage({ type: 'AUDIO_KEEPALIVE', payload: { on: false } })
    .catch(() => {
      // No offscreen document listening — nothing to stop.
    })
}


type ActiveReadAloudSession = {
  currentIndex: number
  currentRep: number
  currentPageRep?: number
  sentences: string[]
  settings: ReadAloudSettings
  lang?: string
  state: ReadAloudState
  tabId: number
  token: number
  // The voice name actually used for the current utterance (either configured
  // or auto-picked in speakCurrentSentence). Surfaced to the mini-player chip.
  resolvedVoice?: string
  // H29 — shadowing mode. When true, an intentional silent gap is inserted
  // between sentences (after a sentence's repetitions finish) so the learner can
  // repeat aloud before the next one starts.
  shadowing?: boolean
  // True only while we're sitting in the intentional inter-sentence gap. The
  // watchdog is cleared for the gap, so this is mostly informational, but it lets
  // the mini-player show a subtle "shadowing…" indicator.
  inGap?: boolean
  // Timestamp until which a same-utterance 'interrupted'/'cancelled'/'error' TTS
  // event should be ignored rather than tearing the session down. Some TTS
  // engines fire one of those as a side effect of chrome.tts.pause()/resume()
  // itself (not a real interruption) — unlike every other control action,
  // pause/resume don't bump `token` (they act on the still-live utterance rather
  // than starting a new one), so that event would otherwise match and kill a
  // session the user only meant to pause.
  suppressStopUntil?: number
  // Timestamp of the last chrome.tts.speak() call for this session. The
  // watchdog gives isSpeaking() a grace period after this before trusting a
  // `false` reading — some engines (especially remote/network voices) take a
  // moment to actually start producing audio for the *next* utterance after
  // the previous one's 'end' event fires, and a watchdog tick landing in that
  // gap would otherwise read as a stall and kill a session that's actually
  // fine, just about to speak (the "random" mid-article stop).
  speakStartedAt?: number
  // Parallel array to `sentences` — which real sentence each clause belongs
  // to. Only populated when the plan was built with shadowing's clause-
  // splitting on; undefined otherwise (repeatWholeSentence has no effect
  // without it). See the matching doc on anchor.ts's buildSentencePlan
  // return type for how this is derived.
  sentenceGroupIds?: number[]
  // How many whole-sentence passes have been completed for the sentence
  // currently being repeated (repeatWholeSentence mode only) — deliberately
  // separate from `currentRep`, which resets on every mid-sentence clause
  // (including the ones a whole-sentence replay walks back through), so it
  // can't double as this counter without being wiped before it reaches
  // `repetition`.
  sentenceRepCount?: number
}

const COLORS = Object.keys(BOOKMARK_COLORS) as BookmarkColor[]
const readAloudStateByTab = new Map<number, ReadAloudState>()
let activeSession: ActiveReadAloudSession | null = null
let sessionCounter = 0
let ttsRestartTimeout: ReturnType<typeof setTimeout> | null = null
let speakingWatchdog: ReturnType<typeof setInterval> | null = null
// H29 — pending inter-sentence "shadowing" gap timer. While this is armed the
// speaking watchdog is deliberately cleared, because TTS is *intentionally*
// silent; a stop/seek/next during the gap must cancel it.
let shadowingGapTimeout: ReturnType<typeof setTimeout> | null = null

let focusTimeAccumulator = 0;
let lastPomodoroStatus: PomodoroStatus = 'stopped';
let lastPomodoroPhase: PomodoroPhase = 'idle';
let lastPomodoroTaskId: string | null | undefined = null;
let lastFocusTickAt = 0;

const COLOR_EMOJI: Record<BookmarkColor, string> = {
  red: '🔴', yellow: '🟡', cyan: '🔵', green: '🟢', blue: '💙',
  orange: '🟠', purple: '🟣', pink: '🩷', teal: '🩵', gray: '⚫',
}

chrome.runtime.onInstalled.addListener((details) => {
  setupContextMenus()
  setupSrsAlarm()
  
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/guide.html') })
  }
})
chrome.runtime.onStartup.addListener(() => {
  setupContextMenus()
  setupSrsAlarm()
})

// Rebuild menus whenever settings change (handles label and order changes).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['settings']) {
    void setupContextMenus()
    // Recreating the alarm resets its periodInMinutes countdown, so only do it
    // when the srsNotifications config itself actually changed — not on every
    // settings save (slider drags, deck edits, ...), which would otherwise keep
    // pushing srs-tick's first fire further into the future indefinitely.
    const oldSrs = (changes.settings.oldValue as Settings | undefined)?.srsNotifications
    const newSrs = (changes.settings.newValue as Settings | undefined)?.srsNotifications
    if (JSON.stringify(oldSrs) !== JSON.stringify(newSrs)) {
      void setupSrsAlarm()
    }
  }
})

async function setupSrsAlarm() {
  const settings = await getSettings()
  const srs = settings.srsNotifications
  if (srs?.enabled) {
    chrome.alarms.create('srs-tick', { periodInMinutes: srs.intervalMinutes || 15 })
  } else {
    chrome.alarms.clear('srs-tick')
  }
}

// Active-hours window check, shared by the SRS due-notification tick and the
// slacking "roast" notification below — both gate on the same
// srsNotifications.activeHoursStart/End setting. Handles a window that wraps
// past midnight (e.g. start=8, end=2 meaning "8am to 2am", active overnight
// until 2am then quiet until 8am) as well as a same-day window (start=8,
// end=22). A naive `currentHour >= start && currentHour < end` only works
// for the same-day case — for a wrapped window every hour of the day falls
// outside that range, which would silence notifications entirely.
function isWithinActiveHours(startHour: number, endHour: number, currentHour: number): boolean {
  if (startHour === endHour) return true // degenerate "0-length" window reads as always-active, not never
  return startHour < endHour
    ? (currentHour >= startHour && currentHour < endHour)
    : (currentHour >= startHour || currentHour < endHour)
}

// Result surfaced back to the "Test Notification" button so a no-op isn't
// silent — previously this function just `return`ed on every skip path with
// no way for the caller to tell "a notification was created" apart from
// "nothing was due" apart from "everything's muted", so pressing the test
// button when e.g. every deck/source happened to be muted (see
// mutedNotificationDecks/mutedNotificationSources) looked identical to the
// feature being completely broken.
type SrsNotificationResult =
  | { created: true }
  | { created: false, reason: 'disabled' | 'outside-active-hours' | 'no-due-items' | 'all-muted' | 'already-mid-review' }

async function triggerSrsNotification(testMode = false): Promise<SrsNotificationResult> {
  const settings = await getSettings()
  if (!settings.srsNotifications?.enabled && !testMode) return { created: false, reason: 'disabled' }

  if (!testMode) {
    const startHour = settings.srsNotifications?.activeHoursStart ?? 8
    const endHour = settings.srsNotifications?.activeHoursEnd ?? 22
    const currentHour = new Date().getHours()
    if (!isWithinActiveHours(startHour, endHour, currentHour)) {
      return { created: false, reason: 'outside-active-hours' }
    }
  }

  const items = await getAllItems()
  // getAllItems() now repairs a missing id on read, but that's a second
  // layer of defense, not the guarantee itself — an item without a usable
  // id must never become a notification candidate: its notification id
  // would serialize as the literal "srs-q-undefined", it wins "most due"
  // forever (due reads as the 0 fallback), and the id round-trip out of
  // "Show Answer" back to an item lookup can never match it either. See
  // getAllItems's comment for the full chain this breaks.
  // Opt-out lists edited from Library.tsx (per-row bell icon, or the bulk
  // "Focus" action) — an item stays a candidate if EITHER its deck or its
  // source is unmuted (OR, not AND). This is deliberate, not an oversight:
  // "Focus" mutes the entire *other* axis when only one is selected (e.g.
  // focusing a single source mutes every deck), so an AND check would mean
  // that source's own items — which still belong to some now-muted deck —
  // could never pass, making single-axis Focus notify nothing at all. OR
  // means a plain per-row bell mute on ONE axis only takes effect if the
  // item's other axis is *also* muted somewhere — e.g. muting a single deck
  // by itself, with no source ever muted, won't suppress that deck's items
  // (every item passes via the unmuted-source side). In practice that's
  // fine: the common single-toggle case is "mute this deck" or "mute this
  // source" as the ONLY mute in play, and OR only fails to suppress when
  // the other axis's list is entirely empty — once anything on either axis
  // is muted (which Focus always does), the combination behaves as expected.
  // Doesn't affect the in-app "Due today" stat or "Study now": muting only
  // means "don't interrupt me", not "hide this from me when I open the app
  // myself".
  const mutedDecks = new Set(settings.mutedNotificationDecks ?? [])
  const mutedSources = new Set(settings.mutedNotificationSources ?? [])
  const eligibleItems = items.filter(i => !i.orphaned && i.text && i.id)
  let dueItems = eligibleItems.filter(i =>
    !mutedDecks.has(i.color) ||
    !mutedSources.has(i.url || 'Dictionary (No URL)')
  )
  // Distinguish "nothing to notify about at all" from "everything's muted"
  // — the latter is easy to hit via the Focus feature (focusing one axis
  // mutes the whole other axis) and previously looked identical to the
  // feature being broken outright, with zero feedback either way.
  if (eligibleItems.length > 0 && dueItems.length === 0) {
    return { created: false, reason: 'all-muted' }
  }

  // `due` (FSRS) is what actually matters once a card has been through FSRS
  // at least once (StudyUI/notification-answer flow both write it now); an
  // item that's only ever had SM-2 history (or has never been reviewed at
  // all) has no `due` yet, so fall back to the legacy `nextReview` for those
  // — same "?? " pattern used everywhere else FSRS due-ness is checked.
  const dueAt = (i: SavedItem) => i.due ?? i.nextReview ?? 0

  // Same selection logic in test mode as the real tick (only the enabled/active-hours
  // gating above is test-only) — otherwise the Test Notification button always takes
  // the random-fallback branch and can never surface a bug in the due-item query.
  const strictlyDue = dueItems.filter(i => dueAt(i) <= Date.now())
  if (strictlyDue.length > 0) {
    dueItems = strictlyDue
    dueItems.sort((a, b) => dueAt(a) - dueAt(b))
  } else {
    // Fallback: If no items are strictly due, just pick a random one to keep the user engaged!
    dueItems.sort(() => Math.random() - 0.5)
  }

  if (dueItems.length === 0) return { created: false, reason: 'no-due-items' }

  const item = dueItems[0]

  // Only one review prompt should ever be on screen at a time. Without this, an
  // earlier tick's unanswered prompt for a *different* item (same-item repeats
  // just replace via the matching notification id) is never dismissed, so
  // requireInteraction notifications pile up in the tray tick after tick.
  const existingIds: string[] = await new Promise(resolve => {
    chrome.notifications.getAll(map => resolve(Object.keys(map || {})))
  })
  for (const id of existingIds) {
    if (id.startsWith('srs-q-') && id !== `srs-q-${item.id}`) chrome.notifications.clear(id)
  }

  // If the selected item is itself already mid-review (the user clicked "Show
  // Answer" on an earlier tick's prompt and hasn't picked "I knew it"/"Forgot"
  // yet), its due date hasn't moved, so it's still picked as the top due item
  // here. Without this check we'd create a brand-new `srs-q-<id>` alongside the
  // still-open `srs-a-<id>` — a different id, so the dedupe loop above (which
  // only matches the `srs-q-` prefix) can't catch it — leaving two prompts for
  // the same card on screen at once, which is exactly the pileup this function
  // is supposed to prevent.
  if (existingIds.includes(`srs-a-${item.id}`)) return { created: false, reason: 'already-mid-review' }

  chrome.notifications.create(`srs-q-${item.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `Review: ${item.text}`,
    message: 'Click "Show Answer" to flip the card.',
    buttons: [{ title: 'Show Answer' }],
    requireInteraction: true
  })
  return { created: true }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'srs-tick') {
    await triggerSrsNotification(false)
    await evaluateSlackingState(false)
  }
})

async function startOcr(tab?: chrome.tabs.Tab | null) {
  if (!tab?.id) return
  try {
    // Normal pages: the content script draws the in-page crop overlay.
    await chrome.tabs.sendMessage(tab.id, { type: 'START_CROP_MODE' })
  } catch {
    // No content script here (Chrome's PDF viewer, chrome:// pages, ...) —
    // fall back to a standalone crop window that works over a screenshot.
    await openOcrWindow(tab)
  }
}

// Tracks the standalone crop popup (PDF viewer / chrome:// fallback) so a
// second trigger_ocr replaces it with a fresh capture instead of stacking
// another window on top of the stale one.
let ocrWindowId: number | null = null
chrome.windows.onRemoved.addListener(id => {
  if (id === ocrWindowId) ocrWindowId = null
})

// Serializes concurrent openOcrWindow() calls: the ocrWindowId guard above is
// only assigned once windows.create() resolves, so two trigger_ocr's fired in
// quick succession would both sail past it while still awaiting
// captureVisibleTab/getSettings/etc and each end up creating their own popup.
// Locking synchronously (before the first await), same pattern as
// setupOffscreenDocument's `creatingOffscreen`, makes the second call wait for
// the first to finish (and inherit its window) instead of racing it.
let openingOcrWindow: Promise<void> | null = null

// Monotonic id for each standalone crop-window OCR run, handed to the popup
// via ocr_window_payload and echoed back through OCR_WINDOW_PROGRESS/RESULT.
// OCR_WINDOW_* messages are a runtime-wide broadcast rather than scoped to a
// window, so without this a result from a job the user abandoned by closing
// the popup mid-OCR can land in a freshly reopened popup and show a stale
// answer.
let ocrWindowRequestSeq = 0

async function openOcrWindow(tab: chrome.tabs.Tab) {
  if (openingOcrWindow) {
    await openingOcrWindow
    return
  }

  let releaseLock: () => void = () => { }
  openingOcrWindow = new Promise(resolve => { releaseLock = resolve })

  try {
    if (ocrWindowId != null) {
      // Ignore the error if the user already closed it manually — either way
      // we're back to "no crop window open", then fall through to open a fresh one.
      try { await chrome.windows.remove(ocrWindowId) } catch { /* already gone */ }
      ocrWindowId = null
    }

    const winId = tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT
    const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' })
    const settings = await getSettings()
    const lang = settings.ocr?.language || 'eng'
    const requestId = ++ocrWindowRequestSeq
    await chrome.storage.session.set({ ocr_window_payload: { dataUrl, lang, requestId } })

    // Match the current window's bounds so the crop popup lands directly over
    // the page it's capturing (PDF viewer / chrome:// — no in-page overlay is
    // possible there) instead of appearing as an unrelated window elsewhere.
    let bounds: Partial<chrome.windows.CreateData> = { width: 1000, height: 780 }
    try {
      const sourceWindow = await chrome.windows.get(winId)
      if (sourceWindow.left != null && sourceWindow.top != null && sourceWindow.width && sourceWindow.height) {
        bounds = {
          left: sourceWindow.left,
          top: sourceWindow.top,
          width: sourceWindow.width,
          height: sourceWindow.height,
        }
      }
    } catch {
      // Fall back to the default centered size above.
    }

    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('src/crop/index.html'),
      type: 'popup',
      ...bounds,
    })
    ocrWindowId = win?.id ?? null
  } catch (e) {
    console.error('Failed to open OCR window:', e)
  } finally {
    openingOcrWindow = null
    releaseLock()
  }
}

// If read-aloud is already running on `tab` (playing OR paused), stop it.
// Otherwise kick off a fresh session exactly like the popup's "Start Reading".
// Shared by the Alt+R shortcut and the "Listen" context menu item.
async function toggleReadAloudForTab(tab: chrome.tabs.Tab) {
  if (!tab?.id) return
  const isActive = activeSession?.tabId === tab.id
    || (readAloudStateByTab.get(tab.id) ?? 'idle') !== 'idle'
  if (isActive) {
    if (activeSession?.tabId === tab.id) {
      await stopActiveSession()
    } else {
      // No live TTS session here, but the tab still thinks it's reading —
      // tell it to reset so its mini-player/highlights tear down.
      readAloudStateByTab.delete(tab.id)
      chrome.tabs.sendMessage(tab.id, { type: 'STOP_READ_ALOUD' }).catch(() => { })
    }
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'START_READ_ALOUD' }).catch(() => { })
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'play_pause' && activeSession) {
    // Delegate to controlReadAloud instead of re-implementing pause/resume here:
    // that's the single source of truth for the suppressStopUntil grace window
    // (a bare chrome.tts.pause()/resume() call can itself fire an
    // interrupted/cancelled event on some engines, which would otherwise tear
    // the session down — see 04c2b5d) and for the stop()+re-speak resume
    // pattern (chrome.tts.resume() alone doesn't reliably un-pause every engine).
    const action = activeSession.state === 'playing' ? 'pause' : activeSession.state === 'paused' ? 'resume' : null
    if (action) {
      await controlReadAloud({} as chrome.runtime.MessageSender, { action, tabId: activeSession.tabId })
    }
  } else if (command === 'trigger_ocr') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tabs[0]) await startOcr(tabs[0])
  } else if (command === 'toggle_read_aloud') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tabs[0]) await toggleReadAloudForTab(tabs[0])
  }
})

async function evaluateSlackingState(testMode = false) {
  const settings = await getSettings()
  // Treat undefined as the default (not as 'off') for existing users.
  const intensity: RoastIntensity = settings.gamification?.roastIntensity ?? DEFAULT_ROAST_INTENSITY

  // 'off' fully suppresses the roast/slacking banner and notifications.
  // Keep the legacy roast.enabled flag as an additional master switch.
  if ((!settings.roast?.enabled || intensity === 'off') && !testMode) {
    await chrome.storage.local.remove('slacking_state')
    return
  }

  if (testMode) {
    // For the test button, preview the current intensity (or the default if off).
    const testIntensity = intensity === 'off' ? DEFAULT_ROAST_INTENSITY : intensity
    const roastMessage = getRandomRoast(testIntensity)!
    const state = { isSlacking: true, level: 3, message: roastMessage }
    await chrome.storage.local.set({ slacking_state: state })

    chrome.notifications.create(`roast-test-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'EleZone Alert 🚨 (Test)',
      message: roastMessage,
      requireInteraction: false
    })
    return
  }

  const items = await getAllItems()
  if (items.length === 0) {
    await chrome.storage.local.remove('slacking_state')
    return
  }
  const now = Date.now()
  

  const activityLog = await getActivityLog()
  const dailyGoal = settings.gamification?.dailyGoalPoints || 100
  const thresholdDays = settings.roast?.noNewItemsDaysThreshold || 3

  let slacking = false
  let level: RoastLevel = 1
  
  const firstItemDate = Math.min(...items.map(i => i.createdAt))
  const firstDateObj = new Date(firstItemDate)
  firstDateObj.setHours(0, 0, 0, 0)

  let consecutiveMissedDays = 0
  // Start from yesterday: today is still in progress and can't yet be judged
  // "missed" (todayPoints is handled separately below), so counting it here
  // would trigger the roast a full day earlier than `thresholdDays` implies.
  for (let i = 1; i <= 30; i++) {
    const date = new Date()
    date.setDate(date.getDate() - i)
    date.setHours(0, 0, 0, 0)

    if (date.getTime() < firstDateObj.getTime()) {
      break // Don't penalize for days before they even started using the extension
    }

    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const ymd = `${year}-${month}-${day}`
    
    const points = activityLog[ymd]?.points || 0
    if (points < dailyGoal) {
      consecutiveMissedDays++
    } else {
      break
    }
  }

  // User is slacking if they haven't met their daily goal for `thresholdDays` consecutive days
  if (consecutiveMissedDays >= thresholdDays) {
    slacking = true
    const severity = consecutiveMissedDays / thresholdDays
    if (severity >= 3) level = 3
    else if (severity >= 2) level = 2
    else level = 1
  }

  const today = getLocalYMD()
  const todayPoints = activityLog[today]?.points || 0

  if (todayPoints > 0 && !testMode) {
    slacking = false
  }

  if (slacking) {
    // The user-selected intensity picks the pool; `level` is kept only as a
    // severity hint in the stored state for backward compatibility.
    const roastMessage = getRandomRoast(intensity)!
    const state = { isSlacking: true, level, message: roastMessage }
    await chrome.storage.local.set({ slacking_state: state })
    
    const { last_roast_time = 0 } = await chrome.storage.local.get('last_roast_time')
    const HOURS_48 = 48 * 60 * 60 * 1000
    
    // Do not notify during sleep hours
    const startHour = settings.srsNotifications?.activeHoursStart ?? 8
    const endHour = settings.srsNotifications?.activeHoursEnd ?? 22
    const currentHour = new Date().getHours()
    const isAwakeTime = isWithinActiveHours(startHour, endHour, currentHour)

    if (now - last_roast_time > HOURS_48 && isAwakeTime) {
      chrome.notifications.create(`roast-${now}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'EleZone Alert 🚨',
        message: roastMessage,
        requireInteraction: false
      })
      await chrome.storage.local.set({ last_roast_time: now })
    }
  } else {
    await chrome.storage.local.remove('slacking_state')
  }
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (notificationId.startsWith('srs-q-')) {
    const id = notificationId.replace('srs-q-', '')
    const items = await getAllItems()
    const item = items.find(i => i.id === id)

    chrome.notifications.clear(notificationId)

    if (!item) return

    let context = ''
    if (item.prefix || item.suffix) {
      context = `\n\nContext: ${item.prefix}${item.text}${item.suffix}`
    }

    const settings = await getSettings()

    // If Read Aloud is actively speaking on some tab, this notification's
    // chrome.tts.stop() would otherwise interrupt it and — via
    // handleTtsEvent's unsuppressed 'interrupted' branch — tear the whole
    // session down. Same pause-then-auto-resume pattern as the SPEAK_TEXT
    // message handler below: pause it first (suppressing that teardown),
    // then resume it once this notification's own utterance finishes.
    // `wasReading` deliberately excludes 'paused' — if the user had already
    // paused Read Aloud themselves, this must not un-pause it for them.
    const wasReading = activeSession?.state === 'playing'
    if (activeSession) {
      activeSession.suppressStopUntil = Date.now() + 3000
      if (wasReading) {
        activeSession.state = 'paused'
        await broadcastReadAloudState(activeSession.tabId, 'paused', activeSession.currentIndex)
      }
    }
    const resumeToken = activeSession?.token

    const onAnswerSpoken = (event: chrome.tts.TtsEvent) => {
      if (!['end', 'interrupted', 'cancelled', 'error'].includes(event.type)) return
      if (wasReading && activeSession && resumeToken === activeSession.token) {
        activeSession.state = 'playing'
        activeSession.suppressStopUntil = Date.now() + 500
        void broadcastReadAloudState(activeSession.tabId, 'playing', activeSession.currentIndex)
        void speakCurrentSentence(resumeToken)
      }
    }

    chrome.tts.stop()
    // `item.sourceLang` was never passed here before — every card was spoken
    // with whichever voice happened to be configured as the global default
    // (or the system default, with no language hint at all), so a card in any
    // other language either came out in the wrong accent or, when that
    // voice's engine can't render the script at all (Latin-only engine given
    // Chinese text), produced no audio and no error. Resolve per-item like
    // every other speak path does (D14/D17).
    const answerVoice = await resolveVoiceForSettings(settings.readAloud, item.sourceLang)
    await holdAudioAwake(settings.readAloud)
    chrome.tts.speak(item.text, {
      pitch: settings.readAloud.pitch,
      rate: settings.readAloud.speed,
      lang: item.sourceLang,
      voiceName: answerVoice,
      volume: settings.readAloud.volume,
      onEvent: onAnswerSpoken,
    }, () => {
      // Same silent-failure gap fixed elsewhere (SPEAK_TEXT, StudyUI's
      // speakText, Library's playAudio): a forced lang/voiceName matching no
      // installed voice makes chrome.tts refuse to start at all. Retry once
      // unconstrained so the card is still heard, just possibly mispronounced.
      if (chrome.runtime.lastError) {
        chrome.tts.speak(item.text, {
          pitch: settings.readAloud.pitch,
          rate: settings.readAloud.speed,
          volume: settings.readAloud.volume,
          onEvent: onAnswerSpoken,
        })
      }
    })

    chrome.notifications.create(`srs-a-${item.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `Answer: ${item.text}${item.phonetics ? `  [${item.phonetics}]` : ''}`,
      message: `${item.translation || '[No translation saved]'}${context}`,
      buttons: [{ title: 'I knew it (Easy)' }, { title: 'Forgot (Hard)' }],
      requireInteraction: true
    })
  } else if (notificationId.startsWith('srs-a-')) {
    const id = notificationId.replace('srs-a-', '')
    const items = await getAllItems()
    const item = items.find(i => i.id === id)
    
    chrome.notifications.clear(notificationId)
    
    if (!item) return
    
    const passed = buttonIndex === 0
    const updated = updateFsrsMetrics(item, passed ? Rating.Good : Rating.Again)

    await saveItem(updated)
    await logActivity('review')
    await evaluateSlackingState(false)
  }
})

chrome.tabs.onRemoved.addListener(tabId => {
  readAloudStateByTab.delete(tabId)
  if (activeSession?.tabId === tabId) {
    void stopActiveSession()
  }
})

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Chrome's contextMenus.create() has no `icons` field for per-item custom
// icons (that's Firefox-only) — menu items are text-title only, so a custom
// deck's actual color can never be rendered exactly here. Approximate it by
// picking whichever preset's emoji is closest in RGB space, instead of
// always falling back to a plain white dot regardless of the chosen color.
function nearestPresetEmoji(color: string): string {
  const rgb = hexToRgb(color)
  if (!rgb) return '⚪'
  let best: BookmarkColor | null = null
  let bestDist = Infinity
  for (const preset of COLORS) {
    const prgb = hexToRgb(BOOKMARK_COLORS[preset])
    if (!prgb) continue
    const dist = (rgb[0] - prgb[0]) ** 2 + (rgb[1] - prgb[1]) ** 2 + (rgb[2] - prgb[2]) ** 2
    if (dist < bestDist) { bestDist = dist; best = preset }
  }
  return best ? COLOR_EMOJI[best] : '⚪'
}

function colorMenuTitle(color: string, deckLabels: Record<string, string>) {
  // Custom decks (a hex from the color picker, e.g. "+ New deck") have no
  // discrete entry in COLOR_EMOJI — approximate with the closest-matching
  // preset emoji rather than excluding them from the menu entirely (they
  // were previously filtered out here, which meant a freshly created deck
  // could never appear in the context menu no matter how it was reordered,
  // unlike the save-text popover in dictionary.ts which never had this
  // restriction).
  const emoji = (COLOR_EMOJI as Record<string, string>)[color] || nearestPresetEmoji(color)
  const label = deckLabels[color]
  return label
    ? `${emoji} ${label}`
    : `${emoji} ${color.charAt(0).toUpperCase() + color.slice(1)}`
}

function createContextMenuItem(props: chrome.contextMenus.CreateProperties) {
  chrome.contextMenus.create(props, () => {
    // create() doesn't throw on failure (e.g. a duplicate id left over from
    // an overlapping rebuild) — it just silently drops the item unless this
    // callback checks lastError, so surface it instead of failing silently.
    if (chrome.runtime.lastError) {
      console.warn(`contextMenus.create(${props.id}) failed:`, chrome.runtime.lastError.message)
    }
  })
}

// setupContextMenus is called every time settings changes at all (see the
// storage.onChanged listener below), so back-to-back settings writes (e.g.
// two quick drags while reordering decks) can trigger overlapping calls.
// Each call's removeAll()+create() sequence used to run un-awaited and
// unserialized, so a newer call's removeAll() could race an older call's
// still-pending create()s — leaving stale items in place or dropping new
// ones as "duplicate id" errors nobody was checking for. Chaining every
// call onto this promise forces them to run strictly one at a time, each
// reading fresh settings only once the previous rebuild has fully finished.
let contextMenusChain: Promise<void> = Promise.resolve()

function setupContextMenus(): Promise<void> {
  contextMenusChain = contextMenusChain
    .then(() => rebuildContextMenus())
    .catch(err => console.error('setupContextMenus failed:', err))
  return contextMenusChain
}

async function rebuildContextMenus() {
  const settings = await getSettings()
  const deckLabels = settings?.deckLabels || {}
  // `deckOrder` is a freeform string[] — both the 10 preset `BookmarkColor`
  // names and custom hex decks made via "+ New deck" in Library. Exclude
  // only the reserved Uncategorized bucket (not a deck the user actively
  // chose to save into).
  const knownOrder = (settings?.deckOrder || []).filter(c => c !== UNCATEGORIZED_COLOR)
  // Append any preset colors missing from `knownOrder` (never customized yet,
  // or — critically — deleted as a deck in Library, which only strips the
  // color from `deckOrder`'s ordering, not from the set of valid colors) so
  // a user's drag-reorder is never discarded wholesale just because the two
  // lists don't match exactly. Previously this required an exact length
  // match against all 10 presets, so deleting even one deck permanently
  // fell back to the unordered preset list forever, ignoring every future
  // reorder — see issues.md.
  const missing = COLORS.filter(c => !knownOrder.includes(c))
  const fullOrder: string[] = [...knownOrder, ...missing]
  // Context menu space is limited — only show the top 5 decks, in the
  // user's own reorder from the Library page (deckOrder), not all 10 presets.
  const order = fullOrder.slice(0, 5)

  const ocrLangMap: Record<string, string> = {
    eng: 'EN',
    chi_sim: 'ZH-S',
    chi_tra: 'ZH-T'
  };
  const ocrLang = settings?.ocr?.language || 'eng';
  const displayLang = ocrLangMap[ocrLang] || ocrLang.toUpperCase();

  // Wrapped in a promise so this rebuild genuinely finishes (including every
  // create() call below) before setupContextMenus's returned promise
  // resolves — previously the async function returned right after
  // getSettings(), well before removeAll's callback ever ran.
  await new Promise<void>(resolve => {
    chrome.contextMenus.removeAll(() => {
      createContextMenuItem({ id: 'ocr', title: `Image to text(Alt + O) [${displayLang}]`, contexts: ['page', 'image', 'selection'] })
      createContextMenuItem({ id: 'listen', title: 'Listen (Alt + R)', contexts: ['page', 'selection'] })
      createContextMenuItem({ id: 'read-from-here', title: 'Read from this sentence', contexts: ['selection'] })
      for (const color of order) {
        createContextMenuItem({
          id: `bookmark-${color}`,
          title: colorMenuTitle(color, deckLabels),
          contexts: ['selection'],
        })
      }
      resolve()
    })
  })
}

function clearSpeakingWatchdog() {
  if (speakingWatchdog !== null) {
    clearInterval(speakingWatchdog)
    speakingWatchdog = null
  }
}

// Cancel any pending shadowing gap. Called on stop/finish and on every
// token-bumping control action (seek/next/prev/setSpeed/setVoice) so a gap that
// was scheduled for the old sentence can't fire against the new one.
function clearShadowingGap() {
  if (shadowingGapTimeout !== null) {
    clearTimeout(shadowingGapTimeout)
    shadowingGapTimeout = null
  }
}

// H29 — estimate the silent gap (ms) to leave for the learner to repeat a
// sentence aloud. Proportional to the sentence's estimated speaking time at the
// current rate (~2 words/sec baseline), clamped to a sensible min/max so very
// short or very long sentences still feel predictable.
const GAP_MIN_MS = 1200
const GAP_MAX_MS = 8000
const GAP_WORDS_PER_SEC = 2
// `ratio` mirrors Video Mode's shadowGapFactor: a learner-tunable multiplier on
// the estimated gap, applied before clamping so it can still push the result
// past the default MIN/MAX. Default 1 = old behaviour (identical output).
function computeShadowingGapMs(sentence: string, speed: number, ratio: number): number {
  const words = sentence.trim().split(/\s+/).filter(Boolean).length || 1
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1
  const speakSec = words / (GAP_WORDS_PER_SEC * rate)
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  const ms = speakSec * 1000 * r
  return Math.round(Math.max(GAP_MIN_MS, Math.min(GAP_MAX_MS, ms)))
}

// Moves the session on to the next sentence (advancing currentIndex, handling
// end-of-article page repetition, or finishing the session) and speaks it.
// Split out from the TTS 'end' handler so the shadowing gap can defer this
// until the gap actually elapses — currentIndex must keep pointing at the
// sentence that was just spoken for the gap's duration, since that's the one
// the learner is meant to repeat, not the upcoming one.
function advanceToNextSentence(token: number) {
  const session = activeSession
  if (!session || session.token !== token) return

  session.currentIndex += 1
  if (session.currentIndex >= session.sentences.length) {
    const pageRep = session.settings.pageRepetition || 1
    session.currentPageRep = (session.currentPageRep || 1) + 1

    if (session.currentPageRep <= pageRep) {
      session.currentIndex = 0
      void speakCurrentSentence(token)
      return
    }

    // Natural end of the article (all page repetitions done) — surface the
    // Finished card rather than a silent teardown (F22).
    void finishActiveSession()
    return
  }

  void speakCurrentSentence(token)
}

// Schedule the shadowing gap before advancing to the next sentence. The
// watchdog is stopped for the duration of the gap so an intentional silence
// can't be mistaken for a stalled utterance and torn down; it is re-armed
// right before we resume speaking. Everything is guarded by `token`, and the
// whole thing is cancelled by clearShadowingGap() on any stop/seek.
// `justSpoke` is the sentence that just finished — its length drives the gap
// so the pause scales with what the learner needs to repeat, and
// session.currentIndex (still pointing at that same sentence) is what stays
// highlighted for the duration of the gap.
function scheduleShadowingGap(token: number, justSpoke: string, onComplete: () => void) {
  const session = activeSession
  if (!session || session.token !== token) return

  clearShadowingGap()
  // Stop the watchdog: TTS is intentionally silent during the gap.
  clearSpeakingWatchdog()

  session.inGap = true
  session.state = 'playing'
  // Keep the mini-player in the 'playing' state but flag the gap so it can show
  // a subtle "shadowing…" hint.
  void broadcastReadAloudState(session.tabId, 'playing', session.currentIndex, false, true)

  const gapMs = computeShadowingGapMs(justSpoke, session.settings.speed, session.settings.shadowingRatio ?? 1)
  shadowingGapTimeout = setTimeout(() => {
    shadowingGapTimeout = null
    const s = activeSession
    // A stop/seek/next during the gap bumps the token or nulls the session.
    if (!s || s.token !== token || s.state !== 'playing') return
    s.inGap = false
    // Re-arm the watchdog before real speech resumes.
    startSpeakingWatchdog(token)
    onComplete()
  }, gapMs)
}

function isTtsSpeaking(): Promise<boolean> {
  return new Promise(resolve => {
    chrome.tts.isSpeaking(speaking => resolve(Boolean(speaking)))
  })
}

function startSpeakingWatchdog(token: number) {
  clearSpeakingWatchdog()
  speakingWatchdog = setInterval(async () => {
    const session = activeSession
    if (!session || session.token !== token || session.state !== 'playing') return
    // H29: never tear the session down during the intentional shadowing gap.
    // The watchdog is already cleared for the gap, but guard here too so no
    // future path can trip it while TTS is deliberately silent.
    if (session.inGap) return

    const isSpeaking = await isTtsSpeaking()
    // Re-check token/inGap/state after the async isSpeaking hop: a gap may have
    // started, or the user may have paused, while we awaited — in either case
    // isSpeaking legitimately resolves false and must not be treated as a stall.
    // (Re-checking `state` here is the fix: without it, a pause() that lands
    // mid-await made chrome.tts.pause() itself the reason isSpeaking is false,
    // and this would tear down a session the user only meant to pause.)
    if (!isSpeaking && activeSession?.token === token && activeSession.state === 'playing' && !activeSession.inGap) {
      // Grace window after the most recent speak() call: some engines (esp.
      // remote/network voices) haven't actually started producing audio yet
      // at this point, so isSpeaking() legitimately reads false for a beat.
      // Without this, a watchdog tick landing in that beat looks identical to
      // a real stall and kills a session that's actually fine — the
      // random-seeming mid-article stop.
      const since = activeSession.speakStartedAt ? Date.now() - activeSession.speakStartedAt : Infinity
      if (since < 1500) return
      await stopActiveSession()
    }
  }, 1000)
}

// `finished` is set on the *terminal* broadcast when reading ended naturally
// (reached the end + page repetitions exhausted), so the content script can show
// a "Finished" card instead of silently hiding the mini-player (F22). A plain
// user stop broadcasts idle WITHOUT this flag.
async function broadcastReadAloudState(
  tabId: number,
  state: ReadAloudState,
  index?: number,
  finished?: boolean,
  gap?: boolean,
) {
  if (state === 'idle') readAloudStateByTab.delete(tabId)
  else readAloudStateByTab.set(tabId, state)

  const forThisTab = activeSession?.tabId === tabId ? activeSession : undefined
  const total = forThisTab?.sentences.length
  const speed = forThisTab?.settings.speed
  const voice = forThisTab?.resolvedVoice
  const lang = forThisTab?.lang
  // Surface the live shadowing/repetition config + the intentional-gap flag so
  // the mini-player controls and the "shadowing…" indicator stay in sync (H29/H31).
  const shadowing = forThisTab?.shadowing
  const repetition = forThisTab?.settings.repetition
  const repeatWholeSentence = forThisTab?.settings.repeatWholeSentence
  const shadowingRatio = forThisTab?.settings.shadowingRatio

  await chrome.tabs.sendMessage(tabId, {
    type: 'READ_ALOUD_UPDATE',
    payload: { state, index, total, speed, voice, lang, finished, gap, shadowing, repetition, repeatWholeSentence, shadowingRatio },
  }).catch(() => { })

  await chrome.runtime.sendMessage({
    type: 'READ_ALOUD_STATE',
    payload: { tabId, state, index, total, speed },
  }).catch(() => { })
}

// Lightweight, high-frequency word-position message for karaoke highlighting.
// `index` identifies which sentence the offset belongs to so a stale word event
// from a sentence we've already advanced past can't mis-highlight the new one.
async function broadcastReadAloudWord(
  tabId: number,
  index: number,
  charIndex: number,
  length?: number,
) {
  await chrome.tabs.sendMessage(tabId, {
    type: 'READ_ALOUD_WORD',
    payload: { index, charIndex, length },
  }).catch(() => { })
}

async function stopActiveSession() {
  const session = activeSession
  clearSpeakingWatchdog()
  clearShadowingGap()
  activeSession = null
  chrome.tts.stop()
  releaseAudioAwake()
  if (session) {
    await broadcastReadAloudState(session.tabId, 'idle')
  }
}

// Like stopActiveSession, but tags the terminal broadcast as a *natural* finish
// so the content script surfaces the "Finished" card + Replay (F22).
async function finishActiveSession() {
  const session = activeSession
  clearSpeakingWatchdog()
  clearShadowingGap()
  activeSession = null
  chrome.tts.stop()
  releaseAudioAwake()
  if (session) {
    await broadcastReadAloudState(session.tabId, 'idle', session.currentIndex, true)
  }
}

function handleTtsEvent(token: number, event: chrome.tts.TtsEvent) {
  const session = activeSession
  if (!session || session.token !== token) return

  if (event.type === 'start') {
    session.state = 'playing'
    void broadcastReadAloudState(session.tabId, 'playing', session.currentIndex)
    return
  }

  if (event.type === 'pause') {
    session.state = 'paused'
    void broadcastReadAloudState(session.tabId, 'paused', session.currentIndex)
    return
  }

  if (event.type === 'resume') {
    session.state = 'playing'
    void broadcastReadAloudState(session.tabId, 'playing', session.currentIndex)
    return
  }

  if (event.type === 'word') {
    // Karaoke word highlighting. Only meaningful while actually playing.
    // Many voices never emit 'word' — that's fine, the sentence highlight still works.
    if (session.state !== 'playing') return
    if (typeof event.charIndex !== 'number') return
    void broadcastReadAloudWord(
      session.tabId,
      session.currentIndex,
      event.charIndex,
      typeof event.length === 'number' ? event.length : undefined,
    )
    return
  }

  if (event.type === 'end') {
    if (session.state !== 'playing') return
    // The sentence that just finished — its length sizes the shadowing gap.
    const justSpoke = session.sentences[session.currentIndex] ?? ''

    // repeatWholeSentence mode: still stop at every clause to shadow, but
    // don't repeat there — only once every clause of the real sentence has
    // been shadowed does the repeat phase start, and what repeats is the
    // WHOLE sentence, not the last clause. Requires shadowing (the setting is
    // documented as only meaningful together with it) and clause-grouping
    // info (absent when the plan wasn't built with shadow-stop splitting).
    if (session.settings.repeatWholeSentence && session.shadowing && session.sentenceGroupIds) {
      const groupIds = session.sentenceGroupIds
      // No groupIds[currentIndex + 1] (end of the whole plan) or a different
      // group id both mean "this was the sentence's last clause".
      const isLastClause = groupIds[session.currentIndex] !== groupIds[session.currentIndex + 1]

      if (!isLastClause) {
        // Mid-sentence clause: shadow-stop once, then move straight to the
        // next clause — no repeat here. Note this fires again for every
        // clause a whole-sentence replay (below) walks back through, so
        // nothing sentence-repeat-related gets touched in this branch.
        scheduleShadowingGap(token, justSpoke, () => {
          advanceToNextSentence(token)
        })
        return
      }

      // Last clause of the sentence — the whole-sentence repeat phase.
      session.sentenceRepCount = (session.sentenceRepCount ?? 0) + 1
      if (session.sentenceRepCount < session.settings.repetition) {
        // Re-speak the sentence clause by clause rather than as one merged
        // utterance: walk backward from this (known last-clause) index to the
        // first clause sharing the same group id. Clauses of one sentence
        // group are always contiguous (buildSentencePlan emits them in
        // document order), so this backward scan is O(clauses-in-sentence)
        // and needs no lookup table. currentIndex then re-enters the normal
        // clause-by-clause 'end'-handler pipeline via speakCurrentSentence,
        // hitting each shadow-stop again until it reaches the last clause
        // (this same check) once more. A single-clause sentence's group has
        // only one member, so the scan is a no-op and this just re-speaks
        // that one clause — matching clause-repeat behavior.
        let groupStart = session.currentIndex
        while (groupStart > 0 && groupIds[groupStart - 1] === groupIds[session.currentIndex]) {
          groupStart--
        }
        // Don't jump currentIndex to groupStart until the gap actually
        // elapses — scheduleShadowingGap keeps whatever's in currentIndex
        // (still the last clause just spoken) highlighted for the gap's
        // duration, same as every other branch here.
        scheduleShadowingGap(token, justSpoke, () => {
          const s = activeSession
          if (!s || s.token !== token) return
          s.currentIndex = groupStart
          void speakCurrentSentence(token)
        })
        return
      }

      session.sentenceRepCount = 0
      scheduleShadowingGap(token, justSpoke, () => {
        advanceToNextSentence(token)
      })
      return
    }

    // Default (repeatWholeSentence off/undefined, or shadowing off): repeat
    // whatever's at currentIndex — a clause when the plan was split, a whole
    // sentence otherwise — exactly `repetition` times before moving on.
    // Unchanged from before repeatWholeSentence existed.
    session.currentRep += 1
    if (session.currentRep < session.settings.repetition) {
      if (session.shadowing) {
        // When shadowing and repetition are both enabled, insert a shadowing gap between repetitions
        scheduleShadowingGap(token, justSpoke, () => {
          void speakCurrentSentence(token)
        })
      } else {
        // Per-sentence repetition: no gap between the repeats themselves.
        void speakCurrentSentence(token)
      }
      return
    }

    session.currentRep = 0

    // H29: shadowing inserts an intentional silent gap before the next sentence
    // so the learner can repeat the one that was just spoken aloud — so
    // currentIndex must NOT advance yet (the gap's highlight should stay on
    // justSpoke); advanceToNextSentence() moves it forward once the gap ends.
    // The watchdog is handled inside scheduleShadowingGap so the gap is never
    // mistaken for a stall.
    if (session.shadowing) {
      scheduleShadowingGap(token, justSpoke, () => {
        advanceToNextSentence(token)
      })
    } else {
      advanceToNextSentence(token)
    }
    return
  }

  if (event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
    // Ignore an artifact of our own pause()/resume() call (see the
    // `suppressStopUntil` field doc) — a real interruption (tab closed, another
    // extension/page speaking, engine failure) still tears the session down as
    // soon as the short grace window passes.
    if (session.suppressStopUntil && Date.now() < session.suppressStopUntil) return
    void stopActiveSession()
  }
}

// Cache the (fairly static) chrome.tts voice list so we don't re-query it on
// every sentence. Refreshed lazily on first use; the list rarely changes within
// a session, so a one-shot cache is plenty.
let ttsVoiceCache: chrome.tts.TtsVoice[] | null = null

function getTtsVoices(): Promise<chrome.tts.TtsVoice[]> {
  if (ttsVoiceCache) return Promise.resolve(ttsVoiceCache)
  return new Promise(resolve => {
    chrome.tts.getVoices(voices => {
      ttsVoiceCache = voices || []
      resolve(ttsVoiceCache)
    })
  })
}

// Does `voiceName` exist and speak a language compatible with `lang`?
function voiceMatchesLang(voiceName: string, lang: string, voices: chrome.tts.TtsVoice[]): boolean {
  const shortLang = lang.split('-')[0]
  const v = voices.find(vc => vc.voiceName === voiceName)
  if (!v?.lang) return false
  const vShort = v.lang.split('-')[0]
  return v.lang === lang || vShort === shortLang
}

// Pick the best available chrome.tts voice for `lang`: exact lang match first,
// then a short-code prefix match; within each tier prefer local (non-remote)
// voices. Returns undefined when nothing matches (chrome.tts then auto-picks).
function pickVoiceForLang(lang: string, voices: chrome.tts.TtsVoice[]): string | undefined {
  if (!lang) return undefined
  const shortLang = lang.split('-')[0]

  const exact = voices.filter(v => v.lang === lang)
  const prefix = voices.filter(v => v.lang && v.lang.split('-')[0] === shortLang && v.lang !== lang)

  const preferLocal = (list: chrome.tts.TtsVoice[]) =>
    list.find(v => v.remote !== true)?.voiceName ?? list[0]?.voiceName

  return preferLocal(exact) ?? preferLocal(prefix)
}

// Resolve the voice to use for `lang` given the readAloud settings. Order:
//  1. an exact/prefix entry in languageVoices for `lang`
//  2. the fallback `voice` IF it actually speaks `lang`
//  3. auto-pick the best chrome.tts voice for `lang` (D14)
// Returns undefined only when no voice at all matches (chrome.tts auto-picks).
// Shared by the page read-aloud session and the SPEAK_TEXT path (D17) so the
// OCR popup and the page reader resolve voices identically.
async function resolveVoiceForSettings(
  settings: ReadAloudSettings,
  lang?: string,
): Promise<string | undefined> {
  const configuredFallback = settings.voice || undefined

  if (lang && settings.languageVoices) {
    const exactMatch = settings.languageVoices[lang]
    if (exactMatch) return exactMatch
    const shortLang = lang.split('-')[0]
    const prefixMatch = Object.entries(settings.languageVoices)
      .find(([k]) => k.startsWith(shortLang) || shortLang.startsWith(k))
    if (prefixMatch) return prefixMatch[1]
  }

  // No language-specific voice configured. If we don't know the language we
  // can't do better than the configured fallback (or chrome.tts auto-pick).
  if (!lang) return configuredFallback

  const voices = await getTtsVoices()

  // Keep the fallback voice only when it can actually speak this language.
  if (configuredFallback && voiceMatchesLang(configuredFallback, lang, voices)) {
    return configuredFallback
  }

  // D14: silently auto-pick a matching voice so read-aloud "just works".
  return pickVoiceForLang(lang, voices) ?? configuredFallback
}

async function speakCurrentSentence(token: number) {
  const session = activeSession
  if (!session || session.token !== token) return

  if (session.currentIndex >= session.sentences.length) {
    await stopActiveSession()
    return
  }

  const resolvedVoice = await resolveVoiceForSettings(session.settings, session.lang)
  // A late await above could have superseded this token; re-check before using.
  if (!activeSession || activeSession.token !== token) return
  session.resolvedVoice = resolvedVoice

  // Real speech is (re)starting, so we're no longer in an intentional gap.
  session.inGap = false
  session.state = 'playing'
  // Force a clean engine reset before every speak() call, not just the
  // resume()/setVoice() ones that already did this. Without it, an engine
  // that hasn't fully released the previous utterance yet starts generating
  // audio for the new one mid-teardown and drops its first word — inaudible
  // on an article's very first sentence (nothing preceded it to race with),
  // but exactly what H29 shadowing/H31 repetition expose: they re-speak the
  // *same* text right after itself, so the listener has just heard the
  // correct version and immediately notices the clipped repeat. Unlike
  // pause()/resume()'s stop() calls, this one targets an utterance that has
  // already fully ended, so it doesn't need suppressStopUntil's guard against
  // a stray interrupted/cancelled event.
  chrome.tts.stop()
  // Give the watchdog a grace window: some engines (esp. remote voices) take a
  // moment after this call before isSpeaking() actually reports true.
  session.speakStartedAt = Date.now()
  await broadcastReadAloudState(session.tabId, 'playing', session.currentIndex)
  await holdAudioAwake(session.settings)

  chrome.tts.speak(session.sentences[session.currentIndex], {
    enqueue: false,
    onEvent: event => handleTtsEvent(token, event),
    pitch: session.settings.pitch,
    rate: session.settings.speed,
    lang: session.lang,
    voiceName: resolvedVoice,
    volume: session.settings.volume,
  }, async () => {
    if (chrome.runtime.lastError && activeSession?.token === token) {
      await stopActiveSession()
    }
  })
}

/**
 * The language of a passage, judged from the text itself.
 *
 * Lives in the background because `chrome.i18n.detectLanguage` is not exposed
 * to content scripts. Read Aloud uses it to pick a voice; Video Mode uses it to
 * decide what a subtitle line is written in, which no `lang` attribute on a
 * player page ever says truthfully.
 *
 * Returns undefined when the detector is unavailable or unsure, leaving the
 * caller's own default in place rather than guessing.
 */
async function detectContentLanguageAsync(text: string): Promise<string | undefined> {
  if (!chrome.i18n?.detectLanguage || !text.trim()) return undefined
  try {
    const result = await new Promise<chrome.i18n.LanguageDetectionResult>(resolve => {
      chrome.i18n.detectLanguage(text, resolve)
    })
    if (result.isReliable && result.languages.length > 0) return result.languages[0].language
  } catch (err) {
    console.warn('Failed to detect language', err)
  }
  return undefined
}

async function startReadAloudSession(
  sender: chrome.runtime.MessageSender,
  payload: unknown,
): Promise<{ ok: boolean }> {
  const tabId = sender.tab?.id
  if (!tabId) return { ok: false }

  const { sentences, startIndex, settings, lang, sentenceGroupIds } = payload as {
    sentences: string[]
    startIndex: number
    settings: ReadAloudSettings
    lang?: string
    sentenceGroupIds?: number[]
  }

  if (!Array.isArray(sentences) || sentences.length === 0) return { ok: false }

  if (activeSession?.tabId !== tabId) {
    await stopActiveSession()
  } else {
    chrome.tts.stop()
  }

  let detectedLang = lang
  if (sentences.length > 0) {
    const detected = await detectContentLanguageAsync(sentences.slice(startIndex, startIndex + 3).join(' '))
    if (detected) detectedLang = detected
  }

  const token = ++sessionCounter
  activeSession = {
    currentIndex: Math.max(0, Math.min(startIndex, sentences.length - 1)),
    currentRep: 0,
    sentences,
    settings,
    lang: detectedLang,
    state: 'playing',
    tabId,
    token,
    // H29: seed shadowing from the persisted setting; the mini-player can toggle
    // it live afterwards.
    shadowing: settings.shadowing === true,
    sentenceGroupIds: Array.isArray(sentenceGroupIds) ? sentenceGroupIds : undefined,
  }

  startSpeakingWatchdog(token)
  await speakCurrentSentence(token)
  return { ok: true }
}

async function controlReadAloud(
  sender: chrome.runtime.MessageSender,
  payload: unknown,
): Promise<{ ok: boolean; wasPlaying?: boolean }> {
  const payloadObj = payload as { action?: string, tabId?: number } | undefined;
  const tabId = payloadObj?.tabId || sender.tab?.id;
  const action = payloadObj?.action;
  if (!tabId || activeSession?.tabId !== tabId || !action) return { ok: false }

  if (action === 'pause') {
    const wasPlaying = activeSession.state === 'playing'
    // Always re-arm suppression, even if already paused, so an external
    // speak call (OCR's window.speechSynthesis, or anything else that steals
    // the shared TTS slot) doesn't tear the session down via a same-utterance
    // interrupted/cancelled event. Extended window (3s) to cover OCR speech
    // duration + message round-trip + resume's own grace period.
    activeSession.suppressStopUntil = Date.now() + 3000
    if (wasPlaying) {
      activeSession.state = 'paused'
      // Pausing during the intentional gap: cancel the pending timer but keep the
      // inGap flag so resume re-arms the gap rather than jumping straight in.
      if (activeSession.inGap) clearShadowingGap()
      // Actually pause the audio so it stops mid-sentence instead of playing on
      // to the end. Any interrupted/cancelled event this triggers is absorbed by
      // suppressStopUntil above. Resume doesn't call chrome.tts.resume() (see
      // below) — it restarts the sentence via speakCurrentSentence(), which works
      // regardless of whether the previous utterance was paused or not.
      chrome.tts.pause()
      await broadcastReadAloudState(tabId, 'paused', activeSession.currentIndex)
    }
    return { ok: true, wasPlaying }
  }

  if (action === 'resume' && activeSession.state === 'paused') {
    activeSession.state = 'playing'
    // See the `suppressStopUntil` field doc: some TTS engines fire an
    // 'interrupted'/'cancelled' event as a side effect of resume() itself.
    // Extended window (3s) for safety, consistent with pause grace period.
    activeSession.suppressStopUntil = Date.now() + 3000
    if (activeSession.inGap) {
      // We were paused mid-gap; re-schedule the remaining gap using the sentence
      // we're about to speak (its length is a good proxy for the just-finished one).
      const idx = activeSession.currentIndex
      const token = activeSession.token
      scheduleShadowingGap(token, activeSession.sentences[idx] ?? '', () => {
        const s = activeSession
        if (!s || s.token !== token) return
        if (s.currentRep === 0) {
          advanceToNextSentence(token)
        } else {
          void speakCurrentSentence(token)
        }
      })
    } else {
      // Restart the current sentence rather than resuming (resume may not work reliably).
      // This re-speaks the current sentence from its start, matching the pattern from 533bffd.
      // chrome.tts.pause() leaves the engine in a paused state that a plain speak()
      // call doesn't reliably break out of (some engines silently drop it, which
      // trips the lastError check in speakCurrentSentence and tears the session
      // down) — stop() first to clear that state; any interrupted/cancelled event
      // it triggers is absorbed by suppressStopUntil above.
      chrome.tts.stop()
      void speakCurrentSentence(activeSession.token)
    }
    await broadcastReadAloudState(tabId, 'playing', activeSession.currentIndex)
    return { ok: true }
  }

  if (action === 'stop') {
    await stopActiveSession()
    return { ok: true }
  }

  if (action === 'setVoice') {
    const voiceName = (payload as { voiceName?: string }).voiceName
    if (typeof voiceName !== 'string' || !voiceName) return { ok: false }
    const session = activeSession
    const lang = session.lang

    // Set the active voice for the current language on the live session, and
    // persist it to stored settings so the choice sticks next time (D15).
    if (lang) {
      const languageVoices = { ...(session.settings.languageVoices || {}), [lang]: voiceName }
      session.settings = { ...session.settings, languageVoices }

      const settings = await getSettings()
      // A stop (or a new session on this or another tab) may have landed while
      // we awaited — don't mutate/broadcast a session that's no longer live.
      // Still report ok: true, because the caller reads ok: false as "no
      // session exists" and tears down its local sentence map; a real stop has
      // already broadcast 'idle' by itself.
      if (activeSession !== session) return { ok: true }
      settings.readAloud = {
        ...settings.readAloud,
        languageVoices: { ...(settings.readAloud.languageVoices || {}), [lang]: voiceName },
      }
      await saveSettings(settings)
      if (activeSession !== session) return { ok: true }
    } else {
      // Unknown page language — fall back to updating the plain fallback voice.
      session.settings = { ...session.settings, voice: voiceName }
      const settings = await getSettings()
      if (activeSession !== session) return { ok: true }
      settings.readAloud = { ...settings.readAloud, voice: voiceName }
      await saveSettings(settings)
      if (activeSession !== session) return { ok: true }
    }

    // Re-speak the current sentence with the new voice (token-bump pattern).
    session.token = ++sessionCounter
    session.state = 'playing'
    clearShadowingGap()
    chrome.tts.stop()
    startSpeakingWatchdog(session.token)
    await speakCurrentSentence(session.token)
    return { ok: true }
  }

  if (action === 'setRepetition') {
    // H31: change how many times each sentence is spoken. Takes effect from the
    // next sentence (no re-speak) and is persisted to stored settings.
    const raw = (payload as { count?: number }).count
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false }
    const count = Math.max(1, Math.min(5, Math.round(raw)))
    const session = activeSession
    session.settings = { ...session.settings, repetition: count }

    const settings = await getSettings()
    // A stop (or a new session on another tab) may have landed while we
    // awaited — don't mutate/broadcast a session that's no longer live.
    if (activeSession !== session) return { ok: false }
    settings.readAloud = { ...settings.readAloud, repetition: count }
    await saveSettings(settings)
    if (activeSession !== session) return { ok: false }

    // Reflect the new value in the mini-player without disturbing playback.
    await broadcastReadAloudState(tabId, session.state, session.currentIndex, false, session.inGap)
    return { ok: true }
  }

  if (action === 'setShadowingRatio') {
    // Mirrors setRepetition above: takes effect from the NEXT gap (no re-arm of
    // whatever gap timer might already be running) and is persisted to stored
    // settings.
    const raw = (payload as { ratio?: number }).ratio
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false }
    const ratio = Math.max(0.5, Math.min(3, raw))
    const session = activeSession
    session.settings = { ...session.settings, shadowingRatio: ratio }

    const settings = await getSettings()
    // A stop (or a new session on another tab) may have landed while we
    // awaited — don't mutate/broadcast a session that's no longer live.
    if (activeSession !== session) return { ok: false }
    settings.readAloud = { ...settings.readAloud, shadowingRatio: ratio }
    await saveSettings(settings)
    if (activeSession !== session) return { ok: false }

    // Reflect the new value in the mini-player without disturbing playback.
    await broadcastReadAloudState(tabId, session.state, session.currentIndex, false, session.inGap)
    return { ok: true }
  }

  if (action === 'setRepeatWholeSentence') {
    // Mirrors setRepetition above: takes effect from the next clause/sentence
    // boundary (no re-speak) and is persisted to stored settings.
    const on = (payload as { on?: boolean }).on
    if (typeof on !== 'boolean') return { ok: false }
    const session = activeSession
    session.settings = { ...session.settings, repeatWholeSentence: on }
    // Switching modes mid-sentence: currentRep/sentenceRepCount were counting
    // for whichever mode was active before — carrying either over would
    // either skip repeats or double-count them under the new mode's rules,
    // so start clean from wherever playback happens to be next.
    session.currentRep = 0
    session.sentenceRepCount = 0

    const settings = await getSettings()
    // A stop (or a new session on another tab) may have landed while we
    // awaited — don't mutate/broadcast a session that's no longer live.
    if (activeSession !== session) return { ok: false }
    settings.readAloud = { ...settings.readAloud, repeatWholeSentence: on }
    await saveSettings(settings)
    if (activeSession !== session) return { ok: false }

    // Reflect the new value in the mini-player without disturbing playback.
    await broadcastReadAloudState(tabId, session.state, session.currentIndex, false, session.inGap)
    return { ok: true }
  }

  if (action === 'next' || action === 'prev' || action === 'seek' || action === 'setSpeed') {
    const session = activeSession
    const lastIndex = session.sentences.length - 1

    if (action === 'next') {
      session.currentIndex = Math.min(session.currentIndex + 1, lastIndex)
      session.currentRep = 0
      session.sentenceRepCount = 0
    } else if (action === 'prev') {
      session.currentIndex = Math.max(session.currentIndex - 1, 0)
      session.currentRep = 0
      session.sentenceRepCount = 0
    } else if (action === 'seek') {
      const target = (payload as { index?: number }).index
      if (typeof target !== 'number') return { ok: false }
      session.currentIndex = Math.max(0, Math.min(Math.round(target), lastIndex))
      session.currentRep = 0
      session.sentenceRepCount = 0
    } else if (action === 'setSpeed') {
      const speed = (payload as { speed?: number }).speed
      if (typeof speed !== 'number' || !Number.isFinite(speed)) return { ok: false }
      session.settings = { ...session.settings, speed }
    }

    // chrome.tts can't change rate/position mid-utterance, so re-speak the
    // (possibly new) current sentence. Bump the token first so any stale
    // 'interrupted'/'cancelled' event from the utterance we're stopping can't
    // tear the session down.
    session.token = ++sessionCounter
    session.state = 'playing'
    // A user-driven jump cancels any pending shadowing gap so it can't fire
    // against the new sentence.
    clearShadowingGap()
    session.inGap = false
    chrome.tts.stop()
    startSpeakingWatchdog(session.token)
    await speakCurrentSentence(session.token)
    return { ok: true }
  }

  return { ok: false }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return

  if (info.menuItemId === 'ocr') {
    await startOcr(tab)
    return
  }

  if (info.menuItemId === 'listen') {
    await toggleReadAloudForTab(tab)
    return
  }

  // `info.selectionText` is the browser's own raw read of the DOM selection
  // — it has no notion of Read Aloud's phonetics wraps, so it picks up their
  // injected `/ipa/` text along with the real words. Ask the content script
  // for the same selection filtered to exclude that (falls back to the raw
  // text if the content script can't answer, e.g. on a page it never
  // injected into) before this text goes anywhere — read aloud, popover, or
  // saved bookmark.
  const cleanText = info.selectionText
    ? await chrome.tabs.sendMessage(tab.id, { type: 'GET_CLEAN_SELECTION_TEXT' })
      .catch(() => null) as string | null
    : null
  const selectionText = cleanText || info.selectionText

  if (info.menuItemId === 'read-from-here') {
    chrome.tabs.sendMessage(tab.id, {
      type: 'START_READ_ALOUD_FROM',
      payload: { selectedText: selectionText ?? '' },
    }).catch(() => { })
    return
  }

  if (!selectionText) return

  const match = info.menuItemId.toString().match(/^bookmark-(.+)$/)
  if (!match || match[1] === 'parent') return

  const color = match[1] as BookmarkColor
  const text = selectionText.trim()

  // If it's a short phrase (<= 10 words), show the dictionary popover to let them add a translation
  if (text.split(/\s+/).length <= 10) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_DICTIONARY_POPOVER',
      payload: { selectedText: text, color },
    }).catch(() => { })
    return
  }

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'GET_SELECTION_CONTEXT',
    payload: { searchString: text }
  }).catch(() => null) as { prefix: string; suffix: string; occurrenceIndex: number; sourceLang?: string } | null

  if (!response) return

  const bookmark: SavedItem = {
    id: crypto.randomUUID(),
    url: info.pageUrl,
    text,
    sourceLang: response.sourceLang,
    prefix: response.prefix,
    suffix: response.suffix,
    occurrenceIndex: response.occurrenceIndex,
    color,
    createdAt: Date.now(),
    orphaned: false,
  }

  await saveItem(bookmark)
  await logActivity('save')
  await evaluateSlackingState(false)
  chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_BOOKMARK', payload: bookmark }).catch(() => { })
})

chrome.webNavigation.onHistoryStateUpdated.addListener(async details => {
  if (details.frameId !== 0) return
  const bookmarks = await getItemsForUrl(details.url)
  if (bookmarks.length === 0) return
  chrome.tabs.sendMessage(details.tabId, {
    type: 'REANCHOR',
    payload: { url: details.url },
  }).catch(() => { })
})

chrome.runtime.onMessage.addListener((msg: { type: string; payload?: unknown }, sender, sendResponse) => {
  dispatch(msg, sender)
    .then(res => sendResponse(res))
    .catch(() => sendResponse(null))
  return true
})

// Deleted old srs imports

async function flushFocusTimeAccumulator() {
  const secs = Math.floor(focusTimeAccumulator);
  if (secs <= 0 || !lastPomodoroTaskId) return;
  focusTimeAccumulator -= secs;

  const settings = await getSettings();
  if (settings.tasks && settings.tasks.length > 0) {
    const taskIndex = settings.tasks.findIndex(t => t.id === lastPomodoroTaskId);
    if (taskIndex > -1) {
      const activeTask = settings.tasks[taskIndex];
      if (!activeTask.actualStartTime) {
        activeTask.actualStartTime = Date.now() - (secs * 1000);
      }
      activeTask.timeSpentSeconds = (activeTask.timeSpentSeconds || 0) + secs;
      await saveSettings(settings);
    }
  }
}

async function dispatch(msg: { type: string; payload?: unknown }, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'GET_ITEMS':
      return getAllItems()
    case 'DELETE_ITEM':
      await deleteItem(msg.payload as string)
      return { ok: true }
    case 'SAVE_ITEM':
      await saveItem(msg.payload as any)
      return { ok: true }
    case 'UPDATE_ITEM':
      await saveItem(msg.payload as any)
      return { ok: true }
    case 'TEST_NOTIFICATION':
      return triggerSrsNotification(true)
    case 'TEST_ROAST_NOTIFICATION':
      await evaluateSlackingState(true)
      return { ok: true }

    case 'SYNC_ITEMS':
      return await syncToDrive((msg.payload as any)?.interactive)
    case 'LOG_ACTIVITY':
      await logActivity(msg.payload as 'save' | 'review')
      await evaluateSlackingState(false)
      return { ok: true }
    case 'GET_ACTIVITY_LOG':
      return getActivityLog()
    case 'GET_SETTINGS':
      return getSettings()

    // Video Mode's in-player panel edits one slice of the settings. Merging it
    // here rather than having the content script send a whole Settings object
    // avoids clobbering anything the popup or options page changed meanwhile.
    case 'SAVE_VIDEO_MODE_SETTINGS': {
      const { settings: videoMode } = (msg.payload ?? {}) as { settings?: VideoModeSettings }
      if (!videoMode) return { ok: false }
      const current = await getSettings()
      await saveSettings({ ...current, videoMode, updatedAt: Date.now() })
      return { ok: true }
    }

    case 'SAVE_LAST_BOOKMARK_COLOR': {
      const { color } = (msg.payload ?? {}) as { color?: BookmarkColor }
      if (!color) return { ok: false }
      const current = await getSettings()
      await saveSettings({ ...current, lastBookmarkColor: color, updatedAt: Date.now() })
      return { ok: true }
    }
    case 'SAVE_SETTINGS': {
      const newSettings = msg.payload as Settings
      await saveSettings(newSettings)
      if (activeSession) {
        const oldVolume = activeSession.settings.volume ?? 1
        activeSession.settings = newSettings.readAloud
        // Keep the live shadowing flag consistent with a settings save.
        if (typeof newSettings.readAloud.shadowing === 'boolean') {
          activeSession.shadowing = newSettings.readAloud.shadowing
        }
        if (activeSession.state === 'playing' && oldVolume !== (newSettings.readAloud.volume ?? 1)) {
          if (ttsRestartTimeout) clearTimeout(ttsRestartTimeout)
          // Snapshot the token so this restart can't fire against a different
          // session (e.g. this one was stopped and a new one started on another
          // tab within the debounce window) — without this check it would bump
          // a stranger session's token and cut off its current sentence.
          const scheduledToken = activeSession.token
          ttsRestartTimeout = setTimeout(() => {
            if (activeSession?.token === scheduledToken && activeSession.state === 'playing') {
              activeSession.token = ++sessionCounter // Prevent old 'interrupted' event from killing the session
              chrome.tts.stop()
              // Re-arm the watchdog with the bumped token — without this it keeps
              // watching for the old (now stale) token forever and silently stops
              // detecting a stalled engine for the rest of the session.
              startSpeakingWatchdog(activeSession.token)
              void speakCurrentSentence(activeSession.token)
            }
          }, 400)
        }
      }
      return { ok: true }
    }
    case 'MARK_ORPHANED': {
      const p = msg.payload as string | { id: string; orphaned?: boolean }
      if (typeof p === 'string') {
        await markOrphaned(p)
      } else {
        await markOrphaned(p.id, p.orphaned ?? true)
      }
      return { ok: true }
    }
    case 'TRANSLATE_IN_CONTEXT':
      return translateInContext(msg.payload as ContextTranslateRequest)
    case 'FETCH_PHONETICS': {
      // Video Mode's auto phonetics — a batch of words from one subtitle line,
      // English-only, IPA source only. Deliberately not `translateInContext`:
      // that also fires a Google Translate call per word, which this doesn't
      // want on every line of a movie.
      const { words, priority } = msg.payload as { words: string[]; priority?: 'high' | 'low' }
      return fetchPhoneticsForWords(words, priority)
    }
    case 'FETCH_PINYIN': {
      // The Chinese counterpart of FETCH_PHONETICS. Kept as its own message
      // rather than a `lang` flag on that one: the two run on entirely
      // different sources (dictionaryapi.dev vs Google's `dt=rm`), and reading
      // one case that forks into both would hide that.
      const { words } = msg.payload as { words: string[] }
      return fetchPinyinForWords(words)
    }
    case 'DETECT_CONTENT_LANGUAGE': {
      // Video Mode asks once per session, off the first cues it receives: a
      // player page's `lang` attribute describes the site's UI, not the film.
      const { text } = msg.payload as { text: string }
      return { lang: await detectContentLanguageAsync(text) }
    }
    case 'START_READ_ALOUD_SESSION':
      return startReadAloudSession(sender, msg.payload)
    case 'CONTROL_READ_ALOUD':
      return controlReadAloud(sender, msg.payload)
    case 'GET_TTS_VOICES': {
      // Return chrome.tts voices (available in the background, not content
      // scripts). Optionally filter to a language; callers can request the full
      // list as an "all languages" fallback. Cached in getTtsVoices().
      const p = msg.payload as { lang?: string } | undefined
      const voices = await getTtsVoices()
      const mapped = voices.map(v => ({
        voiceName: v.voiceName ?? '',
        lang: v.lang ?? '',
        remote: v.remote ?? false,
      })).filter(v => v.voiceName)

      if (p?.lang) {
        const shortLang = p.lang.split('-')[0]
        const filtered = mapped.filter(v => v.lang === p!.lang || v.lang.split('-')[0] === shortLang)
        // If nothing matches the language, fall back to the full list so the
        // picker is never empty.
        return { voices: filtered.length > 0 ? filtered : mapped }
      }
      return { voices: mapped }
    }
    case 'SPEAK_TEXT': {
      // The one place anything in this extension speaks a one-off utterance.
      // Every caller — the dictionary popover, the OCR popup, the library, the
      // study screen and the settings page's voice audition — comes through
      // here, so voice resolution, the audio keepalive, the no-such-voice retry
      // and mini-player pause/resume exist once instead of being reimplemented
      // (and drifting) at each call site (D17). Only the page reader's own
      // session speaks elsewhere, via speakCurrentSentence.
      //
      // Resolves when the utterance *finishes*, not when it starts: a caller
      // outside the background cannot receive tts events, so awaiting this is
      // how it knows to clear its own "speaking" indicator.
      const payload = msg.payload as { text: string, lang?: string, voiceName?: string } | string
      const text = typeof payload === 'string' ? payload : payload.text
      const lang = typeof payload === 'string' ? undefined : payload.lang
      // An explicit voice overrides the configured one, so the settings page can
      // audition a voice the user hasn't committed to yet.
      const forcedVoice = typeof payload === 'string' ? undefined : payload.voiceName
      if (!text) return { ok: false }

      const settings = await getSettings()
      if (!settings?.readAloud) return { ok: false }

      const wasReading = activeSession?.state === 'playing'
      if (activeSession) {
        activeSession.suppressStopUntil = Date.now() + 3000
        if (wasReading) {
          activeSession.state = 'paused'
          await broadcastReadAloudState(activeSession.tabId, 'paused', activeSession.currentIndex)
        }
      }

      const resolvedVoice = forcedVoice ?? await resolveVoiceForSettings(settings.readAloud, lang)
      const token = activeSession?.token
      const resumeSession = () => {
        if (wasReading && activeSession && token === activeSession.token) {
          activeSession.state = 'playing'
          activeSession.suppressStopUntil = Date.now() + 500
          void broadcastReadAloudState(activeSession.tabId, 'playing', activeSession.currentIndex)
          void speakCurrentSentence(token)
        }
      }
      let markFinished: () => void = () => { }
      const finished = new Promise<void>(resolve => { markFinished = resolve })
      const onDone = (event: chrome.tts.TtsEvent) => {
        if (['end', 'interrupted', 'cancelled', 'error'].includes(event.type)) {
          markFinished()
          resumeSession()
        }
      }
      const trySpeak = (opts: chrome.tts.SpeakOptions) => new Promise<boolean>(resolve => {
        chrome.tts.speak(text, opts, () => resolve(!chrome.runtime.lastError))
      })

      await holdAudioAwake(settings.readAloud)
      const started = await trySpeak({
        enqueue: false,
        pitch: settings.readAloud.pitch,
        rate: settings.readAloud.speed,
        lang,
        voiceName: resolvedVoice,
        volume: settings.readAloud.volume,
        onEvent: onDone,
      })
      // A forced lang/voiceName that matches no installed voice makes chrome.tts
      // refuse to start at all — no event ever fires, so the popover's speak
      // button just sits there silent instead of erroring. Retry once fully
      // unconstrained (the same as never specifying lang/voice), so at worst the
      // learner hears the wrong accent instead of nothing.
      if (!started) {
        const retried = await trySpeak({
          enqueue: false,
          pitch: settings.readAloud.pitch,
          rate: settings.readAloud.speed,
          volume: settings.readAloud.volume,
          onEvent: onDone,
        })
        if (!retried) {
          // Nothing is speaking, so no event will ever arrive to unpause the
          // session — do it here rather than leaving the mini-player stuck
          // paused for good.
          resumeSession()
          return { ok: false }
        }
      }
      await finished
      return { ok: true }
    }
    case 'STOP_SPEAKING': {
      // Toggle-off for the one-off utterances above. A read-aloud session has
      // its own stop (CONTROL_READ_ALOUD); this ends whatever single utterance
      // is currently speaking, and the resulting 'interrupted' event is what
      // resumes a mini-player that SPEAK_TEXT had paused.
      chrome.tts.stop()
      return { ok: true }
    }
    case 'GET_READ_ALOUD_STATE': {
      const tabId = (msg.payload as { tabId?: number } | undefined)?.tabId ?? sender.tab?.id
      const state = tabId ? (readAloudStateByTab.get(tabId) ?? 'idle') : ('idle' as ReadAloudState)
      // Mirror the live-session progress/speed the same way broadcastReadAloudState
      // and READ_ALOUD_UPDATE source them, so the popup can render progress on open.
      const forThisTab = activeSession?.tabId === tabId ? activeSession : undefined
      return {
        state,
        index: forThisTab?.currentIndex,
        total: forThisTab?.sentences.length,
        speed: forThisTab?.settings.speed,
      }
    }
    case 'CAPTURE_VISIBLE_TAB':
      return new Promise((resolve) => {
        const winId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
        chrome.tabs.captureVisibleTab(
          winId,
          { format: 'png' },
          dataUrl => {
            if (chrome.runtime.lastError) {
              console.error('captureVisibleTab error:', chrome.runtime.lastError);
              resolve({ dataUrl: null, error: chrome.runtime.lastError.message });
            } else {
              resolve({ dataUrl });
            }
          }
        )
      })
    case 'POMODORO_STATE_UPDATE': {
      const state = msg.payload as PomodoroState;
      const now = Date.now();
      const wasRunningFocus = lastPomodoroStatus === 'running' && lastPomodoroPhase === 'focus';
      const isRunningFocus = state.status === 'running' && state.phase === 'focus';

      if (wasRunningFocus && !isRunningFocus && focusTimeAccumulator > 0) {
        await flushFocusTimeAccumulator();
      }
      if (isRunningFocus) {
        // Only add real elapsed time since the last running/focus update, not per-message,
        // since offscreen also broadcasts on commands like resume/startFocus (not just ticks).
        if (wasRunningFocus) {
          const elapsedSec = Math.max(0, Math.min(5, (now - lastFocusTickAt) / 1000));
          focusTimeAccumulator += elapsedSec;
        }
        lastFocusTickAt = now;
        // Switching the active task mid-focus (still running+focus throughout)
        // must flush whatever's accumulated against the OLD task first —
        // flushFocusTimeAccumulator() reads the module-level lastPomodoroTaskId,
        // which is still the old id here (it isn't reassigned until below), so
        // this can't silently get credited to the task being switched to.
        if (wasRunningFocus && state.activeTaskId !== lastPomodoroTaskId && focusTimeAccumulator > 0) {
          await flushFocusTimeAccumulator();
        } else if (focusTimeAccumulator >= 60) {
          await flushFocusTimeAccumulator();
        }
      }
      lastPomodoroStatus = state.status;
      lastPomodoroPhase = state.phase;
      lastPomodoroTaskId = state.activeTaskId;
      return { ok: true };
    }
    case 'POMODORO_COMMAND':
      await setupOffscreenDocument('src/offscreen/index.html');
      return chrome.runtime.sendMessage({ type: 'POMODORO_COMMAND', payload: msg.payload });
    case 'START_OCR': {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
      await startOcr(t)
      return { ok: true }
    }
    case 'FORWARD_RECOGNIZE_TEXT': {
      const tabId = sender.tab?.id;
      const payload = msg.payload as any;
      // Fire-and-forget: setup offscreen then kick off OCR without awaiting result
      // Result will come back via OCR_COMPLETE message
      setupOffscreenDocument('src/offscreen/index.html').then(() => {
        chrome.runtime.sendMessage({ 
          type: 'RECOGNIZE_TEXT', 
          payload: { ...payload, tabId }
        }).catch(() => {});
      }).catch(() => {});
      return { ack: true }; // Respond immediately so channel doesn't die
    }
    case 'OCR_PROGRESS': {
      const { tabId, status, progress, broadcast, requestId } = msg.payload as { tabId?: number; status: string; progress: number; broadcast?: boolean; requestId?: number };
      if (broadcast) {
        chrome.runtime.sendMessage({ type: 'OCR_WINDOW_PROGRESS', payload: { status, progress, requestId } }).catch(() => {});
      } else if (tabId) {
        // requestId lets the in-page OcrManager drop this if a later Alt+O
        // already replaced the session that kicked off this OCR run.
        chrome.tabs.sendMessage(tabId, { type: 'OCR_PROGRESS', payload: { status, progress, requestId } }).catch(() => {});
      }
      return { ok: true };
    }
    case 'OCR_COMPLETE': {
      const { tabId, text, error, broadcast, requestId } = msg.payload as { tabId?: number; text?: string; error?: string; broadcast?: boolean; requestId?: number };
      if (broadcast) {
        chrome.runtime.sendMessage({ type: 'OCR_WINDOW_RESULT', payload: { text, error, requestId } }).catch(() => {});
      } else if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'OCR_COMPLETE', payload: { text, error, requestId } }).catch(() => {});
      }
      return { ok: true };
    }
    case 'GET_POMODORO_STATE':
      await setupOffscreenDocument('src/offscreen/index.html');
      return chrome.runtime.sendMessage({ type: 'GET_POMODORO_STATE' });
    case 'UPDATE_ACTION_BADGE': {
      const { text, color } = msg.payload as { text: string; color?: string };
      chrome.action.setBadgeText({ text });
      if (color) {
        chrome.action.setBadgeBackgroundColor({ color });
      }
      return { ok: true };
    }
    case 'RESTORE_ACTION_ICON': {
      chrome.action.setIcon({
        path: {
          "16": "/icons/icon16.png",
          "32": "/icons/icon32.png",
          "48": "/icons/icon48.png",
          "128": "/icons/icon128.png"
        }
      });
      return { ok: true };
    }
    case 'UPDATE_ACTION_ICON': {
      const { data, width, height } = msg.payload as { data: number[]; width: number; height: number };
      const clampedArray = new Uint8ClampedArray(data);
      const imageData = new ImageData(clampedArray, width, height);
      chrome.action.setIcon({ imageData: { "32": imageData } });
      return { ok: true };
    }
    default:
      return null
  }
}
