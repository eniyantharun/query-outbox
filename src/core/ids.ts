import type { Clock, Random } from './ports.js'

const TIME_LEN = 9 // base36 milliseconds — good past the year 5000
const SEQ_LEN = 4
const RAND_LEN = 6

function pad(value: number, length: number): string {
  return value.toString(36).padStart(length, '0').slice(-length)
}

/**
 * Lexicographically sortable, monotonically increasing ids.
 *
 * Sort order equals enqueue order, which is why the queue can rebuild its
 * ordering from a key scan alone and never needs a separate index record.
 *
 * The clock is clamped so a backwards system-clock adjustment (NTP correction,
 * user changing the date) can never mint an id that sorts before an existing
 * one and silently reorders pending writes.
 *
 * Within a process the sequence counter guarantees uniqueness outright. Across
 * a restart it cannot, because the counter resets — so the random suffix has to
 * carry that case on its own. Six base36 characters is ~2.2e9 values, chosen
 * because a collision here is not a harmless duplicate id: two operations
 * sharing an id share an idempotency key, and the second write would be
 * silently discarded by the server as a replay of the first. That failure is
 * invisible, so the margin is deliberately generous.
 */
export function createIdFactory(clock: Clock, random: Random = Math.random): () => string {
  let lastTime = 0
  let seq = 0

  return function nextId(): string {
    const now = Math.max(clock.now(), lastTime)
    if (now === lastTime) {
      seq += 1
    } else {
      lastTime = now
      seq = 0
    }
    let suffix = ''
    for (let i = 0; i < RAND_LEN; i += 1) {
      suffix += Math.floor(random() * 36).toString(36)
    }
    return pad(now, TIME_LEN) + pad(seq, SEQ_LEN) + suffix
  }
}
