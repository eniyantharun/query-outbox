# Changelog

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below 1.0.0, minor releases may contain breaking changes;
the API stabilises at 1.0.0.

## 0.1.0

Initial release.

A durable, causally-ordered mutation queue for TanStack Query that survives app
termination, replays in dependency order, and deduplicates with idempotency keys.

### Added

- `createOutbox` — the durable queue, over injected storage, clock and network
  ports.
- `defineOperation` / `defineQueryOperation` — serialisable operations resolved
  from a module-scope registry on cold start, so replay never hits TanStack
  Query's `No mutationFn found`.
- Automatic placeholder resolution with a dependency graph, which makes offline
  create-then-edit work without a server id. Resolutions are persisted, so an
  edit still addresses the real row long after the create has synced.
- `ref(placeholderId, path)` for referencing a different field of a
  not-yet-created entity's result.
- At-least-once delivery with idempotency keys derived from the operation id
  rather than its variables, so the key stays stable when a placeholder is
  rewritten to a real id.
- Exponential backoff with full, equal or no jitter, honouring a server-supplied
  `Retry-After` as a floor. Losing connectivity mid-request does not consume a
  retry attempt.
- Coalescing of unsent operations against the same target.
- Dead-letter queue that cascades to dependents, with retry and discard.
- React bindings: `OutboxProvider`, `useOutbox`, `useOutboxStatus`,
  `useDeadLetters`, `useOutboxRecords`.
- TanStack Query bindings: `useOutboxMutation`, `useOnlineManagerSync` (which
  closes TanStack Query [#4170](https://github.com/TanStack/query/issues/4170)
  on React Native), and `useReplayOptimistic` for restoring queued writes to the
  cache after a cold start.
- Storage adapters for AsyncStorage, `localStorage` and memory; network monitors
  for NetInfo and the browser.

### Notes

- Zero runtime dependencies. Every platform package is an optional peer.
- Requires Node 20 or newer to run; Node 22 or newer to build from source.
