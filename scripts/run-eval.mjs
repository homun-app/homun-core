#!/usr/bin/env node
// Runner della suite eval di fase 9 (punto 3): chiama un modello VERO via
// Ollama e GIUDICA con regole deterministiche (nessun modello giudice).
// NON fa parte di `npx vitest run`: i file vivono in eval/ e la config è
// vitest.eval.config.ts. Uso: npm run eval -- --model kimi-k3:cloud --runs 3
// Opzioni: --model, --runs, --min (soglia pass, default 19), --base-url.
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const model = flag('model', 'kimi-k3:cloud')
const runs = flag('runs', '3')
const min = flag('min', '19')
const baseUrl = flag('base-url', 'http://127.0.0.1:11434')

console.log(`eval fase 9 — modello=${model} runs=${runs} provider=${baseUrl}`)
console.log(`soglia: almeno ${min} pass (il totale casi × run lo stampa la suite)\n`)

const r = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.eval.config.ts'], {
  stdio: 'inherit',
  env: { ...process.env, EVAL_MODEL: model, EVAL_RUNS: runs, EVAL_MIN: min, EVAL_BASE_URL: baseUrl }
})
process.exit(r.status ?? 1)
