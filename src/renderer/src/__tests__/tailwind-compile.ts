// Fase design (DS1): il CSS VERO di styles.css compilato da Tailwind nei test
// — la stessa API `compile` del plugin Vite (è una devDependency del repo,
// nessun pacchetto nuovo). Lo usano i test dei token (design-tokens) e dei
// pezzi del sistema: che un token generi davvero la sua utility lo dice
// solo l'output, non il sorgente. Stessa tecnica della guardia di B5
// (focus-ring-guard.test.ts), qui come modulo condiviso.
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'tailwindcss'

const SRC = fileURLToPath(new URL('..', import.meta.url)) // src/renderer/src

export const CSS_PATH = join(SRC, 'styles.css')

/** La cartella di un pacchetto a partire da `from` (risale finché trova node_modules/<pacchetto>). */
function packageDir(name: string, from: string): string {
  let dir = from
  for (;;) {
    const cand = join(dir, 'node_modules', ...name.split('/'))
    if (statSync(join(cand, 'package.json'), { throwIfNoEntry: false })) return cand
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`pacchetto non trovato: ${name}`)
    dir = parent
  }
}

/** Carica gli @import di styles.css come fa il plugin Vite (il foglio dichiarato dal package.json). */
async function loadStylesheet(id: string, base: string): Promise<{ path: string; base: string; content: string }> {
  let file: string
  if (id.startsWith('.')) {
    file = join(base, id)
  } else {
    const dir = packageDir(id, base)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      style?: string
      main?: string
      exports?: Record<string, string | { style?: string; default?: string | object } | undefined>
    }
    const root = pkg.exports?.['.']
    const entry = (typeof root === 'object' ? root?.style : undefined) ?? pkg.style ?? pkg.main
    if (!entry) throw new Error(`nessun foglio di stile per ${id}`)
    file = join(dir, entry)
  }
  return { path: file, base: dirname(file), content: readFileSync(file, 'utf8') }
}

/** Il CSS di styles.css compilato da Tailwind: le regole per le classi chieste (e il tema). */
export async function compileRenderer(candidates: string[]): Promise<string> {
  const compiler = await compile(readFileSync(CSS_PATH, 'utf8'), { base: dirname(CSS_PATH), loadStylesheet })
  return compiler.build(candidates)
}

/** Una regola su una riga sola, senza spazi accanto alle parentesi (il CSS è su più righe). */
export const squashed = (s: string): string =>
  s.replace(/\(\s+/g, '(').replace(/\s+/g, ' ').trim()
