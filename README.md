# query-outbox

[![CI](https://github.com/eniyantharun/query-outbox/actions/workflows/ci.yml/badge.svg)](https://github.com/eniyantharun/query-outbox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/query-outbox.svg)](https://www.npmjs.com/package/query-outbox)
[![bundle size](https://img.shields.io/bundlephobia/minzip/query-outbox)](https://bundlephobia.com/package/query-outbox)
[![license](https://img.shields.io/npm/l/query-outbox.svg)](./LICENSE)

**A durable, causally-ordered mutation queue for TanStack Query.** Writes survive app termination, replay in dependency order, and never double-apply.

Built for React Native first, works on the web. It wraps the `useMutation` API you already have — there is no data layer to rewrite.

```
npm install query-outbox
```

---

## The problem

TanStack Query pauses mutations when the device goes offline. It does not durably resume them, and its own documentation is explicit about why:

> When persisting to an external storage, only the state of mutations is persisted, as functions cannot be serialized.
>
> After hydration, the component that triggers the mutation might not be mounted, so calling `resumePausedMutations` might yield an error: `No mutationFn found`.

In practice that leaves six gaps that bite real apps:

|                      | What happens today                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cold start**       | `setMutationDefaults` must be hand-wired per mutation key, or resumption throws.                                                                |
| **Ordering**         | `resumePausedMutations()` resumes every paused mutation **concurrently**. Offline edits replay out of order.                                    |
| **Create-then-edit** | Editing something you created offline is impossible: the server id does not exist yet.                                                          |
| **Duplicates**       | A request whose response was lost in flight is replayed as a second write.                                                                      |
| **Poison messages**  | A mutation that can never succeed retries until its budget is gone, every launch.                                                               |
| **React Native**     | `onlineManager` has no default event source, so mutations _reject_ instead of pausing ([#4170](https://github.com/TanStack/query/issues/4170)). |

`query-outbox` closes all six, and keeps your existing queries, cache, and components.

## Quick start

**1. Define operations at module scope.** This is the part that makes cold starts work: a persisted record stores only a `name`, and the function is looked up from the registry on the next launch. Nothing is ever expected to survive serialisation.

```ts
// operations.ts
import { defineQueryOperation } from 'query-outbox/query'

export const createTodo = defineQueryOperation({
  name: 'todo.create',
  handler: async ({ title }: { title: string }, ctx) => {
    const response = await fetch('/api/todos', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': ctx.idempotencyKey,
      },
      body: JSON.stringify({ title }),
      signal: ctx.signal,
    })
    if (response.status === 422) throw new PermanentError('Rejected by the server')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as { id: string; title: string }
  },

  // Lets a later edit address this row before the server has named it.
  resolvesPlaceholder: (result) => result.id,

  // Replayed from disk on cold start, so queued writes stay visible.
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
```

**2. Create the outbox once.**

```ts
// outbox.ts  (React Native)
import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import { createOutbox } from 'query-outbox'
import { createAsyncStorage } from 'query-outbox/storage/async-storage'
import { createNetInfoMonitor } from 'query-outbox/net/netinfo'

import { createTodo, updateTodo } from './operations'

export const outbox = createOutbox({
  operations: [createTodo, updateTodo],
  storage: createAsyncStorage(AsyncStorage),
  network: createNetInfoMonitor(NetInfo),
})
```

On the web, swap two imports:

```ts
import { createLocalStorage } from 'query-outbox/storage/local-storage'
import { createBrowserNetworkMonitor } from 'query-outbox/net/browser'

export const outbox = createOutbox({
  operations: [createTodo, updateTodo],
  storage: createLocalStorage(),
  network: createBrowserNetworkMonitor(),
})
```

**3. Mount the provider.**

```tsx
import { QueryClientProvider } from '@tanstack/react-query'
import { OutboxProvider } from 'query-outbox/react'
import { useOnlineManagerSync, useReplayOptimistic } from 'query-outbox/query'

function Sync() {
  useOnlineManagerSync(outbox) // fixes TanStack #4170
  useReplayOptimistic({ operations: [createTodo, updateTodo] })
  return null
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <OutboxProvider outbox={outbox}>
        <Sync />
        <Screens />
      </OutboxProvider>
    </QueryClientProvider>
  )
}
```

**4. Mutate.**

```tsx
import { useOutboxMutation, useOutboxStatus } from 'query-outbox/query'

function AddTodo() {
  const { mutate, isQueued } = useOutboxMutation(createTodo)
  const { status, pending } = useOutboxStatus()

  return (
    <>
      <Button onPress={() => mutate({ title: 'Buy milk' })} />
      {status === 'offline' && <Text>{pending} waiting to sync</Text>}
    </>
  )
}
```

`mutate` resolves when the write is **on disk**, not when it reaches the server. That is the entire contract: once it resolves, killing the app cannot lose the write.

## Editing something you created offline

This is the case nothing else handles on top of plain `useMutation`, and it needs no special syntax:

```ts
const { placeholderId } = await mutate({ title: 'Draft' })

// Still offline. There is no server id — and it does not matter.
await updateTodo.mutate({ id: placeholderId, title: 'Final' })
```

The outbox scans variables for placeholders, builds a dependency graph, and topologically orders the queue. When the create finally lands, every queued reference to that placeholder is rewritten to the real id **before** the edit is sent. Your UI just passes the optimistic id around like any other id.

Resolutions are persisted, so this keeps working after the create has synced and the screen is still holding the optimistic id:

```ts
// hours later, nothing has refetched — this still addresses the real row
await updateTodo.mutate({ id: placeholderId, title: 'Later' })
```

Need a different field of the parent's result? Use `ref`:

```ts
import { ref } from 'query-outbox'

await attachFile.mutate({ todoId: placeholderId, revision: ref(placeholderId, 'revision') })
```

## What it guarantees

- **At-least-once delivery**, becoming effectively exactly-once against a server that honours `Idempotency-Key`.
- **FIFO within a dependency chain**; independent chains run in parallel up to `concurrency`.
- **Durable enqueue** — persisted before `mutate()` resolves.
- **Bounded** — `maxAttempts`, `maxQueueSize`, then a dead letter you can inspect and retry.

### What your server has to do

One thing: **treat `Idempotency-Key` as a deduplication key.** Store it with the result of the write; if you see it again, return the original result instead of writing again.

Without that, `query-outbox` still guarantees ordering, durability, and delivery — but a request whose response was lost in transit will be applied twice, and no client-side library can prevent that. This is why the guarantee above says _at-least-once_, not _exactly-once_: exactly-once delivery is impossible over an unreliable network. You get exactly-once _effects_ by making the effect idempotent.

The key is derived from the operation id, not from the variables. That is deliberate — a content hash would change the instant a placeholder was rewritten to a real id, which is precisely when deduplication needs to hold.

## Handling permanent failures

```tsx
import { useDeadLetters } from 'query-outbox/react'

function SyncProblems() {
  const { deadLetters, retry, discard } = useDeadLetters()

  return deadLetters.map((record) => (
    <Row key={record.id} title={`Couldn't save: ${record.lastError?.message}`}>
      <Button title="Try again" onPress={() => retry(record.id)} />
      <Button title="Discard" onPress={() => discard(record.id)} />
    </Row>
  ))
}
```

Throw `PermanentError` from a handler (or supply `classifyError`) to dead-letter immediately rather than burning eight retries on a 422 that will never succeed. Dependents of a dead-lettered operation are dead-lettered too — a child of a row that will never exist cannot succeed either, and failing the whole chain at once beats leaking one dead letter per retry cycle.

## API

### Core

| Export                              | Purpose                                         |
| ----------------------------------- | ----------------------------------------------- |
| `createOutbox(options)`             | Builds the queue.                               |
| `defineOperation(definition)`       | Declares a serialisable operation.              |
| `ref(placeholderId, path?)`         | References a field of a not-yet-created entity. |
| `PermanentError` / `RetryableError` | Control retry disposition and `Retry-After`.    |

`createOutbox` options: `operations`, `storage`, `network`, `clock`, `random`, `prefix`, `concurrency` (default 4), `maxQueueSize` (default 1000), `onEvent`.

`Outbox` methods: `start`, `stop`, `enqueue`, `getSnapshot`, `subscribe`, `list`, `drain`, `getDeadLetters`, `retryDeadLetter`, `discardDeadLetter`, `clear`.

### React — `query-outbox/react`

`OutboxProvider`, `useOutbox`, `useOutboxStatus`, `useDeadLetters`, `useOutboxRecords`.

### TanStack Query — `query-outbox/query`

`defineQueryOperation`, `useOutboxMutation`, `useOnlineManagerSync`, `useReplayOptimistic`.

### Adapters

`query-outbox/storage/async-storage` · `/storage/local-storage` · `/storage/memory` · `/net/netinfo` · `/net/browser`

All platform packages are **optional** peer dependencies. A web app never installs React Native modules, and vice versa. MMKV and SQLite adapters are planned; the `OutboxStorage` interface is four methods, so writing your own is straightforward.

## Retry policy

```ts
retry: { maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 300_000, jitter: 'full' }
```

`full` jitter is the default and the choice matters at scale. When a cell tower comes back, every device behind it reconnects at once; without jitter they all retry at exactly `base * 2^n` and hit the origin in synchronised waves. Full jitter spreads each retry uniformly across the window.

Losing connectivity mid-request does **not** consume an attempt. Otherwise a commuter going through a tunnel would exhaust the retry budget of every queued write and they would all dead-letter on arrival.

## How it compares

|                                        | `query-outbox`      | TanStack Query persister       | TanStack DB + offline-transactions | WatermelonDB / PowerSync |
| -------------------------------------- | ------------------- | ------------------------------ | ---------------------------------- | ------------------------ |
| Works with existing `useMutation` code | ✅                  | ✅                             | ❌ rewrite to collections          | ❌ rewrite to a local DB |
| Survives app kill                      | ✅                  | ⚠️ needs `setMutationDefaults` | ✅                                 | ✅                       |
| Ordered replay                         | ✅ dependency graph | ❌ concurrent                  | ✅                                 | ✅                       |
| Offline create-then-edit               | ✅ automatic        | ❌                             | ✅                                 | ✅                       |
| Idempotency keys                       | ✅                  | ❌                             | ❌                                 | varies                   |
| Dead-letter queue                      | ✅                  | ❌                             | ❌                                 | ❌                       |
| Extra infrastructure                   | none                | none                           | SQLite                             | a sync service           |

If you want a full local-first database, use PowerSync or WatermelonDB — they solve a bigger problem. `query-outbox` is for the much more common case: an app that is server-driven and just needs its writes to survive the subway.

## Testing

The queue is a pure state machine over injected `Storage`, `Clock`, and `Network` ports. `src/core` imports nothing — not React, not React Native, not TanStack Query — and a lint rule enforces it. That is what makes the test suite possible:

- **Crash simulation.** The process is killed after each of the first _n_ storage writes in turn, then restarted on the same disk, asserting no lost, duplicated, or misordered writes at any cut point.
- **Property tests** (`fast-check`) over randomised interleavings of enqueue, offline, online, crash, and server failure, asserting that commits always equal distinct idempotency keys and that no unresolved placeholder ever reaches the server.
- **Fault injection** — failing writes, torn writes, corrupt records, a dead store.

A corrupt record is dropped rather than blocking startup. A failing store backs off rather than spinning.

## Requirements

Node ≥ 20 · React ≥ 18 · TanStack Query v5 (optional — the core works standalone)

## License

MIT
