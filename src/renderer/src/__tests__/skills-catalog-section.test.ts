// Fase skill · catalogo (K2) → PL7 (fase plugin): la sezione «Sfoglia» vive
// nella PAGINA «Plugin» (segmento Skill) — il CATALOGO CURATO del repo
// (nessuna rete), categorie coi titoletti, filtri a pillola, ricerca dal
// campo in alto e righe con fonte e descrizione; l'ANTEPRIMA (CatalogPreview)
// resta un pezzo di SkillsWindow riusato dalla pagina. Senza DOM: si legge il
// sorgente; il comportamento VERO lo verifica la sonda sul DOM.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WINDOW = fileURLToPath(new URL('../components/plugin/catalog-preview.tsx', import.meta.url))
const PANEL = fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url))
const src = readFileSync(PANEL, 'utf8')
const preview = readFileSync(WINDOW, 'utf8')

/** Il blocco di un componente interno (dalla `function Nome` al successivo). */
function block(name: string): string {
  const start = src.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`componente ${name} non trovato nei pezzi della skill (plugin/)`)
  const next = src.indexOf('\nfunction ', start + 10)
  return src.slice(start, next > 0 ? next : undefined)
}

describe('K2 → PL5: la sezione «Sfoglia» sta nella pagina Plugin (segmento Skill)', () => {
  it('sta DOPO le righe delle skill (libreria e plugin) nel segmento', () => {
    // fase design (DS4): il segmento è la sezione di sistema — il testid lo porta la prop testId di Section
    const atRows = src.indexOf('testId="plugin-skills"')
    const atCatalog = src.indexOf('testId="plugin-skills-catalog"')
    expect(atRows).toBeGreaterThan(0)
    expect(atCatalog).toBeGreaterThan(atRows)
  })

  it('NESSUN residuo dello Sfoglia dei marketplace (RPC, eventi, componenti)', () => {
    expect(src).not.toContain('skillsBrowse')
    expect(src).not.toContain('skills-browse')
    expect(src).not.toContain('BrowsePreview')
    expect(src).not.toContain('matchesSkillPackQuery')
    expect(src).not.toContain('skill-browse-search')
  })

  it('l\'elenco arriva dall\'RPC LOCALE skillsCatalog (il catalogo è nel repo: nessuna rete)', () => {
    expect(src).toContain('api.skillsCatalog()')
  })

  it('le voci sono raggruppate per categoria, coi titoletti nell\'ordine di SKILL_CATEGORIES', () => {
    expect(src).toMatch(/SKILL_CATEGORIES/)
    expect(src).toContain('<Trans>Sfoglia</Trans>')
    expect(src).toMatch(/skillCatalogDescription\(entry, lang\)/)
  })

  // PP4 (fase plugin-pulita): i filtri non sono più pillole ma testo (UnderlineTabs)
  // — «Tutte» più una per categoria; quella attiva non si ri-toglie più col
  // clic, perché «Tutte» è una scheda a fianco
  it('i filtri come PILLOLE: «Tutte» più una per categoria (C4: una UnderlineTabs sola per pagina)', () => {
    expect(src).toMatch(/skillCatFilter === 'all'/)
    expect(src).toMatch(/data-testid="plugin-skill-filters"/)
    expect(src).toMatch(/onSelect=\{\(\) => setSkillCatFilter\('all'\)\}/)
    expect(src).toContain('>Tutte<')
    expect(src).not.toMatch(/skillCatFilter === c \? 'bg-foreground/)
  })

  it('la ricerca in alto filtra ANCHE il catalogo, con la funzione condivisa del catalogo', () => {
    expect(src).toContain('searchSkillCatalog(catalog ?? [], query, lang)')
  })

  it('la riga: nome umanizzato, descrizione nella lingua, e i badge Aggiunta/Aggiornamento dalla funzione di stato', () => {
    expect(src).toMatch(/humanize\(entry\.id\)/)
    expect(src).toMatch(/skillCatalogInstallState\(entry, skills \?\? \[\]\)/)
    expect(src).toContain('<Trans>Aggiunta</Trans>')
    expect(src).toContain('<Trans>Aggiornamento disponibile</Trans>')
    expect(preview).toContain('data-testid="skills-catalog-preview-title"')
    expect(preview).toContain('<Trans>Aggiornamento disponibile</Trans>')
  })
})

describe('K2 → PL7: l\'anteprima della voce è un pezzo riusato dalla pagina', () => {
  it('CatalogPreview vive in plugin/catalog-preview.tsx e la pagina la apre dalla riga', () => {
    expect(preview).toMatch(/export function CatalogPreview/)
    expect(src).toMatch(/import \{ SkillEditor \} from '\.\/plugin\/skill-editor'/)
    expect(src).toMatch(/import \{ PluginDetail \} from '\.\/plugin\/plugin-detail'/)
    expect(src).toMatch(/import \{ CatalogPreview \} from '\.\/plugin\/catalog-preview'/)
    expect(src).toMatch(/<CatalogPreview/)
  })
})
