import { PermanentError } from 'query-outbox'
import { defineQueryOperation } from 'query-outbox/query'

import { createTodoOnServer, updateTodoOnServer, type Todo } from './fake-server'

export type { Todo }

const TODOS = ['todos'] as const

/** The on-device backend throws a plain Error named PermanentError; re-throw the real one. */
function rethrow(error: unknown): never {
  if (error instanceof Error && error.name === 'PermanentError') {
    throw new PermanentError(error.message)
  }
  throw error
}

export const createTodo = defineQueryOperation({
  name: 'todo.create',

  handler: async ({ title }: { title: string }, ctx) => {
    try {
      return await createTodoOnServer({ title }, ctx.idempotencyKey)
    } catch (error) {
      return rethrow(error)
    }
  },

  // Lets todo.update address this row before the server has named it.
  resolvesPlaceholder: (result) => result.id,

  // Replayed from disk on a cold start, which is why a queued write is still
  // on screen after a force-quit instead of silently vanishing.
  optimistic: ({ title }, { queryClient, placeholderId }) => {
    queryClient.setQueryData<Todo[]>(TODOS, (todos = []) => [
      ...todos,
      { id: placeholderId, title },
    ])
    return () => {
      queryClient.setQueryData<Todo[]>(TODOS, (todos = []) =>
        todos.filter((todo) => todo.id !== placeholderId),
      )
    }
  },

  invalidates: [TODOS],
})

export const updateTodo = defineQueryOperation({
  name: 'todo.update',

  handler: async ({ id, title }: { id: string; title: string }, ctx) => {
    try {
      return await updateTodoOnServer({ id, title }, ctx.idempotencyKey)
    } catch (error) {
      return rethrow(error)
    }
  },

  optimistic: ({ id, title }, { queryClient }) => {
    const previous = queryClient.getQueryData<Todo[]>(TODOS)
    queryClient.setQueryData<Todo[]>(TODOS, (todos = []) =>
      todos.map((todo) => (todo.id === id ? { ...todo, title } : todo)),
    )
    return () => {
      queryClient.setQueryData<Todo[]>(TODOS, previous)
    }
  },

  // Rename the same row five times offline and only one request goes out.
  // Only operations that have never been sent are merged.
  coalesce: {
    key: ({ id }) => id,
    merge: (_earlier, later) => later,
  },

  invalidates: [TODOS],
})

export const operations = [createTodo, updateTodo]
