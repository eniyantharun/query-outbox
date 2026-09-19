/**
 * Placeholder references.
 *
 * When you create an entity offline you do not have a server id, so every
 * follow-up edit has nothing to address. The outbox hands you a `placeholderId`
 * synchronously at enqueue time; you use it for optimistic UI and pass it
 * around exactly like a real id. The queue then does two things with it:
 *
 *   1. Any pending operation whose variables mention a placeholder gains a
 *      dependency edge on the operation that will produce it, so the edit can
 *      never be sent before the create.
 *   2. Once the create succeeds, the placeholder is rewritten to the real id
 *      everywhere it still appears in the queue.
 *
 * The common case needs no ceremony — just pass the string. `ref()` exists for
 * when you need a *different* field of the parent's result, e.g. a revision
 * token: `ref(placeholderId, 'revision')`.
 */

export const REF_MARKER = '__outboxRef' as const

export interface OutboxRef {
  readonly [REF_MARKER]: string
  readonly path?: string
}

export function ref(placeholderId: string, path?: string): OutboxRef {
  return path === undefined
    ? { [REF_MARKER]: placeholderId }
    : { [REF_MARKER]: placeholderId, path }
}

export function isRef(value: unknown): value is OutboxRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    REF_MARKER in value &&
    typeof (value as Record<string, unknown>)[REF_MARKER] === 'string'
  )
}

/** Guards against pathological or cyclic input. */
const MAX_DEPTH = 32

/**
 * Every placeholder id mentioned anywhere in `value`, whether written as a bare
 * string or wrapped in `ref()`. `isPlaceholder` decides which strings count, so
 * an unrelated string that merely looks id-shaped is never captured.
 */
export function collectPlaceholders(
  value: unknown,
  isPlaceholder: (candidate: string) => boolean,
): Set<string> {
  const found = new Set<string>()
  const seen = new WeakSet()

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return

    if (typeof node === 'string') {
      if (isPlaceholder(node)) found.add(node)
      return
    }
    if (typeof node !== 'object' || node === null) return
    if (seen.has(node)) return
    seen.add(node)

    if (isRef(node)) {
      if (isPlaceholder(node[REF_MARKER])) found.add(node[REF_MARKER])
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    for (const item of Object.values(node)) walk(item, depth + 1)
  }

  walk(value, 0)
  return found
}

/** Reads `a.b.c` out of a resolved result. Returns undefined on any miss. */
function readPath(source: unknown, path: string): unknown {
  let current = source
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export type PlaceholderResolver = (
  placeholderId: string,
) => { value: unknown; result: unknown } | undefined

/**
 * Returns a structurally-shared copy of `value` with every resolved placeholder
 * replaced. Unresolved placeholders are left untouched so a partially-resolved
 * chain stays replayable.
 */
export function substitutePlaceholders(value: unknown, resolve: PlaceholderResolver): unknown {
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return node

    if (typeof node === 'string') {
      const hit = resolve(node)
      return hit === undefined ? node : hit.value
    }
    if (typeof node !== 'object' || node === null) return node

    if (isRef(node)) {
      const hit = resolve(node[REF_MARKER])
      if (hit === undefined) return node
      return node.path === undefined ? hit.value : readPath(hit.result, node.path)
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1))
    }
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(node)) {
      output[key] = walk(item, depth + 1)
    }
    return output
  }

  return walk(value, 0)
}
