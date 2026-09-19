import type { Random } from './ports.js'

/**
 * `full` is the default, and the choice matters at scale.
 *
 * When a cell tower comes back, every device behind it reconnects at once. With
 * no jitter they all retry at exactly base*2^n and hammer the origin in
 * synchronised waves. Full jitter spreads each retry uniformly across the whole
 * window, which flattens that thundering herd at the cost of some retries
 * firing sooner than the nominal backoff.
 */
export type JitterStrategy = 'none' | 'full' | 'equal'

export interface RetryPolicy {
  /** Total attempts before dead-lettering. `1` means never retry. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  jitter: JitterStrategy
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  jitter: 'full',
}

export function resolveRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
  return { ...defaultRetryPolicy, ...partial }
}

/**
 * Delay before attempt number `attempt` (1-based: `1` is the first retry,
 * computed after the initial try failed).
 *
 * A server-supplied `retryAfterMs` (429 / 503) is a floor, never a ceiling —
 * we respect being asked to wait longer, but never retry sooner than we would
 * have on our own.
 */
export function computeBackoff(
  attempt: number,
  policy: RetryPolicy,
  random: Random,
  retryAfterMs?: number,
): number {
  const exponent = Math.max(0, attempt - 1)
  const uncapped = policy.baseDelayMs * 2 ** exponent
  const ceiling = Math.min(
    policy.maxDelayMs,
    Number.isFinite(uncapped) ? uncapped : policy.maxDelayMs,
  )

  let delay: number
  switch (policy.jitter) {
    case 'none':
      delay = ceiling
      break
    case 'equal':
      delay = ceiling / 2 + random() * (ceiling / 2)
      break
    case 'full':
      delay = random() * ceiling
      break
  }

  delay = Math.round(delay)
  return retryAfterMs === undefined ? delay : Math.max(delay, retryAfterMs)
}
