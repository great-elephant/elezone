import { Settings, DEFAULT_SETTINGS, SavedItem, ActivityLog, SettingsSection, SETTINGS_SECTIONS } from './types'
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from 'ts-fsrs'
export { Rating } from 'ts-fsrs'
export type { Grade } from 'ts-fsrs'

// ── Settings ─────────────────────────────────────────────────────────────────

/** When each section was last changed, with no gaps — see readSectionClocks(). */
type SectionClocks = Record<SettingsSection, number>

/**
 * Reads the per-section clocks off a settings document from anywhere (local
 * storage, or the file on Drive), filling every section in.
 *
 * A document written before per-section sync existed only carries the flat
 * `updatedAt`, so seed every section from it: that first merge then behaves
 * exactly like the whole-document comparison that wrote it, and the sections
 * drift apart from the next real edit onwards. Nothing an existing user has is
 * lost on the way in.
 */
function readSectionClocks(saved: Partial<Settings> | undefined): SectionClocks {
  const flat = saved?.updatedAt
  const fallback = typeof flat === 'number' && Number.isFinite(flat) ? flat : 0
  const stored = saved?.sectionUpdatedAt
  const clocks = {} as SectionClocks
  for (const section of SETTINGS_SECTIONS) {
    const clock = stored?.[section]
    clocks[section] = typeof clock === 'number' && Number.isFinite(clock) ? clock : fallback
  }
  return clocks
}

/**
 * The flat `updatedAt` we publish alongside the clocks, for peers on a build
 * that still compares one timestamp. `sync` is left out on purpose: it holds
 * device configuration that never travels, so a machine that has done nothing
 * but switch syncing on must not look newer than the cloud to those peers —
 * that is exactly how a fresh install used to flatten everyone else's data.
 */
function newestSharedClock(clocks: SectionClocks): number {
  let newest = 0
  for (const section of SETTINGS_SECTIONS) {
    if (section === 'sync') continue
    if (clocks[section] > newest) newest = clocks[section]
  }
  return newest
}

/**
 * Structural comparison of two section values. Undefined-valued keys are
 * ignored so a section that has been through JSON (everything that comes back
 * from Drive) still compares equal to the in-memory object it was written from.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => sameValue(entry, b[i]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined)
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => sameValue(left[key], right[key]))
}

/** Reads/writes sections off a settings object without widening Settings itself. */
function sectionsOf(settings: Partial<Settings>): Record<SettingsSection, unknown> {
  return settings as unknown as Record<SettingsSection, unknown>
}

/**
 * Clock of the newest copy of each section this device has taken *from Drive*.
 * Deliberately kept out of Settings and never uploaded: it is a record of what
 * this machine has been handed, not part of what the user configured.
 */
const SETTINGS_PULLED_KEY = 'cxt_settings_pulled_at'

async function readPulledClocks(): Promise<SectionClocks> {
  const result = await chrome.storage.local.get(SETTINGS_PULLED_KEY)
  const saved = (result[SETTINGS_PULLED_KEY] ?? {}) as Partial<Record<SettingsSection, number>>
  const clocks = {} as SectionClocks
  for (const section of SETTINGS_SECTIONS) {
    const clock = saved[section]
    clocks[section] = typeof clock === 'number' && Number.isFinite(clock) ? clock : 0
  }
  return clocks
}

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings')
  const saved = (result['settings'] ?? {}) as Partial<Settings>
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    // After the spreads, so a document stored without the clocks (or with only
    // some of them) still comes back with every section filled in.
    sectionUpdatedAt: readSectionClocks(saved),
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

/**
 * Writes a settings document whose clocks are already final — the merge in
 * syncToDrive(). Skips the change detection below, which would otherwise stamp
 * the merged sections with "now" and lose the timestamps the next merge has to
 * compare against.
 */
async function persistSettings(settings: Settings, scheduleSync: boolean): Promise<void> {
  await chrome.storage.local.set({ settings })
  if (scheduleSync) scheduleAutoSync()
}

