import type { RetryPolicy } from './backoff.js'
import type { ErrorDisposition } from './errors.js'
import { UnknownOperationError } from './errors.js'

export interface OperationContext {
  readonly operationId: string
  /** The client-side id handed out at enqueue time. Use it for optimistic UI. */
  readonly placeholderId: string
  /**
   * Stable across every retry and across app restarts, because it is derived
   * from the operation id rather than from the variables. A content hash would
   * change the moment a placeholder was rewritten to a real id — that is, at
   * exactly the moment deduplication needs to hold.
   */
  readonly idempotencyKey: string
  /** 1-based. `1` is the first send. */
  readonly attempt: number
  readonly enqueuedAt: number
  /** Aborted when the outbox is stopped. */
  readonly signal: AbortSignal
}

export interface CoalescePolicy<TVariables> {
  /**
   * Operations of the same name sharing a key collapse into one. Return
   * `undefined` to opt an individual call out of coalescing.
   */
  key: (variables: TVariables) => string | undefined
  merge: (earlier: TVariables, later: TVariables) => TVariables
}

export interface OperationDefinition<TVariables, TResult> {
  /** Stable identity across releases — it is what a persisted record stores. */
  name: string
  handler: (variables: TVariables, context: OperationContext) => Promise<TResult>
  retry?: Partial<RetryPolicy>
  /**
   * Extracts the server-assigned value that this operation's `placeholderId`
   * should be rewritten to. Required for any operation whose placeholder is
   * referenced by a later one — typically `(result) => result.id`.
   */
  resolvesPlaceholder?: (result: TResult) => unknown
  /** Defaults to treating `PermanentError` as `fail` and everything else as `retry`. */
  classifyError?: (error: unknown) => ErrorDisposition
  coalesce?: CoalescePolicy<TVariables>
}

export interface Operation<TVariables, TResult> extends OperationDefinition<
  TVariables,
  TResult
> {
  /** Phantom marker so `Operation` is nominally distinct. Never present at runtime. */
  readonly __result?: TResult
}

/**
 * Declares an operation at module scope, where it is re-registered on every
 * cold start.
 *
 * This is the whole answer to TanStack Query's `No mutationFn found`: a
 * persisted record stores only a `name`, and the function is looked up from the
 * registry at replay time rather than being expected to survive serialisation.
 */
export function defineOperation<TVariables, TResult>(
  definition: OperationDefinition<TVariables, TResult>,
): Operation<TVariables, TResult> {
  if (!definition.name) {
    throw new TypeError('defineOperation requires a non-empty `name`.')
  }
  return definition
}

/** Type-erased view used by the queue, which cannot know concrete variable types. */
export interface ErasedOperation {
  name: string
  handler: (variables: never, context: OperationContext) => Promise<unknown>
  retry?: Partial<RetryPolicy>
  resolvesPlaceholder?: (result: never) => unknown
  classifyError?: (error: unknown) => ErrorDisposition
  coalesce?: {
    key: (variables: never) => string | undefined
    merge: (earlier: never, later: never) => unknown
  }
}

export function eraseOperation<TVariables, TResult>(
  operation: Operation<TVariables, TResult>,
): ErasedOperation {
  return operation
}

export class OperationRegistry {
  readonly #byName = new Map<string, ErasedOperation>()

  constructor(operations: readonly ErasedOperation[]) {
    for (const operation of operations) {
      if (this.#byName.has(operation.name)) {
        throw new TypeError(
          `Duplicate operation name "${operation.name}". Names are persisted, so they must be unique.`,
        )
      }
      this.#byName.set(operation.name, operation)
    }
  }

  has(name: string): boolean {
    return this.#byName.has(name)
  }

  get(name: string): ErasedOperation {
    const operation = this.#byName.get(name)
    if (!operation) throw new UnknownOperationError(name)
    return operation
  }

  names(): string[] {
    return [...this.#byName.keys()]
  }
}
