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

// C0 (fase linguaggio): AppsWindow.tsx è smontato in components/plugin/ — i
// pezzi si leggono lì, uniti
const src = [
  '../components/ui/app-logo.tsx',
  '../components/plugin/app-row.tsx',
  '../components/plugin/connect-flows.tsx',
  '../components/plugin/developers-content.tsx',
  '../components/plugin/gateway-accounts.tsx'
].map((rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')).join('\n\n')

/** Il blocco di un componente (dalla `function Nome` alla successiva). */
function block(name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`componente ${name} non trovato nei pezzi di plugin/`)
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

describe('U2 → PL7: la finestra App non c\'è più; i fogli vivono nella pagina Plugin', () => {
  it('nessuna finestra e nessun foglio-morto nei pezzi di plugin/: solo i pezzi riusati', () => {
    for (const gone of ['AppsWindow', 'AppsView', 'AppDetailSheet', 'ComposioAccountSheet', 'ConnectedDetailSheet', 'DevelopersSheet']) {
      expect(src, gone).not.toMatch(new RegExp(`^(export )?function ${gone}\\(`, 'm'))
    }
    // i pezzi esportati che la pagina usa (fase design, DS5: FilterPill e BotTogglesForApp non
    // le usava più nessuno — resti della finestra «App» — e sono usciti con il censimento degli export)
    for (const piece of ['AppRow', 'AppLogo', 'useConnectFlows', 'GatewayAccountsSection', 'DevelopersContent']) {
      expect(src, piece).toMatch(new RegExp(`^export function ${piece}\\(`, 'm'))
    }
  })

  it('i contenitori dei fogli della PAGINA sono @container (la scheda del plugin e i suoi fogli)', () => {
    const panel = readFileSync(fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url)), 'utf8')
    const card = readFileSync(fileURLToPath(new URL('../components/PluginCard.tsx', import.meta.url)), 'utf8')
    expect(count(code(panel))).toBeGreaterThanOrEqual(2)
    expect(count(code(card))).toBeGreaterThanOrEqual(0)
  })

  it('il componente condiviso SettingsRow non è stato toccato (la soglia resta nei suoi @[420px])', () => {
    const row = readFileSync(fileURLToPath(new URL('../components/settings/SettingsRow.tsx', import.meta.url)), 'utf8')
    expect(row).toContain('@[420px]:flex-row')
    // il componente non si fa contenitore da sé (i commenti di testa lo citano)
    expect(row.replace(/^\s*\/\/.*$/gm, '')).not.toContain('@container')
  })
})

describe('U3 → PL7: la pagina Plugin non è un Dialog (niente anello di focus)', () => {
  it('nessun onOpenAutoFocus da compensare: il campo di ricerca della pagina è testid plugin-search', () => {
    const panel = readFileSync(fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url)), 'utf8')
    expect(panel).not.toContain('onOpenAutoFocus')
    expect(panel).toContain('data-testid="plugin-search"')
    expect(src).not.toContain('data-testid="apps-search"')
  })

  it('i pezzi non mettono autoFocus su un bottone: al più sui campi', () => {
    for (const m of src.matchAll(/autoFocus/g)) {
      const tag = src.slice(src.lastIndexOf('<', m.index), m.index)
      expect(tag).toMatch(/^<(input|textarea)\b/)
    }
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
    // PL1 (fase plugin): dal menu resta solo Impostazioni ad aprire una
    // finestra (le altre voci sono la pagina Plugin della barra) — la segna
    // PRIMA di aprirla, come prima
    for (const open of ['setSettingsOpen(true)']) {
      const item = menu.slice(menu.lastIndexOf('<DropdownMenuItem', menu.indexOf(open)), menu.indexOf(open))
      expect(item, `la voce con ${open}`).toContain('openedWindow.current = true')
    }
  })
})
