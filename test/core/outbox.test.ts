import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOutbox, type Outbox, type OutboxEvent } from '../../src/core/outbox.js'
import { defineOperation } from '../../src/core/operation.js'
import { PermanentError, RetryableError } from '../../src/core/errors.js'
import { ref } from '../../src/core/refs.js'
import { MemoryStorage } from '../../src/storage/memory.js'
import type { OutboxStorage } from '../../src/core/ports.js'
import { FakeServer, TestClock, TestNetwork, seededRandom, settle } from '../helpers.js'

let server: FakeServer
let clock: TestClock
let network: TestNetwork
let storage: MemoryStorage
let events: OutboxEvent[]

const createTodo = defineOperation({
  name: 'todo.create',
  handler: (variables: { title: string }, context) => server.createRow(variables, context),
  resolvesPlaceholder: (result: { id: string }) => result.id,
})

const updateTodo = defineOperation({
  name: 'todo.update',
  handler: (variables: { id: string; title: string }, context) =>
    server.updateRow(variables, context),
})

const deleteTodo = defineOperation({
  name: 'todo.delete',
  handler: (variables: { id: string }, context) => server.deleteRow(variables, context),
})

const operations = [createTodo, updateTodo, deleteTodo]

function build(overrides: Partial<Parameters<typeof createOutbox>[0]> = {}): Outbox {
  return createOutbox({
    operations,
    storage,
    clock,
    network,
    random: seededRandom(42),
    onEvent: (event) => events.push(event),
    ...overrides,
  })
}

beforeEach(() => {
  server = new FakeServer()
  clock = new TestClock()
  network = new TestNetwork(true)
  storage = new MemoryStorage()
  events = []
})

describe('durability', () => {
  it('does not resolve `persisted` until storage has accepted the write', async () => {
    // MemoryStorage commits synchronously, which cannot demonstrate the
    // boundary. Gate the write so the two moments are distinguishable.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = new MemoryStorage()
    const gated: OutboxStorage = {
      getItem: (key) => inner.getItem(key),
      removeItem: (key) => inner.removeItem(key),
      keys: () => inner.keys(),
      setItem: async (key, value) => {
        await gate
        await inner.setItem(key, value)
      },
    }

    const outbox = createOutbox({ operations, storage: gated, clock, network })
    await outbox.start()

    const handle = outbox.enqueue(createTodo, { title: 'Buy milk' })
    let resolved = false
    void handle.persisted.then(() => {
      resolved = true
    })

    await settle()
    expect(resolved).toBe(false)
    expect(inner.raw.size).toBe(0)

    release()
    await handle.persisted
    expect(resolved).toBe(true)
    expect([...inner.raw.keys()].filter((key) => key.includes(':op:'))).toHaveLength(1)
    outbox.stop()
  })

  it('hands out a placeholder id synchronously for optimistic UI', () => {
    const outbox = build()
    const handle = outbox.enqueue(createTodo, { title: 'Buy milk' })
    expect(handle.placeholderId).toMatch(/^ph_/)
  })

  it('rejects variables that cannot be made durable', async () => {
    const outbox = build()
    await outbox.start()
    const circular: { self?: unknown; title: string } = { title: 'x' }
    circular.self = circular

    expect(() => outbox.enqueue(createTodo, circular as never)).toThrow(/not JSON-serialisable/)
  })
})

describe('delivery', () => {
  it('sends a queued operation once online', async () => {
    const outbox = build()
    await outbox.start()

    const handle = outbox.enqueue(createTodo, { title: 'Buy milk' })
    await handle.persisted
    await outbox.drain()

    await expect(handle.settled).resolves.toEqual({ id: 'srv_1', title: 'Buy milk' })
    expect(server.rows.size).toBe(1)
    expect(outbox.getSnapshot().pending).toBe(0)
  })

  it('holds operations while offline and releases them on reconnect', async () => {
    network.setOnline(false)
    const outbox = build()
    await outbox.start()

    const handle = outbox.enqueue(createTodo, { title: 'Offline write' })
    await handle.persisted
    await outbox.drain()

    expect(server.received).toHaveLength(0)
    expect(outbox.getSnapshot().status).toBe('offline')

    network.setOnline(true)
    await outbox.drain()

    await expect(handle.settled).resolves.toMatchObject({ title: 'Offline write' })
    expect(server.received).toHaveLength(1)
  })

  it('does not spend a retry attempt on losing connectivity mid-flight', async () => {
    const outbox = build()
    await outbox.start()

    // The request fails *because* the radio dropped, not because the write was bad.
    const flaky = defineOperation({
      name: 'flaky',
      handler: () => {
        network.setOnline(false)
        return Promise.reject(new Error('Network request failed'))
      },
    })
    const local = createOutbox({
      operations: [flaky],
      storage: new MemoryStorage(),
      clock,
      network,
      random: seededRandom(1),
      onEvent: (event) => events.push(event),
    })
    await local.start()

    const handle = local.enqueue(flaky, {})
    await handle.persisted
    await local.drain()

    expect(events.some((event) => event.type === 'paused')).toBe(true)
    expect(local.list()[0]?.attempt).toBe(0)
    local.stop()
    outbox.stop()
  })
})

