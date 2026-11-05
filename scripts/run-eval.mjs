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
// La soglia --min di default scala sui casi CHE GIRERANNO: round(casi × runs
// × 0,9). Fase skill (S9): il numero dei casi si CHIEDE alla suite (passata
// di conteggio con EVAL_COUNT_ONLY, nessuna chiamata al modello) — non più
// scritto a mano: oggi c'erano 40 scritti a mano e i casi erano 41, più
// questi; e con --cases la soglia si calcola sui casi SCELTI (prima, con 5
// casi, chiedeva comunque 108 pass).
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const model = flag('model', 'kimi-k3:cloud')
const runs = flag('runs', '3')
// fase 11 (residuo 0a): filtro sui casi (es. --cases 9,11,13,14) — passa il
// filtro a EVAL_ONLY della suite, che seleziona gli id corrispondenti
const cases = flag('cases', '')
/**
 * La corsa di CONTEGGIO: la suite stampa «CASI ESEGUITE: n» (i casi scelti
 * da --cases, come la corsa vera) senza chiamare modelli. Fallisce → errore
 * chiaro, mai un numero inventato.
 */
const countChosenCases = () => {
  const r = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.eval.config.ts'], {
    encoding: 'utf8',
    env: {
      ...process.env, EVAL_COUNT_ONLY: '1', EVAL_RUNS: '1',
      ...(cases ? { EVAL_ONLY: cases } : {})
    }
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const m = /CASI ESEGUITE: (\d+)/.exec(out)
  if (!m) {
    console.error('conteggio dei casi fallito — output della suite di conteggio:\n' + out.slice(-1500))
    process.exit(1)
  }
  return Number(m[1])
}
const chosen = countChosenCases()
// fase 17b (A5): Math.round(casi scelti × runs × 0,9), stessa formula di
// sempre — ma sui casi CHE GIRERANNO (il recupero dei turni fa parte del
// sistema: il "modello nudo" lo stampa la suite, solo informativo)
const min = flag('min', String(Math.round(chosen * Number(runs) * 0.9)))
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
console.log(`casi che gireranno: ${chosen} (contati dalla suite) × ${runs} run → soglia: almeno ${min} pass · lingua: quota ≥ ${minLang}\n`)

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
