import type { Clock, NetworkMonitor, OutboxStorage, TimerHandle } from '../src/core/ports.js'
import type { OperationContext } from '../src/core/operation.js'
import { PermanentError } from '../src/core/errors.js'

/** Drains the microtask queue. Enough for handlers that resolve immediately. */
export async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve()
  }
}

/**
 * Lets queued work run to completion.
 *
 * Microtasks only, deliberately. Every async boundary in the core is a promise
 * — the only timers go through the injected Clock — so draining the microtask
 * queue is sufficient, and avoiding a real macrotask turn keeps a property run
 * of several hundred scenarios in the low seconds rather than the low minutes.
 */
export async function settle(): Promise<void> {
  await flush(40)
}

interface ScheduledTimer {
  id: number
  at: number
  fn: () => void
}

/**
 * Virtual time. Backoff windows are minutes long; a test suite that actually
 * waited them out would take hours, and one that shortened them would stop
 * testing the real policy.
 */
export class TestClock implements Clock {
  #now: number
  #timers: ScheduledTimer[] = []
  #sequence = 0

  constructor(start = 1_700_000_000_000) {
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.#sequence += 1
    const id = this.#sequence
    this.#timers.push({ id, at: this.#now + ms, fn })
    return id
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers = this.#timers.filter((timer) => timer.id !== handle)
  }

  get pendingTimers(): number {
    return this.#timers.length
  }

  /** Moves time forward, firing due timers in order and letting work settle. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms
    for (;;) {
      const due = this.#timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.#timers = this.#timers.filter((timer) => timer !== due)
      this.#now = Math.max(this.#now, due.at)
      due.fn()
      await settle()
    }
    this.#now = target
    await settle()
  }
}

export class TestNetwork implements NetworkMonitor {
  #online: boolean
  readonly #listeners = new Set<(online: boolean) => void>()

  constructor(online = true) {
    this.#online = online
  }

  isOnline(): boolean {
    return this.#online
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  setOnline(online: boolean): void {
    if (online === this.#online) return
    this.#online = online
    for (const listener of this.#listeners) listener(online)
  }
}

export class FaultyStorageError extends Error {
  override readonly name = 'FaultyStorageError'
}

export interface FaultPlan {
  /** Fail this many `setItem` calls, starting now. */
  failWrites?: number
  /** Corrupt the value written by the Nth `setItem` (0-based) instead of failing. */
  corruptWriteAt?: number
}

/**
 * Wraps a storage and injects the failures a real device produces: a full disk,
 * a write that lands as garbage, a process that dies between two writes.
 */
export class FaultyStorage implements OutboxStorage {
  #writes = 0
  #plan: FaultPlan = {}

  constructor(readonly inner: OutboxStorage) {}

  plan(plan: FaultPlan): void {
    this.#plan = plan
    this.#writes = 0
  }

  get writeCount(): number {
    return this.#writes
  }

  getItem(key: string): Promise<string | null> {
    return this.inner.getItem(key)
  }

  async setItem(key: string, value: string): Promise<void> {
    const index = this.#writes
    this.#writes += 1
    if (this.#plan.failWrites !== undefined && this.#plan.failWrites > 0) {
      this.#plan.failWrites -= 1
      throw new FaultyStorageError(`Injected write failure for ${key}`)
    }
    if (this.#plan.corruptWriteAt === index) {
      await this.inner.setItem(key, '{"v":1,"id":"trunc')
      return
    }
    await this.inner.setItem(key, value)
  }

  removeItem(key: string): Promise<void> {
    return this.inner.removeItem(key)
  }

  keys(): Promise<string[]> {
    return this.inner.keys()
  }
}

export interface ServerRequest {
  name: string
  variables: unknown
  idempotencyKey: string
  attempt: number
}

export class LostResponseError extends Error {
  override readonly name = 'LostResponseError'
}

/**
 * A server that behaves like a correct one: it honours `Idempotency-Key`, so
 * replaying a request it already committed returns the original result instead
 * of writing a second row. `received` records *every* request including
 * duplicates, which is what lets a test assert the difference between what was
 * sent and what was applied.
 */
export class FakeServer {
  readonly received: ServerRequest[] = []
  readonly rows = new Map<string, Record<string, unknown>>()
  readonly #committed = new Map<string, unknown>()
  #nextRowId = 1

  failNext = 0
  failPermanentlyNext = 0
  /** Commit the write, then throw — the classic lost-ACK case. */
  loseResponseNext = 0

  get appliedWrites(): number {
    return this.#committed.size
  }

  createRow = async (
    variables: { title: string; listId?: string },
    context: OperationContext,
  ): Promise<{ id: string; title: string }> => {
    return this.#apply('create', variables, context, () => {
      const id = `srv_${this.#nextRowId}`
      this.#nextRowId += 1
      this.rows.set(id, {
        id,
        title: variables.title,
        ...(variables.listId !== undefined ? { listId: variables.listId } : {}),
      })
      return { id, title: variables.title }
    })
  }

  updateRow = async (
    variables: { id: string; title: string },
    context: OperationContext,
  ): Promise<{ id: string; title: string }> => {
    return this.#apply('update', variables, context, () => {
      const row = this.rows.get(variables.id)
      if (!row) {
        throw new PermanentError(`No such row: ${variables.id}`)
      }
      row['title'] = variables.title
      return { id: variables.id, title: variables.title }
    })
  }

  deleteRow = async (
    variables: { id: string },
    context: OperationContext,
  ): Promise<{ id: string }> => {
    return this.#apply('delete', variables, context, () => {
      this.rows.delete(variables.id)
      return { id: variables.id }
    })
  }

  async #apply<T>(
    name: string,
    variables: unknown,
    context: OperationContext,
    commit: () => T,
  ): Promise<T> {
    this.received.push({
      name,
      variables: structuredClone(variables),
      idempotencyKey: context.idempotencyKey,
      attempt: context.attempt,
    })

    const already = this.#committed.get(context.idempotencyKey)
    if (already !== undefined) return already as T

    if (this.failPermanentlyNext > 0) {
      this.failPermanentlyNext -= 1
      throw new PermanentError('Unprocessable entity')
    }
    if (this.failNext > 0) {
      this.failNext -= 1
      throw new Error('Transient upstream failure')
    }

    const result = commit()
    this.#committed.set(context.idempotencyKey, result)

    if (this.loseResponseNext > 0) {
      this.loseResponseNext -= 1
      throw new LostResponseError('Committed, but the response never arrived')
    }
    return result
  }

  /** Requests actually delivered, ignoring retries of an already-committed key. */
  uniqueKeys(): string[] {
    return [...new Set(this.received.map((request) => request.idempotencyKey))]
  }
}

/** Deterministic PRNG so jitter is reproducible under property tests. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}
