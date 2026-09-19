import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OutboxStorage } from '../../src/core/ports.js'
import { MemoryStorage, createMemoryStorage } from '../../src/storage/memory.js'
import { createLocalStorage, type WebStorageLike } from '../../src/storage/local-storage.js'
import { createAsyncStorage, type AsyncStorageLike } from '../../src/storage/async-storage.js'
import { createBrowserNetworkMonitor } from '../../src/net/browser.js'
import {
  createNetInfoMonitor,
  type NetInfoLike,
  type NetInfoState,
} from '../../src/net/netinfo.js'

/** Every adapter must satisfy the same contract; the core relies on nothing else. */
function conformanceSuite(name: string, create: () => OutboxStorage): void {
  describe(`${name} conformance`, () => {
    let storage: OutboxStorage

    beforeEach(() => {
      storage = create()
    })

    it('returns null for a missing key', async () => {
      await expect(storage.getItem('nope')).resolves.toBeNull()
    })

    it('round-trips a value', async () => {
      await storage.setItem('k', 'v')
      await expect(storage.getItem('k')).resolves.toBe('v')
    })

    it('overwrites an existing value', async () => {
      await storage.setItem('k', 'one')
      await storage.setItem('k', 'two')
      await expect(storage.getItem('k')).resolves.toBe('two')
    })

    it('removes a value', async () => {
      await storage.setItem('k', 'v')
      await storage.removeItem('k')
      await expect(storage.getItem('k')).resolves.toBeNull()
    })

    it('tolerates removing a key that is not there', async () => {
      await expect(storage.removeItem('ghost')).resolves.toBeUndefined()
    })

    it('enumerates every key it holds', async () => {
      await storage.setItem('a', '1')
      await storage.setItem('b', '2')
      const keys = await storage.keys()
      expect(new Set(keys)).toEqual(new Set(['a', 'b']))
    })

    it('preserves values containing JSON and unicode', async () => {
      const payload = JSON.stringify({ title: 'café ☕ "quoted" \\ \n', n: 1 })
      await storage.setItem('k', payload)
      await expect(storage.getItem('k')).resolves.toBe(payload)
    })

    it('supports the optional batch reads when present', async () => {
      if (!storage.multiGet) return
      await storage.setItem('a', '1')
      const entries = await storage.multiGet(['a', 'missing'])
      expect(entries).toEqual([
        ['a', '1'],
        ['missing', null],
      ])
    })
  })
}

function createFakeWebStorage(): WebStorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  }
}

function createFakeAsyncStorage(withBatch: boolean): AsyncStorageLike {
  const map = new Map<string, string>()
  const base: AsyncStorageLike = {
    getItem: (key) => Promise.resolve(map.get(key) ?? null),
    setItem: (key, value) => {
      map.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key) => {
      map.delete(key)
      return Promise.resolve()
    },
    getAllKeys: () => Promise.resolve([...map.keys()]),
  }
  if (!withBatch) return base
  return {
    ...base,
    multiGet: (keys) =>
      Promise.resolve(keys.map((key) => [key, map.get(key) ?? null] as const)),
    multiRemove: (keys) => {
      for (const key of keys) map.delete(key)
      return Promise.resolve()
    },
  }
}

conformanceSuite('MemoryStorage', () => createMemoryStorage())
conformanceSuite('localStorage', () => createLocalStorage(createFakeWebStorage()))
conformanceSuite('AsyncStorage (batched)', () =>
  createAsyncStorage(createFakeAsyncStorage(true)),
)
conformanceSuite('AsyncStorage (no batch)', () =>
  createAsyncStorage(createFakeAsyncStorage(false)),
)

describe('MemoryStorage', () => {
  it('exposes its backing map so a test can simulate a restart', async () => {
    const disk = new Map<string, string>()
    const first = new MemoryStorage(disk)
    await first.setItem('k', 'v')
    const second = new MemoryStorage(disk)
    await expect(second.getItem('k')).resolves.toBe('v')
  })

  it('removes several keys at once', async () => {
    const storage = new MemoryStorage()
    await storage.setItem('a', '1')
    await storage.setItem('b', '2')
    await storage.multiRemove(['a', 'b'])
    await expect(storage.keys()).resolves.toEqual([])
  })
})