describe('causal ordering', () => {
  it('sends a create before the edit that depends on it, and rewrites the id', async () => {
    network.setOnline(false)
    const outbox = build()
    await outbox.start()

    const created = outbox.enqueue(createTodo, { title: 'Draft' })
    await created.persisted

    // The UI only has the placeholder — exactly what a real screen would hold.
    const edited = outbox.enqueue(updateTodo, {
      id: created.placeholderId,
      title: 'Final',
    })
    await edited.persisted

    network.setOnline(true)
    await outbox.drain()

    await expect(edited.settled).resolves.toEqual({ id: 'srv_1', title: 'Final' })
    expect(server.received.map((request) => request.name)).toEqual(['create', 'update'])
    expect(server.received[1]?.variables).toMatchObject({ id: 'srv_1' })
    expect(server.rows.get('srv_1')).toMatchObject({ title: 'Final' })
  })

  it('resolves a placeholder nested inside arrays and objects', async () => {
    network.setOnline(false)
    const outbox = build()
    await outbox.start()

    const created = outbox.enqueue(createTodo, { title: 'Parent' })
    await created.persisted

    const nested = defineOperation({
      name: 'nested',
      handler: (variables: unknown, context) => {
        server.received.push({
          name: 'nested',
          variables: structuredClone(variables),
          idempotencyKey: context.idempotencyKey,
          attempt: context.attempt,
        })
        return Promise.resolve({})
      },
    })

    const local = createOutbox({
      operations: [createTodo, nested],
      storage,
      clock,
      network,
      random: seededRandom(7),
    })
    await local.start()

    const handle = local.enqueue(nested, {
      payload: { items: [{ ref: created.placeholderId }] },
    })
    await handle.persisted

    network.setOnline(true)
    await local.drain()
    await outbox.drain()
    await local.drain()

    const nestedRequest = server.received.find((request) => request.name === 'nested')
    expect(nestedRequest?.variables).toEqual({ payload: { items: [{ ref: 'srv_1' }] } })
    local.stop()
  })

  it('supports ref() for reaching a different field of the parent result', async () => {
    network.setOnline(false)

    const createWithRevision = defineOperation({
      name: 'create.rev',
      handler: (_variables: Record<string, never>, context) =>
        Promise.resolve({ id: `row_${context.operationId}`, revision: 'rev-7' }),
      resolvesPlaceholder: (result: { id: string }) => result.id,
    })
    const consume = defineOperation({
      name: 'consume',
      handler: (variables: { revision: unknown }) => Promise.resolve(variables),
    })

    const outbox = createOutbox({
      operations: [createWithRevision, consume],
      storage,
      clock,
      network,
      random: seededRandom(3),
    })
    await outbox.start()

    const parent = outbox.enqueue(createWithRevision, {})
    await parent.persisted
    const child = outbox.enqueue(consume, { revision: ref(parent.placeholderId, 'revision') })
    await child.persisted

    network.setOnline(true)
    await outbox.drain()

    await expect(child.settled).resolves.toEqual({ revision: 'rev-7' })
    outbox.stop()
  })

  it('addresses the real row when an edit uses a placeholder that already synced', async () => {
    const outbox = build()
    await outbox.start()

    const created = outbox.enqueue(createTodo, { title: 'Draft' })
    await created.persisted
    await outbox.drain()
    await created.settled

    // The screen still holds the optimistic id; nothing has refetched yet.
    const edited = outbox.enqueue(updateTodo, { id: created.placeholderId, title: 'Later' })
    await edited.persisted
    await outbox.drain()

    await expect(edited.settled).resolves.toEqual({ id: 'srv_1', title: 'Later' })
  })

  it('runs independent chains concurrently', async () => {
    let inFlight = 0
    let peak = 0
    const slow = defineOperation({
      name: 'slow',
      handler: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return {}
      },
    })
    const outbox = createOutbox({
      operations: [slow],
      storage,
      clock,
      network,
      concurrency: 4,
      random: seededRandom(5),
    })
    await outbox.start()

    await Promise.all(Array.from({ length: 6 }, () => outbox.enqueue(slow, {}).persisted))
    await outbox.drain()

    expect(peak).toBeGreaterThan(1)
    outbox.stop()
  })
})

