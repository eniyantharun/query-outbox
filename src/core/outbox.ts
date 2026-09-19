import { computeBackoff, resolveRetryPolicy } from './backoff.js'
import {
  DeadLetteredError,
  DependencyFailedError,
  NotSerializableError,
  QueueOverflowError,
  toStoredError,
  type StoredError,
} from './errors.js'
import { createIdFactory } from './ids.js'
import {
  OperationRegistry,
  type ErasedOperation,
  type Operation,
  type OperationContext,
} from './operation.js'
import {
  alwaysOnline,
  systemClock,
  type Clock,
  type NetworkMonitor,
  type OutboxStorage,
  type Random,
  type TimerHandle,
} from './ports.js'
import { OutboxQueue, RECORD_VERSION, type OperationRecord } from './queue.js'
import { collectPlaceholders, substitutePlaceholders } from './refs.js'
import { ResolutionStore } from './resolutions.js'

export type OutboxEvent =
  | { type: 'hydrated'; loaded: number; corrupt: number; requeued: number }
  | { type: 'enqueued'; id: string; name: string }
  | { type: 'coalesced'; id: string; name: string }
  | { type: 'started'; id: string; name: string; attempt: number }
  | { type: 'succeeded'; id: string; name: string; attempt: number }
  | {
      type: 'failed'
      id: string
      name: string
      attempt: number
      error: StoredError
      retryAt: number
    }
  | { type: 'paused'; id: string; name: string }
  | { type: 'dead-lettered'; id: string; name: string; error: StoredError }
  | { type: 'online-change'; online: boolean }
  | {
      type: 'storage-error'
      phase: 'transition' | 'settle'
      id: string
      error: StoredError
    }
  | { type: 'idle' }

export type OutboxStatus = 'idle' | 'syncing' | 'offline' | 'blocked'

export interface OutboxSnapshot {
  pending: number
  inflight: number
  dead: number
  total: number
  online: boolean
  isIdle: boolean
  status: OutboxStatus
}

export interface EnqueueHandle<TResult> {
  operationId: string
  /** Use this as the optimistic id. It is rewritten to the server id on success. */
  placeholderId: string
  /**
   * Resolves once the operation is durably stored — the point after which a
   * crash can no longer lose it. This is the boundary `useOutboxMutation`
   * awaits before reporting the write as accepted.
   */
  persisted: Promise<void>
  /** Resolves when the operation finally succeeds; rejects if dead-lettered. */
  settled: Promise<TResult>
}

export interface OutboxOptions {
  operations: readonly ErasedOperation[]
  storage: OutboxStorage
  network?: NetworkMonitor
  clock?: Clock
  random?: Random
  /** Namespaces storage keys. Change it to run isolated outboxes side by side. */
  prefix?: string
  /** Independent chains processed at once. Chains themselves stay serial. */
  concurrency?: number
  maxQueueSize?: number
  onEvent?: (event: OutboxEvent) => void
}

const DEFAULT_PREFIX = 'query-outbox'
const DEFAULT_CONCURRENCY = 4
const DEFAULT_MAX_QUEUE_SIZE = 1_000

export class Outbox {
  readonly #registry: OperationRegistry
  readonly #queue: OutboxQueue
  readonly #resolutions: ResolutionStore
  readonly #network: NetworkMonitor
  readonly #clock: Clock
  readonly #random: Random
  readonly #nextId: () => string
  readonly #concurrency: number
  readonly #maxQueueSize: number
  readonly #onEvent: ((event: OutboxEvent) => void) | undefined

  readonly #running = new Set<string>()
  readonly #settlers = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  readonly #listeners = new Set<() => void>()
  /** Maps a placeholder to the operation that will produce its real value. */
  readonly #owners = new Map<string, string>()

  #abort = new AbortController()
  #timer: TimerHandle | undefined
  #unsubscribeNetwork: (() => void) | undefined
  #started = false
  #stopped = false
  #snapshot: OutboxSnapshot
  #idleWaiters: Array<() => void> = []

