// Fase skill · Sfoglia (B4): la terza sezione della finestra «Skill» — il
// catalogo dei pacchetti di sole skill dei marketplace, con la struttura e
// la densità di Rakazo: titoletto, campo «Cerca skill» (max 200), griglia a
// 2 colonne sopra i 640 px, stati (caricamento, «Alcuni pacchetti non si
// sono caricati.» con Riprova, «Nessun pacchetto trovato»), l'anteprima con
// «Aggiungi»/«Annulla» e «Bot che la usano». Senza DOM (niente jsdom): si
// legge il sorgente, come le altre guardie del renderer.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WINDOW = fileURLToPath(new URL('../components/SkillsWindow.tsx', import.meta.url))
const src = readFileSync(WINDOW, 'utf8')

/** Il blocco JSX della sezione Sfoglia (dal tag section alla sua chiusura). */
function browseSection(): string {
  const at = src.indexOf('data-testid="skills-browse"')
  if (at < 0) throw new Error('sezione Sfoglia non trovata in SkillsWindow.tsx')
  const start = src.lastIndexOf('<section', at)
  // chiusura: la prima '</section>' dopo l'apertura (dentro c'è solo la griglia)
  const end = src.indexOf('</section>', at)
  return src.slice(start, end)
}

describe('B4: la sezione «Sfoglia» nella finestra Skill', () => {
  it('sta DOPO l\'elenco delle skill e dei plugin (terza sezione)', () => {
    const atList = src.indexOf('data-testid="skills-list"')
    const atBrowse = src.indexOf('data-testid="skills-browse"')
    expect(atList).toBeGreaterThan(0)
    expect(atBrowse).toBeGreaterThan(atList)
  })

  it('in cima: il titoletto «Sfoglia» e NESSUN campo di ricerca dentro (T1: filtra il campo in alto)', () => {
    const sec = browseSection()
    expect(sec).toContain('<Trans>Sfoglia</Trans>')
    // T1 (ritocchi): il campo dentro la sezione non c'è più — resta solo
    // quello in alto, che filta ANCHE i pacchetti (tetto dei 200 conservato)
    expect(src).not.toContain('skills-browse-search')
    expect((src.match(/maxLength=\{200\}/g) ?? []).length).toBe(1)
    expect(src).toContain('data-testid="skills-search"')
  })

  it('la griglia: 2 colonne sopra i 640 px, 1 sotto', () => {
    const sec = browseSection()
    expect(sec).toContain('data-testid="skills-browse-grid"')
    expect(sec).toContain('grid grid-cols-1 gap-2 sm:grid-cols-2')
  })

  it('gli stati: spinner mentre carica, riga «Alcuni pacchetti non si sono caricati.» con «Riprova», «Nessun pacchetto trovato»', () => {
    const sec = browseSection()
    expect(sec).toMatch(/animate-spin|Spinner/)
    expect(sec).toContain('data-testid="skills-browse-unavailable"')
    expect(sec).toContain('<Trans>Alcuni pacchetti non si sono caricati.</Trans>')
    expect(sec).toContain('data-testid="skills-browse-retry"')
    expect(sec).toContain('<Trans>Riprova</Trans>')
    expect(sec).toContain('data-testid="skills-browse-empty"')
    expect(sec).toContain('<Trans>Nessun pacchetto trovato</Trans>')
  })

  it('la riga del pacchetto: nome, «N skill», etichetta «ufficiale» e «Aggiunto»', () => {
    const sec = browseSection()
    expect(sec).toContain('data-testid={`skills-browse-entry-${')
    expect(sec).toMatch(/\{skillCount|skillCount}/)
    expect(sec).toContain('<Trans>ufficiale</Trans>')
    expect(sec).toContain('<Trans>Aggiunto</Trans>')
  })

  it('l\'anteprima: nome, marketplace, sha12, skill con descrizione, parti «non usate», Aggiungi e Annulla (che scarta lo staging)', () => {
    const start = src.indexOf('function BrowsePreview')
    expect(start).toBeGreaterThan(0)
    const sheet = src.slice(start, src.indexOf('\nfunction ', start + 10) > 0 ? src.indexOf('\nfunction ', start + 10) : undefined)
    expect(sheet).toContain('api.skillsBrowsePreview')
    expect(sheet).toContain('sha12')
    expect(sheet).toContain('marketplace')
    expect(sheet).toContain('<Trans>non usate:</Trans>')
    expect(sheet).toContain('<Trans>Aggiungi</Trans>')
    expect(sheet).toContain('data-testid="skills-browse-add"')
    expect(sheet).toContain('<Trans>Annulla</Trans>')
    expect(sheet).toContain('api.skillsBrowseDiscard')
    expect(sheet).toContain('api.skillsBrowseInstall')
  })

  it('il toggle «Tutti i bot» ACCESO spegne e DISATTIVA i toggle dei singoli bot (anteprima Sfoglia E import GitHub)', () => {
    // l'anteprima di Sfoglia
    const bp = src.slice(src.indexOf('function BrowsePreview'))
    const bpAgents = bp.slice(bp.indexOf('agents.map'), bp.indexOf('agents.map') + 900)
    expect(bpAgents).toContain('checked={allBots ? false : enabledFor.includes(a.id)}')
    expect(bpAgents).toContain('disabled={allBots}')
    // e l'import GitHub (il difetto notato alla verifica precedente)
    const gi = src.slice(src.indexOf('function GithubImport'))
    const giAgents = gi.slice(gi.indexOf('agents.map'), gi.indexOf('agents.map') + 900)
    expect(giAgents).toContain('checked={allBots ? false : enabledFor.includes(a.id)}')
    expect(giAgents).toContain('disabled={allBots}')
  })

  it('il catalogo si carica dalla RPC all\'apertura e filtra in locale (accenti e maiuscole non contano)', () => {
    expect(src).toContain('api.skillsBrowse(')
    expect(src).toContain('matchesSkillPackQuery')
  })
})
