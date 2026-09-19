import { describe, expect, it } from 'vitest'

import {
  computeBackoff,
  defaultRetryPolicy,
  resolveRetryPolicy,
} from '../../src/core/backoff.js'
import { createIdFactory } from '../../src/core/ids.js'
import { collectPlaceholders, isRef, ref, substitutePlaceholders } from '../../src/core/refs.js'
import { ResolutionStore } from '../../src/core/resolutions.js'
import { MemoryStorage } from '../../src/storage/memory.js'
import { TestClock, seededRandom } from '../helpers.js'

describe('backoff', () => {
  const policy = {
    maxAttempts: 10,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitter: 'none' as const,
  }

  it('doubles until it reaches the ceiling', () => {
    const half = () => 0.5
    expect(computeBackoff(1, policy, half)).toBe(1_000)
    expect(computeBackoff(2, policy, half)).toBe(2_000)
    expect(computeBackoff(3, policy, half)).toBe(4_000)
    expect(computeBackoff(10, policy, half)).toBe(60_000)
    expect(computeBackoff(100, policy, half)).toBe(60_000)
  })

  it('keeps full jitter inside [0, ceiling]', () => {
    const random = seededRandom(1234)
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      for (let sample = 0; sample < 200; sample += 1) {
        const delay = computeBackoff(attempt, { ...policy, jitter: 'full' }, random)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(60_000)
      }
    }
  })

  it('spreads full jitter rather than clustering — the point of using it', () => {
    const random = seededRandom(99)
    const samples = Array.from({ length: 600 }, () =>
      computeBackoff(6, { ...policy, jitter: 'full' }, random),
    )
    const ceiling = Math.min(60_000, 1_000 * 2 ** 5)
    const buckets = [0, 0, 0, 0]
    for (const sample of samples) {
      buckets[Math.min(3, Math.floor((sample / ceiling) * 4))]! += 1
    }
    // Every quartile of the window gets used. Without jitter all 600 retries
    // would land on the same millisecond.
    for (const count of buckets) expect(count).toBeGreaterThan(50)
  })

  it('keeps equal jitter in the upper half of the window', () => {
    const random = seededRandom(7)
    for (let sample = 0; sample < 200; sample += 1) {
      const delay = computeBackoff(4, { ...policy, jitter: 'equal' }, random)
      expect(delay).toBeGreaterThanOrEqual(4_000)
      expect(delay).toBeLessThanOrEqual(8_000)
    }
  })

  it('treats Retry-After as a floor, never a ceiling', () => {
    expect(computeBackoff(1, policy, () => 0.5, 45_000)).toBe(45_000)
    // A large computed backoff wins over a small Retry-After.
    expect(computeBackoff(8, policy, () => 0.5, 1_000)).toBe(60_000)
  })

  it('merges partial policies over the defaults', () => {
    expect(resolveRetryPolicy({ maxAttempts: 2 })).toEqual({
      ...defaultRetryPolicy,
      maxAttempts: 2,
    })
    expect(resolveRetryPolicy()).toEqual(defaultRetryPolicy)
  })
})

describe('ids', () => {
  it('sorts lexicographically in mint order', () => {
    const clock = new TestClock()
    const nextId = createIdFactory(clock, seededRandom(3))
    const ids = Array.from({ length: 500 }, () => nextId())
    expect([...ids].sort()).toEqual(ids)
  })

  it('stays monotonic when the system clock jumps backwards', () => {
    let now = 1_000_000
    const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined }
    const nextId = createIdFactory(clock, seededRandom(4))

    const before = nextId()
    now -= 60_000 // NTP correction, or the user changing the date
    const after = nextId()

    expect(after > before).toBe(true)
  })

  it('does not repeat within a process', () => {
    const clock = new TestClock()
    const nextId = createIdFactory(clock, seededRandom(5))
    const ids = new Set(Array.from({ length: 5_000 }, () => nextId()))
    expect(ids.size).toBe(5_000)
  })
})

