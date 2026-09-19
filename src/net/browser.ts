import type { NetworkMonitor } from '../core/ports.js'

/**
 * `navigator.onLine` plus the online/offline events.
 *
 * Worth knowing the limit: the browser reports whether an interface exists, not
 * whether anything is reachable. Captive portals and dead uplinks read as
 * online. The outbox tolerates that — a request that fails while `isOnline()`
 * is true simply retries with backoff — but it is why connectivity is a port
 * rather than something the core assumes it can trust.
 */
export function createBrowserNetworkMonitor(): NetworkMonitor {
  return {
    isOnline: () =>
      typeof globalThis.navigator === 'undefined' ? true : globalThis.navigator.onLine,
    subscribe: (listener) => {
      if (typeof globalThis.addEventListener === 'undefined') return () => undefined
      const goOnline = (): void => {
        listener(true)
      }
      const goOffline = (): void => {
        listener(false)
      }
      globalThis.addEventListener('online', goOnline)
      globalThis.addEventListener('offline', goOffline)
      return () => {
        globalThis.removeEventListener('online', goOnline)
        globalThis.removeEventListener('offline', goOffline)
      }
    },
  }
}
