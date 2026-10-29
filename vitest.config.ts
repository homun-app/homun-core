import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // solo i .test.ts: le fixtures JSON delle __tests__ non sono suite
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
