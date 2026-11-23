// B5 (fase b20-bug): l'anello del fuoco SOLO da tastiera — la guardia sul
// sorgente.
//
// MISURATO DAL VIVO (sonda CDP sull'app, Chromium di Electron 45, macOS con
// «Navigazione con tastiera» SPENTA). L'anello arancione è l'outline NATIVO
// di Chromium, quello che sta su `:focus-visible`, nel colore d'accento di
// sistema. Un clic VERO sulla riga di un bot NON lo mostra; lo mostra il
// TASTO premuto subito dopo, qualunque sia: per l'euristica di Chromium, se
// l'utente usa la tastiera l'elemento che ha il fuoco diventa :focus-visible,
// anche se il fuoco glielo aveva dato il mouse. Clic sulla riga, poi Esc, ⌘K,
// uno Shift… e la riga cliccata si accende.
//
// Il CSS da solo non può rimediare: quando l'anello si vede l'elemento È
// :focus-visible, e `:focus-visible` è l'unico segnale che il CSS riceve
// (`:focus:not(:focus-visible)` non serve a niente: la condizione è falsa
// proprio quando l'anello si vede). Gli eventi dicono da dove arriva il
// fuoco. Perciò:
//   1. lib/focus-from.ts scrive su <html> DA DOVE ARRIVA IL FUOCO
//      (data-focus-from: 'keyboard' o 'pointer'; un clic → pointer, e ci
//      resta finché la tastiera non sposta davvero il fuoco), installato da
//      main.tsx;
//   2. in styles.css UNA regola (in @layer base) toglie l'outline nativo ai
//      controlli presi col puntatore — SENZA guardare :focus-visible, che
//      dopo un clic scatta comunque — e la variante `focus-visible` di
//      Tailwind è ridefinita sullo stesso marcatore, così anche le utility
//      `focus-visible:ring-*` / `outline-*` non scattano;
//   3. nei componenti nessuna classe con la variante `focus:` davanti a
//      ring/outline: scatta su OGNI fuoco, clic compreso (basta la regola).
// I campi di testo restano fuori: il loro fuoco preso col mouse È fuoco da
// tastiera (ci si scrive) — l'anello ci resta, come in Chromium.
//
// Il CSS compilato si verifica con la API `compile` di Tailwind (la stessa
// del plugin Vite): che `@custom-variant` sovrascriva davvero la variante di
// fabbrica lo dice solo l'output, non il sorgente.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'tailwindcss'

const SRC = fileURLToPath(new URL('..', import.meta.url)) // src/renderer/src
const RENDERER = fileURLToPath(new URL('../..', import.meta.url)) // src/renderer
const CSS_PATH = join(SRC, 'styles.css')
const CSS = readFileSync(CSS_PATH, 'utf8')
const MAIN_SRC = readFileSync(join(SRC, 'main.tsx'), 'utf8')

/**
 * `focus:ring…` / `focus:outline…`: la variante che scatta su OGNI fuoco, clic
 * compreso. `focus-visible:ring…` non la matcha: dopo «focus» c'è «-visible»,
 * non «:». Intercetta anche le composte (group-focus:ring-1,
 * data-[state=open]:focus:ring-2).
 */
const CLICK_FOCUS = /focus:(ring|outline)/

/** Il marcatore su <html> che scrive lib/focus-from.ts (dataset.focusFrom). */
const MARKER = "[data-focus-from='pointer']"

/**
 * I CAMPI DI TESTO: <input> di testo (tutti i tipi tranne quelli che non
 * prendono testo), <textarea> e chi è editabile. Checkbox, radio e <select>
 * NON lo sono: presi col mouse non mostrano l'anello. La lista è la STESSA
 * nella variante e nella regola unica — il test sotto lo impone.
 */
const FIELDS = "input:not([type='button'], [type='checkbox'], [type='color'], [type='file'], [type='hidden'], [type='image'], [type='radio'], [type='range'], [type='reset'], [type='submit']), textarea, [contenteditable]:not([contenteditable='false'])"

/** Un selettore su una riga sola, senza spazi accanto alle parentesi (il CSS è su più righe). */
const squashed = (s: string): string => s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ').trim()

