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
} from '../shared/types'
import { translateInContext, ContextTranslateRequest } from './aiTranslate'
import { getRandomRoast, RoastLevel } from '../shared/roasts'

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
  sentences: string[]
  settings: ReadAloudSettings
  lang?: string
  state: ReadAloudState
  tabId: number
  token: number
}

const COLORS = Object.keys(BOOKMARK_COLORS) as BookmarkColor[]
const readAloudStateByTab = new Map<number, ReadAloudState>()
let activeSession: ActiveReadAloudSession | null = null
let sessionCounter = 0
let ttsRestartTimeout: ReturnType<typeof setTimeout> | null = null
let speakingWatchdog: ReturnType<typeof setInterval> | null = null

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

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'play_pause' && activeSession) {
    if (activeSession.state === 'playing') {
      activeSession.state = 'paused'
      chrome.tts.pause()
      await broadcastReadAloudState(activeSession.tabId, 'paused', activeSession.currentIndex)
    } else if (activeSession.state === 'paused') {
      activeSession.state = 'playing'
      chrome.tts.resume()
      await broadcastReadAloudState(activeSession.tabId, 'playing', activeSession.currentIndex)
    }
  } else if (command === 'trigger_ocr') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'START_CROP_MODE' }).catch(() => {})
    }
  }
})

async function evaluateSlackingState(testMode = false) {
  const settings = await getSettings()
  if (!settings.roast?.enabled && !testMode) {
    await chrome.storage.local.remove('slacking_state')
    return
  }

  if (testMode) {
    const roastMessage = getRandomRoast(3)
    const state = { isSlacking: true, level: 3, message: roastMessage }
    await chrome.storage.local.set({ slacking_state: state })
    
    chrome.notifications.create(`roast-test-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'EleZone Cảnh Báo 🚨 (Test)',
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

  if (todayPoints >= dailyGoal && !testMode) {
    slacking = false
  }

  if (slacking) {
    const roastMessage = getRandomRoast(level)
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
        title: 'EleZone Cảnh Báo 🚨',
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

    const isSpeaking = await isTtsSpeaking()
    if (!isSpeaking && activeSession?.token === token) {
      await stopActiveSession()
    }
  }, 1000)
}

async function broadcastReadAloudState(tabId: number, state: ReadAloudState, index?: number) {
  if (state === 'idle') readAloudStateByTab.delete(tabId)
  else readAloudStateByTab.set(tabId, state)

  await chrome.tabs.sendMessage(tabId, {
    type: 'READ_ALOUD_UPDATE',
    payload: { state, index },
  }).catch(() => { })

  await chrome.runtime.sendMessage({
    type: 'READ_ALOUD_STATE',
    payload: { tabId, state },
  }).catch(() => { })
}

async function stopActiveSession() {
  const session = activeSession
  clearSpeakingWatchdog()
  activeSession = null
  chrome.tts.stop()
  if (session) {
    await broadcastReadAloudState(session.tabId, 'idle')
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

  if (event.type === 'end') {
    if (session.state !== 'playing') return
    session.currentRep += 1
    if (session.currentRep < session.settings.repetition) {
      void speakCurrentSentence(token)
      return
    }

    session.currentRep = 0
    session.currentIndex += 1
    if (session.currentIndex >= session.sentences.length) {
      void stopActiveSession()
      return
    }

    void speakCurrentSentence(token)
    return
  }

  if (event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
    void stopActiveSession()
  }
}

async function speakCurrentSentence(token: number) {
  const session = activeSession
  if (!session || session.token !== token) return

  if (session.currentIndex >= session.sentences.length) {
    await stopActiveSession()
    return
  }

  session.state = 'playing'
  await broadcastReadAloudState(session.tabId, 'playing', session.currentIndex)

  chrome.tts.speak(session.sentences[session.currentIndex], {
    enqueue: false,
    onEvent: event => handleTtsEvent(token, event),
    pitch: session.settings.pitch,
    rate: session.settings.speed,
    lang: session.lang,
    voiceName: (session.lang && session.settings.languageVoices?.[session.lang]) || session.settings.voice || undefined,
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

  const token = ++sessionCounter
  activeSession = {
    currentIndex: Math.max(0, Math.min(startIndex, sentences.length - 1)),
    currentRep: 0,
    sentences,
    settings,
    lang,
    state: 'playing',
    tabId,
    token,
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
    chrome.tts.pause()
    await broadcastReadAloudState(tabId, 'paused', activeSession.currentIndex)
    return { ok: true }
  }

  if (action === 'resume' && activeSession.state === 'paused') {
    activeSession.state = 'playing'
    chrome.tts.resume()
    await broadcastReadAloudState(tabId, 'playing', activeSession.currentIndex)
    return { ok: true }
  }

  if (action === 'stop') {
    await stopActiveSession()
    return { ok: true }
  }

  return { ok: false }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return

  if (info.menuItemId === 'ocr') {
    chrome.tabs.sendMessage(tab.id, { type: 'START_CROP_MODE' }).catch(() => { })
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
  }).catch(() => null) as { prefix: string; suffix: string; occurrenceIndex: number } | null

  if (!response) return

  const bookmark: SavedItem = {
    id: crypto.randomUUID(),
    url: info.pageUrl,
    text: info.selectionText,
    prefix: response.prefix,
    suffix: response.suffix,
    occurrenceIndex: response.occurrenceIndex,
    color,
    createdAt: Date.now(),
    orphaned: false,
  }

  await saveItem(bookmark)
  await logActivity('save')
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
    case 'SPEAK_TEXT': {
      const payload = msg.payload as { text: string, lang?: string } | string
      const text = typeof payload === 'string' ? payload : payload.text
      const lang = typeof payload === 'string' ? undefined : payload.lang

      const settings = await getSettings()
      if (settings?.readAloud) {
        chrome.tts.stop()
        if (lang && settings.readAloud.languageVoices?.[lang]) {
          chrome.tts.speak(text, {
            pitch: settings.readAloud.pitch,
            rate: settings.readAloud.speed,
            lang: lang,
            voiceName: settings.readAloud.languageVoices[lang],
            volume: settings.readAloud.volume
          })
        } else if (settings.readAloud.voice) {
          chrome.tts.speak(text, {
            pitch: settings.readAloud.pitch,
            rate: settings.readAloud.speed,
            lang: lang,
            voiceName: settings.readAloud.voice,
            volume: settings.readAloud.volume
          })
        } else {
          chrome.tts.speak(text, { lang })
        }
      }
      return { ok: true }
    }
    case 'GET_READ_ALOUD_STATE': {
      const tabId = (msg.payload as { tabId?: number } | undefined)?.tabId ?? sender.tab?.id
      return { state: tabId ? (readAloudStateByTab.get(tabId) ?? 'idle') : 'idle' as ReadAloudState }
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
    case 'POMODORO_COMMAND':
      await setupOffscreenDocument('src/offscreen/index.html');
      return chrome.runtime.sendMessage({ type: 'POMODORO_COMMAND', payload: msg.payload });
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
      const { tabId, status, progress } = msg.payload as { tabId?: number; status: string; progress: number };
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'OCR_PROGRESS', payload: { status, progress } }).catch(() => {});
      }
      return { ok: true };
    }
    case 'OCR_COMPLETE': {
      const { tabId, text, error } = msg.payload as { tabId?: number; text?: string; error?: string };
      if (tabId) {
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
