/**
 * How a thrown error is treated by the retry policy.
 *
 * - `retry`  — transient; back off and try again.
 * - `fail`   — permanent; dead-letter immediately without burning attempts.
 *              A 422 will never succeed by being sent a ninth time.
 */
export type ErrorDisposition = 'retry' | 'fail'

/**
 * Throw from a handler to dead-letter an operation immediately.
 *
 * Accepts the standard `{ cause }` options bag via `Error`.
 */
export class PermanentError extends Error {
  override readonly name = 'PermanentError'
}

/** Throw from a handler to retry no sooner than `retryAfterMs` (e.g. a 429). */
export class RetryableError extends Error {
  override readonly name = 'RetryableError'
  readonly retryAfterMs: number | undefined

  constructor(message: string, options?: { retryAfterMs?: number; cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.retryAfterMs = options?.retryAfterMs
  }
}

/** Raised when an operation name is enqueued that was never registered. */
export class UnknownOperationError extends Error {
  override readonly name = 'UnknownOperationError'
  constructor(readonly operationName: string) {
    super(
      `Operation "${operationName}" is not registered. Pass it to createOutbox({ operations: [...] }).`,
    )
  }
}

/** Raised when a dependency of an operation was dead-lettered. */
export class DependencyFailedError extends Error {
  override readonly name = 'DependencyFailedError'
  constructor(readonly dependencyId: string) {
    super(
      `A dependency (${dependencyId}) was dead-lettered, so this operation can never succeed.`,
    )
  }
}

export function isPermanent(error: unknown): boolean {
  return error instanceof PermanentError
}

export function retryAfterOf(error: unknown): number | undefined {
  return error instanceof RetryableError ? error.retryAfterMs : undefined
}

/** Serialisable error shape stored on a record for inspection after a restart. */
export interface StoredError {
  name: string
  message: string
  at: number
}

export function toStoredError(error: unknown, at: number): StoredError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, at }
  }
  return { name: 'UnknownError', message: String(error), at }
}

/** Raised when enqueueing would exceed `maxQueueSize`. */
export class QueueOverflowError extends Error {
  override readonly name = 'QueueOverflowError'
  constructor(readonly maxQueueSize: number) {
    super(
      `The outbox is full (${maxQueueSize} operations). Raise maxQueueSize, or resolve the dead-letter queue.`,
    )
  }
}

/** Raised when variables cannot be persisted. */
export class NotSerializableError extends Error {
  override readonly name = 'NotSerializableError'
  constructor(
    readonly operationName: string,
    cause: unknown,
  ) {
    super(
      `Variables for "${operationName}" are not JSON-serialisable, so the operation could not be made durable. ` +
        `Avoid functions, class instances, Map/Set and circular references. (${String(cause)})`,
    )
  }
}

/** Raised when an operation is dead-lettered, as the rejection of `settled`. */
export class DeadLetteredError extends Error {
  override readonly name = 'DeadLetteredError'
  constructor(
    readonly operationId: string,
    readonly operationName: string,
    readonly reason: StoredError,
  ) {
    super(`Operation "${operationName}" (${operationId}) was dead-lettered: ${reason.message}`)
  }
}
