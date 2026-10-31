#!/usr/bin/env node
// Runner della suite eval (fasi 9-11b): chiama un modello VERO e GIUDICA con
// regole deterministiche (nessun modello giudice). NON fa parte di
// `npx vitest run`: i file vivono in eval/ e la config è vitest.eval.config.ts.
// Uso: npm run eval -- --model kimi-k3:cloud --runs 3
// Opzioni: --model, --runs, --min (soglia pass), --provider (fase 18a E5: uno
// dei ProviderKind, default ollama), --base-url (default l'URL noto del kind),
// --cases (filtro),
// --dump <file> (K3: una riga JSONL per caso × run, la diagnostica dei ✗),
// --lang it|en (fase 17b: la lingua del run, default it) e --min-lang
// (fase 17b: soglia della quota di testi nella lingua giusta, default 0,95).
// Fase 18a (E5): la chiave API arriva SOLO dalla variabile d'ambiente
// SANDBOT_EVAL_API_KEY — mai da argv (comparirebbe in ps e nello history),
// mai stampata.
// La soglia --min di default scala sui casi totali: round(casi × runs × 0,9) —
// fase 17b: 40 casi (1, 2b, 3-39) × 3 run = 120 → 108, stesso rapporto ~0,9
// della fase 14 (97 su 36 × 3 = 108).
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const model = flag('model', 'kimi-k3:cloud')
const runs = flag('runs', '3')
// fase 17b (A5): la soglia di default si RICALCOLA sui casi totali con la
// stessa formula — Math.round(TOTAL_CASES × runs × 0,9) — così l'aggiunta dei
// casi 36-39 (40 casi) non chiede di aggiornare un numero a mano.
// Conta il TOTALE (sistema): il recupero dei turni fa parte del sistema (il
// "modello nudo" lo stampa la suite, solo informativo)
const TOTAL_CASES = 40
const min = flag('min', String(Math.round(TOTAL_CASES * Number(runs) * 0.9)))
// fase 18a (E5): il provider di default è Ollama; gli URL noti sono gli
// stessi KNOWN_BASE_URLS di src/main/agent/providers.ts (il runner è .mjs,
// non importa il TS: la copia vive qui e il runner la valida)
const KNOWN_BASE_URLS = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  'openai-compatible': 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  mistral: 'https://api.mistral.ai',
  openrouter: 'https://openrouter.ai/api',
  zai: 'https://api.z.ai/api/paas/v4',
  xai: 'https://api.x.ai',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai',
  custom: 'http://127.0.0.1:11434'
}
const KEYLESS_KINDS = new Set(['ollama', 'lmstudio', 'openai-compatible', 'custom'])
const provider = flag('provider', 'ollama')
if (!(provider in KNOWN_BASE_URLS)) {
  console.error(`--provider sconosciuto: "${provider}" (uno di: ${Object.keys(KNOWN_BASE_URLS).join(', ')})`)
  process.exit(1)
}
const baseUrl = flag('base-url', KNOWN_BASE_URLS[provider])
// fase 11 (residuo 0a): filtro sui casi (es. --cases 9,11,13,14) — passa il
// filtro a EVAL_ONLY della suite, che seleziona gli id corrispondenti
const cases = flag('cases', '')
// fase 17b (A5): la lingua del run (default it) e la soglia del controllo lingua
const lang = flag('lang', 'it')
const minLang = flag('min-lang', '0.95')
// K3: diagnostica dei run — il file JSONL sta dove dice l'utente (MAI nella
// directory dati dell'eval, che la suite cancella a fine corsa)
const dump = flag('dump', '')
// fase 18a (E5): la chiave SOLO dall'ambiente; i kind che la richiedono non
// partono senza (errore chiaro PRIMA di qualsiasi chiamata)
const hasKey = !!process.env.SANDBOT_EVAL_API_KEY && process.env.SANDBOT_EVAL_API_KEY.trim().length > 0
console.log(`eval fase 9 — modello=${model} runs=${runs} provider=${provider} base-url=${baseUrl} lingua=${lang}${cases ? ` casi=${cases}` : ''}${dump ? ` dump=${dump}` : ''}`)
console.log(`chiave: ${hasKey ? 'presente' : 'assente'}`)
if (!KEYLESS_KINDS.has(provider) && !hasKey) {
  console.error(`il provider "${provider}" richiede una chiave: impostala nella variabile d'ambiente SANDBOT_EVAL_API_KEY (mai da riga di comando)`)
  process.exit(1)
}
console.log(`soglia: almeno ${min} pass · lingua: quota ≥ ${minLang} (il totale casi × run lo stampa la suite)\n`)

const r = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.eval.config.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env, EVAL_MODEL: model, EVAL_RUNS: runs, EVAL_MIN: min, EVAL_BASE_URL: baseUrl,
    EVAL_PROVIDER: provider, EVAL_LANG: lang, EVAL_MIN_LANG: minLang,
    ...(cases ? { EVAL_ONLY: cases } : {}),
    ...(dump ? { EVAL_DUMP: dump } : {})
  }
})
process.exit(r.status ?? 1)
