import { defineConfig } from 'vitest/config'
import babel from '@rolldown/plugin-babel'

export default defineConfig({
  // fase 17a: le macro di Lingui (t/msg/plural usati dal renderer) vanno
  // compilate anche nei test — non compilate lanciano errore a runtime.
  // fase 17c (C1): anche i .ts di shared/main/daemon usano la macro msg
  // (src/shared/ui-messages.ts), quindi la compilazione copre TUTTI i sorgenti.
  plugins: [babel({ plugins: ['@lingui/babel-plugin-lingui-macro'], include: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx', 'src/shared/**/*.ts', 'src/main/**/*.ts', 'src/daemon/**/*.ts'] })],
  test: {
    environment: 'node',
    // solo i .test.ts: le fixtures JSON delle __tests__ non sono suite.
    // Fase catalogo app (P1): anche i test degli script (server finto su 127.0.0.1)
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.ts'],
    // N2 (fase 13 correzioni 3): SANDBOT_DATA_DIR su una temporanea per tutta
    // la corsa (src/test-setup.ts) — nessun test può più aprire ~/.sandbot/data
    setupFiles: ['src/test-setup.ts'],
  },
})
