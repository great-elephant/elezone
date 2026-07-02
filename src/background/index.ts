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
  updateSrsMetrics,
  getLocalYMD
} from '../shared/library'
import {
  SavedItem,
  BookmarkColor,
  BOOKMARK_COLORS,
  ReadAloudSettings,
  ReadAloudState,
  Settings,
  PomodoroStatus,
  PomodoroPhase,
  PomodoroState,
} from '../shared/types'
import { translateInContext, ContextTranslateRequest } from './aiTranslate'
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
    void setupSrsAlarm()
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

async function triggerSrsNotification(testMode = false) {
  const settings = await getSettings()
  if (!settings.srsNotifications?.enabled && !testMode) return

  if (!testMode) {
    const startHour = settings.srsNotifications?.activeHoursStart ?? 8
    const endHour = settings.srsNotifications?.activeHoursEnd ?? 22
    const currentHour = new Date().getHours()
    if (currentHour < startHour || currentHour >= endHour) {
      return
    }
  }

  const items = await getAllItems()
  let dueItems = items.filter(i => !i.orphaned && i.text)
  
  if (!testMode) {
    const strictlyDue = dueItems.filter(i => (i.nextReview || 0) <= Date.now())
    if (strictlyDue.length > 0) {
      dueItems = strictlyDue
      dueItems.sort((a, b) => (a.nextReview || 0) - (b.nextReview || 0))
    } else {
      // Fallback: If no items are strictly due, just pick a random one to keep the user engaged!
      dueItems.sort(() => Math.random() - 0.5)
    }
  } else {
    // Test mode: always random
    dueItems.sort(() => Math.random() - 0.5)
  }
  
  if (dueItems.length === 0) return

  const item = dueItems[0]

  chrome.notifications.create(`srs-q-${item.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `Review: ${item.text}`,
    message: 'Click "Show Answer" to flip the card.',
    buttons: [{ title: 'Show Answer' }],
    requireInteraction: true
  })
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

async function openOcrWindow(tab: chrome.tabs.Tab) {
  try {
    const winId = tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT
    const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' })
    const settings = await getSettings()
    const lang = settings.ocr?.language || 'eng'
    await chrome.storage.session.set({ ocr_window_payload: { dataUrl, lang } })
    await chrome.windows.create({
      url: chrome.runtime.getURL('src/crop/index.html'),
      type: 'popup',
      width: 1000,
      height: 780,
    })
  } catch (e) {
    console.error('Failed to open OCR window:', e)
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'play_pause' && activeSession) {
    if (activeSession.state === 'playing') {
      activeSession.state = 'paused'
      if (activeSession.inGap) clearShadowingGap()
      chrome.tts.pause()
      await broadcastReadAloudState(activeSession.tabId, 'paused', activeSession.currentIndex)
    } else if (activeSession.state === 'paused') {
      activeSession.state = 'playing'
      if (activeSession.inGap) {
        const idx = activeSession.currentIndex
        scheduleShadowingGap(activeSession.token, activeSession.sentences[idx] ?? '')
      } else {
        chrome.tts.resume()
      }
      await broadcastReadAloudState(activeSession.tabId, 'playing', activeSession.currentIndex)
    }
  } else if (command === 'trigger_ocr') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tabs[0]) await startOcr(tabs[0])
  } else if (command === 'toggle_read_aloud') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (!tab?.id) return
    // If read-aloud is already running on this tab (playing OR paused), stop it.
    // Otherwise kick off a fresh session exactly like the popup's "Start Reading".
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
  for (let i = 0; i < 30; i++) {
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
    const isAwakeTime = currentHour >= startHour && currentHour < endHour

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
    if (!item) return
    
    chrome.notifications.clear(notificationId)
    
    let context = ''
    if (item.prefix || item.suffix) {
      context = `\n\nContext: ${item.prefix}${item.text}${item.suffix}`
    }

    const settings = await getSettings()
    chrome.tts.stop()
    if (settings.readAloud?.voice) {
      chrome.tts.speak(item.text, {
        pitch: settings.readAloud.pitch,
        rate: settings.readAloud.speed,
        voiceName: settings.readAloud.voice,
        volume: settings.readAloud.volume
      })
    } else {
      chrome.tts.speak(item.text)
    }

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
    const updated = updateSrsMetrics(item, passed)
    
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

function colorMenuTitle(color: BookmarkColor, deckLabels: Partial<Record<BookmarkColor, string>>) {
  const label = deckLabels[color]
  return label
    ? `${COLOR_EMOJI[color]} ${label}`
    : `${COLOR_EMOJI[color]} ${color.charAt(0).toUpperCase() + color.slice(1)}`
}

async function setupContextMenus() {
  const settings = await getSettings()
  const deckLabels = settings?.deckLabels || {}
  const order: BookmarkColor[] = settings?.deckOrder?.length === COLORS.length
    ? settings.deckOrder
    : COLORS

  const ocrLangMap: Record<string, string> = {
    eng: 'EN',
    chi_sim: 'ZH-S',
    chi_tra: 'ZH-T'
  };
  const ocrLang = settings?.ocr?.language || 'eng';
  const displayLang = ocrLangMap[ocrLang] || ocrLang.toUpperCase();

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ocr', title: `Image to text(OCR) [${displayLang}]`, contexts: ['page', 'image', 'selection'] })
    chrome.contextMenus.create({ id: 'read-from-here', title: 'Read from this sentence', contexts: ['selection'] })
    for (const color of order) {
      chrome.contextMenus.create({
        id: `bookmark-${color}`,
        title: colorMenuTitle(color, deckLabels),
        contexts: ['selection'],
      })
    }
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
// current rate (~3 words/sec baseline), clamped to a sensible min/max so very
// short or very long sentences still feel predictable.
const GAP_MIN_MS = 1200
const GAP_MAX_MS = 8000
const GAP_WORDS_PER_SEC = 3
function computeShadowingGapMs(sentence: string, speed: number): number {
  const words = sentence.trim().split(/\s+/).filter(Boolean).length || 1
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1
  const speakSec = words / (GAP_WORDS_PER_SEC * rate)
  const ms = speakSec * 1000
  return Math.round(Math.max(GAP_MIN_MS, Math.min(GAP_MAX_MS, ms)))
}

// Schedule the shadowing gap before speaking the (already-advanced) current
// sentence. The watchdog is stopped for the duration of the gap so an
// intentional silence can't be mistaken for a stalled utterance and torn down;
// it is re-armed right before we resume speaking. Everything is guarded by
// `token`, and the whole thing is cancelled by clearShadowingGap() on any
// stop/seek. `justSpoke` is the sentence that just finished — its length drives
// the gap so the pause scales with what the learner needs to repeat.
function scheduleShadowingGap(token: number, justSpoke: string) {
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

  const gapMs = computeShadowingGapMs(justSpoke, session.settings.speed)
  shadowingGapTimeout = setTimeout(() => {
    shadowingGapTimeout = null
    const s = activeSession
    // A stop/seek/next during the gap bumps the token or nulls the session.
    if (!s || s.token !== token || s.state !== 'playing') return
    s.inGap = false
    // Re-arm the watchdog before real speech resumes.
    startSpeakingWatchdog(token)
    void speakCurrentSentence(token)
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
    // Re-check inGap after the async isSpeaking hop: a gap may have started while
    // we awaited, and an intentional silence must not be treated as a stall.
    if (!isSpeaking && activeSession?.token === token && !activeSession.inGap) {
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

  await chrome.tabs.sendMessage(tabId, {
    type: 'READ_ALOUD_UPDATE',
    payload: { state, index, total, speed, voice, lang, finished, gap, shadowing, repetition },
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
    session.currentRep += 1
    if (session.currentRep < session.settings.repetition) {
      // Per-sentence repetition: no gap between the repeats themselves.
      void speakCurrentSentence(token)
      return
    }

    session.currentRep = 0
    session.currentIndex += 1
    if (session.currentIndex >= session.sentences.length) {
      const pageRep = session.settings.pageRepetition || 1
      session.currentPageRep = (session.currentPageRep || 1) + 1

      if (session.currentPageRep <= pageRep) {
        session.currentIndex = 0
        // H29: still honour the inter-sentence gap when looping back to the top.
        if (session.shadowing) scheduleShadowingGap(token, justSpoke)
        else void speakCurrentSentence(token)
        return
      }

      // Natural end of the article (all page repetitions done) — surface the
      // Finished card rather than a silent teardown (F22).
      void finishActiveSession()
      return
    }

    // H29: shadowing inserts an intentional silent gap before the next sentence
    // so the learner can repeat aloud. The watchdog is handled inside
    // scheduleShadowingGap so the gap is never mistaken for a stall.
    if (session.shadowing) scheduleShadowingGap(token, justSpoke)
    else void speakCurrentSentence(token)
    return
  }

  if (event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
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
  await broadcastReadAloudState(session.tabId, 'playing', session.currentIndex)

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

async function startReadAloudSession(
  sender: chrome.runtime.MessageSender,
  payload: unknown,
): Promise<{ ok: boolean }> {
  const tabId = sender.tab?.id
  if (!tabId) return { ok: false }

  const { sentences, startIndex, settings, lang } = payload as {
    sentences: string[]
    startIndex: number
    settings: ReadAloudSettings
    lang?: string
  }

  if (!Array.isArray(sentences) || sentences.length === 0) return { ok: false }

  if (activeSession?.tabId !== tabId) {
    await stopActiveSession()
  } else {
    chrome.tts.stop()
  }

  let detectedLang = lang
  if (sentences.length > 0 && chrome.i18n?.detectLanguage) {
    const textToDetect = sentences.slice(startIndex, startIndex + 3).join(' ')
    if (textToDetect.trim()) {
      try {
        const result = await new Promise<chrome.i18n.LanguageDetectionResult>(resolve => {
          chrome.i18n.detectLanguage(textToDetect, resolve)
        })
        if (result.isReliable && result.languages.length > 0) {
          detectedLang = result.languages[0].language
        }
      } catch (err) {
        console.warn('Failed to detect language', err)
      }
    }
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
  }

  startSpeakingWatchdog(token)
  await speakCurrentSentence(token)
  return { ok: true }
}

async function controlReadAloud(
  sender: chrome.runtime.MessageSender,
  payload: unknown,
): Promise<{ ok: boolean }> {
  const payloadObj = payload as { action?: string, tabId?: number } | undefined;
  const tabId = payloadObj?.tabId || sender.tab?.id;
  const action = payloadObj?.action;
  if (!tabId || activeSession?.tabId !== tabId || !action) return { ok: false }

  if (action === 'pause' && activeSession.state === 'playing') {
    activeSession.state = 'paused'
    // Pausing during the intentional gap: cancel the pending timer but keep the
    // inGap flag so resume re-arms the gap rather than jumping straight in.
    if (activeSession.inGap) clearShadowingGap()
    chrome.tts.pause()
    await broadcastReadAloudState(tabId, 'paused', activeSession.currentIndex)
    return { ok: true }
  }

  if (action === 'resume' && activeSession.state === 'paused') {
    activeSession.state = 'playing'
    if (activeSession.inGap) {
      // We were paused mid-gap; re-schedule the remaining gap using the sentence
      // we're about to speak (its length is a good proxy for the just-finished one).
      const idx = activeSession.currentIndex
      scheduleShadowingGap(activeSession.token, activeSession.sentences[idx] ?? '')
    } else {
      chrome.tts.resume()
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
      settings.readAloud = {
        ...settings.readAloud,
        languageVoices: { ...(settings.readAloud.languageVoices || {}), [lang]: voiceName },
      }
      await saveSettings(settings)
    } else {
      // Unknown page language — fall back to updating the plain fallback voice.
      session.settings = { ...session.settings, voice: voiceName }
      const settings = await getSettings()
      settings.readAloud = { ...settings.readAloud, voice: voiceName }
      await saveSettings(settings)
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
    settings.readAloud = { ...settings.readAloud, repetition: count }
    await saveSettings(settings)

    // Reflect the new value in the mini-player without disturbing playback.
    await broadcastReadAloudState(tabId, session.state, session.currentIndex, false, session.inGap)
    return { ok: true }
  }

  if (action === 'setShadowing') {
    // H29: toggle shadowing mode live. Persisted to stored settings so the
    // choice sticks. Turning it OFF mid-gap resumes speaking immediately.
    const enabled = (payload as { enabled?: boolean }).enabled === true
    const session = activeSession
    session.shadowing = enabled

    const settings = await getSettings()
    settings.readAloud = { ...settings.readAloud, shadowing: enabled }
    await saveSettings(settings)

    if (!enabled && session.inGap) {
      // Cancel the pending gap and continue reading right away.
      clearShadowingGap()
      session.inGap = false
      session.token = ++sessionCounter
      session.state = 'playing'
      chrome.tts.stop()
      startSpeakingWatchdog(session.token)
      await speakCurrentSentence(session.token)
      return { ok: true }
    }

    await broadcastReadAloudState(tabId, session.state, session.currentIndex, false, session.inGap)
    return { ok: true }
  }

  if (action === 'next' || action === 'prev' || action === 'seek' || action === 'setSpeed') {
    const session = activeSession
    const lastIndex = session.sentences.length - 1

    if (action === 'next') {
      session.currentIndex = Math.min(session.currentIndex + 1, lastIndex)
      session.currentRep = 0
    } else if (action === 'prev') {
      session.currentIndex = Math.max(session.currentIndex - 1, 0)
      session.currentRep = 0
    } else if (action === 'seek') {
      const target = (payload as { index?: number }).index
      if (typeof target !== 'number') return { ok: false }
      session.currentIndex = Math.max(0, Math.min(Math.round(target), lastIndex))
      session.currentRep = 0
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

  if (info.menuItemId === 'read-from-here') {
    chrome.tabs.sendMessage(tab.id, {
      type: 'START_READ_ALOUD_FROM',
      payload: { selectedText: info.selectionText ?? '' },
    }).catch(() => { })
    return
  }

  if (!info.selectionText) return

  const match = info.menuItemId.toString().match(/^bookmark-(.+)$/)
  if (!match || match[1] === 'parent') return

  const color = match[1] as BookmarkColor
  const text = info.selectionText.trim()

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
    text: info.selectionText,
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
      await triggerSrsNotification(true)
      return { ok: true }
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
          ttsRestartTimeout = setTimeout(() => {
            if (activeSession?.state === 'playing') {
              activeSession.token = Date.now() // Prevent old 'interrupted' event from killing the session
              chrome.tts.stop()
              void speakCurrentSentence(activeSession.token)
            }
          }, 400)
        }
      }
      return { ok: true }
    }
    case 'MARK_ORPHANED':
      await markOrphaned(msg.payload as string)
      return { ok: true }
    case 'TRANSLATE_IN_CONTEXT':
      return translateInContext(msg.payload as ContextTranslateRequest)
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
      // Speak arbitrary text via chrome.tts using the same readAloud settings +
      // resolved voice as the page reader (D17). Used by the OCR popup so its
      // voice/speed matches the page read-aloud. Speaking here (not a page
      // session) does not touch activeSession.
      const payload = msg.payload as { text: string, lang?: string } | string
      const text = typeof payload === 'string' ? payload : payload.text
      const lang = typeof payload === 'string' ? undefined : payload.lang
      if (!text) return { ok: false }

      const settings = await getSettings()
      if (!settings?.readAloud) return { ok: false }

      const resolvedVoice = await resolveVoiceForSettings(settings.readAloud, lang)
      chrome.tts.stop()
      chrome.tts.speak(text, {
        enqueue: false,
        pitch: settings.readAloud.pitch,
        rate: settings.readAloud.speed,
        lang,
        voiceName: resolvedVoice,
        volume: settings.readAloud.volume,
      })
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
        if (focusTimeAccumulator >= 60) {
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
      const { tabId, status, progress, broadcast } = msg.payload as { tabId?: number; status: string; progress: number; broadcast?: boolean };
      if (broadcast) {
        chrome.runtime.sendMessage({ type: 'OCR_WINDOW_PROGRESS', payload: { status, progress } }).catch(() => {});
      } else if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'OCR_PROGRESS', payload: { status, progress } }).catch(() => {});
      }
      return { ok: true };
    }
    case 'OCR_COMPLETE': {
      const { tabId, text, error, broadcast } = msg.payload as { tabId?: number; text?: string; error?: string; broadcast?: boolean };
      if (broadcast) {
        chrome.runtime.sendMessage({ type: 'OCR_WINDOW_RESULT', payload: { text, error } }).catch(() => {});
      } else if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'OCR_COMPLETE', payload: { text, error } }).catch(() => {});
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
