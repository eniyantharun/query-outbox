# Examples

Two runnable apps built on the same operations, both installing `query-outbox`
from npm so they exercise the published package rather than `src/`.

- **[`react-native/`](./react-native)** — Expo, AsyncStorage, NetInfo. The one to
  run if you want to see the actual guarantee, because you can put a real device
  in airplane mode and force-quit the app.
- **[`web/`](./web)** — Vite, `localStorage`, `navigator.onLine`. Same flow using
  DevTools → Network → Offline, with a hard reload standing in for the force-quit.

## React Native

```bash
cd examples/react-native
npm install
npx expo start
```

Then press `i` for iOS, `a` for Android, or scan the QR code with Expo Go.

There is no backend to run. `fake-server.ts` is a pretend server living on the
device, storing rows in AsyncStorage under its own key and honouring the
idempotency key exactly as a real server should. That is not a shortcut around
the demo: the outbox decides whether to send based on what NetInfo reports, not
on whether a request happens to fail, so airplane mode still exercises the real
code path.

## Web

```bash
cd examples/web
npm install
npm run dev
```

The Vite dev server serves a small in-memory `/api` that also honours
`Idempotency-Key`, so the duplicate-write behaviour below is real rather than
simulated.

## The scenario worth trying

This is the one that fails with a plain persisted `useMutation`:

1. **Go offline.** Airplane mode, or DevTools → Network → Offline. The banner
   turns amber.
2. **Add a todo.** It appears immediately, dimmed — that is the optimistic row,
   written under a placeholder id.
3. **Tap it to rename it.** There is no server id yet. This is the step that
   normally breaks.
4. **Force-quit the app** (or hard-reload the tab).
5. **Reopen it.** The todo is still there, still dimmed. The optimistic effect
   was replayed from disk rather than silently disappearing.
6. **Go back online.** Watch the console: one create, then one rename, in that
   order, with the rename addressing the id the create returned.

## The other behaviours

Each example has controls for the failure modes that are otherwise hard to
produce on demand:

| Control                                    | What it shows                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fail next 2**                            | Transient failures. The write retries with exponential backoff and eventually lands. Nothing is lost.                                       |
| **Drop next reply**                        | The server commits but the response never arrives. The outbox retries; the idempotency key means the server applies it **once**, not twice. |
| Rename one row several times while offline | Coalescing. The renames collapse into a single request, because none of them had been sent yet.                                             |
| Rename a row the server does not have      | A permanent failure. It dead-letters immediately instead of burning eight retries, and the UI offers retry or discard.                      |

On the web the same controls are available from the console:

```js
fetch('/api/_chaos?fail=2') // fail the next two writes
fetch('/api/_chaos?drop=1') // commit the next write but drop its response
```

## What to watch in the logs

Both examples log every outbox event. The one worth noticing is `paused`:
losing connectivity mid-request emits that rather than `failed`, because the
retry budget deliberately is not spent on something that was not the write's
fault.