describe('retries and dead letters', () => {
  it('retries a transient failure with backoff and then succeeds', async () => {
    server.failNext = 2
    const outbox = build()
    await outbox.start()

    const handle = outbox.enqueue(createTodo, { title: 'Eventually' })
    await handle.persisted
    await outbox.drain()

    expect(server.rows.size).toBe(0)

    await clock.advance(60_000)
    await clock.advance(60_000)
    await outbox.drain()

    await expect(handle.settled).resolves.toMatchObject({ title: 'Eventually' })
    expect(server.received.length).toBeGreaterThanOrEqual(3)
  })

  it('dead-letters a permanent failure immediately without burning attempts', async () => {
    server.failPermanentlyNext = 1
    const outbox = build()
    await outbox.start()

    const handle = outbox.enqueue(createTodo, { title: 'Invalid' })
    await handle.persisted
    await outbox.drain()

    await expect(handle.settled).rejects.toThrow(/dead-lettered/)
    expect(outbox.getDeadLetters()).toHaveLength(1)
    expect(server.received).toHaveLength(1)
    expect(outbox.getSnapshot().status).toBe('blocked')
  })

  it('dead-letters after exhausting the attempt budget', async () => {
    server.failNext = 99
    const limited = defineOperation({
      name: 'limited',
      handler: (variables: { title: string }, context) => server.createRow(variables, context),
      retry: { maxAttempts: 3, baseDelayMs: 1_000, jitter: 'none' },
    })
    const outbox = createOutbox({
      operations: [limited],
      storage,
      clock,
      network,
      random: seededRandom(9),
    })
    await outbox.start()

    const handle = outbox.enqueue(limited, { title: 'Doomed' })
    await handle.persisted
    await outbox.drain()
    await clock.advance(10_000)
    await clock.advance(10_000)
    await outbox.drain()

    await expect(handle.settled).rejects.toThrow(/dead-lettered/)
    expect(server.received).toHaveLength(3)
    outbox.stop()
  })

  it('honours a server-supplied Retry-After as a floor', async () => {
    const throttled = defineOperation({
      name: 'throttled',
      handler: () =>
        Promise.reject(new RetryableError('Too many requests', { retryAfterMs: 30_000 })),
      retry: { maxAttempts: 5, baseDelayMs: 10, jitter: 'none' },
    })
    const outbox = createOutbox({
      operations: [throttled],
      storage,
      clock,
      network,
      random: seededRandom(11),
      onEvent: (event) => events.push(event),
    })
    await outbox.start()

    const handle = outbox.enqueue(throttled, {})
    await handle.persisted
    await outbox.drain()

    const failure = events.find((event) => event.type === 'failed')
    expect(failure).toBeDefined()
    if (failure?.type === 'failed') {
      expect(failure.retryAt - clock.now()).toBeGreaterThanOrEqual(30_000)
    }
    outbox.stop()
  })

  it('cascades a dead letter to everything that depended on it', async () => {
    network.setOnline(false)
    server.failPermanentlyNext = 1
    const outbox = build()
    await outbox.start()

    const created = outbox.enqueue(createTodo, { title: 'Doomed parent' })
    await created.persisted
    const edited = outbox.enqueue(updateTodo, { id: created.placeholderId, title: 'Orphan' })
    await edited.persisted
    const removed = outbox.enqueue(deleteTodo, { id: created.placeholderId })
    await removed.persisted

    network.setOnline(true)
    await outbox.drain()

    await expect(created.settled).rejects.toThrow(/dead-lettered/)
    await expect(edited.settled).rejects.toThrow(/dependency/i)
    await expect(removed.settled).rejects.toThrow(/dependency/i)

    // The children were never sent. Sending them would have addressed a row
    // the server never created.
    expect(server.received.map((request) => request.name)).toEqual(['create'])
    expect(outbox.getDeadLetters()).toHaveLength(3)
  })

  it('replays a dead letter with a fresh budget on request', async () => {
    server.failPermanentlyNext = 1
    const outbox = build()
    await outbox.start()

    const handle = outbox.enqueue(createTodo, { title: 'Retry me' })
    await handle.persisted
    await outbox.drain()
    await expect(handle.settled).rejects.toThrow()

    const [dead] = outbox.getDeadLetters()
    expect(dead).toBeDefined()
    await outbox.retryDeadLetter(dead!.id)
    await outbox.drain()

    expect(outbox.getDeadLetters()).toHaveLength(0)
    expect(server.rows.size).toBe(1)
  })

  it('discards a dead letter and cascades to its dependents', async () => {
    network.setOnline(false)
    server.failPermanentlyNext = 1
    const outbox = build()
    await outbox.start()

    const created = outbox.enqueue(createTodo, { title: 'Doomed' })
    await created.persisted
    network.setOnline(true)
    await outbox.drain()
    await expect(created.settled).rejects.toThrow()

    const [dead] = outbox.getDeadLetters()
    await outbox.discardDeadLetter(dead!.id)
    expect(outbox.getDeadLetters()).toHaveLength(0)
    expect(outbox.list()).toHaveLength(0)
  })
})

