import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  useOnlineManagerSync,
  useOutboxMutation,
  useReplayOptimistic,
} from 'query-outbox/query'
import { OutboxProvider, useDeadLetters, useOutboxStatus } from 'query-outbox/react'
import { useState, type ReactElement } from 'react'
import { Button, FlatList, Text, TextInput, View } from 'react-native'

import { createTodo, operations, updateTodo, type Todo } from './operations'
import { outbox } from './outbox'

const queryClient = new QueryClient()

function Sync(): null {
  // Without this, TanStack Query believes the device is permanently online and
  // its own mutations reject instead of pausing (TanStack Query #4170).
  useOnlineManagerSync(outbox)

  // Re-applies queued writes to the cache after a cold start, so unsent edits
  // do not silently vanish from the screen on relaunch.
  useReplayOptimistic({ operations })

  return null
}

function StatusBanner(): ReactElement | null {
  const { status, pending, dead } = useOutboxStatus()
  if (status === 'idle') return null

  return (
    <View style={{ padding: 8, backgroundColor: status === 'offline' ? '#fde68a' : '#bfdbfe' }}>
      <Text>
        {status === 'offline' ? `Offline — ${pending} waiting to sync` : `Syncing ${pending}…`}
        {dead > 0 ? ` · ${dead} could not be saved` : ''}
      </Text>
    </View>
  )
}

function Failures(): ReactElement | null {
  const { deadLetters, retry, discard } = useDeadLetters()
  if (deadLetters.length === 0) return null

  return (
    <View style={{ padding: 8, backgroundColor: '#fecaca' }}>
      {deadLetters.map((record) => (
        <View key={record.id}>
          <Text>
            Could not save {record.name}: {record.lastError?.message}
          </Text>
          <Button title="Try again" onPress={() => void retry(record.id)} />
          <Button title="Discard" onPress={() => void discard(record.id)} />
        </View>
      ))}
    </View>
  )
}

function Todos(): ReactElement {
  const [title, setTitle] = useState('')
  const create = useOutboxMutation(createTodo)
  const update = useOutboxMutation(updateTodo)

  const { data: todos = [] } = useQuery<Todo[]>({
    queryKey: ['todos'],
    queryFn: async () => {
      const response = await fetch('https://api.example.com/todos')
      return (await response.json()) as Todo[]
    },
  })

  return (
    <View style={{ flex: 1 }}>
      <TextInput value={title} onChangeText={setTitle} placeholder="New todo" />
      <Button
        title="Add"
        onPress={() => {
          // Resolves once the write is on disk, not once it reaches the server.
          void create.mutate({ title })
          setTitle('')
        }}
      />

      <FlatList
        data={todos}
        keyExtractor={(todo) => todo.id}
        renderItem={({ item }) => (
          <View style={{ opacity: item.pending === true ? 0.5 : 1 }}>
            <Text>{item.title}</Text>
            {/*
              `item.id` may still be a placeholder if this row has not synced
              yet. Passing it is fine: the outbox orders the edit behind the
              create and rewrites the id once the server assigns one.
            */}
            <Button
              title="Rename"
              onPress={() => void update.mutate({ id: item.id, title: `${item.title}!` })}
            />
          </View>
        )}
      />
    </View>
  )
}

export default function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <OutboxProvider outbox={outbox}>
        <Sync />
        <StatusBanner />
        <Failures />
        <Todos />
      </OutboxProvider>
    </QueryClientProvider>
  )
}