/** I sorgenti del renderer (non i test): .ts, .tsx, .css. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // i test sono fuori: qui i token vietati si scrivono apposta
    if (name === '__tests__' || name.includes('.test.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full)
  }
  return out
}

/** Il CSS senza commenti (stessa lunghezza: gli indici restano validi). */
const cssWithoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

/** Il preludio (es. `@layer base`) del blocco che contiene `index`; null se non è in un blocco. */
function enclosingPrelude(css: string, index: number): string | null {
  const stack: string[] = []
  let start = 0
  for (let i = 0; i < index; i++) {
    const ch = css[i]
    if (ch === '{') {
      stack.push(squashed(css.slice(start, i)))
      start = i + 1
    } else if (ch === '}') {
      stack.pop()
      start = i + 1
    } else if (ch === ';') {
      start = i + 1
    }
  }
  return stack.at(-1) ?? null
}

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

/** Il CSS vero di styles.css compilato da Tailwind (solo le classi chieste). */
async function compileRenderer(candidates: string[]): Promise<string> {
  const compiler = await compile(CSS, { base: dirname(CSS_PATH), loadStylesheet })
  return compiler.build(candidates)
}

describe('B5 — la guardia: nessuna classe che mostra l’anello su OGNI fuoco', () => {
  it('la regex intercetta focus:ring… e focus:outline…, anche dentro le varianti composte', () => {
    for (const bad of ['focus:ring-2', 'focus:ring-ring', 'focus:outline-none', 'focus:outline-hidden', 'group-focus:ring-1', 'data-[state=open]:focus:ring-2', 'peer-focus:outline-2']) {
      expect(bad, bad).toMatch(CLICK_FOCUS)
    }
  })

  it('la regex NON intercetta focus-visible:… né le varianti sul colore (focus:bg-, focus:text-)', () => {
    for (const good of ['focus-visible:ring-[3px]', 'focus-visible:ring-ring/50', 'focus-visible:outline-2', 'focus-visible:outline-offset-2', 'outline-none', 'outline-hidden', 'ring-2', 'hover:ring-1', 'focus:bg-accent', 'focus:text-destructive']) {
      expect(good, good).not.toMatch(CLICK_FOCUS)
    }
  })

  it('nessun sorgente del renderer (fuori dai test) ha focus:ring… o focus:outline…', () => {
    const files = sourceFiles(RENDERER)
    expect(files.length, 'i sorgenti del renderer').toBeGreaterThan(50)
    const hits: string[] = []
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/[\w\[\]=\/.:-]*focus:(?:ring|outline)[\w\[\]=\/.:-]*/g)) {
        hits.push(`${relative(process.cwd(), f)}: ${m[0]}`)
      }
    }
    expect(hits, 'varianti che scattano anche al clic: usare focus-visible: (o niente, ci pensa la regola unica)').toEqual([])
  })
})

