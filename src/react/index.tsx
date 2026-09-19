import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import type { Outbox, OutboxSnapshot } from '../core/outbox.js'
import type { OperationRecord } from '../core/queue.js'

const OutboxContext = createContext<Outbox | null>(null)

export interface OutboxProviderProps {
  outbox: Outbox
  children: ReactNode
  /**
   * Start the outbox on mount and stop it on unmount. Default `true`.
   *
   * Turn it off when something else owns the lifecycle — a React Native app
   * that wants the queue to keep draining while the tree is unmounted during a
   * navigation reset, for instance.
   */
  autoStart?: boolean
}

export function OutboxProvider({
  outbox,
  children,
  autoStart = true,
}: OutboxProviderProps): ReactNode {
  useEffect(() => {
    if (!autoStart) return undefined
    // `start()` is idempotent, which is what makes StrictMode's double-invoked
    // effects harmless here rather than something to work around.
    void outbox.start()
    return () => {
      outbox.stop()
    }
  }, [outbox, autoStart])

  return createElement(OutboxContext.Provider, { value: outbox }, children)
}

export function useOutbox(): Outbox {
  const outbox = useContext(OutboxContext)
  if (!outbox) {
    throw new Error('useOutbox must be used inside an <OutboxProvider>.')
  }
  return outbox
}

/**
 * Subscribes to the queue's aggregate state.
 *
 * The snapshot object is only replaced when something a consumer can observe
 * actually changed, so this is safe for `useSyncExternalStore` — returning a
 * fresh object each call would re-render on every tick.
 */
export function useOutboxStatus(): OutboxSnapshot {
  const outbox = useOutbox()
  return useSyncExternalStore(
    (listener) => outbox.subscribe(listener),
    () => outbox.getSnapshot(),
    () => outbox.getSnapshot(),
  )
}

export interface DeadLetterControls {
  deadLetters: readonly OperationRecord[]
  retry: (id: string) => Promise<void>
  discard: (id: string) => Promise<void>
}

/**
 * The operations that gave up, plus the two things a user can do about them.
 *
 * Surfacing this is the point of having a dead-letter queue at all: a write
 * that can never succeed should become a visible "couldn't save this" in the
 * UI, not an entry in a log nobody reads.
 */
export function useDeadLetters(): DeadLetterControls {
  const outbox = useOutbox()
  const snapshot = useOutboxStatus()

  const deadLetters = useMemo(
    () => outbox.getDeadLetters(),
    // Recomputed only when the snapshot identity changes, which is what keeps
    // this from returning a new array on every render.
    [outbox, snapshot],
  )

  return useMemo(
    () => ({
      deadLetters,
      retry: (id: string) => outbox.retryDeadLetter(id),
      discard: (id: string) => outbox.discardDeadLetter(id),
    }),
    [outbox, deadLetters],
  )
}

/** The queued operations, newest last. Useful for a debug screen. */
export function useOutboxRecords(): readonly OperationRecord[] {
  const outbox = useOutbox()
  const snapshot = useOutboxStatus()
  return useMemo(() => outbox.list(), [outbox, snapshot])
}

/** Keeps the latest value without re-subscribing effects that read it. */
export function useLatest<T>(value: T): { readonly current: T } {
  const box = useRef(value)
  box.current = value
  return box
}
