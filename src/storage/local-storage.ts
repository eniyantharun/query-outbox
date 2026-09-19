import type { OutboxStorage } from '../core/ports.js'

/** The subset of the Web Storage API the outbox uses. */
export interface WebStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

/**
 * `localStorage` (or `sessionStorage`) for React on the web.
 *
 * Writes are synchronous and can throw — Safari private mode and a full quota
 * both do. Those are surfaced as a rejected `persisted` promise rather than
 * swallowed, because a write the caller believes is durable but is not is worse
 * than a visible failure.
 */
export function createLocalStorage(storage?: WebStorageLike): OutboxStorage {
  const target = storage ?? resolveDefaultStorage()

  // Every method is `async` rather than returning `Promise.resolve(...)`, so a
  // synchronous throw from the Web Storage API becomes a rejected promise. An
  // OutboxStorage that throws synchronously would escape any caller that only
  // attached a `.catch()`, and a failed write must always be observable as one.
  //
  // require-await is disabled deliberately: the `async` keyword is doing error
  // conversion here, not awaiting anything, and that is the entire point.
  /* eslint-disable @typescript-eslint/require-await */
  return {
    async getItem(key) {
      return target.getItem(key)
    },
    async setItem(key, value) {
      target.setItem(key, value)
    },
    async removeItem(key) {
      target.removeItem(key)
    },
    async keys() {
      const keys: string[] = []
      for (let index = 0; index < target.length; index += 1) {
        const key = target.key(index)
        if (key !== null) keys.push(key)
      }
      return keys
    },
  }
  /* eslint-enable @typescript-eslint/require-await */
}

function resolveDefaultStorage(): WebStorageLike {
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error(
      'localStorage is not available here. Pass a storage explicitly, or use createMemoryStorage() on the server.',
    )
  }
  return globalThis.localStorage
}
