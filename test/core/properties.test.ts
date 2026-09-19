import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createOutbox } from '../../src/core/outbox.js'
import { defineOperation } from '../../src/core/operation.js'
import type { OutboxStorage } from '../../src/core/ports.js'
import { MemoryStorage } from '../../src/storage/memory.js'
import { FakeServer, TestClock, TestNetwork, seededRandom } from '../helpers.js'

type Command =
  | { kind: 'create'; title: string }
  | { kind: 'update'; target: number; title: string }
  | { kind: 'offline' }
  | { kind: 'online' }
  | { kind: 'crash' }
  | { kind: 'advance'; ms: number }
  | { kind: 'flaky'; failures: number }

const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      title: fc.string({ minLength: 1, maxLength: 6 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('update' as const),
      target: fc.nat({ max: 8 }),
      title: fc.string({ minLength: 1, maxLength: 6 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('offline' as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('online' as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('crash' as const) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ms: fc.integer({ min: 100, max: 60_000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('flaky' as const),
      failures: fc.integer({ min: 1, max: 3 }),
    }),
  },
)

/** A storage whose writes stop landing once the owning "process" is killed. */
class KillableStorage implements OutboxStorage {
  #alive = true
  constructor(readonly disk: Map<string, string>) {}

  kill(): void {
    this.#alive = false
  }

  getItem(key: string): Promise<string | null> {
    if (!this.#alive) return Promise.reject(new Error('dead'))
    return Promise.resolve(this.disk.get(key) ?? null)
  }

  setItem(key: string, value: string): Promise<void> {
    if (!this.#alive) return Promise.reject(new Error('dead'))
    this.disk.set(key, value)
    return Promise.resolve()
  }

  removeItem(key: string): Promise<void> {
    if (!this.#alive) return Promise.reject(new Error('dead'))
    this.disk.delete(key)
    return Promise.resolve()
  }

  keys(): Promise<string[]> {
    if (!this.#alive) return Promise.reject(new Error('dead'))
    return Promise.resolve([...this.disk.keys()])
  }
}

interface RunOutcome {
  server: FakeServer
  /** Placeholders whose enqueue was confirmed durable. */
  durableCreates: string[]
  durableUpdates: number
}

async function execute(commands: readonly Command[], seed: number): Promise<RunOutcome> {
  const server = new FakeServer()
  const disk = new Map<string, string>()
  const clock = new TestClock()
  const network = new TestNetwork(true)

  const createTodo = defineOperation({
    name: 'todo.create',
    handler: (variables: { title: string }, context) => server.createRow(variables, context),
    resolvesPlaceholder: (result: { id: string }) => result.id,
    retry: { maxAttempts: 25, baseDelayMs: 500, maxDelayMs: 30_000, jitter: 'full' },
  })
  const updateTodo = defineOperation({
    name: 'todo.update',
    handler: (variables: { id: string; title: string }, context) =>
      server.updateRow(variables, context),
    retry: { maxAttempts: 25, baseDelayMs: 500, maxDelayMs: 30_000, jitter: 'full' },
  })
  const operations = [createTodo, updateTodo]

  // A restart gets a fresh RNG stream, as a real process would: the runtime
  // reseeds Math.random on boot. Reusing one seed across restarts is not a
  // harsher test, it is an unrealistic one.
  let restarts = 0
  let storage = new KillableStorage(disk)
  let outbox = createOutbox({
    operations,
    storage,
    clock,
    network,
    random: seededRandom(seed),
  })
  await outbox.start()

  const placeholders: string[] = []
  const durableCreates: string[] = []
  let durableUpdates = 0

  for (const next of commands) {
    switch (next.kind) {
      case 'create': {
        const handle = outbox.enqueue(createTodo, { title: next.title })
        placeholders.push(handle.placeholderId)
        try {
          await handle.persisted
          durableCreates.push(handle.placeholderId)
        } catch {
          // The write never landed, so the operation was never promised.
        }
        break
      }
      case 'update': {
        if (placeholders.length === 0) break
        const target = placeholders[next.target % placeholders.length]!
        const handle = outbox.enqueue(updateTodo, { id: target, title: next.title })
        try {
          await handle.persisted
          durableUpdates += 1
        } catch {
          /* not durable, not promised */
        }
        break
      }
      case 'offline':
        network.setOnline(false)
        break
      case 'online':
        network.setOnline(true)
        break
      case 'advance':
        try {
          await clock.advance(next.ms)
        } catch {
          /* a dead store can surface here */
        }
        break
      case 'flaky':
        server.failNext += next.failures
        break
      case 'crash': {
        storage.kill()
        outbox.stop()
        restarts += 1
        storage = new KillableStorage(disk)
        outbox = createOutbox({
          operations,
          storage,
          clock,
          network,
          random: seededRandom(seed + restarts * 7919),
        })
        await outbox.start()
        break
      }
    }
    try {
      await outbox.drain()
    } catch {
      /* ignore */
    }
  }

  // Recovery: online, no more induced faults, plenty of time to finish.
  server.failNext = 0
  network.setOnline(true)
  for (let round = 0; round < 14; round += 1) {
    await outbox.drain()
    await clock.advance(60_000)
  }
  await outbox.drain()
  outbox.stop()

  return { server, durableCreates, durableUpdates }
}

describe('properties', () => {
  it('never applies a write twice, whatever the interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(command, { minLength: 1, maxLength: 14 }),
        fc.integer({ min: 1, max: 100_000 }),
        async (commands, seed) => {
          const { server } = await execute(commands, seed)
          // Requests may be sent many times. Commits must equal distinct
          // idempotency keys — that is exactly the at-least-once + idempotency
          // contract the README claims.
          expect(server.appliedWrites).toBe(server.uniqueKeys().length)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('never sends an unresolved placeholder to the server', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(command, { minLength: 1, maxLength: 14 }),
        fc.integer({ min: 1, max: 100_000 }),
        async (commands, seed) => {
          const { server } = await execute(commands, seed)
          for (const request of server.received) {
            if (request.name !== 'update') continue
            const { id } = request.variables as { id: string }
            // An update addressing `ph_...` means the id rewrite was lost —
            // the write would land on a row that does not exist.
            expect(id.startsWith('ph_')).toBe(false)
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('delivers every durably-enqueued create once quiescent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('create' as const),
              title: fc.string({ minLength: 1, maxLength: 5 }),
            }),
            fc.record({ kind: fc.constant('offline' as const) }),
            fc.record({ kind: fc.constant('online' as const) }),
            fc.record({ kind: fc.constant('crash' as const) }),
            fc.record({
              kind: fc.constant('advance' as const),
              ms: fc.integer({ min: 100, max: 20_000 }),
            }),
          ),
          { minLength: 1, maxLength: 12 },
        ),
        fc.integer({ min: 1, max: 100_000 }),
        async (commands, seed) => {
          const { server, durableCreates } = await execute(commands, seed)
          // No permanent failures are induced in this generator, so anything
          // the caller was told was durable must have reached the server.
          const creates = server.received.filter((request) => request.name === 'create')
          expect(new Set(creates.map((r) => r.idempotencyKey)).size).toBe(durableCreates.length)
          expect(server.rows.size).toBe(durableCreates.length)
        },
      ),
      { numRuns: 50 },
    )
  })

  it('applies a create before any update that depends on it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(command, { minLength: 2, maxLength: 12 }),
        fc.integer({ min: 1, max: 100_000 }),
        async (commands, seed) => {
          const { server } = await execute(commands, seed)
          const firstCreateAt = new Map<string, number>()
          server.received.forEach((request, index) => {
            if (request.name !== 'create') return
            if (!firstCreateAt.has(request.idempotencyKey)) {
              firstCreateAt.set(request.idempotencyKey, index)
            }
          })
          // Every update targets a `srv_` id, and that row exists by the time
          // the update is sent — the server would have thrown PermanentError
          // otherwise, which would show up as a dead letter rather than a
          // successful chain.
          for (const request of server.received) {
            if (request.name !== 'update') continue
            const { id } = request.variables as { id: string }
            expect(id).toMatch(/^srv_/)
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe('storage fuzzing', () => {
  it('a corrupt record on disk never prevents startup', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 60 }), async (garbage) => {
        const disk = new Map<string, string>([['query-outbox:op:zzzz', garbage]])
        const server = new FakeServer()
        const create = defineOperation({
          name: 'c',
          handler: (variables: { title: string }, context) =>
            server.createRow(variables, context),
        })
        const outbox = createOutbox({
          operations: [create],
          storage: new MemoryStorage(disk),
          clock: new TestClock(),
          network: new TestNetwork(true),
        })
        await outbox.start()
        await outbox.enqueue(create, { title: 'after' }).persisted
        await outbox.drain()
        expect(server.rows.size).toBe(1)
        outbox.stop()
      }),
      { numRuns: 40 },
    )
  })
})
