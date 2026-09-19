import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { createOutbox, PermanentError } from 'query-outbox'
import { createBrowserNetworkMonitor } from 'query-outbox/net/browser'
import {
  defineQueryOperation,
  useOnlineManagerSync,
  useOutboxMutation,
  useReplayOptimistic,
} from 'query-outbox/query'
import { OutboxProvider, useDeadLetters, useOutboxStatus } from 'query-outbox/react'
import { createLocalStorage } from 'query-outbox/storage/local-storage'
import { useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

interface Todo {
  id: string
  title: string
  pending?: boolean
}

const api = async <T,>(path: string, init: RequestInit, key: string): Promise<T> => {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...init.headers },
  })
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new PermanentError(`Rejected: ${response.status}`)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

const createTodo = defineQueryOperation({
  name: 'todo.create',
  handler: ({ title }: { title: string }, ctx) =>
    api<Todo>(
      '/todos',
      { method: 'POST', body: JSON.stringify({ title }) },
      ctx.idempotencyKey,
    ),
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

const renameTodo = defineQueryOperation({
  name: 'todo.rename',
  handler: ({ id, title }: { id: string; title: string }, ctx) =>
    api<Todo>(
      `/todos/${id}`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
      ctx.idempotencyKey,
    ),
  coalesce: { key: ({ id }) => id, merge: (_earlier, later) => later },
  invalidates: [['todos']],
})

const operations = [createTodo, renameTodo]

const outbox = createOutbox({
  operations,
  storage: createLocalStorage(),
  network: createBrowserNetworkMonitor(),
  onEvent: (event) => console.log('[outbox]', event.type, event),
})

const queryClient = new QueryClient()

function App(): ReactElement {
  const [title, setTitle] = useState('')
  const create = useOutboxMutation(createTodo)
  const rename = useOutboxMutation(renameTodo)
  const { status, pending, dead } = useOutboxStatus()
  const { deadLetters, retry, discard } = useDeadLetters()

  useOnlineManagerSync(outbox)
  useReplayOptimistic({ operations })

  const { data: todos = [] } = useQuery<Todo[]>({
    queryKey: ['todos'],
    queryFn: async () => (await fetch('/api/todos')).json() as Promise<Todo[]>,
  })

  return (
    <main>
      <p>
        {status} · {pending} queued{dead > 0 ? ` · ${dead} failed` : ''}
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void create.mutate({ title })
          setTitle('')
        }}
      >
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
        <button type="submit">Add</button>
      </form>

      <ul>
        {todos.map((todo) => (
          <li key={todo.id} style={{ opacity: todo.pending === true ? 0.5 : 1 }}>
            {todo.title} {/* todo.id may still be a placeholder; the outbox resolves it. */}
            <button
              onClick={() => void rename.mutate({ id: todo.id, title: `${todo.title}!` })}
            >
              Rename
            </button>
          </li>
        ))}
      </ul>

      {deadLetters.map((record) => (
        <p key={record.id}>
          Could not save {record.name}: {record.lastError?.message}
          <button onClick={() => void retry(record.id)}>Retry</button>
          <button onClick={() => void discard(record.id)}>Discard</button>
        </p>
      ))}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <OutboxProvider outbox={outbox}>
      <App />
    </OutboxProvider>
  </QueryClientProvider>,
)
