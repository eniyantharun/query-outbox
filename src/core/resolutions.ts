import type { OutboxStorage } from './ports.js'

export interface Resolution {
  value: unknown
  result: unknown
}

const DEFAULT_CAPACITY = 500

/**
 * Remembers what each placeholder id turned into.
 *
 * This has to outlive the operation that produced it. A screen can still be
 * holding `ph_...` in component state long after the create synced — the list
 * only stops showing it once something refetches — and an edit made in that
 * window must still address the real row. So resolutions are persisted and
 * consulted at enqueue time, not just while a dependency is outstanding.
 *
 * Bounded by an LRU because it is otherwise unbounded growth in a long-lived
 * app; the oldest placeholders are the ones no UI can plausibly still hold.
 */
export class ResolutionStore {
  readonly #entries = new Map<string, Resolution>()
  readonly #storage: OutboxStorage
  readonly #key: string
  readonly #capacity: number

  constructor(storage: OutboxStorage, prefix: string, capacity: number = DEFAULT_CAPACITY) {
    this.#storage = storage
    this.#key = `${prefix}:resolved`
    this.#capacity = capacity
  }

  async hydrate(): Promise<void> {
    const raw = await this.#storage.getItem(this.#key)
    if (raw === null) return
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      for (const entry of parsed as Array<[string, Resolution]>) {
        if (Array.isArray(entry) && typeof entry[0] === 'string') {
          this.#entries.set(entry[0], entry[1])
        }
      }
    } catch {
      // A corrupt resolution map costs correctness of id rewriting, not
      // durability of the queue itself. Drop it rather than refusing to start.
      await this.#storage.removeItem(this.#key)
    }
  }

  get(placeholderId: string): Resolution | undefined {
    return this.#entries.get(placeholderId)
  }

  has(placeholderId: string): boolean {
    return this.#entries.has(placeholderId)
  }

  async set(placeholderId: string, resolution: Resolution): Promise<void> {
    this.#entries.delete(placeholderId)
    this.#entries.set(placeholderId, resolution)
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
    await this.#persist()
  }

  async clear(): Promise<void> {
    this.#entries.clear()
    await this.#storage.removeItem(this.#key)
  }

  get size(): number {
    return this.#entries.size
  }

  async #persist(): Promise<void> {
    await this.#storage.setItem(this.#key, JSON.stringify([...this.#entries.entries()]))
  }
}
