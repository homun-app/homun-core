#!/usr/bin/env node
// Runner della suite eval (fasi 9-10): chiama un modello VERO via Ollama e
// GIUDICA con regole deterministiche (nessun modello giudice). NON fa parte di
// `npx vitest run`: i file vivono in eval/ e la config è vitest.eval.config.ts.
// Uso: npm run eval -- --model kimi-k3:cloud --runs 3
// Opzioni: --model, --runs, --min (soglia pass), --base-url.
// La soglia di default (33 su 12 casi × 3 run = 36) è l'equivalente
// proporzionale del 30/33 della specifica fase 10 (che contava 11 casi).
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const model = flag('model', 'kimi-k3:cloud')
const runs = flag('runs', '3')
const min = flag('min', '33')
const baseUrl = flag('base-url', 'http://127.0.0.1:11434')

console.log(`eval fase 9 — modello=${model} runs=${runs} provider=${baseUrl}`)
console.log(`soglia: almeno ${min} pass (il totale casi × run lo stampa la suite)\n`)

const r = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.eval.config.ts'], {
  stdio: 'inherit',
  env: { ...process.env, EVAL_MODEL: model, EVAL_RUNS: runs, EVAL_MIN: min, EVAL_BASE_URL: baseUrl }
})
process.exit(r.status ?? 1)
