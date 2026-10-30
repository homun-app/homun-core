// Config della suite EVAL (fase 9, punto 3): gira su un modello VERO e NON
// fa parte di `npx vitest run` (i file *.eval.ts non matchano il glob dei
// test normali). Il comando è `npm run eval -- --model kimi-k3:cloud --runs 3`.
import { defineConfig } from 'vitest/config'
import babel from '@rolldown/plugin-babel'

export default defineConfig({
  // fase 17c (C1): l'eval importa loop.ts e behaviors.eval.ts, che ora usano
  // la macro msg — stessa compilazione babel della suite normale
  plugins: [babel({ plugins: ['@lingui/babel-plugin-lingui-macro'], include: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx', 'src/shared/**/*.ts', 'src/main/**/*.ts', 'src/daemon/**/*.ts', 'eval/**/*.ts'] })],
  test: {
    include: ['eval/**/*.eval.ts'],
    // fase 10 (residuo 0a): silent:false — vitest 5 nasconde i console.log dei
    // test che passano, e la tabella dell'eval è proprio l'output che serve
    // quando la soglia è raggiunta
    silent: false,
    // una chiamata può essere lenta (modello cloud): la singola esecuzione di
    // tutti i casi × run ha un tetto ampio, non il progetto
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxConcurrency: 1
  }
})
