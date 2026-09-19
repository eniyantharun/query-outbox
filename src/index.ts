export { createOutbox, Outbox } from './core/outbox.js'
export type {
  EnqueueHandle,
  OutboxEvent,
  OutboxOptions,
  OutboxSnapshot,
  OutboxStatus,
} from './core/outbox.js'

export { defineOperation, eraseOperation, OperationRegistry } from './core/operation.js'
export type {
  CoalescePolicy,
  ErasedOperation,
  Operation,
  OperationContext,
  OperationDefinition,
} from './core/operation.js'

export { isRef, ref, REF_MARKER } from './core/refs.js'
export type { OutboxRef } from './core/refs.js'

export { computeBackoff, defaultRetryPolicy, resolveRetryPolicy } from './core/backoff.js'
export type { JitterStrategy, RetryPolicy } from './core/backoff.js'

export {
  DeadLetteredError,
  DependencyFailedError,
  NotSerializableError,
  PermanentError,
  QueueOverflowError,
  RetryableError,
  UnknownOperationError,
} from './core/errors.js'
export type { ErrorDisposition, StoredError } from './core/errors.js'

export { alwaysOnline, systemClock } from './core/ports.js'
export type { Clock, NetworkMonitor, OutboxStorage, Random, TimerHandle } from './core/ports.js'

export type { OperationRecord, OperationStatus } from './core/queue.js'