/**
 * Persists a settings document, working out for itself which sections actually
 * changed rather than trusting the caller to say so.
 *
 * Callers hand over a whole settings object built by spreading the one they
 * read, so what they changed is recoverable by comparing against what is in
 * storage — and that is far more reliable than asking every call site to
 * remember to stamp a clock. Two things fall out of it:
 *
 * - Switching syncing on only touches the `sync` section, so a machine that was
 *   installed a minute ago does not claim its untouched defaults are newer than
 *   the cloud's real data, and pulls that data down instead of erasing it.
 * - The Pomodoro flush only touches `tasks`, so a minute of focus time recorded
 *   on this machine no longer swallows a voice or translation change made on
 *   another one.
 *
 * A caller can also be working from a snapshot that a sync has since overtaken:
 * it read the settings, a merge then pulled a newer copy of that section down
 * from Drive, and only afterwards did the write arrive — which is exactly the
 * order the options page can produce, since switching syncing on fires the save
 * and the sync off together. Sections older than the last pull are left as the
 * merge left them; letting that write through would push the pre-merge values
 * back out to every other machine.
 */
export async function saveSettings(
  settings: Settings,
  options?: { scheduleSync?: boolean }
): Promise<void> {
  const stored = await getSettings()
  const storedClocks = readSectionClocks(stored)
  const pulledClocks = await readPulledClocks()
  // What the caller's copy knew when it was read. A caller that dropped the
  // clocks entirely gets the benefit of the doubt (treated as up to date) —
  // better than silently discarding a real edit.
  const baseClocks = settings.sectionUpdatedAt ? readSectionClocks(settings) : storedClocks

  const now = Date.now()
  const next = { ...settings }
  const nextSections = sectionsOf(next)
  const storedSections = sectionsOf(stored)
  const clocks = {} as SectionClocks

  for (const section of SETTINGS_SECTIONS) {
    if (sameValue(nextSections[section], storedSections[section])) {
      clocks[section] = storedClocks[section]
    } else if (baseClocks[section] < pulledClocks[section]) {
      // Compared against the last *pull*, not against the stored clock: a page
      // keeps the object it sent, not the clock the write ended up with, so its
      // own previous save always looks "older" than storage. Measuring against
      // pulls means a page's second edit in a row still lands, and only a write
      // that predates data the cloud has since handed us is turned away.
      nextSections[section] = storedSections[section]
      clocks[section] = storedClocks[section]
    } else {
      clocks[section] = now
    }
  }

  next.sectionUpdatedAt = clocks
  next.updatedAt = newestSharedClock(clocks)
  await persistSettings(next, options?.scheduleSync ?? true)
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

// Serializes logActivity()'s read-modify-write on the activity log. Without
// this, two calls landing close together (e.g. saving a word right after
// finishing a review) both read the same pre-update log before either writes
// back, so one call's increment silently overwrites the other's instead of
// adding to it.
let activityLogQueue: Promise<void> = Promise.resolve()

export async function logActivity(type: 'save' | 'review'): Promise<void> {
  const previous = activityLogQueue
  let release!: () => void
  activityLogQueue = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
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
  } finally {
    release()
  }
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
  // Retroactive repair, persisted (not just backfilled on read like createdAt
  // below): the same old videoMode bug that left createdAt undefined also
  // left `id` undefined on those items. An undefined id is worse than an
  // undefined createdAt — every notification's id is `srs-q-${item.id}`, so
  // a missing id serializes as the literal string "srs-q-undefined". Its
  // `due` reads as 0 (via the `?? 0` fallback everywhere due-ness is
  // checked), the smallest possible timestamp, so it wins "which item is
  // most due" on every single tick — the notification never rotates to a
  // different word. Worse, clicking "Show Answer" extracts the id back out
  // of the notification id via string replace, getting the *string*
  // "undefined" — which never matches the real item's *value* undefined, so
  // the lookup silently fails and no follow-up "Answer" notification is ever
  // created. A computed-on-read default (like createdAt's) isn't enough
  // here: every other piece of code identifies an item BY id (saveItem's
  // update-vs-insert check, DELETE_ITEM, the notification id itself), so a
  // fresh random id generated on every read instead of persisted would
  // itself keep breaking those lookups. Fix and write back once.
  let repaired = false
  for (const i of raw as any[]) {
    if (!i.id) {
      i.id = crypto.randomUUID()
      repaired = true
    }
  }
  if (repaired) {
    await chrome.storage.local.set({ [LIBRARY_KEY]: raw })
    cachedLibrary = raw
  }
  return raw
    .filter(i => !i.deleted)
    // Defensive: an earlier (never-shipped, now-reverted) experimental
    // design briefly stored Group/Deck-shaped entries inside this same
    // `elezone_library` array (`isGroup`/`isDeck` + placeholder
    // `text`/`translation`). This array should only ever hold real
    // SavedItems — but a browser that ran that old code still has those
    // stray entries sitting in storage, and they'd otherwise render as
    // bogus "saved words". Filter them out regardless of how they got there.
    .filter((i: any) => !i.isGroup && !i.isDeck)
    .map(i => ({
      ...i,
      color: i.color || 'red',
      // Defensive: videoMode's saveWordFromSubtitle used to send a SAVE_ITEM
      // payload with no `createdAt` at all (fixed at the source below, but
      // storage that already went through the old code has items with
      // createdAt: undefined sitting in it forever otherwise). A single item
      // with a non-numeric createdAt turns Math.max/subtraction-based sort
      // comparators (Library.tsx's "By Source" newest/oldest sort) into NaN,
      // which can corrupt the ordering of the WHOLE list, not just that one
      // item — Array.sort's behavior is unspecified once the comparator ever
      // returns NaN. updatedAt is always set by saveItem, even historically,
      // so it's a real timestamp to fall back to instead of "now" or 0.
      createdAt: (typeof i.createdAt === 'number' && !isNaN(i.createdAt)) ? i.createdAt : (i.updatedAt || 0),
    }))
}

