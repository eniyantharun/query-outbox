/**
 * The ports the core depends on. Nothing else.
 *
 * Everything platform-specific enters through one of these three interfaces,
 * which is what lets the entire queue run — and be crash-tested — in plain Node.
 */

/**
 * A key/value store that can enumerate its own keys.
 *
 * Enumeration is required rather than optional on purpose. It lets the queue
 * persist one record per key and rebuild its ordering by sorting ids at
 * startup, so every state transition is a *single* store write. A design with
 * a separate index key would need two writes per transition, and a crash
 * between them could strand a pointer to a record that was never written.
 */
export interface OutboxStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  keys(): Promise<string[]>
  /** Optional batch reads. The queue falls back to serial `getItem` calls. */
  multiGet?(keys: readonly string[]): Promise<Array<readonly [string, string | null]>>
  /** Optional batch removal. The queue falls back to serial `removeItem` calls. */
  multiRemove?(keys: readonly string[]): Promise<void>
}

export type TimerHandle = { readonly __timer: unique symbol } | number | object

/** Injected so tests can drive time deterministically instead of sleeping. */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export interface NetworkMonitor {
  isOnline(): boolean
  /** Returns an unsubscribe function. */
  subscribe(listener: (online: boolean) => void): () => void
}

/** Injected so jitter is reproducible under property tests. */
export type Random = () => number

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/** A monitor that reports permanent connectivity. Useful in tests and on servers. */
export const alwaysOnline: NetworkMonitor = {
  isOnline: () => true,
  subscribe: () => () => undefined,
}