describe('idempotency', () => {
  it('does not write twice when the response is lost in flight', async () => {
    server.loseResponseNext = 1
    const outbox = build()
    await outbox.start()

    const handle = outbox.enqueue(createTodo, { title: 'Exactly once' })
    await handle.persisted
    await outbox.drain()
    await clock.advance(120_000)
    await outbox.drain()

    await expect(handle.settled).resolves.toMatchObject({ title: 'Exactly once' })
    // Two requests left the device; the server applied one.
    expect(server.received.length).toBe(2)
    expect(server.appliedWrites).toBe(1)
    expect(server.rows.size).toBe(1)
  })

  it('keeps the idempotency key stable across retries and id rewriting', async () => {
    network.setOnline(false)
    server.failNext = 1
    const outbox = build()
    await outbox.start()

    const created = outbox.enqueue(createTodo, { title: 'Parent' })
    await created.persisted
    const edited = outbox.enqueue(updateTodo, { id: created.placeholderId, title: 'Child' })
    await edited.persisted

    network.setOnline(true)
    await outbox.drain()
    await clock.advance(120_000)
    await outbox.drain()

    const updateKeys = new Set(
      server.received
        .filter((request) => request.name === 'update')
        .map((r) => r.idempotencyKey),
    )
    // The variables changed when the placeholder was rewritten. The key did not.
    expect(updateKeys.size).toBe(1)
  })
})

describe('coalescing', () => {
  it('merges unsent edits to the same target into one request', async () => {
    network.setOnline(false)
    const patch = defineOperation({
      name: 'patch',
      handler: (variables: { id: string; fields: Record<string, unknown> }, context) => {
        server.received.push({
          name: 'patch',
          variables: structuredClone(variables),
          idempotencyKey: context.idempotencyKey,
          attempt: context.attempt,
        })
        return Promise.resolve(variables)
      },
      coalesce: {
        key: (variables) => variables.id,
        merge: (earlier, later) => ({
          id: later.id,
          fields: { ...earlier.fields, ...later.fields },
        }),
      },
    })

    const outbox = createOutbox({
      operations: [patch],
      storage,
      clock,
      network,
      random: seededRandom(13),
      onEvent: (event) => events.push(event),
    })
    await outbox.start()

    await outbox.enqueue(patch, { id: 'row_1', fields: { title: 'a' } }).persisted
    await outbox.enqueue(patch, { id: 'row_1', fields: { title: 'b' } }).persisted
    await outbox.enqueue(patch, { id: 'row_1', fields: { done: true } }).persisted
    await outbox.enqueue(patch, { id: 'row_2', fields: { title: 'other' } }).persisted

    expect(outbox.list()).toHaveLength(2)

    network.setOnline(true)
    await outbox.drain()

    const patches = server.received.filter((request) => request.name === 'patch')
    expect(patches).toHaveLength(2)
    expect(patches[0]?.variables).toEqual({ id: 'row_1', fields: { title: 'b', done: true } })
    expect(events.filter((event) => event.type === 'coalesced')).toHaveLength(2)
    outbox.stop()
  })

  it('never merges into an operation that has already been sent', async () => {
    server.failNext = 1
    const patch = defineOperation({
      name: 'patch',
      handler: (variables: { id: string; n: number }, context) =>
        server.createRow({ title: `${variables.id}:${variables.n}` }, context),
      retry: { maxAttempts: 5, baseDelayMs: 1_000, jitter: 'none' },
      coalesce: { key: (variables) => variables.id, merge: (_earlier, later) => later },
    })
    const outbox = createOutbox({
      operations: [patch],
      storage,
      clock,
      network,
      random: seededRandom(17),
    })
    await outbox.start()

    const first = outbox.enqueue(patch, { id: 'row', n: 1 })
    await first.persisted
    await outbox.drain() // attempt 1 fails, record now has attempt === 1

    const second = outbox.enqueue(patch, { id: 'row', n: 2 })
    await second.persisted

    expect(second.operationId).not.toBe(first.operationId)
    expect(outbox.list()).toHaveLength(2)
    outbox.stop()
  })
})

