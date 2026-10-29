import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // solo i .test.ts: le fixtures JSON delle __tests__ non sono suite
    include: ['src/**/__tests__/**/*.test.ts'],
    // N2 (fase 13 correzioni 3): SANDBOT_DATA_DIR su una temporanea per tutta
    // la corsa (src/test-setup.ts) — nessun test può più aprire ~/.sandbot/data
    setupFiles: ['src/test-setup.ts'],
  },
})
