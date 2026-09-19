// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
  useQuery,
} from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { createOutbox, type Outbox } from '../../src/core/outbox.js'
import { MemoryStorage } from '../../src/storage/memory.js'
import {
  OutboxProvider,
  useDeadLetters,
  useOutboxRecords,
  useOutboxStatus,
} from '../../src/react/index.js'
import {
  defineQueryOperation,
  useOnlineManagerSync,
  useOutboxMutation,
  useReplayOptimistic,
} from '../../src/query/index.js'
import { FakeServer, TestClock, TestNetwork, seededRandom } from '../helpers.js'

interface Todo {
  id: string
  title: string
  pending?: boolean
}

let server: FakeServer
let clock: TestClock
let network: TestNetwork
let disk: Map<string, string>
let queryClient: QueryClient

const TODOS: readonly unknown[] = ['todos']

const createTodo = defineQueryOperation({
  name: 'todo.create',
  handler: (variables: { title: string }, context) => server.createRow(variables, context),
  resolvesPlaceholder: (result: { id: string }) => result.id,
  optimistic: (variables, { queryClient: client, placeholderId }) => {
    const previous = client.getQueryData<Todo[]>(TODOS) ?? []
    client.setQueryData<Todo[]>(TODOS, [
      ...previous,
      { id: placeholderId, title: variables.title, pending: true },
    ])
    return () => {
      client.setQueryData<Todo[]>(
        TODOS,
        (current) => current?.filter((todo) => todo.id !== placeholderId) ?? [],
      )
    }
  },
  invalidates: [TODOS],
})

function makeOutbox(): Outbox {
  return createOutbox({
    operations: [createTodo],
    storage: new MemoryStorage(disk),
    clock,
    network,
    random: seededRandom(21),
  })
}

function wrapper(outbox: Outbox) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <OutboxProvider outbox={outbox}>{children}</OutboxProvider>
      </QueryClientProvider>
    )
  }
}

beforeEach(() => {
  server = new FakeServer()
  clock = new TestClock()
  network = new TestNetwork(true)
  disk = new Map()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
})

describe('useOutboxMutation', () => {
  it('resolves once the write is durable, not once it is sent', async () => {
    network.setOnline(false)
    const outbox = makeOutbox()
    let result: ReturnType<typeof useOutboxMutation<{ title: string }, { id: string }>>

    function Screen(): ReactNode {
      result = useOutboxMutation(createTodo)
      return <span data-testid="status">{result.status}</span>
    }

    render(<Screen />, { wrapper: wrapper(outbox) })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('idle'))

    await act(async () => {
      await result.mutate({ title: 'Offline' })
    })

    // Nothing reached the server, but the operation is on disk and the hook
    // reports it as accepted.
    expect(server.received).toHaveLength(0)
    expect([...disk.keys()].some((key) => key.includes(':op:'))).toBe(true)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('queued'))
  })

  it('applies an optimistic row immediately and reconciles it on success', async () => {
    // Offline first, so the optimistic state is observable rather than a
    // frame-long flicker between enqueue and the server's reply.
    network.setOnline(false)
    const outbox = makeOutbox()
    let mutate!: (variables: { title: string }) => Promise<unknown>

    function Screen(): ReactNode {
      const mutation = useOutboxMutation(createTodo)
      mutate = mutation.mutate
      const { data } = useQuery({
        queryKey: TODOS,
        queryFn: () => [...server.rows.values()] as unknown as Todo[],
      })
      return (
        <ul>
          {(data ?? []).map((todo) => (
            <li key={todo.id} data-testid="todo">
              {todo.title}
              {todo.pending === true ? ' (pending)' : ''}
            </li>
          ))}
        </ul>
      )
    }

    render(<Screen />, { wrapper: wrapper(outbox) })
    await waitFor(() => expect(screen.queryAllByTestId('todo')).toHaveLength(0))

    await act(async () => {
      await mutate({ title: 'Buy milk' })
    })

    // Optimistic row is on screen before the server has answered.
    await waitFor(() => {
      expect(screen.getByTestId('todo')).toHaveTextContent('Buy milk (pending)')
    })

    expect(server.received).toHaveLength(0)

    await act(async () => {
      network.setOnline(true)
      await outbox.drain()
    })

    // Once it syncs, the invalidation replaces the optimistic row with the
    // server's, and the pending marker goes away.
    await waitFor(() => {
      expect(screen.getByTestId('todo')).toHaveTextContent('Buy milk')
      expect(screen.getByTestId('todo')).not.toHaveTextContent('pending')
    })
    expect(server.rows.size).toBe(1)
  })

  it('rolls the optimistic row back when the operation is dead-lettered', async () => {
    server.failPermanentlyNext = 1
    const outbox = makeOutbox()
    let mutate!: (variables: { title: string }) => Promise<unknown>

    function Screen(): ReactNode {
      mutate = useOutboxMutation(createTodo).mutate
      const rows = queryClient.getQueryData<Todo[]>(TODOS) ?? []
      return <span data-testid="count">{rows.length}</span>
    }

    render(<Screen />, { wrapper: wrapper(outbox) })

    await act(async () => {
      await mutate({ title: 'Doomed' })
    })
    await act(async () => {
      await outbox.drain()
    })

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'))
    expect(outbox.getDeadLetters()).toHaveLength(1)
  })

  it('mutateAsync waits for the server, mutate does not', async () => {
    const outbox = makeOutbox()
    let mutateAsync!: (variables: { title: string }) => Promise<{ id: string }>

    function Screen(): ReactNode {
      mutateAsync = useOutboxMutation(createTodo).mutateAsync
      return null
    }
    render(<Screen />, { wrapper: wrapper(outbox) })

    await act(async () => {
      const settled = await mutateAsync({ title: 'Awaited' })
      expect(settled.id).toBe('srv_1')
    })
    expect(server.rows.size).toBe(1)
  })
})