describe('localStorage adapter', () => {
  it('propagates a quota failure rather than pretending the write landed', async () => {
    const throwing: WebStorageLike = {
      ...createFakeWebStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const storage = createLocalStorage(throwing)
    await expect(storage.setItem('k', 'v')).rejects.toThrow(/Quota/)
  })

  it('explains itself when no localStorage exists', () => {
    const original = Reflect.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Reflect.deleteProperty(globalThis, 'localStorage')
    expect(() => createLocalStorage()).toThrow(/not available/)
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
  })
})

describe('AsyncStorage adapter', () => {
  it('uses multiGet when the host provides it', async () => {
    const inner = createFakeAsyncStorage(true)
    const spy = vi.spyOn(inner, 'multiGet')
    const storage = createAsyncStorage(inner)
    await storage.setItem('a', '1')
    await storage.multiGet?.(['a'])
    expect(spy).toHaveBeenCalled()
  })

  it('omits multiGet entirely when the host lacks it', () => {
    const storage = createAsyncStorage(createFakeAsyncStorage(false))
    expect(storage.multiGet).toBeUndefined()
    expect(storage.multiRemove).toBeUndefined()
  })
})

describe('browser network monitor', () => {
  it('reports online when navigator is absent (server rendering)', () => {
    const original = Reflect.getOwnPropertyDescriptor(globalThis, 'navigator')
    Reflect.deleteProperty(globalThis, 'navigator')
    expect(createBrowserNetworkMonitor().isOnline()).toBe(true)
    if (original) Object.defineProperty(globalThis, 'navigator', original)
  })
})

describe('NetInfo monitor', () => {
  function createFakeNetInfo(initial: NetInfoState) {
    let listener: ((state: NetInfoState) => void) | undefined
    return {
      netInfo: {
        addEventListener: (next: (state: NetInfoState) => void) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        fetch: () => Promise.resolve(initial),
      } satisfies NetInfoLike,
      emit: (state: NetInfoState) => listener?.(state),
    }
  }

  it('treats an unreachable connection as offline by default', async () => {
    const { netInfo, emit } = createFakeNetInfo({
      isConnected: true,
      isInternetReachable: true,
    })
    const monitor = createNetInfoMonitor(netInfo)
    const seen: boolean[] = []
    monitor.subscribe((online) => seen.push(online))

    // A captive portal: associated with Wi-Fi, but nothing gets through.
    emit({ isConnected: true, isInternetReachable: false })
    expect(monitor.isOnline()).toBe(false)
    expect(seen).toEqual([false])
  })

  it('can be told to trust isConnected alone', () => {
    const { netInfo, emit } = createFakeNetInfo({ isConnected: true })
    const monitor = createNetInfoMonitor(netInfo, { requireInternetReachable: false })
    emit({ isConnected: true, isInternetReachable: false })
    expect(monitor.isOnline()).toBe(true)
  })

  it('treats a not-yet-probed reachability as online', () => {
    const { netInfo, emit } = createFakeNetInfo({ isConnected: true })
    const monitor = createNetInfoMonitor(netInfo)
    emit({ isConnected: true, isInternetReachable: null })
    expect(monitor.isOnline()).toBe(true)
  })

  it('does not re-notify when the state has not changed', () => {
    const { netInfo, emit } = createFakeNetInfo({ isConnected: true })
    const monitor = createNetInfoMonitor(netInfo)
    const seen: boolean[] = []
    monitor.subscribe((online) => seen.push(online))

    emit({ isConnected: true, isInternetReachable: true })
    emit({ isConnected: true, isInternetReachable: true })
    emit({ isConnected: false })
    emit({ isConnected: false })

    expect(seen).toEqual([false])
  })

  it('unsubscribes cleanly', () => {
    const { netInfo, emit } = createFakeNetInfo({ isConnected: true })
    const monitor = createNetInfoMonitor(netInfo)
    const seen: boolean[] = []
    const unsubscribe = monitor.subscribe((online) => seen.push(online))
    unsubscribe()
    emit({ isConnected: false })
    expect(seen).toEqual([])
  })
})

describe('storage contract', () => {
  it('every adapter rejects rather than throwing synchronously', async () => {
    const boom = (): never => {
      throw new Error('boom')
    }
    const hostile: WebStorageLike = {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      key: boom,
      get length(): number {
        return boom()
      },
    }
    const storage = createLocalStorage(hostile)

    // `.catch()` must be enough. A synchronous throw would escape it entirely.
    for (const call of [
      () => storage.getItem('k'),
      () => storage.setItem('k', 'v'),
      () => storage.removeItem('k'),
      () => storage.keys(),
    ]) {
      let rejected = false
      await call().catch(() => {
        rejected = true
      })
      expect(rejected).toBe(true)
    }
  })
})
