import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  useOnlineManagerSync,
  useOutboxMutation,
  useReplayOptimistic,
} from 'query-outbox/query'
import { OutboxProvider, useDeadLetters, useOutboxStatus } from 'query-outbox/react'
import { useState, type ReactElement } from 'react'
import {
  Button,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { chaos, listTodos, resetServer } from './fake-server'
import { createTodo, operations, updateTodo, type Todo } from './operations'
import { outbox } from './outbox'

const queryClient = new QueryClient()
const TODOS = ['todos'] as const

function Sync(): null {
  // Without this, TanStack Query believes the device is permanently online and
  // its own mutations reject instead of pausing (TanStack Query #4170).
  useOnlineManagerSync(outbox)

  // Re-applies queued writes to the cache after a cold start, so unsent edits
  // do not silently vanish from the screen on relaunch.
  useReplayOptimistic({ operations })

  return null
}

function StatusBanner(): ReactElement {
  const { status, pending, dead, online } = useOutboxStatus()

  const background =
    status === 'offline'
      ? '#fde68a'
      : status === 'blocked'
        ? '#fecaca'
        : status === 'syncing'
          ? '#bfdbfe'
          : '#e5e7eb'

  return (
    <View style={[styles.banner, { backgroundColor: background }]}>
      <Text style={styles.bannerText}>
        {online ? 'online' : 'OFFLINE'} · {status}
        {pending > 0 ? ` · ${pending} waiting` : ''}
        {dead > 0 ? ` · ${dead} failed` : ''}
      </Text>
    </View>
  )
}

function Failures(): ReactElement | null {
  const { deadLetters, retry, discard } = useDeadLetters()
  if (deadLetters.length === 0) return null

  return (
    <View style={styles.failures}>
      {deadLetters.map((record) => (
        <View key={record.id} style={styles.failureRow}>
          <Text style={styles.failureText}>
            Could not save {record.name}: {record.lastError?.message}
          </Text>
          <View style={styles.row}>
            <Button title="Try again" onPress={() => void retry(record.id)} />
            <Button title="Discard" onPress={() => void discard(record.id)} />
          </View>
        </View>
      ))}
    </View>
  )
}

function Todos(): ReactElement {
  const [title, setTitle] = useState('')
  const create = useOutboxMutation(createTodo)
  const rename = useOutboxMutation(updateTodo)

  const { data: todos = [], refetch } = useQuery<Todo[]>({
    queryKey: TODOS,
    queryFn: listTodos,
  })

  return (
    <View style={styles.flex}>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="New todo"
          onSubmitEditing={() => {
            if (!title.trim()) return
            void create.mutate({ title })
            setTitle('')
          }}
        />
        <Button
          title="Add"
          onPress={() => {
            if (!title.trim()) return
            // Resolves once the write is on disk, not once it reaches the server.
            void create.mutate({ title })
            setTitle('')
          }}
        />
      </View>

      <FlatList
        data={todos}
        keyExtractor={(todo) => todo.id}
        ListEmptyComponent={<Text style={styles.empty}>Nothing yet. Add a todo.</Text>}
        renderItem={({ item }) => {
          const unsent = item.id.startsWith('ph_')
          return (
            <Pressable
              style={[styles.todo, unsent && styles.todoPending]}
              onPress={() => {
                // item.id may still be a placeholder. Passing it is fine: the
                // outbox orders the rename behind the create and rewrites the
                // id once the server assigns one.
                void rename.mutate({ id: item.id, title: `${item.title}!` })
              }}
            >
              <Text style={styles.todoTitle}>{item.title}</Text>
              <Text style={styles.todoMeta}>
                {unsent ? 'not yet synced · tap to rename' : item.id}
              </Text>
            </Pressable>
          )
        }}
      />

      <View style={styles.tools}>
        <Button title="Refetch" onPress={() => void refetch()} />
        <Button
          title="Fail next 2"
          onPress={() => {
            chaos.failNext += 2
          }}
        />
        <Button
          title="Drop next reply"
          onPress={() => {
            chaos.loseResponseNext += 1
          }}
        />
        <Button
          title="Reset"
          onPress={() => {
            void (async () => {
              await outbox.clear()
              await resetServer()
              queryClient.setQueryData(TODOS, [])
              await refetch()
            })()
          }}
        />
      </View>
    </View>
  )
}

export default function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <OutboxProvider outbox={outbox}>
        <SafeAreaView style={styles.flex}>
          <Sync />
          <StatusBanner />
          <Failures />
          <Todos />
        </SafeAreaView>
      </OutboxProvider>
    </QueryClientProvider>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#fff' },
  banner: { paddingVertical: 10, paddingHorizontal: 16 },
  bannerText: { fontSize: 13, fontWeight: '600', color: '#111' },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  todo: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  todoPending: { opacity: 0.5 },
  todoTitle: { fontSize: 16, color: '#111' },
  todoMeta: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  empty: { padding: 24, textAlign: 'center', color: '#6b7280' },
  failures: { backgroundColor: '#fee2e2', padding: 12 },
  failureRow: { marginBottom: 8 },
  failureText: { color: '#991b1b', marginBottom: 4 },
  row: { flexDirection: 'row', gap: 8 },
  tools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
})
