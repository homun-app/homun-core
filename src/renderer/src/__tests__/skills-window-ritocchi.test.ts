// Fase skill · Sfoglia — RITOCCHI (T1–T5): la finestra Skill pulita dopo la
// verifica delle catture. Un solo campo di ricerca (quello in alto, che
// filtra insieme tue skill, plugin e pacchetti di Sfoglia), il contenuto
// della finestra è un @container (le righe SettingsRow mettono il controllo
// a destra), l'anteprima di Sfoglia mostra il displayName della griglia con
// lo slug nella riga piccola, un solo «Annulla» (in alto «‹ Indietro») e
// niente anello di focus all'apertura. Senza DOM (niente jsdom): si legge il
// sorgente, come le altre guardie del renderer; il comportamento VERO lo
// verifica la sonda scripts/fase-skill-sfoglia-probe.mjs sul DOM.
// (Fase design, DS4: in fondo anche il render dell'editor, per i campi e i bottoni ai token.)
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'

// C0 (fase linguaggio): SkillsWindow.tsx è smontato in components/plugin/ —
// skill-editor, plugin-detail e catalog-preview — e i pezzi si leggono lì
const PIECES = [
  '../components/plugin/skill-editor.tsx',
  '../components/plugin/plugin-detail.tsx',
  '../components/plugin/catalog-preview.tsx',
  '../components/plugin/skill-bits.ts'
].map((rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))
const PANEL = fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url))
const src = readFileSync(PANEL, 'utf8')
const pieces = PIECES.join('\n\n')

/** Il blocco di un componente interno dei PEZZI (dalla `function Nome` al successivo). */
function block(name: string): string {
  const start = pieces.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`componente ${name} non trovato nei pezzi della skill (plugin/)`)
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

// ---- Fase design (DS4): i pezzi delle skill ai token ----
describe('T1–T5 → DS4 (fase design): i pezzi delle skill ai token', () => {
  /** Il codice dei pezzi, senza i commenti (che raccontano com'era). */
  const code = pieces.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

  it('niente più emoji né glifi al posto di un\'icona: davanti al nome di una skill di plugin e di una voce del catalogo c\'è un\'icona lucide, in una casa da 40 (il logo delle testate di scheda)', () => {
    expect(code).not.toMatch(/🧩|✦/)
    expect(code).toContain('<Puzzle className="size-5" />')
    expect(code).toContain('<Sparkles className="size-5" />')
    expect(code).toMatch(/const TILE = '[^']*size-10[^']*'/)
    // e il nome della skill, nel dettaglio di plugin e nell'anteprima, è il titolo del foglio (text-title)
    expect(code).toContain('text-title font-semibold">{humanizeSkillName(name)}')
    expect(code).toContain('text-title font-semibold" data-testid="skills-catalog-preview-title">{humanizeSkillName(entry.id)}')
    // niente più un 48 px col raggio suo: la misura è quella dei loghi
    expect(code).not.toContain('size-12')
  })

  it('i bottoni sono Button, e le azioni che ANNULLANO sono testo (ghost): mai un bottone pieno per «Annulla»', () => {
    const annulla = code.match(/<Button(?:(?!<\/Button>)[\s\S])*?<Trans>Annulla<\/Trans>\s*<\/Button>/g) ?? []
    // tre: l'aggiornamento da GitHub, il fondo dell'anteprima, il diff dell'aggiornamento del catalogo
    expect(annulla).toHaveLength(3)
    for (const b of annulla) expect(b).toContain('variant="ghost"')
    // nessun <button> scritto a mano porta il testo di un'azione di salvataggio
    for (const hand of code.match(/<button\b[\s\S]*?<\/button>/g) ?? []) expect(hand).not.toMatch(/Salva|Aggiorna|Aggiungi|Rimuovi|Collega/)
  })

  it('l\'editor di una skill nuova: i campi sono alti 36 col raggio dei controlli; «Salva» è l\'unico pieno; «Indietro» sta in una casa alta 32', async () => {
    const { SkillEditor } = await import('../components/plugin/skill-editor')
    const root = parseHtml(renderHtml(createElement(SkillEditor, { folder: null, onDone: () => undefined, onCancel: () => undefined })))
    // il campo su una riga: 36. Le aree di testo (descrizione, istruzioni) non hanno un'altezza fissa —
    // crescono col testo — ma il raggio e il testo sono quelli dei campi
    const name = findAll(root, (n) => n.attrs['data-testid'] === 'skill-field-name')[0]!
    for (const cls of ['h-control', 'rounded-control', 'text-body']) expect(name.attrs.class ?? '', cls).toContain(cls)
    const description = findAll(root, (n) => n.attrs['data-testid'] === 'skill-field-description')[0]!
    expect(description.tag).toBe('textarea')
    for (const cls of ['rounded-control', 'text-body', 'min-h-16']) expect(description.attrs.class ?? '').toContain(cls)
    // le istruzioni sono codice (markdown): monospazio, a 13 px — non una taglia sotto i 12 come prima
    const body = findAll(root, (n) => n.attrs['data-testid'] === 'skill-field-body')[0]!
    expect(body.tag).toBe('textarea')
    for (const cls of ['rounded-control', 'font-mono', 'text-small', 'min-h-40']) expect(body.attrs.class ?? '').toContain(cls)
    const save = findAll(root, (n) => n.attrs['data-testid'] === 'skill-save')[0]!
    expect(save.attrs['data-slot']).toBe('button')
    expect(save.attrs.class).toContain('bg-foreground')
    expect(save.attrs.class).toContain('h-control')
    const back = findAll(root, (n) => n.attrs['data-testid'] === 'skill-back')[0]!
    expect(back.attrs.class).toContain('h-control-sm')
  })
})
