import {
  onlineManager,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { defineOperation, type Operation, type OperationDefinition } from '../core/operation.js'
import type { EnqueueHandle, Outbox } from '../core/outbox.js'
import { useLatest, useOutbox } from '../react/index.js'

export interface OptimisticContext {
  queryClient: QueryClient
  /** The client-side id this operation will write under until the server answers. */
  placeholderId: string
}

export interface QueryOperationExtras<TVariables, TResult> {
  /**
   * Applies the operation's effect to the query cache before the server has
   * seen it. Return a function to undo it.
   *
   * It must be a pure function of `(variables, placeholderId)`, because it is
   * replayed from the persisted record after a cold start — that is what makes
   * queued writes still visible when the user reopens the app.
   */
  optimistic?: (variables: TVariables, context: OptimisticContext) => (() => void) | undefined
  /** Query keys to invalidate once the operation finally succeeds. */
  invalidates?: QueryKey[] | ((result: TResult, variables: TVariables) => QueryKey[])
  onSuccess?: (result: TResult, variables: TVariables, context: OptimisticContext) => void
  onError?: (error: unknown, variables: TVariables, context: OptimisticContext) => void
}

export interface QueryOperation<TVariables, TResult>
  extends Operation<TVariables, TResult>, QueryOperationExtras<TVariables, TResult> {}

/**
 * An operation that also knows how to reflect itself in the TanStack Query
 * cache. The cache concerns live here rather than in the core so that
 * `src/core` keeps its zero-dependency, zero-framework property.
 */
export function defineQueryOperation<TVariables, TResult>(
  definition: OperationDefinition<TVariables, TResult> &
    QueryOperationExtras<TVariables, TResult>,
): QueryOperation<TVariables, TResult> {
  const base = defineOperation(definition)
  return Object.assign(base, {
    ...(definition.optimistic ? { optimistic: definition.optimistic } : {}),
    ...(definition.invalidates ? { invalidates: definition.invalidates } : {}),
    ...(definition.onSuccess ? { onSuccess: definition.onSuccess } : {}),
    ...(definition.onError ? { onError: definition.onError } : {}),
  })
}

function invalidateFor<TVariables, TResult>(
  operation: QueryOperation<TVariables, TResult>,
  result: TResult,
  variables: TVariables,
  queryClient: QueryClient,
): void {
  const { invalidates } = operation
  if (!invalidates) return
  const keys = typeof invalidates === 'function' ? invalidates(result, variables) : invalidates
  for (const queryKey of keys) {
    void queryClient.invalidateQueries({ queryKey })
  }
}

export type OutboxMutationStatus = 'idle' | 'queued' | 'success' | 'error'

export interface UseOutboxMutationResult<TVariables, TResult> {
  /** Enqueues durably. Returns once the write is persisted, not once it is sent. */
  mutate: (variables: TVariables) => Promise<EnqueueHandle<TResult>>
  /** Enqueues and waits for the server to actually accept it. */
  mutateAsync: (variables: TVariables) => Promise<TResult>
  status: OutboxMutationStatus
  /** True between enqueue and final settlement, offline periods included. */
  isQueued: boolean
  isSuccess: boolean
  isError: boolean
  data: TResult | undefined
  error: unknown
  reset: () => void
}

/**
 * The durable counterpart to `useMutation`.
 *
 * The difference that matters: `useMutation` keeps a paused mutation in memory,
 * so closing the app loses it. Here the write is on disk before `mutate`
 * resolves, and the handler is looked up by name from the registry on the next
 * launch — which is why this never hits TanStack Query's `No mutationFn found`.
 */
export function useOutboxMutation<TVariables, TResult>(
  operation: QueryOperation<TVariables, TResult>,
): UseOutboxMutationResult<TVariables, TResult> {
  const outbox = useOutbox()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<OutboxMutationStatus>('idle')
  const [data, setData] = useState<TResult | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const latest = useLatest({ operation, queryClient, outbox })

  const enqueue = useCallback(
    async (variables: TVariables): Promise<EnqueueHandle<TResult>> => {
      const current = latest.current
      const handle = current.outbox.enqueue(current.operation, variables)

      const rollback = current.operation.optimistic?.(variables, {
        queryClient: current.queryClient,
        placeholderId: handle.placeholderId,
      })

      setStatus('queued')
      setError(undefined)

      handle.settled.then(
        (result) => {
          current.operation.onSuccess?.(result, variables, {
            queryClient: current.queryClient,
            placeholderId: handle.placeholderId,
          })
          invalidateFor(current.operation, result, variables, current.queryClient)
          if (!mounted.current) return
          setData(result)
          setStatus('success')
        },
        (settleError: unknown) => {
          // The operation was dead-lettered, so the optimistic row will never
          // become real. Undo it rather than leaving a ghost in the UI.
          rollback?.()
          current.operation.onError?.(settleError, variables, {
            queryClient: current.queryClient,
            placeholderId: handle.placeholderId,
          })
          if (!mounted.current) return
          setError(settleError)
          setStatus('error')
        },
      )

      // Resolving here, not on `settled`, is the whole point: the caller learns
      // the write is durable without waiting for connectivity.
      await handle.persisted
      return handle
    },
    [latest],
  )

  const mutateAsync = useCallback(
    async (variables: TVariables): Promise<TResult> => {
      const handle = await enqueue(variables)
      return handle.settled
    },
    [enqueue],
  )

  const reset = useCallback(() => {
    setStatus('idle')
    setData(undefined)
    setError(undefined)
  }, [])

  return useMemo(
    () => ({
      mutate: enqueue,
      mutateAsync,
      status,
      isQueued: status === 'queued',
      isSuccess: status === 'success',
      isError: status === 'error',
      data,
      error,
      reset,
    }),
    [enqueue, mutateAsync, status, data, error, reset],
  )
}

/**
 * Points TanStack Query's `onlineManager` at the outbox's connectivity source.
 *
 * On React Native `onlineManager` has no default event source, so without
 * wiring like this it believes the device is permanently online and mutations
 * reject instead of pausing — the behaviour reported as TanStack Query #4170.
 * Sharing one source also guarantees queries and the outbox never disagree
 * about whether the device is connected.
 */
export function useOnlineManagerSync(outbox: Outbox): void {
  useEffect(() => {
    onlineManager.setOnline(outbox.getSnapshot().online)
    onlineManager.setEventListener((setOnline) =>
      outbox.subscribe(() => {
        setOnline(outbox.getSnapshot().online)
      }),
    )
    // `onlineManager` is a process-wide singleton and offers no way to unset a
    // listener; installing another one replaces this. There is nothing to clean
    // up, and unsubscribing would leave TanStack Query blind to connectivity.
  }, [outbox])
}

export interface ReplayOptimisticOptions {
  operations: readonly QueryOperation<never, never>[]
}

/**
 * Re-applies the optimistic effect of every still-queued operation after a
 * cold start.
 *
 * Without this, reopening the app shows the server's state and the user's
 * unsent edits simply vanish from the screen until they sync — which reads as
 * data loss even though nothing was lost.
 */
export function useReplayOptimistic(options: ReplayOptimisticOptions): void {
  const outbox = useOutbox()
  const queryClient = useQueryClient()
  const latest = useLatest(options.operations)
  const replayed = useRef(false)

  useEffect(() => {
    if (replayed.current) return undefined
    let cancelled = false

    const run = (): void => {
      if (cancelled || replayed.current) return
      const records = outbox.list()
      if (records.length === 0 && outbox.getSnapshot().total === 0) return
      replayed.current = true

      const byName = new Map(latest.current.map((operation) => [operation.name, operation]))
      for (const record of records) {
        if (record.status === 'dead') continue
        const operation = byName.get(record.name)
        operation?.optimistic?.(record.variables as never, {
          queryClient,
          placeholderId: record.placeholderId,
        })
      }
    }

    run()
    const unsubscribe = outbox.subscribe(run)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [outbox, queryClient, latest])
}

export { onlineManager }
