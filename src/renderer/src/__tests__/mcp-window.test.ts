// M2 (fase beta12-correzioni): i server MCP hanno una finestra LORO, come le
// Skill — la voce «Server MCP» nel menu dell'account (tra Skill e
// Impostazioni) apre McpWindow; dentro: l'elenco dei server collegati e il
// form di aggiunta di oggi (ManualServers SPOSTATO da AppsWindow, non
// riscritto), in fondo il rimando piccolo «Gateway, plugin e registro» che
// apre «Per sviluppatori». «Per sviluppatori» non mostra più il form ma una
// riga che rimanda alla finestra. La voce vale ANCHE per la rotaia (il menu
// dell'account è uno solo). Oltre alle guardie sul sorgente: il render del
// componente VERO con l'api finta (i server esistenti e il bottone di
// aggiunta), come gli altri test del renderer senza DOM.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, dialogPassThroughMock } from './render-helper'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const SIDEBAR = fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url))
const APPSW = fileURLToPath(new URL('../components/AppsWindow.tsx', import.meta.url))
const MCPW = fileURLToPath(new URL('../components/McpWindow.tsx', import.meta.url))
const APP = fileURLToPath(new URL('../App.tsx', import.meta.url))
const STORE = fileURLToPath(new URL('../store.ts', import.meta.url))

/** Il blocco DropdownMenuContent dell'AccountMenu (il menu in fondo). */
function accountMenuContent(): string {
  const src = readFileSync(SIDEBAR, 'utf8')
  const m = /function AccountMenu\([\s\S]*?<DropdownMenuContent([^>]*)>([\s\S]*?)<\/DropdownMenuContent>/.exec(src)
  if (!m) throw new Error('AccountMenu non trovata in Sidebar.tsx')
  return m[2]!
}

describe('M2 → PL1: la voce «Server MCP» NON sta più nel menu dell\'account', () => {
  // PL1 (fase plugin): «Collega app», «Skill» e «Server MCP» sono uscite dal
  // menu — la casa unica è la pagina «Plugin» della barra; i server MCP si
  // aprono lì (PluginPoint {kind:'mcp'}), dentro sta ManualServers com'era
  it('il menu non ha più la voce (né menu-mcp né setMcpOpen)', () => {
    const menu = accountMenuContent()
    expect(menu).not.toContain('<Trans>Server MCP</Trans>')
    expect(menu).not.toContain('data-testid="menu-mcp"')
    expect(menu).not.toContain('setMcpOpen(true)')
  })

  it('la pagina Plugin apre ManualServers nel punto MCP (openPlugin {kind:\'mcp\'})', () => {
    const panel = readFileSync(fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url)), 'utf8')
    expect(panel).toMatch(/kind === 'mcp'/)
    expect(panel).toContain("view === 'mcp'")
    expect(panel).toMatch(/<ManualServers \/>/)
  })

  it('il menu dell\'account è UNO solo: la voce vale anche per la rotaia', () => {
    const src = readFileSync(SIDEBAR, 'utf8')
    expect((src.match(/function AccountMenu\(/g) ?? []).length).toBe(1)
    expect(src).toMatch(/<AccountMenu\s+rail\b/)
  })
})

