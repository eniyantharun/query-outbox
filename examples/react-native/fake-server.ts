import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * A pretend backend that lives on the device.
 *
 * This is not a shortcut around running a real server — it is what makes the
 * demo honest. The outbox decides whether to send based on what NetInfo
 * reports, not on whether a request happens to fail, so flipping airplane mode
 * still exercises the real code path: the queue holds writes, then flushes them
 * when the radio comes back. You get the full offline story with nothing to
 * deploy.
 *
 * It stores its rows under its own AsyncStorage key, separate from the outbox's,
 * so "force-quit and relaunch" shows writes that genuinely persisted rather than
 * state that happened to survive in memory.
 *
 * Crucially it honours the idempotency key, exactly as the README asks a real
 * server to: a replayed request returns the original result instead of writing
 * a second row.
 */

const ROWS_KEY = 'demo-server:rows'
const COMMITTED_KEY = 'demo-server:committed'

export interface Todo {
  id: string
  title: string
}

/** Artificial latency, so optimistic UI is visible rather than a single frame. */
const LATENCY_MS = 600

/** Flip these from the UI to demonstrate retries and dead letters. */
export const chaos = {
  failNext: 0,
  /** Commit the write, then throw — the lost-ACK case. */
  loseResponseNext: 0,
}

async function readMap<T>(key: string): Promise<Record<string, T>> {
  const raw = await AsyncStorage.getItem(key)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, T>
  } catch {
    return {}
  }
}

async function writeMap<T>(key: string, value: Record<string, T>): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function listTodos(): Promise<Todo[]> {
  const rows = await readMap<Todo>(ROWS_KEY)
  return Object.values(rows)
}

export async function resetServer(): Promise<void> {
  await AsyncStorage.multiRemove([ROWS_KEY, COMMITTED_KEY])
}

async function apply<T>(idempotencyKey: string, commit: () => Promise<T>): Promise<T> {
  await sleep(LATENCY_MS)

  const committed = await readMap<T>(COMMITTED_KEY)
  const already = committed[idempotencyKey]
  if (already !== undefined) {
    // Seen this exact write before. Return what we returned the first time
    // instead of applying it again.
    return already
  }

  if (chaos.failNext > 0) {
    chaos.failNext -= 1
    throw new Error('Injected upstream failure')
  }

  const result = await commit()
  committed[idempotencyKey] = result
  await writeMap(COMMITTED_KEY, committed)

  if (chaos.loseResponseNext > 0) {
    chaos.loseResponseNext -= 1
    throw new Error('Committed, but the response never arrived')
  }
  return result
}

export async function createTodoOnServer(
  variables: { title: string },
  idempotencyKey: string,
): Promise<Todo> {
  return apply(idempotencyKey, async () => {
    const rows = await readMap<Todo>(ROWS_KEY)
    const id = `srv_${Object.keys(rows).length + 1}_${Date.now().toString(36)}`
    const todo: Todo = { id, title: variables.title }
    rows[id] = todo
    await writeMap(ROWS_KEY, rows)
    return todo
  })
}

export async function updateTodoOnServer(
  variables: { id: string; title: string },
  idempotencyKey: string,
): Promise<Todo> {
  return apply(idempotencyKey, async () => {
    const rows = await readMap<Todo>(ROWS_KEY)
    const existing = rows[variables.id]
    if (!existing) {
      // A permanent failure: retrying will never make this row exist. The
      // outbox dead-letters it rather than burning its whole attempt budget.
      const error = new Error(`No such todo: ${variables.id}`)
      error.name = 'PermanentError'
      throw error
    }
    const updated: Todo = { ...existing, title: variables.title }
    rows[variables.id] = updated
    await writeMap(ROWS_KEY, rows)
    return updated
  })
}
