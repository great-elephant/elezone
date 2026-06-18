import { Settings, DEFAULT_SETTINGS, SavedItem, ActivityLog } from './types'

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings')
  if (!result['settings']) return DEFAULT_SETTINGS
  const saved = result['settings'] as Partial<Settings>
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    readAloud: {
      ...DEFAULT_SETTINGS.readAloud,
      ...saved.readAloud,
    },
    translation: {
      ...DEFAULT_SETTINGS.translation,
      ...saved.translation,
    },
    srs: {
      ...DEFAULT_SETTINGS.srs,
      ...saved.srs,
    }
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings })
}

// ── Activity Log ─────────────────────────────────────────────────────────────

const ACTIVITY_KEY = 'cxt_activity_log'

export async function getActivityLog(): Promise<ActivityLog> {
  const result = await chrome.storage.local.get(ACTIVITY_KEY)
  return (result[ACTIVITY_KEY] as ActivityLog) || {}
}

export function getLocalYMD(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export async function logActivity(type: 'save' | 'review'): Promise<void> {
  const settings = await getSettings()
  const config = settings.gamification || DEFAULT_SETTINGS.gamification
  const log = await getActivityLog()
  const today = getLocalYMD()

  if (!log[today]) {
    log[today] = { saved: 0, reviewed: 0, points: 0 }
  }

  if (type === 'save') {
    log[today].saved += 1
    log[today].points += config.pointsPerSave
  } else if (type === 'review') {
    log[today].reviewed += 1
    log[today].points += config.pointsPerReview
  }

  await chrome.storage.local.set({ [ACTIVITY_KEY]: log })
}

// ── Unified Library (SavedItems) ──────────────────────────────────────────────

const LIBRARY_KEY = 'cxt_library'
const DRIVE_FILE_NAME = 'cxt_library.json'

let cachedLibrary: SavedItem[] | null = null

export async function migrateLegacyDataIfNeeded(): Promise<void> {
  const all = await chrome.storage.local.get(null)

  // Check if we already migrated
  if (all['cxt_legacy_migrated']) return

  const migratedItems: SavedItem[] = []

  // 1. Migrate Bookmarks (keys starting with 'bookmark:')
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith('bookmark:')) {
      const b = val as any
      migratedItems.push({
        id: b.id,
        url: b.url,
        text: b.text,
        prefix: b.prefix,
        suffix: b.suffix,
        occurrenceIndex: b.occurrenceIndex,
        color: b.color || 'yellow',
        createdAt: b.createdAt,
        orphaned: b.orphaned || false,
      })
      // Clean up legacy bookmark key
      await chrome.storage.local.remove(key)
    }
  }

  // 2. Migrate Flashcards (from 'cxt_flashcards')
  const legacyDeck = all['cxt_flashcards'] as any[] | undefined
  if (legacyDeck && Array.isArray(legacyDeck)) {
    for (const f of legacyDeck) {
      migratedItems.push({
        id: f.id,
        url: '', // Flashcards lacked URL
        text: f.word,
        prefix: f.contextPrefix,
        suffix: f.contextSuffix,
        occurrenceIndex: 0,
        color: 'red', // Default color for old flashcards
        createdAt: f.createdAt,
        orphaned: false,
        translation: f.translation,
        nextReview: f.nextReview,
        interval: f.interval,
        ease: f.ease,
        repetitions: f.repetitions
      })
    }
    await chrome.storage.local.remove('cxt_flashcards')
  }

  // If there are migrated items, save them to the new library key
  if (migratedItems.length > 0) {
    const existing = all[LIBRARY_KEY] as SavedItem[] | undefined || []
    await chrome.storage.local.set({ [LIBRARY_KEY]: [...existing, ...migratedItems] })
  }

  await chrome.storage.local.set({ 'cxt_legacy_migrated': true })
}

export async function getRawItems(): Promise<SavedItem[]> {
  await migrateLegacyDataIfNeeded()
  if (cachedLibrary) return cachedLibrary
  const data = await chrome.storage.local.get(LIBRARY_KEY)
  cachedLibrary = data[LIBRARY_KEY] || []
  return cachedLibrary!
}

export async function getAllItems(): Promise<SavedItem[]> {
  const raw = await getRawItems()
  return raw.filter(i => !i.deleted).map(i => ({
    ...i,
    color: i.color || 'red'
  }))
}

export async function saveItem(item: SavedItem): Promise<void> {
  item.updatedAt = Date.now()
  const library = await getRawItems()
  const existingIdx = library.findIndex(i => i.id === item.id)
  if (existingIdx >= 0) {
    library[existingIdx] = item
  } else {
    library.push(item)
  }
  await chrome.storage.local.set({ [LIBRARY_KEY]: library })
  cachedLibrary = library
  scheduleAutoSync()
}

export async function deleteItem(id: string): Promise<void> {
  const library = await getRawItems()
  const item = library.find(i => i.id === id)
  if (item) {
    item.deleted = true
    item.updatedAt = Date.now()
    await chrome.storage.local.set({ [LIBRARY_KEY]: library })
    cachedLibrary = library
    scheduleAutoSync()
  }
}

export async function getItemsForUrl(url: string): Promise<SavedItem[]> {
  const all = await getAllItems()
  return all.filter(i => i.url === url)
}

