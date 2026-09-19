// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserNetworkMonitor } from '../../src/net/browser.js'
import { alwaysOnline, systemClock } from '../../src/core/ports.js'
import {
  DeadLetteredError,
  DependencyFailedError,
  NotSerializableError,
  PermanentError,
  QueueOverflowError,
  RetryableError,
  UnknownOperationError,
  isPermanent,
  retryAfterOf,
  toStoredError,
} from '../../src/core/errors.js'
import { OperationRegistry, defineOperation, eraseOperation } from '../../src/core/operation.js'

function setOnLine(value: boolean): void {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  })
}

afterEach(() => {
  setOnLine(true)
})

describe('browser network monitor', () => {
  it('reads navigator.onLine', () => {
    const monitor = createBrowserNetworkMonitor()
    expect(monitor.isOnline()).toBe(true)
    setOnLine(false)
    expect(monitor.isOnline()).toBe(false)
  })

  it('notifies on the online and offline events', () => {
    const monitor = createBrowserNetworkMonitor()
    const seen: boolean[] = []
    const unsubscribe = monitor.subscribe((online) => seen.push(online))

    globalThis.dispatchEvent(new Event('offline'))
    globalThis.dispatchEvent(new Event('online'))
    expect(seen).toEqual([false, true])

    unsubscribe()
    globalThis.dispatchEvent(new Event('offline'))
    expect(seen).toEqual([false, true])
  })

  it('removes its listeners on unsubscribe', () => {
    const remove = vi.spyOn(globalThis, 'removeEventListener')
    const unsubscribe = createBrowserNetworkMonitor().subscribe(() => undefined)
    unsubscribe()
    expect(remove).toHaveBeenCalledWith('online', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('offline', expect.any(Function))
    remove.mockRestore()
  })
})

describe('default ports', () => {
  it('systemClock schedules and cancels real timers', async () => {
    expect(systemClock.now()).toBeGreaterThan(0)

    const fired = await new Promise<boolean>((resolve) => {
      systemClock.setTimeout(() => resolve(true), 1)
    })
    expect(fired).toBe(true)

    let cancelledRan = false
    const handle = systemClock.setTimeout(() => {
      cancelledRan = true
    }, 1)
    systemClock.clearTimeout(handle)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(cancelledRan).toBe(false)
  })

  it('alwaysOnline reports connectivity and unsubscribes cleanly', () => {
    expect(alwaysOnline.isOnline()).toBe(true)
    const unsubscribe = alwaysOnline.subscribe(() => undefined)
    expect(unsubscribe()).toBeUndefined()
  })
})

describe('error types', () => {
  it('carries a cause through PermanentError', () => {
    const cause = new Error('root')
    const error = new PermanentError('nope', { cause })
    expect(error.name).toBe('PermanentError')
    expect(error.cause).toBe(cause)
    expect(isPermanent(error)).toBe(true)
    expect(isPermanent(new Error('other'))).toBe(false)
  })

  it('exposes retryAfterMs on RetryableError only', () => {
    expect(retryAfterOf(new RetryableError('slow down', { retryAfterMs: 5_000 }))).toBe(5_000)
    expect(retryAfterOf(new RetryableError('slow down'))).toBeUndefined()
    expect(retryAfterOf(new Error('plain'))).toBeUndefined()
  })

  it('produces readable messages', () => {
    expect(new UnknownOperationError('ghost').message).toMatch(/not registered/)
    expect(new DependencyFailedError('op_1').message).toMatch(/dead-lettered/)
    expect(new QueueOverflowError(50).message).toMatch(/50/)
    expect(new NotSerializableError('op', new Error('circular')).message).toMatch(/JSON/)
    expect(
      new DeadLetteredError('op_1', 'todo.create', {
        name: 'X',
        message: 'boom',
        at: 0,
      }).message,
    ).toMatch(/todo\.create/)
  })

  it('serialises non-Error throws', () => {
    expect(toStoredError('just a string', 7)).toEqual({
      name: 'UnknownError',
      message: 'just a string',
      at: 7,
    })
    expect(toStoredError(new TypeError('bad'), 9)).toEqual({
      name: 'TypeError',
      message: 'bad',
      at: 9,
    })
  })
})

describe('operation registry', () => {
  const alpha = defineOperation({ name: 'alpha', handler: () => Promise.resolve(1) })
  const beta = defineOperation({ name: 'beta', handler: () => Promise.resolve(2) })

  it('looks operations up by name', () => {
    const registry = new OperationRegistry([eraseOperation(alpha), eraseOperation(beta)])
    expect(registry.has('alpha')).toBe(true)
    expect(registry.has('gamma')).toBe(false)
    expect(registry.get('beta').name).toBe('beta')
    expect(registry.names().sort()).toEqual(['alpha', 'beta'])
  })

  it('throws for an unregistered name', () => {
    const registry = new OperationRegistry([])
    expect(() => registry.get('missing')).toThrow(UnknownOperationError)
  })

  it('requires a name', () => {
    expect(() => defineOperation({ name: '', handler: () => Promise.resolve(null) })).toThrow(
      /non-empty/,
    )
  })
})