export async function saveItem(item: SavedItem): Promise<void> {
  // Defensive: at least one caller (videoMode's saveWordFromSubtitle) used to
  // send a payload missing `id`/`createdAt` entirely, expecting this function
  // to fill them in — it never did, so those items got stored with `id`/
  // `createdAt` literally undefined. Undefined `id` means every subsequent
  // such save's `findIndex` below matches and silently overwrites the
  // previous one instead of adding a new item; undefined `createdAt` poisons
  // any Math.max/subtraction-based sort (see getAllItems). Filling both in
  // here means no caller can ever corrupt storage this way again, regardless
  // of what it forgets to set.
  item.id ||= crypto.randomUUID()
  item.createdAt ||= Date.now()
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

export async function markOrphaned(id: string, orphaned = true): Promise<void> {
  const library = await getRawItems()
  const item = library.find(i => i.id === id)
  if (item && item.orphaned !== orphaned) {
    item.orphaned = orphaned
    item.updatedAt = Date.now()
    await chrome.storage.local.set({ [LIBRARY_KEY]: library })
    cachedLibrary = library
    // Orphan state usually doesn't need aggressive cloud sync, but doing it anyway
    scheduleAutoSync()
  }
}


// ── Spaced Repetition (SRS) ──────────────────────────────────────────────────

const EASE_MIN = 1.3
const EASE_MAX = 3.0
// Small bump applied to `ease` on a correct answer. The original SM-2 formula
// (`ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))`) evaluates to exactly 0
// for a fixed quality of q=4, which is what "passed" was hardcoded to — so ease
// could only ever go down (on "Forgot") and never recover. We don't collect a
// finer-grained quality signal from the UI, so instead of reintroducing that
// formula, apply a small flat bonus on every pass.
const EASE_BONUS = 0.1

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
    // Ease adjustment on a correct answer.
    ease = Math.min(EASE_MAX, ease + EASE_BONUS)
  } else {
    repetitions = 0
    interval = 1
    // SM-2 Ease adjustment (quality = 0 for "Forgot")
    ease = Math.max(EASE_MIN, ease - 0.2)
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

// ── FSRS ─────────────────────────────────────────────────────────────────────
// Replaces `updateSrsMetrics` (SM-2, above) as the scheduler StudyUI actually
// calls. `updateSrsMetrics` and its fields (`ease`/`interval`/`nextReview`)
// are kept, not deleted, so a card reviewed before this switch keeps its
// history instead of losing it — but nothing writes to them anymore.
const fsrsScheduler = fsrs(generatorParameters())

const FSRS_STATE_TO_ITEM: Record<State, NonNullable<SavedItem['state']>> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
}
const ITEM_STATE_TO_FSRS: Record<NonNullable<SavedItem['state']>, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
}

