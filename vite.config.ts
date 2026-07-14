import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.ts', 'src/tournament/**/*.ts', 'src/data/**/*.ts'],
    },
  },
});
