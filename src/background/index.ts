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
  updateSrsMetrics
} from '../shared/library'
import {
  SavedItem,
  BookmarkColor,
  BOOKMARK_COLORS,
  ReadAloudSettings,
  ReadAloudState,
  Settings,
} from '../shared/types'

type ActiveReadAloudSession = {
  currentIndex: number
  currentRep: number
  sentences: string[]
  settings: ReadAloudSettings
  state: ReadAloudState
  tabId: number
  token: number
}

const COLORS = Object.keys(BOOKMARK_COLORS) as BookmarkColor[]
const readAloudStateByTab = new Map<number, ReadAloudState>()
let activeSession: ActiveReadAloudSession | null = null
let sessionCounter = 0
let speakingWatchdog: ReturnType<typeof setInterval> | null = null

const COLOR_EMOJI: Record<BookmarkColor, string> = {
  red: '🔴', yellow: '🟡', cyan: '🔵', green: '🟢', blue: '💙',
  orange: '🟠', purple: '🟣', pink: '🩷', teal: '🩵', gray: '⚫',
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus()
  setupSrsAlarm()
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
    chrome.alarms.create('srs-tick', { periodInMinutes: srs.intervalMinutes || 30 })
  } else {
    chrome.alarms.clear('srs-tick')
  }
}

async function triggerSrsNotification(testMode = false) {
  const settings = await getSettings()
  if (!settings.srsNotifications?.enabled && !testMode) return

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
  }
})

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

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ocr', title: 'Image to text(OCR)', contexts: ['page', 'image', 'selection'] })
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
    voiceName: session.settings.voice || undefined,
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

  const { sentences, startIndex, settings } = payload as {
    sentences: string[]
    startIndex: number
    settings: ReadAloudSettings
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
  const tabId = sender.tab?.id
  const action = (payload as { action?: string } | undefined)?.action
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
  dispatch(msg, sender).then(sendResponse).catch(() => sendResponse(null))
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

    case 'SYNC_ITEMS':
      return await syncToDrive((msg.payload as any)?.interactive)
    case 'LOG_ACTIVITY':
      await logActivity(msg.payload as 'save' | 'review')
      return { ok: true }
    case 'GET_ACTIVITY_LOG':
      return getActivityLog()
    case 'GET_SETTINGS':
      return getSettings()
    case 'SAVE_SETTINGS':
      await saveSettings(msg.payload as Settings)
      return { ok: true }
    case 'MARK_ORPHANED':
      await markOrphaned(msg.payload as string)
      return { ok: true }
    case 'START_READ_ALOUD_SESSION':
      return startReadAloudSession(sender, msg.payload)
    case 'CONTROL_READ_ALOUD':
      return controlReadAloud(sender, msg.payload)
    case 'SPEAK_TEXT':
      const settings = await getSettings()
      if (settings?.readAloud) {
        chrome.tts.stop()
        if (settings.readAloud.voice) {
          chrome.tts.speak(msg.payload as string, {
            pitch: settings.readAloud.pitch,
            rate: settings.readAloud.speed,
            voiceName: settings.readAloud.voice,
            volume: settings.readAloud.volume
          })
        } else {
          chrome.tts.speak(msg.payload as string)
        }
      }
      return { ok: true }
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
    default:
      return null
  }
}
