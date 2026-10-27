// Config della suite EVAL (fase 9, punto 3): gira su un modello VERO e NON
// fa parte di `npx vitest run` (i file *.eval.ts non matchano il glob dei
// test normali). Il comando è `npm run eval -- --model kimi-k3:cloud --runs 3`.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['eval/**/*.eval.ts'],
    // una chiamata può essere lenta (modello cloud): la singola esecuzione di
    // tutti i casi × run ha un tetto ampio, non il progetto
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxConcurrency: 1
  }
})
