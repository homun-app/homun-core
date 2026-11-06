// Fase skill · catalogo (K2): la sezione «Sfoglia» della finestra «Skill» non
// mostra più i pacchetti dei marketplace ma il CATALOGO CURATO che vive nel
// repo (src/shared/skill-catalog) — nessuna rete per l'elenco, categorie con
// titoletti, filtri a pillola, ricerca dal campo in alto (funzione condivisa)
// e righe con fonte e «Aggiunta». Senza DOM (niente jsdom): si legge il
// sorgente, come le altre guardie del renderer; il comportamento VERO lo
// verifica la sonda scripts/fase-skill-catalogo-probe.mjs sul DOM.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WINDOW = fileURLToPath(new URL('../components/SkillsWindow.tsx', import.meta.url))
const src = readFileSync(WINDOW, 'utf8')

/** Il blocco di un componente interno (dalla `function Nome` al successivo). */
function block(name: string): string {
  const start = src.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`componente ${name} non trovato in SkillsWindow.tsx`)
  const next = src.indexOf('\nfunction ', start + 10)
  return src.slice(start, next > 0 ? next : undefined)
}

describe('K2: la sezione «Sfoglia» mostra il CATALOGO del repo', () => {
  it('sta DOPO l\'elenco delle skill e dei plugin (terza sezione)', () => {
    const atList = src.indexOf('data-testid="skills-list"')
    const atCatalog = src.indexOf('data-testid="skills-catalog"')
    expect(atList).toBeGreaterThan(0)
    expect(atCatalog).toBeGreaterThan(atList)
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
    const sec = block('SkillsWindow')
    expect(sec).toContain('data-testid={`skills-catalog-category-${')
    expect(sec).toMatch(/SKILL_CATEGORIES/)
    expect(src).toContain('<Trans>Sfoglia</Trans>')
  })

  it('i filtri a pillola: «Tutte» più una per categoria', () => {
    const sec = block('SkillsWindow')
    expect(sec).toContain('data-testid="skills-catalog-filters"')
    expect(sec).toMatch(/skills-catalog-filter-\$\{/)
    expect(src).toContain('<Trans>Tutte</Trans>')
  })

  it('la ricerca in alto filtra ANCHE il catalogo, con la funzione condivisa del catalogo', () => {
    expect(src).toContain('searchSkillCatalog')
    expect(src).not.toContain('skills-catalog-search')
  })

  it('la riga: nome, descrizione nella lingua dell\'interfaccia, fonte owner/repo piccola e grigia, «Aggiunta»', () => {
    const sec = block('SkillsWindow')
    expect(sec).toMatch(/skills-catalog-entry-\$\{/)
    expect(sec).toContain('skillCatalogDescription')
    expect(sec).toMatch(/entry\.source\.repo/)
    // la fonte è la riga piccola e grigia
    const atRepo = sec.indexOf('entry.source.repo')
    expect(sec.slice(Math.max(0, atRepo - 220), atRepo)).toContain('text-muted-foreground')
    expect(sec).toContain('<Trans>Aggiunta</Trans>')
    expect(sec).toContain('<Trans>Aggiornamento disponibile</Trans>')
  })
})

describe('K2: l\'anteprima della voce (K3) resta nella finestra', () => {
  it('il componente CatalogPreview esiste e si apre dalla riga', () => {
    expect(src).toMatch(/function CatalogPreview/)
    expect(src).toMatch(/<CatalogPreview/)
  })
})
