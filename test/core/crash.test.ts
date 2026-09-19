import { describe, expect, it } from 'vitest'

import { createOutbox } from '../../src/core/outbox.js'
import { defineOperation } from '../../src/core/operation.js'
import type { OutboxStorage } from '../../src/core/ports.js'
import { MemoryStorage } from '../../src/storage/memory.js'
import { FakeServer, TestClock, TestNetwork, seededRandom } from '../helpers.js'

/**
 * Storage that stops accepting writes once the process is declared dead.
 *
 * Killing the store rather than the Outbox object is what makes this a real
 * crash: any write the outbox believed it had made after the cut simply did not
 * happen, exactly as if the OS had reclaimed the process mid-`await`.
 */
class CrashableStorage implements OutboxStorage {
  #writes = 0
  #dead = false

  constructor(
    readonly raw: Map<string, string>,
    private readonly crashAtWrite: number | null,
  ) {}

  get crashed(): boolean {
    return this.#dead
  }

  get writes(): number {
    return this.#writes
  }

  #assertAlive(): void {
    if (this.#dead) throw new Error('process is gone')
  }

  getItem(key: string): Promise<string | null> {
    this.#assertAlive()
    return Promise.resolve(this.raw.get(key) ?? null)
  }

  setItem(key: string, value: string): Promise<void> {
    this.#assertAlive()
    this.#writes += 1
    if (this.crashAtWrite !== null && this.#writes > this.crashAtWrite) {
      this.#dead = true
      throw new Error('process is gone')
    }
    this.raw.set(key, value)
    return Promise.resolve()
  }

  removeItem(key: string): Promise<void> {
    this.#assertAlive()
    this.raw.delete(key)
    return Promise.resolve()
  }

  keys(): Promise<string[]> {
    this.#assertAlive()
    return Promise.resolve([...this.raw.keys()])
  }
}

interface Scenario {
  server: FakeServer
  disk: Map<string, string>
}

function makeOperations(server: FakeServer) {
  const createTodo = defineOperation({
    name: 'todo.create',
    handler: (variables: { title: string }, context) => server.createRow(variables, context),
    resolvesPlaceholder: (result: { id: string }) => result.id,
    retry: { maxAttempts: 20, baseDelayMs: 100, jitter: 'none' },
  })
  const updateTodo = defineOperation({
    name: 'todo.update',
    handler: (variables: { id: string; title: string }, context) =>
      server.updateRow(variables, context),
    retry: { maxAttempts: 20, baseDelayMs: 100, jitter: 'none' },
  })
  return { createTodo, updateTodo, operations: [createTodo, updateTodo] }
}

/**
 * Runs a create-then-edit chain, cutting power after exactly `crashAtWrite`
 * storage writes, then restarts on the same disk and lets it finish.
 */
async function runWithCrash(crashAtWrite: number | null): Promise<Scenario> {
  const server = new FakeServer()
  const disk = new Map<string, string>()
  const { createTodo, updateTodo, operations } = makeOperations(server)

  // ---- first boot, offline so both writes queue up before anything is sent
  {
    const storage = new CrashableStorage(disk, crashAtWrite)
    const clock = new TestClock()
    const network = new TestNetwork(false)
    const outbox = createOutbox({
      operations,
      storage,
      clock,
      network,
      random: seededRandom(5),
    })

    try {
      await outbox.start()
      const created = outbox.enqueue(createTodo, { title: 'Draft' })
      await created.persisted
      const edited = outbox.enqueue(updateTodo, {
        id: created.placeholderId,
        title: 'Final',
      })
      await edited.persisted

      network.setOnline(true)
      await outbox.drain()
      await clock.advance(1_000)
      await outbox.drain()
    } catch {
      // The crash surfaces as a rejection somewhere. That is the point.
    }
    outbox.stop()
  }

  // ---- second boot, healthy disk, same server
  {
    const storage = new MemoryStorage(disk)
    const clock = new TestClock()
    const network = new TestNetwork(true)
    const outbox = createOutbox({
      operations,
      storage,
      clock,
      network,
      random: seededRandom(5),
    })
    await outbox.start()
    await outbox.drain()
    for (let round = 0; round < 25; round += 1) {
      await clock.advance(5_000)
      await outbox.drain()
    }
    outbox.stop()
  }

  return { server, disk }
}