describe('useOutboxStatus', () => {
  it('tracks connectivity and queue depth', async () => {
    network.setOnline(false)
    const outbox = makeOutbox()
    let mutate!: (variables: { title: string }) => Promise<unknown>

    function Screen(): ReactNode {
      const snapshot = useOutboxStatus()
      mutate = useOutboxMutation(createTodo).mutate
      return (
        <span data-testid="s">
          {snapshot.status}:{snapshot.pending}
        </span>
      )
    }

    render(<Screen />, { wrapper: wrapper(outbox) })
    await waitFor(() => expect(screen.getByTestId('s')).toHaveTextContent('idle:0'))

    await act(async () => {
      await mutate({ title: 'Queued' })
    })
    await waitFor(() => expect(screen.getByTestId('s')).toHaveTextContent('offline:1'))

    await act(async () => {
      network.setOnline(true)
      await outbox.drain()
    })
    await waitFor(() => expect(screen.getByTestId('s')).toHaveTextContent('idle:0'))
  })

  it('survives StrictMode double-mounting', async () => {
    const outbox = makeOutbox()
    function Screen(): ReactNode {
      const snapshot = useOutboxStatus()
      return <span data-testid="s">{snapshot.status}</span>
    }

    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <OutboxProvider outbox={outbox}>
            <Screen />
          </OutboxProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByTestId('s')).toBeInTheDocument())
  })

  it('throws a useful error outside a provider', () => {
    function Orphan(): ReactNode {
      useOutboxStatus()
      return null
    }
    expect(() => render(<Orphan />)).toThrow(/inside an <OutboxProvider>/)
  })
})

describe('useDeadLetters', () => {
  it('lists failures and can retry them', async () => {
    server.failPermanentlyNext = 1
    const outbox = makeOutbox()
    let mutate!: (variables: { title: string }) => Promise<unknown>
    let controls!: ReturnType<typeof useDeadLetters>

    function Screen(): ReactNode {
      mutate = useOutboxMutation(createTodo).mutate
      controls = useDeadLetters()
      return <span data-testid="dead">{controls.deadLetters.length}</span>
    }

    render(<Screen />, { wrapper: wrapper(outbox) })
    await act(async () => {
      await mutate({ title: 'Will fail' })
    })
    await act(async () => {
      await outbox.drain()
    })
    await waitFor(() => expect(screen.getByTestId('dead')).toHaveTextContent('1'))

    await act(async () => {
      await controls.retry(controls.deadLetters[0]!.id)
      await outbox.drain()
    })
    await waitFor(() => expect(screen.getByTestId('dead')).toHaveTextContent('0'))
    expect(server.rows.size).toBe(1)
  })

  it('returns a stable array identity while nothing changes', async () => {
    const outbox = makeOutbox()
    const seen: unknown[] = []
    function Screen(): ReactNode {
      seen.push(useDeadLetters().deadLetters)
      return null
    }
    const { rerender } = render(<Screen />, { wrapper: wrapper(outbox) })
    rerender(<Screen />)
    await waitFor(() => expect(seen.length).toBeGreaterThan(1))
    expect(seen[0]).toBe(seen[seen.length - 1])
  })
})

describe('useReplayOptimistic', () => {
  it('re-applies queued writes to the cache after a cold start', async () => {
    // Boot one: queue a write while offline, then "close the app".
    network.setOnline(false)
    const first = makeOutbox()
    await first.start()
    await first.enqueue(createTodo, { title: 'Written on the train' }).persisted
    first.stop()

    expect(disk.size).toBeGreaterThan(0)

    // Boot two: a fresh cache with nothing in it.
    const second = makeOutbox()
    function Screen(): ReactNode {
      useReplayOptimistic({ operations: [createTodo] as never })
      useOutboxRecords()
      const rows = queryClient.getQueryData<Todo[]>(TODOS) ?? []
      return <span data-testid="rows">{rows.map((row) => row.title).join(',')}</span>
    }

    render(<Screen />, { wrapper: wrapper(second) })

    // The unsent edit is visible again instead of silently disappearing.
    await waitFor(() => {
      expect(screen.getByTestId('rows')).toHaveTextContent('Written on the train')
    })
    second.stop()
  })
})

describe('useOnlineManagerSync', () => {
  it('drives TanStack Query onlineManager from the outbox network source', async () => {
    const outbox = makeOutbox()
    function Screen(): ReactNode {
      useOnlineManagerSync(outbox)
      useOutboxStatus()
      return null
    }
    render(<Screen />, { wrapper: wrapper(outbox) })
    await waitFor(() => expect(onlineManager.isOnline()).toBe(true))

    await act(async () => {
      network.setOnline(false)
      await outbox.drain()
    })
    // Without this wiring onlineManager would still report online and
    // TanStack mutations would reject instead of pausing (issue #4170).
    await waitFor(() => expect(onlineManager.isOnline()).toBe(false))

    await act(async () => {
      network.setOnline(true)
    })
    await waitFor(() => expect(onlineManager.isOnline()).toBe(true))
  })
})
