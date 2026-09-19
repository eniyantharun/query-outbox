import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Property runs execute hundreds of full scenarios; the default 5s is
    // generous for a unit test and far too tight for a model-based one.
    testTimeout: 60_000,
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // React binding tests opt into jsdom with a `@vitest-environment` docblock.
    // The core suite deliberately runs in plain Node — if it ever needed a DOM,
    // the ports boundary would have leaked.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/index.ts'],
      // These also act as a tripwire. When a dev tool quietly drops support
      // for the oldest Node we target, its test files fail to load and vitest
      // still reports the remaining ones as a pass — the coverage floor is
      // what actually catches the silently skipped suites.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
})