export async function markOrphaned(id: string): Promise<void> {
  const library = await getRawItems()
  const item = library.find(i => i.id === id)
  if (item) {
    item.orphaned = true
    item.updatedAt = Date.now()
    await chrome.storage.local.set({ [LIBRARY_KEY]: library })
    cachedLibrary = library
    // Orphan state usually doesn't need aggressive cloud sync, but doing it anyway
    scheduleAutoSync()
  }
}

export async function reviewItem(id: string, rating: 1 | 2 | 3 | 4): Promise<void> {
  const library = await getRawItems()
  const item = library.find(i => i.id === id)
  if (!item || item.nextReview === undefined) return

  const settings = await getSettings()
  const srsConfig = settings.srs || DEFAULT_SETTINGS.srs

  let { interval = 0, repetitions = 0, ease = srsConfig.easeMultiplier } = item

  if (rating >= 3) {
    if (repetitions === 0) {
      interval = srsConfig.initialInterval
    } else if (repetitions === 1) {
      interval = srsConfig.secondInterval
    } else {
      interval = Math.round(interval * ease)
    }
    repetitions++
  } else {
    repetitions = 0
    interval = srsConfig.initialInterval
  }

  ease = ease + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02))
  if (ease < 1.3) ease = 1.3

  const DAY_IN_MS = 24 * 60 * 60 * 1000
  item.interval = interval
  item.repetitions = repetitions
  item.ease = ease
  item.nextReview = Date.now() + (interval * DAY_IN_MS)
  item.updatedAt = Date.now()

  await chrome.storage.local.set({ [LIBRARY_KEY]: library })
  cachedLibrary = library
  scheduleAutoSync()
}

// ── Google Drive Sync ────────────────────────────────────────────────────────

let isSyncing = false
let autoSyncTimeout: ReturnType<typeof setTimeout> | null = null

export async function scheduleAutoSync() {
  const settings = await getSettings()
  if (!settings.sync?.enabled) return

  const delayMs = (settings.sync.debounceSeconds ?? 5) * 1000

  if (autoSyncTimeout) clearTimeout(autoSyncTimeout)
  autoSyncTimeout = setTimeout(() => {
    syncToDrive(false).catch(console.error)
  }, delayMs)
}

function broadcastSyncStatus(status: 'idle' | 'syncing' | 'success' | 'error') {
  chrome.runtime.sendMessage({ type: 'SYNC_STATUS_UPDATE', payload: status }).catch(() => { })
}

export async function syncToDrive(interactive = false): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings()
  if (!interactive && !settings.sync?.enabled) return { ok: true }

  if (isSyncing) return { ok: false, error: 'Already syncing' }
  isSyncing = true
  broadcastSyncStatus('syncing')

  try {
    const token = await getAuthToken(interactive)
    if (!token) {
      broadcastSyncStatus('idle')
      return { ok: false, error: 'Not authenticated. Please grant permission.' }
    }

    let library = await getRawItems()
    const fileId = await getDriveFileId(token)

    if (fileId) {
      const driveLibrary = await downloadDriveFile(token, fileId)
      if (driveLibrary) {
        const merged = new Map<string, SavedItem>()
        for (const item of driveLibrary) {
          merged.set(item.id, item)
        }
        for (const item of library) {
          const existing = merged.get(item.id)
          const itemTime = item.updatedAt || item.createdAt
          const existingTime = existing ? (existing.updatedAt || existing.createdAt) : 0
          if (!existing || itemTime > existingTime) {
            merged.set(item.id, item)
          }
        }
        library = Array.from(merged.values())
        await chrome.storage.local.set({ [LIBRARY_KEY]: library })
        cachedLibrary = library
      }
      await updateDriveFile(token, fileId, library)
    } else {
      await createDriveFile(token, library)
    }
    broadcastSyncStatus('success')
    setTimeout(() => broadcastSyncStatus('idle'), 2500)
    return { ok: true }
  } catch (err: any) {
    console.error('Failed to sync to drive:', err)
    broadcastSyncStatus('error')
    setTimeout(() => broadcastSyncStatus('idle'), 2500)
    return { ok: false, error: err.message || 'Unknown error occurred' }
  } finally {
    isSyncing = false
  }
}

async function downloadDriveFile(token: string, fileId: string): Promise<SavedItem[] | null> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return null
  return res.json()
}

async function getAuthToken(interactive = false): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Authentication failed.'))
      } else if (!token) {
        reject(new Error('No token returned.'))
      } else {
        resolve(token)
      }
    })
  })
}

async function getDriveFileId(token: string): Promise<string | null> {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`)
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive`

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return null
  const data = await res.json()
  return data.files && data.files.length > 0 ? data.files[0].id : null
}

async function createDriveFile(token: string, library: SavedItem[]): Promise<void> {
  const metadata = { name: DRIVE_FILE_NAME, mimeType: 'application/json' }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('file', new Blob([JSON.stringify(library)], { type: 'application/json' }))

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  if (!res.ok) throw new Error('Failed to create drive file')
}

async function updateDriveFile(token: string, fileId: string, library: SavedItem[]): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(library)
  })
  if (!res.ok) throw new Error('Failed to update drive file')
}
