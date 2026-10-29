#!/usr/bin/env node
// Runner della suite eval (fasi 9-11b): chiama un modello VERO via Ollama e
// GIUDICA con regole deterministiche (nessun modello giudice). NON fa parte di
// `npx vitest run`: i file vivono in eval/ e la config è vitest.eval.config.ts.
// Uso: npm run eval -- --model kimi-k3:cloud --runs 3
// Opzioni: --model, --runs, --min (soglia pass), --base-url, --cases (filtro),
// --dump <file> (K3: una riga JSONL per caso × run, la diagnostica dei ✗).
// La soglia di default (41 su 15 casi × 3 run = 45) è l'equivalente
// proporzionale del 30/33 della specifica fase 10 (che contava 11 casi; con
// le correzioni i casi sono 15: 2b e 8-14).
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const model = flag('model', 'kimi-k3:cloud')
const runs = flag('runs', '3')
// fase 13 (punto 10): 30 casi (1, 2, 2b, 3-29) × 3 run = 90; la soglia 81 è
// l'equivalente proporzionale del 68/75 della fase 12 (stesso rapporto ~0,907).
// Conta il TOTALE (sistema): il recupero dei turni fa parte del sistema (il
// "modello nudo" lo stampa la suite, solo informativo)
const min = flag('min', '81')
const baseUrl = flag('base-url', 'http://127.0.0.1:11434')
// fase 11 (residuo 0a): filtro sui casi (es. --cases 9,11,13,14) — passa il
// filtro a EVAL_ONLY della suite, che seleziona gli id corrispondenti
const cases = flag('cases', '')
// K3: diagnostica dei run — il file JSONL sta dove dice l'utente (MAI nella
// directory dati dell'eval, che la suite cancella a fine corsa)
const dump = flag('dump', '')

console.log(`eval fase 9 — modello=${model} runs=${runs} provider=${baseUrl}${cases ? ` casi=${cases}` : ''}${dump ? ` dump=${dump}` : ''}`)
console.log(`soglia: almeno ${min} pass (il totale casi × run lo stampa la suite)\n`)

const r = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.eval.config.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env, EVAL_MODEL: model, EVAL_RUNS: runs, EVAL_MIN: min, EVAL_BASE_URL: baseUrl,
    ...(cases ? { EVAL_ONLY: cases } : {}),
    ...(dump ? { EVAL_DUMP: dump } : {})
  }
})
process.exit(r.status ?? 1)
