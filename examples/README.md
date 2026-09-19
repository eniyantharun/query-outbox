# Examples

Two apps exercising the same operations against the same outbox core.

- **`react-native/`** — Expo, AsyncStorage, NetInfo. The one to run if you want to
  see the actual guarantee: turn on airplane mode, create a todo, edit it,
  force-quit the app, relaunch, turn the network back on.
- **`web/`** — Vite, localStorage, `navigator.onLine`. Same flow using DevTools →
  Network → Offline, and a hard reload in place of the force-quit.

Neither is wired into the root workspace. Each installs `query-outbox` from the
packed tarball, so it exercises the published artifact rather than `src/`:

```bash
npm run build && npm pack          # in the repo root
cd examples/react-native
npm install ../../query-outbox-0.1.0.tgz
npx expo start
```

## The scenario worth trying

1. Go offline.
2. Create a todo. It appears immediately, marked pending.
3. **Edit that same todo.** There is no server id yet — this is the case that
   fails with a plain persisted `useMutation`.
4. Force-quit the app.
5. Relaunch. The pending todo is still on screen, because the optimistic effect
   is replayed from disk.
6. Go online. Watch the network log: one POST, then one PATCH, in that order,
   with the PATCH addressing the id the POST returned.

## What to watch for

The `onEvent` hook in each example logs every state transition. Going offline
mid-request produces a `paused` event rather than a `failed` one — that is the
retry budget deliberately _not_ being spent on something that was not the
write's fault.
