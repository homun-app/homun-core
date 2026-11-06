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
const src = readFileSync(WINDOW, 'utf8')

/** Il blocco di un componente interno (dalla `function Nome` al successivo). */
function block(name: string): string {
  const start = src.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`componente ${name} non trovato in SkillsWindow.tsx`)
  const next = src.indexOf('\nfunction ', start + 10)
  return src.slice(start, next > 0 ? next : undefined)
}

/** Il blocco dell'elenco: dalla lista delle skill alla sezione Sfoglia. */
function listBlock(): string {
  const atList = src.indexOf('data-testid="skills-list"')
  const atBrowse = src.indexOf('data-testid="skills-catalog"')
  if (atList < 0 || atBrowse < 0) throw new Error('elenco o sezione Sfoglia non trovati')
  return src.slice(atList, atBrowse)
}

describe('T1: un solo campo di ricerca', () => {
  it('il campo dentro Sfoglia non c\'è più (né lo stato dedicato): resta solo quello in alto', () => {
    expect(src).not.toContain('skills-catalog-search')
    expect(src).not.toContain('catalogQuery')
    // il campo in alto resta UNO solo (un solo placeholder «Cerca skill»)
    expect((src.match(/placeholder=\{t`Cerca skill`\}/g) ?? []).length).toBe(1)
  })

  it('il campo in alto filtra ANCHE il catalogo di Sfoglia (la ricerca condivisa del catalogo)', () => {
    expect(src).toContain('searchSkillCatalog(catalog ?? [], query, lang)')
  })

  it('ricerca/filtro senza risultati → «Nessuna skill trovata»; l\'invito lungo solo a libreria VUOTA e SENZA ricerca', () => {
    const list = listBlock()
    expect(list).toContain('<Trans>Nessuna skill trovata</Trans>')
    expect(list).toContain('data-testid="skills-empty-filtered"')
    // il lungo (skills-empty) dietro la condizione esplicita: libreria
    // davvero vuota E nessuna ricerca
    expect(src).toMatch(/const longEmpty = libEmpty && !queryTrimmed/)
  })
})

describe('T2: il contenuto della finestra è un @container', () => {
  it('la classe @container sta SOLO sul contenitore del contenuto (vale per dettaglio, editor e anteprime)', () => {
    // una sola classe @container in tutto il file: quella del contenitore
    const withContainer = src.match(/className="[^"]*@container[^"]*"/g) ?? []
    expect(withContainer.length).toBe(1)
    expect(withContainer[0]).toContain('min-h-0 flex-1 overflow-y-auto')
    expect(src).toContain('data-testid="skills-content"')
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

describe('T5: niente anello di focus all\'apertura', () => {
  it('all\'apertura il focus va al campo di ricerca (onOpenAutoFocus preventDefault, niente «Nuova skill»)', () => {
    const at = src.indexOf('onOpenAutoFocus')
    expect(at).toBeGreaterThan(0)
    const handler = src.slice(at, at + 700)
    expect(handler).toContain('preventDefault')
    expect(handler).toContain('skills-search')
  })
})
