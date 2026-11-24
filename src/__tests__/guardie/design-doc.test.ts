// F4 (fase fondamenta): il test di coerenza di docs/DESIGN.md — la fonte
// unica del design NON si può disallineare dal codice:
//   · ogni token definito in styles.css (--text-*, --spacing-*, --radius-*,
//     --w-*, i colori del tema…) compare nel documento con lo stesso valore,
//     e viceversa (nessuna riga di token nel documento senza la definizione);
//   · ogni file di src/renderer/src/components/ui/ ha la sua voce «### nome».
// La documentazione che mente è peggiore della documentazione assente: il
// test fa sì che non si possa togliere una voce senza che sia rosso.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const QUI = dirname(fileURLToPath(import.meta.url)) // src/__tests__/guardie
const RENDERER = join(QUI, '..', '..', 'renderer', 'src')
const RADICE = join(QUI, '..', '..', '..')
const DOC = join(RADICE, 'docs', 'DESIGN.md')

const css = readFileSync(join(RENDERER, 'styles.css'), 'utf8')
const doc = readFileSync(DOC, 'utf8')

const normale = (v: string) => v.replace(/\s+/g, ' ').trim()

/**
 * Le definizioni di token in styles.css: `--nome: valore;` (anche a più righe).
 * Il valore è quello LETTERALE; un token definito in ENTRAMBI i temi con valori
 * diversi (i puntini --bot-dot-*) porta TUTTI i suoi valori: il documento mostra
 * la variante del tema chiaro, e il test accetta uno dei valori definiti.
 */
const defInCss = new Map<string, Set<string>>()
for (const m of css.matchAll(/(^|\n)\s*(--[\w-]+):\s*([^;]+);/g)) {
  const nome = m[2]!
  const valore = normale(m[3]!)
  defInCss.get(nome)?.add(valore) ?? defInCss.set(nome, new Set([valore]))
}

/** Le righe di token del documento: | `--nome` | valore | quando si usa | */
const tokenNelDoc = new Map<string, string>()
for (const m of doc.matchAll(/^\| `(--[\w-]+)` \| (.+?) \|/gm)) {
  tokenNelDoc.set(m[1]!, normale(m[2]!))
}

/** I componenti: i file di components/ui/ e le voci «### nome» del documento. */
const fileUi = readdirSync(join(RENDERER, 'components', 'ui')).filter((f) => f.endsWith('.tsx')).map((f) => f.replace(/\.tsx$/, ''))
const voci = new Set([...doc.matchAll(/^### ([\w-]+)$/gm)].map((m) => m[1]))

describe('docs/DESIGN.md è coerente col codice', () => {
  it('ogni token di styles.css compare nel documento con lo stesso valore', () => {
    const mancanti = [...defInCss].filter(([nome, valori]) => !valori.has(tokenNelDoc.get(nome) ?? ''))
    expect(mancanti.map(([nome, valori]) => `${nome}: nel css [${[...valori].join(' | ')}], nel doc ${tokenNelDoc.get(nome) ?? '(assente)'}`)).toEqual([])
  })

  it('nessuna riga di token del documento senza la definizione in styles.css', () => {
    const extra = [...tokenNelDoc].filter(([nome]) => !defInCss.has(nome))
    expect(extra.map(([nome]) => nome)).toEqual([])
  })

  it('e i valori non sono inventati: stesso valore letterale a entrambi i lati (già coperto sopra)', () => {
    expect(tokenNelDoc.size).toBeGreaterThan(50) // la tabella esiste davvero
    expect(defInCss.size).toBeGreaterThan(50)
  })

  it('ogni file di components/ui/ ha la sua voce nel documento', () => {
    const mancanti = fileUi.filter((f) => !voci.has(f))
    expect(mancanti).toEqual([])
  })
})
