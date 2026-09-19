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
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
})
