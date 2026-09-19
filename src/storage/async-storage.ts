import type { OutboxStorage } from '../core/ports.js'

/**
 * The slice of @react-native-async-storage/async-storage the outbox needs.
 * Declared structurally so the package never imports it, which keeps it a
 * genuinely optional peer dependency for web consumers.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  getAllKeys(): Promise<readonly string[]>
  multiGet?(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>
  multiRemove?(keys: readonly string[]): Promise<void>
}

/**
 * React Native storage backed by AsyncStorage.
 *
 * `multiGet` is used when present, which is the difference between one bridge
 * round-trip and one per queued operation at startup.
 *
 * AsyncStorage has a 6MB per-key default on Android. The outbox stores one
 * record per key rather than a single blob, so that ceiling applies per
 * operation, not to the queue as a whole.
 */
export function createAsyncStorage(asyncStorage: AsyncStorageLike): OutboxStorage {
  const adapter: OutboxStorage = {
    getItem: (key) => asyncStorage.getItem(key),
    setItem: (key, value) => asyncStorage.setItem(key, value),
    removeItem: (key) => asyncStorage.removeItem(key),
    keys: async () => [...(await asyncStorage.getAllKeys())],
  }

  // Bound to the host object rather than destructured, so an implementation
  // that relies on `this` keeps working.
  const multiGet = asyncStorage.multiGet?.bind(asyncStorage)
  if (multiGet) {
    adapter.multiGet = async (keys) => [...(await multiGet(keys))]
  }
  const multiRemove = asyncStorage.multiRemove?.bind(asyncStorage)
  if (multiRemove) {
    adapter.multiRemove = async (keys) => {
      await multiRemove(keys)
    }
  }

  return adapter
}
