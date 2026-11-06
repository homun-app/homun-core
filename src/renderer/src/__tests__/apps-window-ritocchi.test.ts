// Fase pulizia · ritocchi (U2, U3): la finestra App come la finestra Skill
// dopo T2/T5. Il contenuto della finestra e ogni foglio che apre (dettaglio
// app, account Composio, server MCP, «Per sviluppatori») sono un @container,
// in UN punto per contenitore — così le righe SettingsRow mettono il
// controllo a destra del nome come nelle Impostazioni; SettingsRow non si
// tocca. Senza DOM (niente jsdom): si legge il sorgente, come le altre
// guardie del renderer; il comportamento VERO lo verifica la sonda
// scripts/fase-pulizia-probe.mjs sul DOM (top del toggle entro ±8 px).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WINDOW = fileURLToPath(new URL('../components/AppsWindow.tsx', import.meta.url))
const src = readFileSync(WINDOW, 'utf8')

/** Il blocco di un componente (dalla `function Nome` alla successiva). */
function block(name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`componente ${name} non trovato in AppsWindow.tsx`)
  const next = src.indexOf('\nfunction ', start + 10)
  const nextExport = src.indexOf('\nexport function ', start + 10)
  const ends = [next, nextExport].filter((i) => i > 0)
  return src.slice(start, ends.length ? Math.min(...ends) : undefined)
}

/** Le classi del contenitore del foglio: il div che ferma il click sul velo. */
function sheetContainerClasses(name: string): string {
  const m = block(name).match(/<div className="([^"]*)" onClick=\{\(e\) => e\.stopPropagation\(\)\}/)
  if (!m) throw new Error(`contenitore del foglio non trovato in ${name}`)
  return m[1]!
}

const count = (text: string): number => (text.match(/@container/g) ?? []).length
/** Il codice di un blocco senza i commenti JSX (che possono citare «@container»). */
const code = (text: string): string => text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

describe('U2: la finestra App e i suoi fogli sono @container', () => {
  it('il contenitore del contenuto della finestra (quello che scorre) è un @container', () => {
    const w = block('AppsWindow')
    expect(w).toMatch(/className="@container [^"]*overflow-y-auto[^"]*"/)
    expect(w).toContain('data-testid="apps-content"')
    // UN punto solo nella finestra: il contenitore del contenuto
    expect(count(code(w))).toBe(1)
  })

  for (const sheet of ['AppDetailSheet', 'ComposioAccountSheet', 'ConnectedDetailSheet', 'DevelopersSheet']) {
    it(`${sheet}: il contenitore del foglio è un @container (un punto solo)`, () => {
      expect(sheetContainerClasses(sheet).split(/\s+/)).toContain('@container')
      // nessun altro @container dentro il foglio
      expect(count(code(block(sheet)))).toBe(1)
    })
  }

  it('il componente condiviso SettingsRow non è stato toccato (la soglia resta nei suoi @[420px])', () => {
    const row = readFileSync(fileURLToPath(new URL('../components/settings/SettingsRow.tsx', import.meta.url)), 'utf8')
    expect(row).toContain('@[420px]:flex-row')
    // il componente non si fa contenitore da sé (i commenti di testa lo citano)
    expect(row.replace(/^\s*\/\/.*$/gm, '')).not.toContain('@container')
  })
})

describe('U3: niente anello di focus all\'apertura della finestra App', () => {
  it('all\'apertura il focus va al campo «Cerca tra app e skill», nel frame DOPO (come T5)', () => {
    const w = block('AppsWindow')
    const at = w.indexOf('onOpenAutoFocus')
    expect(at).toBeGreaterThan(0)
    const handler = w.slice(at, at + 900)
    // niente focus di Radix sul primo bottone (la ✕ con l'anello arancione)
    expect(handler).toContain('e.preventDefault()')
    // nel frame dopo, come T5
    expect(handler).toMatch(/requestAnimationFrame\(\(\) => [^\n]*\[data-testid="apps-search"\][^\n]*\.focus\(\)/)
  })

  it('il campo di ricerca è riconoscibile (data-testid="apps-search")', () => {
    const input = src.slice(src.lastIndexOf('<input', src.indexOf('placeholder={t`Cerca tra app e skill`}')), src.indexOf('placeholder={t`Cerca tra app e skill`}'))
    expect(input).toContain('data-testid="apps-search"')
  })

  it('i fogli che si aprono sopra non portano MAI il focus su un bottone: al più sul primo campo', () => {
    // autoFocus solo sui campi (input/textarea), mai su un bottone
    for (const m of src.matchAll(/autoFocus/g)) {
      const tag = src.slice(src.lastIndexOf('<', m.index), m.index)
      expect(tag).toMatch(/^<(input|textarea)\b/)
    }
    // l'unico focus da programma è quello del campo di ricerca
    const calls = [...src.matchAll(/\.focus\(\)/g)].map((m) => src.slice(Math.max(0, m.index - 120), m.index))
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('[data-testid="apps-search"]')
  })

  it('il menu dell\'account NON riprende il focus quando una sua voce apre una finestra', () => {
    // il frame dopo non basta: il menu Radix restituisce il focus al trigger a
    // fine animazione, SEMPRE dopo il nostro frame; lo riporta indietro solo la
    // trappola del dialogo, e a finestra senza focus di sistema non scatta
    // (niente focusin). La voce che apre una finestra lo dice al menu.
    const sidebar = readFileSync(fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url)), 'utf8')
    const at = sidebar.indexOf('function AccountMenu(')
    expect(at).toBeGreaterThan(0)
    const menu = sidebar.slice(at, sidebar.indexOf('\nfunction ', at + 10))
    expect(menu).toMatch(/onCloseAutoFocus=\{\(e\) => \{[^}]*openedWindow\.current[^}]*e\.preventDefault\(\)/)
    // le tre voci che aprono una finestra lo segnano PRIMA di aprirla
    for (const open of ['setAppsOpen(true)', 'setSkillsOpen(true)', 'setSettingsOpen(true)']) {
      const item = menu.slice(menu.lastIndexOf('<DropdownMenuItem', menu.indexOf(open)), menu.indexOf(open))
      expect(item, `la voce con ${open}`).toContain('openedWindow.current = true')
    }
  })
})
