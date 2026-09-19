import { PermanentError } from 'query-outbox'
import { defineQueryOperation } from 'query-outbox/query'

const API = 'https://api.example.com'

export interface Todo {
  id: string
  title: string
  done?: boolean
  pending?: boolean
}

async function request<T>(
  path: string,
  init: RequestInit,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    signal,
    headers: {
      'Content-Type': 'application/json',
      // The server stores this alongside the write. A replay returns the
      // original result instead of writing a second row.
      'Idempotency-Key': idempotencyKey,
      ...init.headers,
    },
  })

  // A 4xx other than 408/429 will never succeed by being retried, so fail fast
  // rather than spending the whole attempt budget on it.
  if (response.status >= 400 && response.status < 500) {
    if (response.status !== 408 && response.status !== 429) {
      throw new PermanentError(`Server rejected the write: ${response.status}`)
    }
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

export const createTodo = defineQueryOperation({
  name: 'todo.create',
  handler: ({ title }: { title: string }, ctx) =>
    request<Todo>(
      '/todos',
      { method: 'POST', body: JSON.stringify({ title }) },
      ctx.idempotencyKey,
      ctx.signal,
    ),

  // Lets `todo.update` address this row before the server has named it.
  resolvesPlaceholder: (result) => result.id,

  optimistic: ({ title }, { queryClient, placeholderId }) => {
    queryClient.setQueryData<Todo[]>(['todos'], (todos = []) => [
      ...todos,
      { id: placeholderId, title, pending: true },
    ])
    return () => {
      queryClient.setQueryData<Todo[]>(['todos'], (todos = []) =>
        todos.filter((todo) => todo.id !== placeholderId),
      )
    }
  },

  invalidates: [['todos']],
})

export const updateTodo = defineQueryOperation({
  name: 'todo.update',
  handler: ({ id, title }: { id: string; title: string }, ctx) =>
    request<Todo>(
      `/todos/${id}`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
      ctx.idempotencyKey,
      ctx.signal,
    ),

  optimistic: ({ id, title }, { queryClient }) => {
    const previous = queryClient.getQueryData<Todo[]>(['todos'])
    queryClient.setQueryData<Todo[]>(['todos'], (todos = []) =>
      todos.map((todo) => (todo.id === id ? { ...todo, title, pending: true } : todo)),
    )
    return () => {
      queryClient.setQueryData<Todo[]>(['todos'], previous)
    }
  },

  // Many edits to one row while offline collapse into a single request. Only
  // operations that have never been sent are merged.
  coalesce: {
    key: ({ id }) => id,
    merge: (_earlier, later) => later,
  },

  invalidates: [['todos']],
})

export const operations = [createTodo, updateTodo]