function itemToFsrsCard(item: SavedItem): Card {
  // No `due`/`state` yet means this item has never been through FSRS (either
  // brand new, or it only has SM-2 history from before this switch) — start
  // it as a fresh card rather than guessing at a conversion from SM-2 fields.
  if (item.due == null || !item.state) {
    return createEmptyCard(item.lastReview ? new Date(item.lastReview) : new Date())
  }
  return {
    due: new Date(item.due),
    stability: item.stability ?? 0,
    difficulty: item.difficulty ?? 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: item.repetitions ?? 0,
    lapses: 0,
    state: ITEM_STATE_TO_FSRS[item.state] ?? State.New,
    last_review: item.lastReview ? new Date(item.lastReview) : undefined,
  }
}

export function updateFsrsMetrics(item: SavedItem, grade: Grade): SavedItem {
  const card = itemToFsrsCard(item)
  const { card: next } = fsrsScheduler.next(card, new Date(), grade)
  return {
    ...item,
    stability: next.stability,
    difficulty: next.difficulty,
    due: next.due.getTime(),
    state: FSRS_STATE_TO_ITEM[next.state],
    lastReview: Date.now(),
    repetitions: next.reps,
  }
}

// Non-committing preview of what each of the 4 grades WOULD schedule this
// card to (the "10m / 1d / 4d / 9d" hints under Again/Hard/Good/Easy buttons
// in the study UI) — doesn't touch storage, just runs the scheduler forward
// for every grade at once via ts-fsrs's own `repeat`.
export function previewFsrsDue(item: SavedItem): Record<Grade, Date> {
  const card = itemToFsrsCard(item)
  const preview = fsrsScheduler.repeat(card, new Date())
  return {
    [Rating.Again]: preview[Rating.Again].card.due,
    [Rating.Hard]: preview[Rating.Hard].card.due,
    [Rating.Good]: preview[Rating.Good].card.due,
    [Rating.Easy]: preview[Rating.Easy].card.due,
  } as Record<Grade, Date>
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
        // Garbage Collection for Tombstones. This must comfortably outlast how long a
        // device can realistically stay offline between syncs — 3 days was too short:
        // a device offline longer than that could merge back an item whose tombstone
        // had already been GC'd off Drive by other, more frequently-syncing devices,
        // resurrecting something the user deliberately deleted.
        const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        library = Array.from(merged.values()).filter(item => {
          // Hard delete items that have been marked as deleted for longer than the TTL
          if (item.deleted && item.updatedAt && (now - item.updatedAt > TOMBSTONE_TTL)) {
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

        if (driveSettings) {
          /**
           * SETTINGS MERGE, ONE SECTION AT A TIME
           *
           * Comparing a single document-wide timestamp meant the loser's entire
           * settings were thrown away: change the reading speed here, change the
           * volume there five seconds later, and the first change was gone for
           * good. Each section carries its own clock instead, so only genuinely
           * competing edits — two machines changing the *same* section — can
           * still overwrite one another.
           */
          const localClocks = readSectionClocks(localSettings)
          const remoteClocks = readSectionClocks(driveSettings)
          const mergedSettings: Settings = { ...localSettings }
          const mergedSections = sectionsOf(mergedSettings)
          const remoteSections = sectionsOf(driveSettings)
          const mergedClocks = {} as SectionClocks
          const pulledClocks = await readPulledClocks()
          let pulledAnything = false

          for (const section of SETTINGS_SECTIONS) {
            // `sync` is this device's own configuration (whether syncing is on,
            // how long to debounce), not shared state.
            const shared = section !== 'sync'
            // A section the remote file simply doesn't have yet — an older
            // schema, or a machine that has never set it — must not blank out
            // the copy we do have, however new the remote clock looks.
            const present = section in driveSettings
            if (shared && present && remoteClocks[section] > localClocks[section]) {
              mergedSections[section] = remoteSections[section]
              mergedClocks[section] = remoteClocks[section]
              // Remembered so a write still in flight from a page that read this
              // section before the pull can't undo it — see saveSettings().
              pulledClocks[section] = Math.max(pulledClocks[section], remoteClocks[section])
              pulledAnything = true
            } else {
              mergedClocks[section] = localClocks[section]
            }
          }
          if (pulledAnything) await chrome.storage.local.set({ [SETTINGS_PULLED_KEY]: pulledClocks })

          // Carry the winning side's clock for each section, so the next merge
          // on this or any other machine compares against the right moment.
          mergedSettings.sectionUpdatedAt = mergedClocks
          mergedSettings.updatedAt = newestSharedClock(mergedClocks)

          // Also force gamification daily goal back to 100 if it was broken by an old backup
          if (mergedSettings.gamification && mergedSettings.gamification.dailyGoalPoints < 100) {
            mergedSettings.gamification = { ...mergedSettings.gamification, dailyGoalPoints: 100 }
          }
          // The clocks above are the merge result, not a fresh user edit, so this
          // goes straight to storage: re-running change detection would restamp
          // every pulled section with "now". Auto-sync stays unscheduled too, or
          // the debounce timer would re-arm itself forever off its own writes.
          await persistSettings(mergedSettings, false)
          localSettings = mergedSettings
        }
      }
      await updateDriveFile(token, fileId, { version: 1, library, activityLog, settings: localSettings })
    } else {
      await createDriveFile(token, { version: 1, library, activityLog, settings: localSettings })
    }
    // Only record this activity snapshot as "synced" once the remote write has
    // actually succeeded. Doing this earlier (before the upload) would make the
    // next sync think this delta was already pushed if the upload above throws,
    // permanently dropping those points/reviews from ever reaching the cloud.
    await chrome.storage.local.set({ 'cxt_last_synced_activity_log': activityLog })
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

// Removes a stale/invalid cached token so the next sync (auto or manual)
// requests a fresh one instead of retrying with the same rejected token
// forever, which would otherwise look like a permanent auth failure.
async function invalidateToken(token: string): Promise<void> {
  await chrome.identity.removeCachedAuthToken({ token })
}

// Throws (rather than returning null/false) on any non-OK response so callers
// can't mistake "the request failed" for "there is no remote data yet" — that
// conflation previously caused a failed lookup/download to be treated as an
// empty Drive, which either duplicated the remote file or blindly overwrote
// it with an unmerged local snapshot.
async function assertDriveResponseOk(res: Response, token: string, action: string): Promise<void> {
  if (res.ok) return
  if (res.status === 401) {
    await invalidateToken(token)
    throw new Error(`Google sign-in expired while trying to ${action}. Please sync again to reconnect.`)
  }
  throw new Error(`Failed to ${action} (Google Drive returned ${res.status}).`)
}

async function downloadDriveFile(token: string, fileId: string): Promise<any> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  await assertDriveResponseOk(res, token, 'download your synced data')
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Your synced data on Google Drive looks corrupted. Sync was aborted to avoid overwriting it.')
  }
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
  await assertDriveResponseOk(res, token, 'look up your synced file')
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
  await assertDriveResponseOk(res, token, 'create your synced file')
}

async function updateDriveFile(token: string, fileId: string, data: any): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
  await assertDriveResponseOk(res, token, 'save your synced data')
}
