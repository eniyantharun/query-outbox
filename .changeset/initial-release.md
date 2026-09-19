---
'query-outbox': minor
---

Initial release.

A durable, causally-ordered mutation queue for TanStack Query that survives app
termination, replays in dependency order, and deduplicates with idempotency keys.

- `defineOperation` / `defineQueryOperation` — serialisable operations resolved
  from a module-scope registry on cold start, so replay never hits
  `No mutationFn found`.
- Automatic placeholder resolution, making offline create-then-edit work without
  a server id.
- At-least-once delivery with stable idempotency keys derived from the operation
  id rather than its variables.
- Exponential backoff with full jitter; connectivity loss does not consume a
  retry attempt.
- Dead-letter queue with cascade to dependents, plus retry and discard.
- Adapters for AsyncStorage, localStorage, in-memory, NetInfo and the browser.