describe('registry', () => {
  it('rejects duplicate operation names at construction', () => {
    const a = defineOperation({ name: 'dupe', handler: () => Promise.resolve(null) })
    const b = defineOperation({ name: 'dupe', handler: () => Promise.resolve(null) })
    expect(() => createOutbox({ operations: [a, b], storage })).toThrow(
      /Duplicate operation name/,
    )
  })

  it('refuses to enqueue an unregistered operation', async () => {
    const stranger = defineOperation({ name: 'stranger', handler: () => Promise.resolve(null) })
    const outbox = build()
    await outbox.start()
    expect(() => outbox.enqueue(stranger, {})).toThrow(/not registered/)
  })

  it('enforces maxQueueSize', async () => {
    network.setOnline(false)
    const outbox = build({ maxQueueSize: 2 })
    await outbox.start()

    await outbox.enqueue(createTodo, { title: '1' }).persisted
    await outbox.enqueue(createTodo, { title: '2' }).persisted
    expect(() => outbox.enqueue(createTodo, { title: '3' })).toThrow(/outbox is full/)
  })
})

describe('observability', () => {
  it('notifies subscribers when the snapshot changes', async () => {
    const outbox = build()
    await outbox.start()
    const listener = vi.fn()
    outbox.subscribe(listener)

    await outbox.enqueue(createTodo, { title: 'Notify' }).persisted
    expect(listener).toHaveBeenCalled()
  })

  it('reports offline, syncing and blocked states', async () => {
    network.setOnline(false)
    const outbox = build()
    await outbox.start()
    expect(outbox.getSnapshot().status).toBe('idle')

    await outbox.enqueue(createTodo, { title: 'x' }).persisted
    expect(outbox.getSnapshot().status).toBe('offline')

    server.failPermanentlyNext = 1
    network.setOnline(true)
    await outbox.drain()
    expect(outbox.getSnapshot().status).toBe('blocked')
  })

  it('classifies errors through a custom classifier', async () => {
    const classified = defineOperation({
      name: 'classified',
      handler: () => Promise.reject(new Error('HTTP 404')),
      classifyError: (error) => (String(error).includes('404') ? 'fail' : 'retry'),
    })
    const outbox = createOutbox({
      operations: [classified],
      storage,
      clock,
      network,
      random: seededRandom(19),
    })
    await outbox.start()

    const handle = outbox.enqueue(classified, {})
    await handle.persisted
    await outbox.drain()

    await expect(handle.settled).rejects.toThrow(/dead-lettered/)
    expect(outbox.getDeadLetters()).toHaveLength(1)
    outbox.stop()
  })

  it('treats PermanentError as terminal without a classifier', async () => {
    const boom = defineOperation({
      name: 'boom',
      handler: () => Promise.reject(new PermanentError('nope')),
    })
    const outbox = createOutbox({ operations: [boom], storage, clock, network })
    await outbox.start()
    const handle = outbox.enqueue(boom, {})
    await handle.persisted
    await outbox.drain()
    await expect(handle.settled).rejects.toThrow(/dead-lettered/)
    outbox.stop()
  })
})
