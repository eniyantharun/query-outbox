import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    // The examples install the published tarball and platform packages that are
    // not present in this workspace, so they are typechecked where they run,
    // not here.
    ignores: ['dist', 'coverage', 'node_modules', 'examples'],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,

  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx', '*.config.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  {
    // The core must stay free of platform and framework imports. That rule is
    // what makes crash simulation in plain Node possible, so it is enforced
    // rather than left as a convention someone will eventually break.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', '@tanstack/*', '@react-native*'],
              message:
                'src/core must have zero framework/platform imports. Use a port from core/ports.ts.',
            },
          ],
        },
      ],
    },
  },

  {
    // Tests mirror host-API shapes and assert on void calls constantly. These
    // rules guard against production hazards that do not exist in a test file.
    files: ['test/**/*.ts', 'test/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },

  {
    // This file is not part of the TypeScript program, so type-aware rules have
    // no type information to work from and report noise instead of findings.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
])
