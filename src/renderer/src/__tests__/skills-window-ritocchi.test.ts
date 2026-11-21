// Fase skill · Sfoglia — RITOCCHI (T1–T5): la finestra Skill pulita dopo la
// verifica delle catture. Un solo campo di ricerca (quello in alto, che
// filtra insieme tue skill, plugin e pacchetti di Sfoglia), il contenuto
// della finestra è un @container (le righe SettingsRow mettono il controllo
// a destra), l'anteprima di Sfoglia mostra il displayName della griglia con
// lo slug nella riga piccola, un solo «Annulla» (in alto «‹ Indietro») e
// niente anello di focus all'apertura. Senza DOM (niente jsdom): si legge il
// sorgente, come le altre guardie del renderer; il comportamento VERO lo
// verifica la sonda scripts/fase-skill-sfoglia-probe.mjs sul DOM.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WINDOW = fileURLToPath(new URL('../components/SkillsWindow.tsx', import.meta.url))
const PANEL = fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url))
const src = readFileSync(PANEL, 'utf8')
const pieces = readFileSync(WINDOW, 'utf8')

/** Il blocco di un componente interno dei PEZZI (dalla `function Nome` al successivo). */
function block(name: string): string {
  const start = pieces.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`componente ${name} non trovato in SkillsWindow.tsx`)
  const next = pieces.indexOf('\nfunction ', start + 10)
  return pieces.slice(start, next > 0 ? next : undefined)
}

describe('T1 → PL7: un solo campo di ricerca (quello della pagina Plugin)', () => {
  it('il campo dentro Sfoglia non c\'è mai stato nella pagina: resta solo quello in alto', () => {
    expect(src).not.toContain('skills-catalog-search')
    expect(src).not.toContain('catalogQuery')
    // il campo in alto della pagina resta UNO solo
    expect((src.match(/data-testid="plugin-search"/g) ?? []).length).toBe(1)
  })

  it('il campo in alto filtra ANCHE il catalogo di Sfoglia (la ricerca condivisa del catalogo)', () => {
    expect(src).toContain('searchSkillCatalog(catalog ?? [], query, lang)')
  })

  it('ricerca senza risultati → «Nessuna skill trovata» (il messaggio breve della pagina); l\'invito lungo solo a elenco VUOTO', () => {
    expect(src).toContain('<Trans>Nessuna skill. Creane una, importala, o chiedi a un bot di salvarne una.</Trans>')
    expect(src).toContain('<Trans>Nessuna skill trovata</Trans>')
  })
})

describe('T2 → PL7: il contenitore @container è quello dei fogli della pagina', () => {
  it('i fogli della pagina (editor, dettaglio plugin-skill, anteprima) sono @container', () => {
    // il pannello della pagina e i suoi fogli portano @container (le righe
    // SettingsRow dell'editor mettono il controllo a destra)
    const withContainer = src.match(/className="@container[^"]*"/g) ?? []
    expect(withContainer.length).toBeGreaterThanOrEqual(2)
  })
  it('la vecchia FINESTRA non c\'è più: in SkillsWindow.tsx restano solo i pezzi', () => {
    expect(pieces).not.toMatch(/export function SkillsWindow/)
    expect(pieces).not.toContain('Dialog open')
    expect(pieces).not.toContain('data-testid="skills-window"')
  })

  it('il componente condiviso SettingsRow non è stato toccato (la soglia resta nei suoi @[420px])', () => {
    // T2 si risolve nella finestra, non nel componente: la riga continua a
    // decidere dal contesto — qui si legge il sorgente condiviso
    const row = readFileSync(fileURLToPath(new URL('../components/settings/SettingsRow.tsx', import.meta.url)), 'utf8')
    expect(row).toContain('@[420px]:flex-row')
  })
})

describe('T3: il nome dell\'anteprima è lo stesso della riga del catalogo', () => {
  it('il titolo dell\'anteprima è l\'id umanizzato della voce (come la riga), con fonte e commit sotto', () => {
    const cp = block('CatalogPreview')
    expect(src).toMatch(/<CatalogPreview[^>]*entry=/)
    expect(cp).toContain('data-testid="skills-catalog-preview-title"')
    expect(cp).toMatch(/humanizeSkillName\(entry\.id\)/)
    // la riga piccola: owner/repo · commit (i primi 12)
    expect(cp).toMatch(/entry\.source\.repo[\s\S]{0,120}preview\.commit\.slice\(0, 12\)/)
  })
})

describe('T4: un solo «Annulla» in basso nell\'anteprima di una voce del catalogo', () => {
  it('in alto «‹ Indietro» che chiude; «Annulla» e «Aggiungi» restano in basso', () => {
    const cp = block('CatalogPreview')
    // il PRIMO bottone del blocco: l'Indietro, che chiude l'anteprima
    const atFirst = cp.indexOf('<button')
    const firstBtn = cp.slice(atFirst, cp.indexOf('</button>', atFirst))
    expect(firstBtn).toContain('<Trans>Indietro</Trans>')
    expect(firstBtn).toContain('data-testid="skills-catalog-back"')
    expect(firstBtn).toMatch(/onClick=\{onClose\}/)
    // UN solo «Annulla» nella riga delle azioni in basso, accanto ad «Aggiungi»
    // (nel diff dell'aggiornamento l'«Annulla» è un'altra cosa: chiude il diff)
    const atAdd = cp.indexOf('data-testid="skills-catalog-add"')
    expect(atAdd).toBeGreaterThan(0)
    const actions = cp.slice(cp.lastIndexOf('<div', atAdd), atAdd)
    expect((actions.match(/<Trans>Annulla<\/Trans>/g) ?? []).length).toBe(1)
    expect(cp).toContain('data-testid="skills-catalog-cancel"')
  })
})

describe('T5 → PL7: niente più dialogo della finestra Skill (niente anello di focus)', () => {
  it('la pagina Plugin non è un Dialog: nessun onOpenAutoFocus da compensare', () => {
    expect(src).not.toContain('onOpenAutoFocus')
    expect(pieces).not.toContain('onOpenAutoFocus')
  })
})
