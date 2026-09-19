// LRU cache that survives the service worker being unloaded (Chrome does that
// after ~30s idle) by mirroring itself into chrome.storage.local.
//
// A Map iterates in insertion order, so re-inserting on access keeps the most
// recently used entry last; once over `max`, the first key is the least
// recently used and gets evicted.
//
// Call `await cache.ready()` once before the first get/set — get/set themselves
// stay synchronous so existing call sites don't have to become async.

const PERSIST_DELAY_MS = 2000

export class PersistentLru<V> {
  private map = new Map<string, V>()
  private loaded: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private storageKey: string, private max: number) {}

  ready(): Promise<void> {
    this.loaded ??= chrome.storage.local
      .get(this.storageKey)
      .then(r => {
        const saved = r[this.storageKey] as Array<[string, V]> | undefined
        // Anything cached while loading is newer than what was saved: keep it last.
        const fresh = [...this.map]
        this.map.clear()
        for (const [k, v] of saved ?? []) this.map.set(k, v)
        for (const [k, v] of fresh) this.map.set(k, v)
        this.evict()
      })
      .catch(() => {})
    return this.loaded
  }

  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    this.evict()
    this.timer ??= setTimeout(() => {
      this.timer = null
      chrome.storage.local.set({ [this.storageKey]: [...this.map] }).catch(() => {})
    }, PERSIST_DELAY_MS)
  }

  private evict(): void {
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string)
  }
}
