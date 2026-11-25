// M2 (fase beta12-correzioni) → PL7 (fase plugin): la finestra «Server MCP»
// NON esiste più — la casa unica è la pagina «Plugin» (voce della barra),
// che nel punto MCP (openPlugin {kind:'mcp'}) mostra ManualServers COM'ERA:
// l'elenco dei server col test, il form stdio/http con le variabili cifrate
// e l'import da altre app. Qui si guardano i PEZZI (il file McpWindow.tsx li
// espone) e il render vero del componente con l'api finta.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'

const SIDEBAR = fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url))
const APPSW = fileURLToPath(new URL('../components/AppsWindow.tsx', import.meta.url))
const MCPW = fileURLToPath(new URL('../components/plugin/manual-servers.tsx', import.meta.url))
const APP = fileURLToPath(new URL('../App.tsx', import.meta.url))
const PANEL = fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url))
const STORE = fileURLToPath(new URL('../store.ts', import.meta.url))

describe('PL7: la finestra «Server MCP» non c\'è più', () => {
  it('McpWindow.tsx non esporta NESSUNA finestra: solo i pezzi riusati', () => {
    const src = readFileSync(MCPW, 'utf8')
    expect(src).not.toMatch(/export function McpWindow\b/)
    expect(src).not.toContain('Dialog open')
    expect(src).toContain('export function ManualServers()')
    // C0 (fase linguaggio): l'elenco di import è un file suo, accanto
    expect(src).toMatch(/import \{ ImportList \} from '\.\/import-list'/)
  })

  it('lo store NON ha più mcpOpen/setMcpOpen né i flag del foglio sviluppatori', () => {
    const src = readFileSync(STORE, 'utf8')
    expect(src).not.toMatch(/mcpOpen: boolean/)
    expect(src).not.toMatch(/setMcpOpen\b/)
    expect(src).not.toMatch(/appsOpenDevelopers/)
    expect(src).not.toMatch(/appsDevelopersScrollTo/)
  })

  it('App NON monta finestre: la pagina Plugin copre l\'area centrale', () => {
    const src = readFileSync(APP, 'utf8')
    expect(src).not.toMatch(/AppsWindow/)
    expect(src).not.toMatch(/SkillsWindow/)
    expect(src).not.toMatch(/McpWindow/)
    expect(src).toMatch(/\{pluginOpen && <PluginPanel \/>}/)
  })

  it('il menu dell\'account è UNO solo: la rotaia usa lo stesso AccountMenu', () => {
    const src = readFileSync(SIDEBAR, 'utf8')
    expect((src.match(/function AccountMenu\(/g) ?? []).length).toBe(1)
    expect(src).toMatch(/<AccountMenu\s+rail\b/)
  })
})

describe('PL7: ManualServers — i pezzi di oggi, spostati non riscritti', () => {
  const src = readFileSync(MCPW, 'utf8')

  it('il form di oggi resta com\'era: stdio e http, bearer cifrato, «+ Aggiungi server MCP»', () => {
    const start = src.indexOf('function ManualServers(')
    const block = src.slice(start, src.indexOf('\nfunction ', start + 10) > 0 ? src.indexOf('\nfunction ', start + 10) : undefined)
    expect(block).toContain('t`stdio (comando locale)`')
    expect(block).toContain('t`http (URL)`')
    expect(block).toContain('type="password"')
    expect(block).toContain('Bearer token (opzionale — salvato cifrato)')
    expect(block).toContain('+ Aggiungi server MCP')
    expect(block).toContain('data-testid="mcp-import-button"')
  })

  it('l\'elenco dice da quali bot è usato un server, quando il dato esiste già (enabledFor)', () => {
    expect(src).toMatch(/enabledFor/)
  })
})

describe('PL7: la pagina Plugin apre ManualServers nel punto MCP', () => {
  it('la vista interna mcp rende ManualServers, dal rimando e dal menù Aggiungi', () => {
    const src = readFileSync(PANEL, 'utf8')
    expect(src).toMatch(/kind === 'mcp'/)
    expect(src).toContain("view === 'mcp'")
    expect(src).toMatch(/<ManualServers \/>/)
  })

  it('DevelopersContent non ha più il rimando alla finestra (la pagina è la casa)', () => {
    const src = readFileSync(APPSW, 'utf8')
    expect(src).toContain('export function DevelopersContent(')
    expect(src).not.toContain('data-testid="developers-open-mcp"')
    expect(src).not.toContain('setMcpOpen')
  })
})

describe('PL7: il render di ManualServers (componente vero, api finta)', () => {
  it('l\'intestazione dell\'elenco e il form di aggiunta', async () => {
    const { ManualServers } = await import('../components/plugin/manual-servers')
    const { useStore } = await import('../store')
    setStoreStateForRender(useStore, {
      agents: [
        { id: 'a-bot', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
      ]
    })
    const html = renderHtml(createElement(ManualServers, {}))
    const root = parseHtml(html)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('Server MCP personalizzato')
    expect(texts).toContain('+ Aggiungi server MCP')
    expect(texts).toContain('Importa da altre app')
  })
})