describe('crash recovery', () => {
  it('completes the chain when no crash occurs', async () => {
    const { server } = await runWithCrash(null)
    expect(server.rows.size).toBe(1)
    expect([...server.rows.values()][0]).toMatchObject({ title: 'Final' })
    expect(server.appliedWrites).toBe(2)
  })

  // 14 covers every write the happy path performs, so the cut lands at each
  // await point in turn: enqueue, in-flight transition, dependent rewrite,
  // resolution-map write, retry scheduling.
  const cutPoints = Array.from({ length: 14 }, (_, index) => index)

  it.each(cutPoints)('survives a crash after %i storage writes', async (crashAtWrite) => {
    const { server } = await runWithCrash(crashAtWrite)

    // Invariant 1: no duplicate application. Requests may have been sent more
    // than once; the server must never have committed the same logical write
    // twice, which is what the idempotency key buys.
    expect(server.appliedWrites).toBe(server.uniqueKeys().length)
    expect(server.rows.size).toBeLessThanOrEqual(1)

    // Invariant 2: no torn state. If the edit was applied then the create was
    // too, and the row carries the final title — never the draft, which would
    // mean the update outran the create.
    const applied = server.received.filter((request) => request.name === 'update')
    if (applied.length > 0 && server.rows.size === 1) {
      const row = [...server.rows.values()][0]
      expect(row).toMatchObject({ title: 'Final' })
    }

    // Invariant 3: an update never addresses a placeholder. If it does, the id
    // rewrite was lost across the restart and the server got a bogus row id.
    for (const request of server.received) {
      if (request.name !== 'update') continue
      const variables = request.variables as { id: string }
      expect(variables.id.startsWith('ph_')).toBe(false)
    }
  })

  it('replays an operation that was in flight when the process died', async () => {
    const server = new FakeServer()
    const disk = new Map<string, string>()
    const { createTodo, operations } = makeOperations(server)

    // Boot one: get the record to `inflight`, then die before the outcome lands.
    {
      const storage = new CrashableStorage(disk, 2)
      const outbox = createOutbox({
        operations,
        storage,
        clock: new TestClock(),
        network: new TestNetwork(true),
      })
      try {
        await outbox.start()
        await outbox.enqueue(createTodo, { title: 'Interrupted' }).persisted
        await outbox.drain()
      } catch {
        /* expected */
      }
      outbox.stop()
    }

    const persisted = [...disk.values()].find((raw) => raw.includes('todo.create'))
    expect(persisted).toBeDefined()

    // Boot two: the record must come back as `pending`, not be stranded.
    const outbox = createOutbox({
      operations,
      storage: new MemoryStorage(disk),
      clock: new TestClock(),
      network: new TestNetwork(true),
    })
    await outbox.start()
    await outbox.drain()

    expect(server.rows.size).toBe(1)
    expect(outbox.list()).toHaveLength(0)
    outbox.stop()
  })

  it('drops a corrupt record rather than refusing to start', async () => {
    const disk = new Map<string, string>()
    disk.set('query-outbox:op:aaaa', '{"v":1,"id":"aaa')
    disk.set('query-outbox:op:bbbb', JSON.stringify({ v: 2, id: 'bbbb' }))

    const server = new FakeServer()
    const { createTodo, operations } = makeOperations(server)
    const events: string[] = []
    const outbox = createOutbox({
      operations,
      storage: new MemoryStorage(disk),
      clock: new TestClock(),
      network: new TestNetwork(true),
      onEvent: (event) => {
        if (event.type === 'hydrated') events.push(`corrupt=${event.corrupt}`)
      },
    })

    await outbox.start()
    expect(events).toEqual(['corrupt=2'])
    expect(disk.has('query-outbox:op:aaaa')).toBe(false)

    // Still fully functional afterwards.
    await outbox.enqueue(createTodo, { title: 'Fine' }).persisted
    await outbox.drain()
    expect(server.rows.size).toBe(1)
    outbox.stop()
  })

  it('survives a corrupt resolution map without losing the queue', async () => {
    const disk = new Map<string, string>()
    disk.set('query-outbox:resolved', 'not json at all')

    const server = new FakeServer()
    const { createTodo, operations } = makeOperations(server)
    const outbox = createOutbox({
      operations,
      storage: new MemoryStorage(disk),
      clock: new TestClock(),
      network: new TestNetwork(true),
    })

    await outbox.start()
    await outbox.enqueue(createTodo, { title: 'Fine' }).persisted
    await outbox.drain()

    expect(server.rows.size).toBe(1)
    outbox.stop()
  })
})