describe('refs', () => {
  const known = (candidate: string): boolean => candidate.startsWith('ph_')

  it('finds placeholders at any depth', () => {
    const found = collectPlaceholders(
      { a: 'ph_1', b: [{ c: 'ph_2' }], d: ref('ph_3'), e: 'not-a-placeholder' },
      known,
    )
    expect([...found].sort()).toEqual(['ph_1', 'ph_2', 'ph_3'])
  })

  it('ignores strings that merely look like ids', () => {
    expect(collectPlaceholders({ id: 'srv_42' }, known).size).toBe(0)
  })

  it('survives a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { id: 'ph_1' }
    cyclic['self'] = cyclic
    expect([...collectPlaceholders(cyclic, known)]).toEqual(['ph_1'])
  })

  it('substitutes bare strings and refs alike', () => {
    const resolve = (id: string) =>
      id === 'ph_1' ? { value: 'srv_9', result: { id: 'srv_9', rev: 'r7' } } : undefined

    expect(substitutePlaceholders({ id: 'ph_1' }, resolve)).toEqual({ id: 'srv_9' })
    expect(substitutePlaceholders({ id: ref('ph_1') }, resolve)).toEqual({ id: 'srv_9' })
    expect(substitutePlaceholders({ rev: ref('ph_1', 'rev') }, resolve)).toEqual({ rev: 'r7' })
  })

  it('leaves unresolved placeholders intact so the chain stays replayable', () => {
    const input = { a: 'ph_unknown', b: ref('ph_unknown') }
    const output = substitutePlaceholders(input, () => undefined)
    expect(output).toEqual(input)
  })

  it('returns undefined for a path that does not exist', () => {
    const resolve = () => ({ value: 'x', result: { a: 1 } })
    expect(substitutePlaceholders({ v: ref('ph_1', 'a.b.c') }, resolve)).toEqual({
      v: undefined,
    })
  })

  it('recognises ref markers', () => {
    expect(isRef(ref('ph_1'))).toBe(true)
    expect(isRef({ __outboxRef: 7 })).toBe(false)
    expect(isRef(null)).toBe(false)
    expect(isRef('ph_1')).toBe(false)
  })
})

describe('resolution store', () => {
  it('persists and reloads resolutions', async () => {
    const disk = new Map<string, string>()
    const first = new ResolutionStore(new MemoryStorage(disk), 'test')
    await first.set('ph_1', { value: 'srv_1', result: { id: 'srv_1' } })

    const second = new ResolutionStore(new MemoryStorage(disk), 'test')
    await second.hydrate()
    expect(second.get('ph_1')).toEqual({ value: 'srv_1', result: { id: 'srv_1' } })
  })

  it('evicts oldest entries beyond capacity', async () => {
    const store = new ResolutionStore(new MemoryStorage(), 'test', 3)
    for (let index = 0; index < 5; index += 1) {
      await store.set(`ph_${index}`, { value: index, result: null })
    }
    expect(store.size).toBe(3)
    expect(store.has('ph_0')).toBe(false)
    expect(store.has('ph_4')).toBe(true)
  })

  it('refreshes recency on re-set', async () => {
    const store = new ResolutionStore(new MemoryStorage(), 'test', 2)
    await store.set('a', { value: 1, result: null })
    await store.set('b', { value: 2, result: null })
    await store.set('a', { value: 3, result: null })
    await store.set('c', { value: 4, result: null })
    expect(store.has('a')).toBe(true)
    expect(store.has('b')).toBe(false)
  })

  it('discards a corrupt map instead of throwing', async () => {
    const disk = new Map<string, string>([['test:resolved', '<<not json>>']])
    const store = new ResolutionStore(new MemoryStorage(disk), 'test')
    await expect(store.hydrate()).resolves.toBeUndefined()
    expect(store.size).toBe(0)
    expect(disk.has('test:resolved')).toBe(false)
  })
})
