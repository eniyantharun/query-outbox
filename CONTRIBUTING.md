# Contributing

```bash
npm install
npm run verify     # lint, format, typecheck, test, build, exports check
```

`verify` runs exactly what CI runs, so a green local run means a green CI run.

**Node 22+ is required to develop this package**, because tsdown needs
`Promise.withResolvers`. Consumers only need Node 20, which is what
`engines.node` advertises and what CI proves by running the whole suite on 20 —
it just skips the bundler there.

## The one architectural rule

**`src/core` imports nothing.** Not React, not React Native, not TanStack Query.
Everything platform-specific enters through `OutboxStorage`, `Clock`, or
`NetworkMonitor` in `src/core/ports.ts`. An ESLint rule enforces this.

This is not tidiness for its own sake. It is what makes the queue a plain state
machine that can be driven deterministically in Node, which in turn is what
makes the crash simulation and property tests possible. If the core ever needs a
platform import, the port is missing — add the port.

## Layout

```
src/core/       the state machine: queue, scheduler, backoff, refs, resolutions
src/react/      OutboxProvider and hooks (React only)
src/query/      TanStack Query binding (React + TanStack Query)
src/storage/    OutboxStorage implementations
src/net/        NetworkMonitor implementations
```

## Tests

| File                            | Covers                                                   |
| ------------------------------- | -------------------------------------------------------- |
| `test/core/units.test.ts`       | backoff, ids, refs, resolution store                     |
| `test/core/outbox.test.ts`      | delivery, ordering, retries, dead letters, coalescing    |
| `test/core/crash.test.ts`       | process death after each of the first _n_ storage writes |
| `test/core/properties.test.ts`  | `fast-check` over randomised interleavings               |
| `test/storage/adapters.test.ts` | one shared conformance suite per adapter                 |
| `test/query/bindings.test.tsx`  | hooks, optimistic updates, rollback, replay              |

Use the virtual `TestClock` rather than real timers — backoff windows are
minutes long, and shortening them in tests would stop testing the real policy.

A new storage adapter needs one line: add it to `conformanceSuite(...)`. If it
passes, the core will work with it.

## Changesets

Every user-visible change needs one:

```bash
npm run changeset
```

Releases happen from `main` via the Changesets action, publishing with npm
provenance over OIDC. There is no `NPM_TOKEN` in this repository.