  constructor(options: OutboxOptions) {
    this.#registry = new OperationRegistry(options.operations)
    this.#clock = options.clock ?? systemClock
    this.#random = options.random ?? Math.random
    this.#network = options.network ?? alwaysOnline
    this.#nextId = createIdFactory(this.#clock, this.#random)
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    this.#maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
    this.#onEvent = options.onEvent

    const prefix = options.prefix ?? DEFAULT_PREFIX
    this.#queue = new OutboxQueue(options.storage, prefix)
    this.#resolutions = new ResolutionStore(options.storage, prefix)
    this.#snapshot = this.#computeSnapshot()
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.#started) return
    this.#stopped = false

    await this.#resolutions.hydrate()
    const report = await this.#queue.hydrate()

    for (const record of this.#queue.all()) {
      this.#owners.set(record.placeholderId, record.id)
    }

    this.#started = true
    this.#emit({ type: 'hydrated', ...report })

    this.#unsubscribeNetwork = this.#network.subscribe((online) => {
      this.#emit({ type: 'online-change', online })
      this.#refresh()
      this.#pump()
    })

    this.#refresh()
    this.#pump()
  }

  /**
   * Stops scheduling and aborts in-flight handlers. Nothing is lost: every
   * record is already durable, and anything mid-flight is replayed on restart
   * behind its idempotency key.
   */
  stop(): void {
    this.#stopped = true
    this.#started = false
    this.#clearTimer()
    this.#unsubscribeNetwork?.()
    this.#unsubscribeNetwork = undefined
    this.#abort.abort()
    this.#abort = new AbortController()
  }

  // ------------------------------------------------------------------ enqueue

  enqueue<TVariables, TResult>(
    operation: Operation<TVariables, TResult>,
    variables: TVariables,
  ): EnqueueHandle<TResult> {
    const definition = this.#registry.get(operation.name)

    // Resolve any placeholder that is already known, so an edit made against a
    // stale optimistic id addresses the real row rather than deriving a
    // dependency on an operation that has long since completed.
    const resolved = substitutePlaceholders(variables, (id) => this.#resolutions.get(id))

    try {
      JSON.stringify(resolved)
    } catch (error) {
      throw new NotSerializableError(operation.name, error)
    }

    const merged = this.#tryCoalesce(definition, resolved)
    if (merged) return merged as EnqueueHandle<TResult>

    if (this.#queue.size >= this.#maxQueueSize) {
      throw new QueueOverflowError(this.#maxQueueSize)
    }

    const id = this.#nextId()
    const placeholderId = `ph_${id}`
    const now = this.#clock.now()

    const dependsOn = [
      ...collectPlaceholders(resolved, (candidate) => this.#owners.has(candidate)),
    ]
      .map((placeholder) => this.#owners.get(placeholder))
      .filter((ownerId): ownerId is string => ownerId !== undefined)

    const coalesceKey = definition.coalesce?.key(resolved as never)

    const record: OperationRecord = {
      v: RECORD_VERSION,
      id,
      name: operation.name,
      variables: resolved,
      placeholderId,
      idempotencyKey: `ik_${id}`,
      status: 'pending',
      attempt: 0,
      enqueuedAt: now,
      nextAttemptAt: now,
      dependsOn: [...new Set(dependsOn)],
      ...(coalesceKey === undefined ? {} : { coalesceKey }),
    }

    this.#owners.set(placeholderId, id)

    const settled = new Promise<TResult>((resolve, reject) => {
      this.#settlers.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
    // Nothing observes `settled` until the caller does; keep Node quiet until then.
    settled.catch(() => undefined)

    const persisted = this.#queue.put(record).then(() => {
      this.#emit({ type: 'enqueued', id, name: operation.name })
      this.#refresh()
      this.#pump()
    })

    return { operationId: id, placeholderId, persisted, settled }
  }

  #tryCoalesce(
    definition: ErasedOperation,
    variables: unknown,
  ): EnqueueHandle<unknown> | undefined {
    if (!definition.coalesce) return undefined
    const key = definition.coalesce.key(variables as never)
    if (key === undefined) return undefined

    // Only ever merge into an operation that has never been sent. Once a
    // request has left the device we cannot know whether the server applied it,
    // and rewriting its body would change what that idempotency key means.
    const target = this.#queue
      .all()
      .find(
        (record) =>
          record.name === definition.name &&
          record.coalesceKey === key &&
          record.status === 'pending' &&
          record.attempt === 0 &&
          !this.#running.has(record.id),
      )
    if (!target) return undefined

    target.variables = definition.coalesce.merge(target.variables as never, variables as never)

    const previous = this.#settlers.get(target.id)
    const settled = new Promise<unknown>((resolve, reject) => {
      this.#settlers.set(target.id, {
        resolve: (value) => {
          previous?.resolve(value)
          resolve(value)
        },
        reject: (error) => {
          previous?.reject(error)
          // Whatever the handler threw is forwarded unchanged. JavaScript does
          // not require a thrown value to be an Error, and rewrapping would
          // hide the caller's own error type from them.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error)
        },
      })
    })
    settled.catch(() => undefined)

    const persisted = this.#queue.put(target).then(() => {
      this.#emit({ type: 'coalesced', id: target.id, name: target.name })
      this.#refresh()
      this.#pump()
    })

    return {
      operationId: target.id,
      placeholderId: target.placeholderId,
      persisted,
      settled,
    }
  }

  // --------------------------------------------------------------- scheduling

  #pump(): void {
    if (!this.#started || this.#stopped) {
      this.#settleIdleWaitersIfQuiet()
      return
    }
    if (!this.#network.isOnline()) {
      this.#settleIdleWaitersIfQuiet()
      return
    }

    const now = this.#clock.now()
    let slots = this.#concurrency - this.#running.size
    let nextWake = Number.POSITIVE_INFINITY

    for (const record of this.#queue.all()) {
      if (record.status !== 'pending') continue
      if (this.#running.has(record.id)) continue
      if (!this.#dependenciesSatisfied(record)) continue
      if (record.nextAttemptAt > now) {
        nextWake = Math.min(nextWake, record.nextAttemptAt)
        continue
      }
      if (slots <= 0) break
      slots -= 1
      // #run is total by construction; the catch is here so that a future edit
      // to it can never turn a queued write into an unhandled rejection.
      void this.#run(record).catch(() => undefined)
    }

    this.#clearTimer()
    if (Number.isFinite(nextWake)) {
      this.#timer = this.#clock.setTimeout(
        () => {
          this.#timer = undefined
          this.#pump()
        },
        Math.max(0, nextWake - now),
      )
    }

    this.#settleIdleWaitersIfQuiet()
  }

  /**
   * A dependency counts as satisfied only once its record has left the queue,
   * which happens exactly on success. A dependency sitting in the queue as
   * `dead` therefore blocks — and is cascaded to its dependents rather than
   * being allowed to stall them forever.
   */
  #dependenciesSatisfied(record: OperationRecord): boolean {
    return record.dependsOn.every((id) => !this.#queue.has(id))
  }

  async #run(record: OperationRecord): Promise<void> {
    this.#running.add(record.id)
    const definition = this.#registry.get(record.name)

    record.status = 'inflight'
    record.attempt += 1
    try {
      await this.#queue.put(record)
    } catch (error) {
      // Storage refused the transition, so we must not send a request we could
      // not record having sent. Roll back, and back off *in memory* before
      // trying again: the write failed, so there is nothing to persist, and
      // leaving the record immediately-due would spin the scheduler against a
      // failing store — or, if nothing else ever woke it, stall the queue
      // outright until the next enqueue.
      const now = this.#clock.now()
      record.status = 'pending'
      record.attempt -= 1
      record.lastError = toStoredError(error, now)
      record.nextAttemptAt =
        now + computeBackoff(1, resolveRetryPolicy(definition.retry), this.#random)
      this.#running.delete(record.id)
      this.#emit({
        type: 'storage-error',
        phase: 'transition',
        id: record.id,
        error: record.lastError,
      })
      this.#refresh()
      this.#pump()
      return
    }

    this.#emit({ type: 'started', id: record.id, name: record.name, attempt: record.attempt })
    this.#refresh()

    const context: OperationContext = {
      operationId: record.id,
      placeholderId: record.placeholderId,
      idempotencyKey: record.idempotencyKey,
      attempt: record.attempt,
      enqueuedAt: record.enqueuedAt,
      signal: this.#abort.signal,
    }

    let result: unknown
    let handlerError: unknown
    let succeeded = false
    try {
      const variables = substitutePlaceholders(record.variables, (id) =>
        this.#resolutions.get(id),
      )
      result = await definition.handler(variables as never, context)
      succeeded = true
    } catch (error) {
      handlerError = error
    }

    try {
      if (succeeded) {
        await this.#onSuccess(record, definition, result)
      } else {
        await this.#onFailure(record, definition, handlerError)
      }
    } catch (bookkeepingError) {
      // Storage refused a write while we were recording the outcome. There is
      // nothing useful to do here and nothing is lost: the record is still on
      // disk in whatever state it last reached, and hydration reconciles it on
      // the next boot. What must not happen is an unhandled rejection — in
      // React Native that surfaces as a redbox, and on Node it is fatal under
      // --unhandled-rejections=strict.
      this.#emit({
        type: 'storage-error',
        phase: 'settle',
        id: record.id,
        error: toStoredError(bookkeepingError, this.#clock.now()),
      })
    }

    this.#running.delete(record.id)
    this.#refresh()
    this.#pump()
  }

  async #onSuccess(
    record: OperationRecord,
    definition: ErasedOperation,
    result: unknown,
  ): Promise<void> {
    const value = definition.resolvesPlaceholder?.(result as never)

    // Order matters and is load-bearing. Dependents are rewritten and persisted
    // *before* the completed record is removed. If the process dies in between,
    // this operation is simply replayed — the idempotency key makes that a
    // no-op on the server, and the substitution below is itself idempotent.
    // Removing first would leave dependents with their dependency gone and an
    // unresolved placeholder still in their variables, and they would be sent
    // addressing an id that does not exist.
    if (value !== undefined) {
      await this.#resolutions.set(record.placeholderId, { value, result })
      await this.#substituteIntoDependents(record.id)
    } else {
      await this.#releaseDependents(record.id)
    }

    await this.#queue.remove(record.id)
    this.#owners.delete(record.placeholderId)

    this.#emit({ type: 'succeeded', id: record.id, name: record.name, attempt: record.attempt })
    this.#settlers.get(record.id)?.resolve(result)
    this.#settlers.delete(record.id)
  }

  async #substituteIntoDependents(dependencyId: string): Promise<void> {
    const dependents = this.#queue.all().filter((r) => r.dependsOn.includes(dependencyId))
    for (const dependent of dependents) {
      dependent.variables = substitutePlaceholders(dependent.variables, (id) =>
        this.#resolutions.get(id),
      )
      dependent.dependsOn = dependent.dependsOn.filter((id) => id !== dependencyId)
      await this.#queue.put(dependent)
    }
  }

  async #releaseDependents(dependencyId: string): Promise<void> {
    const dependents = this.#queue.all().filter((r) => r.dependsOn.includes(dependencyId))
    for (const dependent of dependents) {
      dependent.dependsOn = dependent.dependsOn.filter((id) => id !== dependencyId)
      await this.#queue.put(dependent)
    }
  }

  async #onFailure(
    record: OperationRecord,
    definition: ErasedOperation,
    error: unknown,
  ): Promise<void> {
    const now = this.#clock.now()
    const stored = toStoredError(error, now)
    record.lastError = stored

    // Losing connectivity mid-request is not the operation's fault, so it must
    // not consume an attempt. Otherwise a commuter going through a tunnel
    // exhausts the retry budget of every queued write and they all dead-letter
    // on arrival. This is the durable equivalent of TanStack Query's `paused`.
    if (!this.#network.isOnline()) {
      record.attempt -= 1
      record.status = 'pending'
      record.nextAttemptAt = now
      await this.#queue.put(record)
      this.#emit({ type: 'paused', id: record.id, name: record.name })
      return
    }

    const disposition =
      definition.classifyError?.(error) ?? (isPermanentError(error) ? 'fail' : 'retry')
    const policy = resolveRetryPolicy(definition.retry)

    if (disposition === 'fail' || record.attempt >= policy.maxAttempts) {
      await this.#deadLetter(record, stored)
      return
    }

    const delay = computeBackoff(record.attempt, policy, this.#random, retryAfterOf(error))
    record.status = 'pending'
    record.nextAttemptAt = now + delay
    await this.#queue.put(record)

    this.#emit({
      type: 'failed',
      id: record.id,
      name: record.name,
      attempt: record.attempt,
      error: stored,
      retryAt: record.nextAttemptAt,
    })
  }

  async #deadLetter(record: OperationRecord, error: StoredError): Promise<void> {
    record.status = 'dead'
    record.lastError = error
    await this.#queue.put(record)
    this.#emit({ type: 'dead-lettered', id: record.id, name: record.name, error })

    this.#settlers.get(record.id)?.reject(new DeadLetteredError(record.id, record.name, error))
    this.#settlers.delete(record.id)

    // A child of an operation that will never exist can itself never succeed.
    // Failing it now surfaces the whole broken chain at once instead of leaking
    // one dead-letter per retry cycle as each child exhausts its own budget.
    await this.#cascade(record.id)
  }

  async #cascade(failedId: string): Promise<void> {
    const dependents = this.#queue
      .all()
      .filter((r) => r.status !== 'dead' && r.dependsOn.includes(failedId))

    for (const dependent of dependents) {
      const reason = toStoredError(new DependencyFailedError(failedId), this.#clock.now())
      dependent.status = 'dead'
      dependent.lastError = reason
      await this.#queue.put(dependent)
      this.#emit({
        type: 'dead-lettered',
        id: dependent.id,
        name: dependent.name,
        error: reason,
      })
      this.#settlers
        .get(dependent.id)
        ?.reject(new DeadLetteredError(dependent.id, dependent.name, reason))
      this.#settlers.delete(dependent.id)
      await this.#cascade(dependent.id)
    }
  }

  // -------------------------------------------------------------- dead letters

  getDeadLetters(): readonly OperationRecord[] {
    return this.#queue.all().filter((record) => record.status === 'dead')
  }

  /** Returns a dead-lettered operation to the queue with a fresh attempt budget. */
  async retryDeadLetter(id: string): Promise<void> {
    const record = this.#queue.get(id)
    if (!record || record.status !== 'dead') return
    record.status = 'pending'
    record.attempt = 0
    record.nextAttemptAt = this.#clock.now()
    delete record.lastError
    await this.#queue.put(record)
    this.#refresh()
    this.#pump()
  }

  async discardDeadLetter(id: string): Promise<void> {
    const record = this.#queue.get(id)
    if (!record || record.status !== 'dead') return
    await this.#queue.remove(id)
    this.#owners.delete(record.placeholderId)
    await this.#cascade(id)
    this.#refresh()
    this.#pump()
  }

  // --------------------------------------------------------------- inspection

  getSnapshot(): OutboxSnapshot {
    return this.#snapshot
  }

  list(): readonly OperationRecord[] {
    return this.#queue.all()
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Resolves when nothing is runnable — everything has succeeded, is waiting on
   * a backoff timer, or is dead. Primarily a testing affordance.
   */
  async drain(): Promise<void> {
    if (this.#isQuiet()) return
    await new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve)
    })
  }

  async clear(): Promise<void> {
    await this.#queue.clear()
    await this.#resolutions.clear()
    this.#owners.clear()
    this.#settlers.clear()
    this.#refresh()
  }

  // ----------------------------------------------------------------- internals

  #isQuiet(): boolean {
    if (this.#running.size > 0) return false
    if (!this.#network.isOnline()) return true
    const now = this.#clock.now()
    return !this.#queue
      .all()
      .some(
        (record) =>
          record.status === 'pending' &&
          record.nextAttemptAt <= now &&
          this.#dependenciesSatisfied(record),
      )
  }

  #settleIdleWaitersIfQuiet(): void {
    if (this.#idleWaiters.length === 0 || !this.#isQuiet()) return
    const waiters = this.#idleWaiters
    this.#idleWaiters = []
    for (const resolve of waiters) resolve()
    this.#emit({ type: 'idle' })
  }

  #computeSnapshot(): OutboxSnapshot {
    const pending = this.#queue.countByStatus('pending')
    const inflight = this.#running.size
    const dead = this.#queue.countByStatus('dead')
    const online = this.#network.isOnline()
    const isIdle = pending === 0 && inflight === 0

    let status: OutboxStatus
    if (!online && pending > 0) status = 'offline'
    else if (inflight > 0 || (online && pending > 0)) status = 'syncing'
    else if (dead > 0) status = 'blocked'
    else status = 'idle'

    return { pending, inflight, dead, total: this.#queue.size, online, isIdle, status }
  }

  #refresh(): void {
    const next = this.#computeSnapshot()
    const previous = this.#snapshot
    const changed =
      next.pending !== previous.pending ||
      next.inflight !== previous.inflight ||
      next.dead !== previous.dead ||
      next.total !== previous.total ||
      next.online !== previous.online ||
      next.status !== previous.status
    if (!changed) return
    this.#snapshot = next
    for (const listener of this.#listeners) listener()
  }

  #emit(event: OutboxEvent): void {
    this.#onEvent?.(event)
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }
}

function isPermanentError(error: unknown): boolean {
  return error instanceof Error && error.name === 'PermanentError'
}

function retryAfterOf(error: unknown): number | undefined {
  if (error instanceof Error && error.name === 'RetryableError') {
    const candidate = (error as { retryAfterMs?: unknown }).retryAfterMs
    return typeof candidate === 'number' ? candidate : undefined
  }
  return undefined
}

export function createOutbox(options: OutboxOptions): Outbox {
  return new Outbox(options)
}
