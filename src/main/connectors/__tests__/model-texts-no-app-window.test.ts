// B6 (fase b20-bug): i testi per il MODELLO non parlano più della finestra
// «App» (non c'è dalla fase plugin: ora è la scheda del plugin nella pagina
// Plugin). La guardia legge i sorgenti del prodotto SENZA i commenti (che ne
// raccontano la storia possono restare): nessun testo — per il modello o per
// l'interfaccia — nomina «App window», «finestra App», «App e skill» né il
// vecchio «restart the connection from Settings» (la connessione si riavvia
// dalla scheda del server, non dalle Impostazioni).
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url)) // src/main/connectors
const PRODUCT = fileURLToPath(new URL('../..', import.meta.url)) // src

/** I sorgenti del prodotto (ts/tsx), senza test, cataloghi e risorse. */
const sourcesOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return ['__tests__', 'locales', 'assets'].includes(e.name) ? [] : sourcesOf(p)
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : []
  })

const senzaCommenti = (text: string): string =>
  text
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

/** I nomi di cose che non esistono più, nei testi (non nei commenti). */
const STALE = /App window|finestra App|finestra «App|App e skill|Apps and skills|restart the connection from Settings/

describe('B6: i testi non parlano di finestre che non ci sono più', () => {
  it('nessun sorgente del prodotto (main, daemon, shared, renderer) nomina la finestra «App», «App e skill» o il vecchio «da Impostazioni»', () => {
    const hits = sourcesOf(PRODUCT).filter((f) => STALE.test(senzaCommenti(readFileSync(f, 'utf8'))))
    expect(hits.map((f) => f.slice(PRODUCT.length))).toEqual([])
  })

  it("la guardia vede un testo che li nomina (non si spegne da sola)", () => {
    const src = "// App window nel commento: non conta\nconst msg = 'open the App window'\n/* finestra App: nemmeno */\n"
    expect(STALE.test(senzaCommenti(src))).toBe(true)
    expect(STALE.test(senzaCommenti("// App window\n/* App e skill */\nconst ok = 1"))).toBe(false)
  })

  it('i due testi dell’installazione dicono DOVE l’utente completa la configurazione: la scheda nella pagina Plugin', () => {
    const install = readFileSync(join(SRC, 'install.ts'), 'utf8')
    const setup = install.match(/completes the setup[^`]*/g) ?? []
    expect(setup.length).toBeGreaterThanOrEqual(3)
    for (const s of setup) expect(s).toContain('in ')
    expect(setup.filter((s) => /in the card|in its card in the Plugins page/.test(s))).toHaveLength(setup.length)
  })
})
