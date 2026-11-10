// Fase rilascio di prova (RP4/RP5): i documenti del rilascio. docs/RILASCIO.md
// dice come si taglia una prova e una stabile, come si caricano gli asset di
// Engramma (IL COMANDO LO ESEGUE L'UTENTE con gh, mai l'agente) e cosa
// controllare in CI; PROVA-INSTALLAZIONE.md ha la sezione «Canale di prova»
// da seguire a mano. E RP5: il CHANGELOG ha la voce 0.3.1001-beta.1 con le
// novità dalla 0.3.1000 (extract-release-notes la esige, la CI pure).
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

describe('fase rilascio di prova (RP4): docs/RILASCIO.md', () => {
  it('esiste e dice come si taglia una PROVA e una STABILE', () => {
    const doc = read('docs/RILASCIO.md')
    expect(doc).toContain('git tag v0.3.1001-beta.1')
    expect(doc).toContain('git push origin v0.3.1001-beta.1')
    // la stabile resta bozza da pubblicare a mano
    expect(doc).toMatch(/stabile/i)
    expect(doc).toMatch(/bozza|draft/i)
  })

  it('ha IL COMANDO esatto del caricamento degli asset di Engramma (lo esegue l\'utente)', () => {
    const doc = read('docs/RILASCIO.md')
    expect(doc).toContain('gh release create engramma-fase-v0.4.3')
    expect(doc).toContain('--repo homun-app/homun-core')
    // i 3 file del lock, dai percorsi di vendor
    for (const f of ['engramma.darwin-arm64.node', 'index.js', 'index.d.ts']) {
      expect(doc).toContain(`vendor/engramma/${f}`)
    }
  })

  it('dice cosa controllare in CI (prerelease non bozza per i -beta.N, dmg graffato, checksum)', () => {
    const doc = read('docs/RILASCIO.md')
    expect(doc).toMatch(/prerelease/i)
    expect(doc).toMatch(/graffat|staple/i)
    expect(doc).toMatch(/SHA256SUMS/i)
  })
})

describe('fase rilascio di prova (RP4): la sezione «Canale di prova» della prova d\'installazione', () => {
  it('PROVA-INSTALLAZIONE.md ha la sezione coi passi del canale di prova', () => {
    const doc = read('docs/PROVA-INSTALLAZIONE.md')
    expect(doc).toMatch(/## 9\. Canale di prova/)
    // i punti della spec: l'interruttore, il giro 0.3.1001-beta.1 → beta.2,
    // un solo daemon dopo l'aggiornamento, modello/Engramma, Homun 2 escluso
    expect(doc).toContain('Ricevi le versioni di prova')
    expect(doc).toContain('0.3.1001-beta.1')
    expect(doc).toContain('0.3.1001-beta.2')
    expect(doc).toMatch(/un solo daemon|UN solo daemon/i)
    expect(doc).toMatch(/Homun 2.*prerelease|prerelease.*Homun 2/s)
  })

  it('la tabella degli esiti ha la riga del canale di prova', () => {
    const doc = read('docs/PROVA-INSTALLAZIONE.md')
    expect(doc).toMatch(/9 Canale di prova/)
  })
})

describe('fase rilascio di prova (RP5): versione e CHANGELOG', () => {
  it('package.json resta 0.3.1001: la versione la stampa il tag in CI', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.version).toBe('0.3.1001')
  })

  it('il CHANGELOG ha la voce 0.3.1001-beta.1 con corpo per l\'utente (extract-release-notes la trova)', async () => {
    const { extractReleaseNotes } = (await import('../extract-release-notes.mjs')) as {
      extractReleaseNotes: (changelog: string, version: string) => string | null
    }
    const body = extractReleaseNotes(read('CHANGELOG.md'), '0.3.1001-beta.1')
    expect(body, 'manca la sezione ## [0.3.1001-beta.1] nel CHANGELOG').not.toBeNull()
    expect(body!.length).toBeGreaterThan(80) // in parole per l'utente, non una riga
    // dice la novità del canale di prova, che è il punto della beta
    expect(body).toContain('versioni di prova')
  })

  it('RV5 (fase beta.2): la voce 0.3.1001-beta.2 c’è, SOPRA la beta.1, in parole per l’utente', async () => {
    const { extractReleaseNotes } = (await import('../extract-release-notes.mjs')) as {
      extractReleaseNotes: (changelog: string, version: string) => string | null
    }
    const changelog = read('CHANGELOG.md')
    const body = extractReleaseNotes(changelog, '0.3.1001-beta.2')
    expect(body, 'manca la sezione ## [0.3.1001-beta.2] nel CHANGELOG').not.toBeNull()
    expect(body!.length).toBeGreaterThan(80) // in parole per l'utente, non una riga
    // le cinque cose della beta.2, dette come le vede chi usa l'app (i corpi
    // del changelog vanno a capo: le frasi si cercano a spazi normalizzati)
    const flat = body!.replace(/\s+/g, ' ')
    expect(flat).toContain('Applicazioni')
    expect(flat).toMatch(/✕/)
    expect(flat).toMatch(/[Ll]a lingua/)
    expect(flat).toMatch(/modello/)
    expect(flat).toContain('Configura prima un provider')
    // e sta SOPRA la beta.1 (chi legge il changelog vede prima la più nuova)
    expect(changelog.indexOf('## [0.3.1001-beta.2]')).toBeLessThan(changelog.indexOf('## [0.3.1001-beta.1]'))
  })
})

void existsSync