describe('B5 — la regola unica e la variante, lette dal sorgente', () => {
  const rule = /html\[data-focus-from='pointer'\] :where\(:focus:not\(([\s\S]*?)\)\)\s*\{([^}]*)\}/.exec(cssWithoutComments)
  const ruleAt = cssWithoutComments.indexOf(`html${MARKER}`)
  const ruleSelector = rule ? squashed(cssWithoutComments.slice(rule.index, rule.index + rule[0].indexOf('{'))) : null
  const variant = /@custom-variant focus-visible \(\s*([\s\S]*?)\s*\);/.exec(cssWithoutComments)

  it('styles.css ha la regola unica: sotto il puntatore nessun outline ai controlli che non sono campi di testo', () => {
    expect(rule, 'selettore html[data-focus-from=\'pointer\'] :where(:focus:not(…)) { … }').not.toBeNull()
    expect(squashed(rule![2]!), 'la dichiarazione').toContain('outline: none')
    expect(ruleAt).toBeGreaterThan(-1)
  })

  it('la regola unica NON guarda :focus-visible — dopo un clic un tasto qualunque lo fa scattare (misurato) — e va bene così: è autore, vince sul nativo', () => {
    expect(ruleSelector).not.toBeNull()
    expect(ruleSelector).toMatch(/^html\[data-focus-from='pointer'\] :where\(:focus:not\(/)
    expect(ruleSelector, 'la regola vale anche quando Chromium dice :focus-visible').not.toContain('focus-visible')
    expect(ruleSelector, 'dentro :where: specificità 0, pesa solo html[data-focus-from]').toContain(':where(')
  })

  it('la regola unica sta in @layer base: vince sull’outline nativo (autore > UA), perde contro le utility', () => {
    expect(ruleAt).toBeGreaterThan(-1)
    expect(enclosingPrelude(cssWithoutComments, ruleAt)).toBe('@layer base')
  })

  it('la variante focus-visible di Tailwind è ridefinita sullo stesso marcatore, con la stessa specificità di fabbrica', () => {
    expect(variant, '@custom-variant focus-visible (…)').not.toBeNull()
    // :focus-visible resta FUORI da :where (vale 1 come nella variante di
    // fabbrica `&:focus-visible`); la negazione sta DENTRO :where (vale 0)
    expect(squashed(variant![1]!)).toBe(`&:focus-visible:not(:where(${MARKER} :not(${FIELDS})))`)
  })

  it('variante e regola unica esentano gli STESSI campi di testo', () => {
    expect(rule).not.toBeNull()
    expect(squashed(rule![1]!)).toBe(FIELDS)
  })

  it('il modulino scrive proprio quel marcatore (dataset.focusFrom → data-focus-from), con keyboard e pointer', () => {
    const mod = readFileSync(join(SRC, 'lib', 'focus-from.ts'), 'utf8')
    expect(mod).toContain('dataset.focusFrom')
    expect(mod).toContain("'keyboard'")
    expect(mod).toContain("'pointer'")
    expect(mod).toContain("'pointerdown'")
    expect(mod).toContain("'keydown'")
  })

  it('main.tsx installa il marcatore (senza di lui regola e variante non scattano mai)', () => {
    expect(MAIN_SRC).toMatch(/import \{ installFocusFrom \} from '\.\/lib\/focus-from'/)
    expect(MAIN_SRC).toContain('installFocusFrom(')
  })
})

describe('B5 — il CSS compilato da Tailwind (la prova che la variante è davvero sovrascritta)', () => {
  it('focus-visible:ring-2 compila con la negazione del puntatore, non come la variante di fabbrica', async () => {
    const out = await compileRenderer(['focus-visible:ring-2', 'focus-visible:outline-2', 'focus:ring-2'])
    const m = /^ *(\.focus-visible\\:ring-2[^{\n]*)\{/m.exec(out)
    expect(m, 'la regola di focus-visible:ring-2 nel CSS compilato').not.toBeNull()
    expect(squashed(m![1]!)).toBe(`.focus-visible\\:ring-2:focus-visible:not(:where(${MARKER} :not(${FIELDS})))`)
    // la variante `focus:` non è stata toccata
    expect(out).toMatch(/^ *\.focus\\:ring-2:focus \{/m)
  })

  it('nel CSS compilato la regola unica sta in @layer base e le utility in @layer utilities, che viene DOPO: outline-none e le ring- dei componenti vincono', async () => {
    const out = await compileRenderer(['outline-none', 'focus-visible:ring-[3px]', 'focus-visible:ring-ring/50'])
    const ruleAt = out.indexOf(`html${MARKER}`)
    expect(ruleAt, 'la regola unica nel CSS compilato').toBeGreaterThan(-1)
    expect(enclosingPrelude(out, ruleAt)).toBe('@layer base')
    expect(squashed(out.slice(out.indexOf('{', ruleAt), out.indexOf('}', ruleAt)))).toContain('outline: none')
    // L'ordine dei layer lo decide la PRIMA dichiarazione, non dove stanno i
    // blocchi nel file (nel compilato il blocco di Tailwind viene prima di
    // quello dell'app): utilities è dichiarato dopo base, dunque vince.
    const orderAt = out.indexOf('@layer theme, base, components, utilities;')
    expect(orderAt, 'la dichiarazione dell’ordine dei layer').toBeGreaterThan(-1)
    expect(orderAt).toBeLessThan(ruleAt)
    expect(enclosingPrelude(out, out.indexOf('@layer utilities {'))).toBeNull()
    expect(enclosingPrelude(out, out.indexOf('.outline-none {')), 'outline-none resta una utility').toBe('@layer utilities')
    expect(enclosingPrelude(out, out.indexOf('.focus-visible\\:ring-\\[3px\\]')), 'le ring- dei componenti restano utility').toBe('@layer utilities')
  })
})
