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

    gamification: {
      ...DEFAULT_SETTINGS.gamification,
      ...saved.gamification,
    },
    ocr: {
      ...DEFAULT_SETTINGS.ocr,
      ...saved.ocr,
    },
    srsNotifications: {
      ...DEFAULT_SETTINGS.srsNotifications,
      ...saved.srsNotifications,
    } as Settings['srsNotifications'],
    roast: {
      ...DEFAULT_SETTINGS.roast,
      ...saved.roast,
    } as Settings['roast'],
    pomodoro: {
      ...DEFAULT_SETTINGS.pomodoro,
      ...saved.pomodoro,
    } as Settings['pomodoro']
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  // We no longer blindly update Date.now() here. The UI (SettingsPanel) decides if a user-facing setting was changed.
  // This ensures that merely toggling "Sync enabled" doesn't falsely make the local settings appear "newer" than the cloud.
  await chrome.storage.local.set({ settings })
  scheduleAutoSync()
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

const LIBRARY_KEY = 'elezone_library'
const DRIVE_FILE_NAME = 'elezone_data.json'

let cachedLibrary: SavedItem[] | null = null



export async function getRawItems(): Promise<SavedItem[]> {
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


// ── Spaced Repetition (SRS) ──────────────────────────────────────────────────

export function updateSrsMetrics(item: SavedItem, passed: boolean): SavedItem {
  let ease = item.ease ?? 2.5
  let interval = item.interval ?? 0
  let repetitions = item.repetitions ?? 0

  if (passed) {
    repetitions += 1
    if (repetitions === 1) {
      interval = 1
    } else if (repetitions === 2) {
      interval = 6
    } else {
      interval = Math.round(interval * ease)
    }
    // SM-2 Ease adjustment (quality = 4 for "I knew it")
    ease = ease + (0.1 - (5 - 4) * (0.08 + (5 - 4) * 0.02))
  } else {
    repetitions = 0
    interval = 1
    // SM-2 Ease adjustment (quality = 0 for "Forgot")
    ease = Math.max(1.3, ease - 0.2)
  }

  // Next review date calculation
  const nextReview = Date.now() + interval * 24 * 60 * 60 * 1000

  return {
    ...item,
    ease,
    interval,
    repetitions,
    nextReview
  }
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
    let activityLog = await getActivityLog()
    let localSettings = await getSettings()
    const fileId = await getDriveFileId(token)

    if (fileId) {
      const driveData = await downloadDriveFile(token, fileId)
      if (driveData) {
        const driveLibrary: SavedItem[] = driveData.library || []
        const driveLog: ActivityLog = driveData.activityLog || {}
        const driveSettings: Settings | undefined = driveData.settings

        /**
         * DELTA SYNC LOGIC FOR LIBRARY (LWW-Element-Set CRDT approach)
         * 
         * For the library, we use a Last-Write-Wins (LWW) strategy combined with Tombstones.
         * - When an item is deleted, it is not actually removed from storage. Instead, `deleted: true` is set 
         *   and `updatedAt` is bumped (Tombstone).
         * - During sync, we merge local and remote arrays. If there's a conflict (same item ID), 
         *   we strictly compare `updatedAt` or `createdAt`. The one with the larger timestamp wins.
         * This guarantees eventual consistency across all devices without losing legitimate updates or deletions.
         */
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
        // 3-day Garbage Collection for Tombstones
        const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        library = Array.from(merged.values()).filter(item => {
          // Hard delete items that have been marked as deleted for more than 3 days
          if (item.deleted && item.updatedAt && (now - item.updatedAt > THREE_DAYS)) {
            return false;
          }
          return true;
        });
        await chrome.storage.local.set({ [LIBRARY_KEY]: library })
        cachedLibrary = library

        const lastSyncedData = await chrome.storage.local.get('cxt_last_synced_activity_log')
        const lastSyncedLog = (lastSyncedData['cxt_last_synced_activity_log'] as ActivityLog) || {}

        /**
         * DELTA SYNC LOGIC FOR ACTIVITY LOG (CRDT-like approach)
         * 
         * Problem:
         * If we simply take Math.max(local, remote), users lose points if they study on multiple devices concurrently.
         * If we simply add them (local + remote), points will multiply to infinity every time the user clicks "Sync".
         * 
         * Solution:
         * We store a snapshot of the activity log from the *last successful sync* (`cxt_last_synced_activity_log`).
         * When syncing, we calculate the "unsynced delta" (new points earned locally since the last sync).
         * We then add only this delta to the remote (Cloud) data.
         * 
         * Example:
         * 1. Machine A syncs 50 points. (Cloud = 50, A_Local = 50, A_LastSynced = 50)
         * 2. Machine B syncs. (Cloud = 50, B_Local = 50, B_LastSynced = 50)
         * 3. Machine A earns 10 new points. (A_Local = 60).
         * 4. Machine B earns 20 new points. (B_Local = 70).
         * 5. Machine A syncs:
         *    - Delta A = 60 (A_Local) - 50 (A_LastSynced) = 10.
         *    - Cloud becomes 50 + 10 = 60.
         *    - A_Local and A_LastSynced become 60.
         * 6. Machine B syncs:
         *    - Delta B = 70 (B_Local) - 50 (B_LastSynced) = 20.
         *    - Cloud becomes 60 + 20 = 80.
         *    - B_Local and B_LastSynced become 80.
         * 
         * Result: Total points = 50 + 10 + 20 = 80! No data loss, no infinite multiplication.
         */

        // 1. Calculate unsynced local changes and add them to the remote log
        for (const date in activityLog) {
          const local = activityLog[date]
          const remote = driveLog[date] || { saved: 0, reviewed: 0, points: 0 }
          const lastSynced = lastSyncedLog[date] || { saved: 0, reviewed: 0, points: 0 }

          const unsyncedSaved = Math.max(0, (local.saved || 0) - (lastSynced.saved || 0))
          const unsyncedReviewed = Math.max(0, (local.reviewed || 0) - (lastSynced.reviewed || 0))
          const unsyncedPoints = Math.max(0, (local.points || 0) - (lastSynced.points || 0))

          if (unsyncedSaved > 0 || unsyncedReviewed > 0 || unsyncedPoints > 0) {
            driveLog[date] = {
              saved: (remote.saved || 0) + unsyncedSaved,
              reviewed: (remote.reviewed || 0) + unsyncedReviewed,
              points: (remote.points || 0) + unsyncedPoints
            }
          }
        }

        // 2. Bring down the updated remote log to local
        let logChanged = false
        for (const date in driveLog) {
          const remote = driveLog[date]
          if (!activityLog[date]) {
            activityLog[date] = { ...remote }
            logChanged = true
          } else {
            const local = activityLog[date]
            if (local.saved !== remote.saved || local.reviewed !== remote.reviewed || local.points !== remote.points) {
              activityLog[date] = { ...remote }
              logChanged = true
            }
          }
        }

        if (logChanged) {
          await chrome.storage.local.set({ [ACTIVITY_KEY]: activityLog })
        }
        await chrome.storage.local.set({ 'cxt_last_synced_activity_log': activityLog })

        if (driveSettings) {
          const localTime = localSettings.updatedAt || 0
          const remoteTime = driveSettings.updatedAt || 0

          let mergedSettings: Settings
          if (remoteTime > localTime) {
            // Remote is newer, use remote but preserve local sync configuration
            mergedSettings = {
              ...localSettings,
              ...driveSettings,
              sync: localSettings.sync // Always keep local sync config
            }
          } else {
            // Local is newer (or equal), keep local settings entirely
            mergedSettings = localSettings
          }

          // Also force gamification daily goal back to 100 if it was broken by an old backup
          if (mergedSettings.gamification && mergedSettings.gamification.dailyGoalPoints < 100) {
            mergedSettings.gamification.dailyGoalPoints = 100
          }
          await saveSettings(mergedSettings)
          localSettings = mergedSettings
        }
      }
      await updateDriveFile(token, fileId, { version: 1, library, activityLog, settings: localSettings })
    } else {
      await createDriveFile(token, { version: 1, library, activityLog, settings: localSettings })
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

async function downloadDriveFile(token: string, fileId: string): Promise<any | null> {
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

async function createDriveFile(token: string, data: any): Promise<void> {
  const metadata = { name: DRIVE_FILE_NAME, mimeType: 'application/json' }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }))

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  if (!res.ok) throw new Error('Failed to create drive file')
}

async function updateDriveFile(token: string, fileId: string, data: any): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
  if (!res.ok) throw new Error('Failed to update drive file')
}
