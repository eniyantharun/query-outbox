import type { OutboxStorage } from '../core/ports.js'

/**
 * In-memory storage. Durable for exactly as long as the process lives, which
 * makes it the right default for tests and for the crash simulation — the
 * harness keeps the Map and builds a fresh Outbox around it to model a restart.
 */
export class MemoryStorage implements OutboxStorage {
  readonly #map: Map<string, string>

  constructor(initial?: Map<string, string>) {
    this.#map = initial ?? new Map<string, string>()
  }

  /** The backing store, so a test can survive it across a simulated restart. */
  get raw(): Map<string, string> {
    return this.#map
  }

  getItem(key: string): Promise<string | null> {
    return Promise.resolve(this.#map.get(key) ?? null)
  }

  setItem(key: string, value: string): Promise<void> {
    this.#map.set(key, value)
    return Promise.resolve()
  }

  removeItem(key: string): Promise<void> {
    this.#map.delete(key)
    return Promise.resolve()
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.#map.keys()])
  }

  multiGet(keys: readonly string[]): Promise<Array<readonly [string, string | null]>> {
    return Promise.resolve(keys.map((key) => [key, this.#map.get(key) ?? null] as const))
  }

  multiRemove(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.#map.delete(key)
    return Promise.resolve()
  }
}

export function createMemoryStorage(initial?: Map<string, string>): MemoryStorage {
  return new MemoryStorage(initial)
}
