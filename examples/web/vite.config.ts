import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

interface Todo {
  id: string
  title: string
}

/**
 * A tiny in-memory API served by the dev server, so the example runs with no
 * backend to set up.
 *
 * It deliberately honours `Idempotency-Key` the way the README asks a real
 * server to: a request whose key it has already committed returns the original
 * result instead of writing a second row. Without that, the duplicate-write
 * demo below would not prove anything.
 */
function mockApi(): Plugin {
  const rows = new Map<string, Todo>()
  const committed = new Map<string, unknown>()
  let nextId = 1

  /** Flip in the browser console: `fetch('/api/_chaos?drop=1')` */
  let dropNextResponse = false
  let failNext = 0

  const readBody = async (request: import('node:http').IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  }

  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use('/api', (request, response, next) => {
        void (async () => {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const send = (status: number, body: unknown): void => {
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(body))
          }

          // Chaos controls, so you can demonstrate retries and dead letters.
          if (url.pathname === '/_chaos') {
            if (url.searchParams.has('drop')) dropNextResponse = true
            if (url.searchParams.has('fail'))
              failNext = Number(url.searchParams.get('fail') ?? 1)
            send(200, { dropNextResponse, failNext })
            return
          }

          if (request.method === 'GET' && url.pathname === '/todos') {
            send(200, [...rows.values()])
            return
          }

          const key = request.headers['idempotency-key']
          const idempotencyKey = typeof key === 'string' ? key : undefined

          if (idempotencyKey && committed.has(idempotencyKey)) {
            // Already applied. Return what we returned the first time.
            send(200, committed.get(idempotencyKey))
            return
          }

          if (failNext > 0) {
            failNext -= 1
            send(500, { message: 'Injected upstream failure' })
            return
          }

          if (request.method === 'POST' && url.pathname === '/todos') {
            const body = (await readBody(request)) as { title: string }
            const todo: Todo = { id: `srv_${nextId++}`, title: body.title }
            rows.set(todo.id, todo)
            if (idempotencyKey) committed.set(idempotencyKey, todo)
            if (dropNextResponse) {
              // Committed, but the client never hears back. The retry must not
              // create a second row — that is what the idempotency key is for.
              dropNextResponse = false
              request.destroy()
              return
            }
            send(201, todo)
            return
          }

          if (request.method === 'PATCH' && url.pathname.startsWith('/todos/')) {
            const id = url.pathname.slice('/todos/'.length)
            const existing = rows.get(id)
            if (!existing) {
              // A 4xx the client should never retry — it will never succeed.
              send(422, { message: `No such todo: ${id}` })
              return
            }
            const body = (await readBody(request)) as { title: string }
            const updated = { ...existing, title: body.title }
            rows.set(id, updated)
            if (idempotencyKey) committed.set(idempotencyKey, updated)
            send(200, updated)
            return
          }

          next()
        })()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), mockApi()],
})
