import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import { createOutbox } from 'query-outbox'
import { createNetInfoMonitor } from 'query-outbox/net/netinfo'
import { createAsyncStorage } from 'query-outbox/storage/async-storage'

import { operations } from './operations'

declare const __DEV__: boolean

export const outbox = createOutbox({
  operations,

  // One storage key per operation rather than a single blob, so Android's 6MB
  // per-key AsyncStorage ceiling applies per write, not to the whole queue.
  storage: createAsyncStorage(AsyncStorage),

  // `requireInternetReachable` defaults to true. Being associated with a Wi-Fi
  // network that has no working uplink — a hotel captive portal, an ISP outage
  // — reports `isConnected: true`, and sending into that only burns retries.
  network: createNetInfoMonitor(NetInfo),

  onEvent: (event) => {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[outbox]', event.type, event)
    }
  },
})