describe('M2: McpWindow — la finestra dei server MCP', () => {
  const src = readFileSync(MCPW, 'utf8')

  it('il file esiste e contiene ManualServers SPOSTATO (in AppsWindow non c\'è più)', () => {
    expect(src).toContain('function ManualServers(')
    expect(readFileSync(APPSW, 'utf8')).not.toContain('function ManualServers(')
  })

  it('il form di oggi resta com\'era: stdio e http, bearer cifrato, «+ Aggiungi server MCP»', () => {
    const start = src.indexOf('function ManualServers(')
    const block = src.slice(start, src.indexOf('\nfunction ', start + 10) > 0 ? src.indexOf('\nfunction ', start + 10) : undefined)
    expect(block).toContain('t`stdio (comando locale)`')
    expect(block).toContain('t`http (URL)`')
    expect(block).toContain('type="password"')
    expect(block).toContain('Bearer token (opzionale — salvato cifrato)')
    expect(block).toContain('+ Aggiungi server MCP')
  })

  it('come SkillsWindow: Dialog aperta, chiusura e Esc (onOpenChange → setMcpOpen(false)), testid propria', () => {
    expect(src).toMatch(/<Dialog open onOpenChange=\{\(o\) => \{ if \(!o\) (setMcpOpen\(false\)|[^\n]*)/)
    expect(src).toContain('data-testid="mcp-window"')
    expect(src).toContain('sr-only')
  })

  it('intestazione: titolo «Server MCP» e la spiegazione semplice (Cursor o Claude)', () => {
    expect(src).toContain('<Trans>Server MCP</Trans>')
    expect(src).toMatch(/Cursor o Claude/)
    expect(src).toMatch(/stesso comando o lo stesso indirizzo/)
  })

  it('in fondo, piccolo: «Gateway, plugin e registro» apre «Per sviluppatori»', () => {
    expect(src).toContain('<Trans>Gateway, plugin e registro</Trans>')
    expect(src).toMatch(/setAppsOpenDevelopers\(true\)/)
  })

  it('l\'elenco dice da quali bot è usato un server, quando il dato esiste già (enabledFor)', () => {
    expect(src).toMatch(/enabledFor/)
  })
})

describe('M2: «Per sviluppatori» rimanda, non mostra più il form', () => {
  it('DevelopersSheet non rende più ManualServers e ha la riga di rimando', () => {
    const src = readFileSync(APPSW, 'utf8')
    const start = src.indexOf('function DevelopersSheet(')
    const block = src.slice(start, src.indexOf('\nfunction ', start + 10))
    expect(block).not.toContain('<ManualServers')
    // la riga che rimanda alla finestra «Server MCP»
    expect(block).toMatch(/setMcpOpen\(true\)/)
    expect(block).toMatch(/Server MCP/)
  })

  it('ServerSheet non si tocca: AppsWindow lo importa ancora per il dettaglio dei server', () => {
    expect(readFileSync(APPSW, 'utf8')).toContain("from './ServerSheet'")
  })
})

describe('M2: store e App', () => {
  it('lo store ha mcpOpen (chiusa) e setMcpOpen', () => {
    const src = readFileSync(STORE, 'utf8')
    expect(src).toMatch(/mcpOpen: boolean/)
    expect(src).toMatch(/mcpOpen: false/)
    expect(src).toMatch(/setMcpOpen\(v\)/)
  })

  it('App monta McpWindow quando mcpOpen', () => {
    const src = readFileSync(APP, 'utf8')
    expect(src).toMatch(/import \{ McpWindow \} from '\.\/components\/McpWindow'/)
    expect(src).toMatch(/\{mcpOpen && <McpWindow \/>}/)
  })
})

describe('M2: il render della finestra (componente vero, api finta)', () => {
  // il render statico non esegue gli effect: la lista dei server ARRIVA da
  // api.mcpList con lo stesso codice di oggi (spostato, non toccato) e le
  // righe coi nomi dei server le verifica la sonda sul DOM vero; qui il
  // MINIMO che la finestra mostra appena aperta
  it('titolo, spiegazione, intestazione dell\'elenco, form di aggiunta, rimando in fondo', async () => {
    const { McpWindow } = await import('../components/McpWindow')
    const { useStore } = await import('../store')
    setStoreStateForRender(useStore, {
      agents: [
        { id: 'a-bot', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
      ]
    })
    const html = renderHtml(createElement(McpWindow, {}))
    const root = parseHtml(html)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('Server MCP')
    expect(texts).toContain('Server MCP personalizzato')
    expect(texts).toContain('+ Aggiungi server MCP')
    expect(texts).toContain('Cursor o Claude')
    // il rimando in fondo
    expect(texts).toContain('Gateway, plugin e registro')
  })
})
