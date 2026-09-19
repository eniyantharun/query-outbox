import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/react/index.tsx',
    'src/query/index.ts',
    'src/storage/memory.ts',
    'src/storage/local-storage.ts',
    'src/storage/async-storage.ts',
    'src/net/browser.ts',
    'src/net/netinfo.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: 'es2022',
  // Never bundle the platform peers into dist; consumers supply them.
  external: [
    'react',
    '@tanstack/react-query',
    '@react-native-async-storage/async-storage',
    '@react-native-community/netinfo',
  ],
})
