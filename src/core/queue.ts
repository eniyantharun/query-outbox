import type { StoredError } from './errors.js'
import type { OutboxStorage } from './ports.js'

export type OperationStatus = 'pending' | 'inflight' | 'dead'

export const RECORD_VERSION = 1 as const

export interface OperationRecord {
  v: typeof RECORD_VERSION
  id: string
  name: string
  variables: unknown
  placeholderId: string
  idempotencyKey: string
  status: OperationStatus
  /** Completed attempts. `0` means never sent. */
  attempt: number
  enqueuedAt: number
  nextAttemptAt: number
  dependsOn: string[]
  coalesceKey?: string
  lastError?: StoredError
}

export interface HydrationReport {
  loaded: number
  /** Unparseable or structurally invalid records, dropped from storage. */
  corrupt: number
  /** Records found mid-flight after a crash and returned to `pending`. */
  requeued: number
}

function isRecord(value: unknown): value is OperationRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<OperationRecord>
  return (
    candidate.v === RECORD_VERSION &&
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.placeholderId === 'string' &&
    typeof candidate.idempotencyKey === 'string' &&
    typeof candidate.attempt === 'number' &&
    typeof candidate.enqueuedAt === 'number' &&
    typeof candidate.nextAttemptAt === 'number' &&
    Array.isArray(candidate.dependsOn) &&
    (candidate.status === 'pending' ||
      candidate.status === 'inflight' ||
      candidate.status === 'dead')
  )
}

/**
 * The durable log.
 *
 * One storage key per record, so every state transition is a single write and
 * can never be torn across two keys. Ordering is recovered by sorting ids,
 * which are monotonic by construction (see `ids.ts`).
 *
 * An in-memory mirror backs the synchronous reads the scheduler and the React
 * bindings need; storage remains the source of truth across restarts.
 */
export class OutboxQueue {
  readonly #storage: OutboxStorage
  readonly #prefix: string
  readonly #records = new Map<string, OperationRecord>()

  constructor(storage: OutboxStorage, prefix: string) {
    this.#storage = storage
    this.#prefix = prefix
  }

  #key(id: string): string {
    return `${this.#prefix}:op:${id}`
  }

  #isOwnKey(key: string): boolean {
    return key.startsWith(`${this.#prefix}:op:`)
  }

  async hydrate(): Promise<HydrationReport> {
    const keys = (await this.#storage.keys()).filter((key) => this.#isOwnKey(key))
    const entries = await this.#readMany(keys)

    let corrupt = 0
    const doomed: string[] = []
    const requeuedRecords: OperationRecord[] = []

    for (const [key, raw] of entries) {
      if (raw === null) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        corrupt += 1
        doomed.push(key)
        continue
      }
      if (!isRecord(parsed)) {
        corrupt += 1
        doomed.push(key)
        continue
      }
      // A record left `inflight` means the process died after the request was
      // sent but before the outcome was recorded. We cannot know whether the
      // server applied it, so we replay: the idempotency key is what makes that
      // safe, and is the reason at-least-once delivery is acceptable here.
      if (parsed.status === 'inflight') {
        parsed.status = 'pending'
        requeuedRecords.push(parsed)
      }
      this.#records.set(parsed.id, parsed)
    }

    if (doomed.length > 0) await this.#removeMany(doomed)
    // Persist only the records we actually transitioned, so hydration costs
    // nothing on the overwhelmingly common clean-restart path.
    await Promise.all(requeuedRecords.map(async (record) => this.put(record)))

    return { loaded: this.#records.size, corrupt, requeued: requeuedRecords.length }
  }

  async #readMany(keys: string[]): Promise<Array<readonly [string, string | null]>> {
    if (keys.length === 0) return []
    if (this.#storage.multiGet) return this.#storage.multiGet(keys)
    return Promise.all(
      keys.map(async (key) => [key, await this.#storage.getItem(key)] as const),
    )
  }

  async #removeMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    if (this.#storage.multiRemove) {
      await this.#storage.multiRemove(keys)
      return
    }
    await Promise.all(keys.map(async (key) => this.#storage.removeItem(key)))
  }

  /** Sorted by id, which is enqueue order. */
  all(): OperationRecord[] {
    return [...this.#records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  get(id: string): OperationRecord | undefined {
    return this.#records.get(id)
  }

  has(id: string): boolean {
    return this.#records.has(id)
  }

  get size(): number {
    return this.#records.size
  }

  countByStatus(status: OperationStatus): number {
    let total = 0
    for (const record of this.#records.values()) if (record.status === status) total += 1
    return total
  }

  /** Durably writes the record. Resolves only once storage has accepted it. */
  async put(record: OperationRecord): Promise<void> {
    this.#records.set(record.id, record)
    await this.#storage.setItem(this.#key(record.id), JSON.stringify(record))
  }

  async remove(id: string): Promise<void> {
    this.#records.delete(id)
    await this.#storage.removeItem(this.#key(id))
  }

  async clear(): Promise<void> {
    const keys = [...this.#records.keys()].map((id) => this.#key(id))
    this.#records.clear()
    await this.#removeMany(keys)
  }
}
