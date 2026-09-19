import type { NetworkMonitor } from '../core/ports.js'

export interface NetInfoState {
  isConnected: boolean | null
  isInternetReachable?: boolean | null
}

/** The slice of @react-native-community/netinfo the outbox needs. */
export interface NetInfoLike {
  addEventListener(listener: (state: NetInfoState) => void): () => void
  fetch(): Promise<NetInfoState>
}

export interface NetInfoMonitorOptions {
  /**
   * Require `isInternetReachable` as well as `isConnected`.
   *
   * Default `true`. Being associated with a Wi-Fi network that has no working
   * uplink — a hotel portal, an ISP outage — reports `isConnected: true`, and
   * treating that as online means burning retry attempts against a network that
   * cannot deliver. `isInternetReachable` is `null` until NetInfo has probed,
   * which is treated as online so the queue is not stalled by a slow first check.
   */
  requireInternetReachable?: boolean
}

/**
 * React Native connectivity, and the reason a fresh RN app does not hit
 * TanStack Query issue #4170: without this wiring `onlineManager` never learns
 * the device went offline, so mutations reject instead of pausing.
 */
export function createNetInfoMonitor(
  netInfo: NetInfoLike,
  options: NetInfoMonitorOptions = {},
): NetworkMonitor {
  const requireReachable = options.requireInternetReachable ?? true

  const evaluate = (state: NetInfoState): boolean => {
    if (state.isConnected !== true) return false
    if (!requireReachable) return true
    return state.isInternetReachable !== false
  }

  // Assume online until told otherwise: a queue that refuses to start because
  // connectivity has not been probed yet is worse than one attempt that fails.
  let online = true
  netInfo
    .fetch()
    .then((state) => {
      online = evaluate(state)
    })
    .catch(() => undefined)

  return {
    isOnline: () => online,
    subscribe: (listener) =>
      netInfo.addEventListener((state) => {
        const next = evaluate(state)
        if (next === online) return
        online = next
        listener(next)
      }),
  }
}
