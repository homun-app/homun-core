// B1.1 (fase beta.4): il corpo della release senza a capo spezzati. Le righe
// del CHANGELOG sono spezzate a ~75 colonne e GitHub trasforma OGNI a capo in
// `<br>` + `\n`; coi clienti che ancora mostrano l'HTML (beta.3) il risultato
// era ogni frase mozzata con una riga vuota in mezzo. Da qui le righe di
// continuazione di un paragrafo o di una voce di elenco si UNISCONO con uno
// spazio: GitHub non mette più `<br>` e l'NSAlert dei beta.3 riceve testo
// pulito. Le righe vuote, i titoli, gli elenchi e i blocchi di codice restano.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractReleaseNotes } from '../extract-release-notes.mjs'

const REPO = join(import.meta.dirname, '..', '..')

/** la sezione beta.3 VERA del CHANGELOG (quella che i beta.3 hanno mostrato) */
const BETA3_MD = extractReleaseNotes(
  readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8'),
  '0.3.1001-beta.3'
)!

describe('B1: extract-release-notes — le righe di continuazione si uniscono', () => {
  it('la sezione beta.3 VERA produce voci di UNA riga sola (le frasi spezzate si ricompongono)', () => {
    expect(BETA3_MD, 'manca la sezione beta.3 nel CHANGELOG').not.toBeNull()
    // le frasi che nel CHANGELOG sono spezzate su più righe ricompaiono
    // INTERE, su una riga sola, con lo spazio al posto dell'a capo
    expect(BETA3_MD).toContain('chi legge per rispondere a ciò che hai chiesto non chiede più a ogni passo')
    expect(BETA3_MD).toContain('le tue board di Trello), le altre letture della stessa app')
    // nessuna voce di elenco è spezzata: dopo ogni riga «- » che inizia una
    // voce NON c'è una riga di continuazione (la voce finisce dove finisce)
    const lines = BETA3_MD.split('\n')
    const bulletEnds = lines.filter((l) => l.startsWith('- '))
    expect(bulletEnds.length).toBeGreaterThanOrEqual(6) // le 6 voci di Approvazioni + 2
    for (const b of bulletEnds) {
      expect(b.length, `voce spezzata: «${b}»`).toBeGreaterThan(60)
    }
  })

  it('i titoli e le righe vuote restano come sono', () => {
    const md = `## [1.2.3] — 2026-01-01

Titolo della sezione.

- voce uno che continua
  su un'altra riga.

Paragrafo su due righe
che si unisce.
`
    const body = extractReleaseNotes(md, '1.2.3')!
    const lines = body.split('\n')
    // il titolo e la riga vuota NON si toccano
    expect(lines).toContain('Titolo della sezione.')
    expect(lines).toContain('')
    // la voce di elenco unisce la sua continuazione, il paragrafo pure
    expect(lines).toContain("- voce uno che continua su un'altra riga.")
    expect(lines).toContain('Paragrafo su due righe che si unisce.')
  })

  it('un blocco di codice resta INTATTO (dentro il recinto non si unisce nulla)', () => {
    const code = ['```', 'npm install', 'omun --version', '```'].join('\n')
    const md = `## [1.2.3] — 2026-01-01

Prima del codice
su due righe.

${code}

Dopo il codice.
`
    const body = extractReleaseNotes(md, '1.2.3')!
    expect(body).toContain('Prima del codice su due righe.')
    expect(body).toContain('Dopo il codice.')
    // le righe DENTRO il recinto restano una per riga, ognuna com'era
    expect(body).toContain('```\nnpm install\nomun --version\n```')
  })
})
