// PP2 (fase plugin-pulita): la Cassaforte ha il gruppo «Dei plugin» (sola
// lettura): per ogni server con un segreto, logo + nome + tipo («token»,
// «intestazioni: 2», «variabili segrete: 3») e «Apri nella scheda ›», che
// chiude le Impostazioni e apre la pagina Plugin con la scheda di quel
// server sulla tab «Account e bot» — la credenziale si gestisce dove vive
// l'integrazione, il portachiavi centrale la elenca e rimanda lì. E mai
// emoji: nella scheda «Segreti» 🔐 diventa l'icona lucide KeyRound.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, dialogPassThroughMock } from './render-helper'
import { stubApiMethod, callsOf } from './render-helper-install'
import type { McpServerInfo } from '../../../shared/types'

const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})
vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const VAULT_SRC = readFileSync(fileURLToPath(new URL('../components/VaultSettings.tsx', import.meta.url)), 'utf8')
const STORE_SRC = readFileSync(fileURLToPath(new URL('../store.ts', import.meta.url)), 'utf8')

const { VaultTab } = await import('../components/VaultSettings')
const { PluginPanel } = await import('../components/PluginPanel')
const { useStore } = await import('../store')

const NAMES = [
  { id: 'srv-token', bearer: true, headers: [], env: [] },
  { id: 'srv-h', bearer: false, headers: ['X-Api-Key', 'X-Tenant'], env: [] },
  { id: 'srv-env', bearer: false, headers: [], env: ['TOKEN', 'API', 'PIANO'] }
]
const SERVERS: McpServerInfo[] = [
  { id: 'srv-token', name: 'ufficio', transport: 'http', url: 'http://127.0.0.1:9/mcp', enabled: true },
  { id: 'srv-h', name: 'registro', transport: 'http', url: 'http://127.0.0.1:9/mcp', enabled: true },
  { id: 'srv-env', name: 'variabili', transport: 'stdio', command: 'node', enabled: true },
  { id: 'srv-zero', name: 'senza segreti', transport: 'stdio', command: 'node', enabled: true }
]
const PLUGINS = { names: NAMES, servers: SERVERS.map((s) => ({ id: s.id, name: s.name })) }

beforeEach(() => {
  capture.els.length = 0
  stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
  stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
  stubApiMethod('mcpList', () => [])
  stubApiMethod('getPermissions', () => ({ default: 'needs_approval', rules: [] }))
  setStoreStateForRender(useStore, {
    connectors: [], composio: null, composioGateway: null, pluginAt: null,
    agents: [{ id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
  })
})
const byId = (root: ReturnType<typeof parseHtml>, id: string) => findAll(root, (n) => n.attrs['data-testid'] === id)
const el = (id: string) => capture.els.find((e) => e.props['data-testid'] === id)

describe("PP2: la Cassaforte ha il gruppo «Dei plugin»", () => {
  it("la scheda «Dei plugin» c'è, accanto a Login · Segreti · Contatti · Concessioni", () => {
    const root = parseHtml(renderHtml(createElement(VaultTab)))
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    for (const voce of ['Login', 'Segreti', 'Contatti', 'Concessioni', 'Dei plugin']) expect(texts).toContain(voce)
  })

  it('elenca OGNI server con un segreto: nome e tipo — «token», «intestazioni: 2», «variabili segrete: 3» — e chi non ne ha non compare', () => {
    const root = parseHtml(renderHtml(createElement(VaultTab, { initial: { tab: 'plugins', plugins: PLUGINS } } as never)))
    const panel = byId(root, 'vault-plugins')[0]
    expect(panel).toBeTruthy()
    const texts = findAll(panel!, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('ufficio')
    expect(texts).toContain('token')
    expect(texts).toContain('registro')
    expect(texts).toContain('intestazioni: 2')
    expect(texts).toContain('variabili')
    expect(texts).toContain('variabili segrete: 3')
    expect(texts).not.toContain('senza segreti')
    // i nomi dei segreti e i valori non compaiono: solo il tipo e quanti sono
    for (const nome of ['X-Api-Key', 'X-Tenant', 'TOKEN', 'API', 'PIANO']) expect(texts).not.toContain(nome)
    // ogni riga ha il suo «Apri nella scheda ›»
    expect(byId(root, 'vault-plugin-open-srv-token')).toHaveLength(1)
    expect(byId(root, 'vault-plugin-open-srv-h')).toHaveLength(1)
    expect(byId(root, 'vault-plugin-open-srv-env')).toHaveLength(1)
    expect(byId(root, 'vault-plugin-open-srv-zero')).toHaveLength(0)
    expect(textOf(byId(root, 'vault-plugin-open-srv-token')[0]!)).toBe('Apri nella scheda ›')
  })

  it("è sola lettura: nella scheda non c'è nessun campo e nessun «Salva»", () => {
    const root = parseHtml(renderHtml(createElement(VaultTab, { initial: { tab: 'plugins', plugins: PLUGINS } } as never)))
    const panel = byId(root, 'vault-plugins')[0]!
    expect(findAll(panel!, (n) => n.tag === 'input' || n.tag === 'textarea' || n.tag === 'select')).toHaveLength(0)
    expect(textOf(panel!)).not.toContain('Salva')
    expect(textOf(panel!)).not.toContain('elimina')
  })

  it('«Apri nella scheda ›» chiude le Impostazioni e apre la pagina Plugin su QUEL server, sulla tab «Account e bot»', () => {
    setStoreStateForRender(useStore, { settingsOpen: true, pluginOpen: false, pluginAt: null })
    renderHtml(createElement(VaultTab, { initial: { tab: 'plugins', plugins: PLUGINS } } as never))
    ;(el('vault-plugin-open-srv-h')!.props.onClick as () => void)()
    const s = useStore.getState() as unknown as { settingsOpen: boolean; pluginOpen: boolean; pluginAt: unknown }
    expect(s.settingsOpen).toBe(false)
    expect(s.pluginOpen).toBe(true)
    expect(s.pluginAt).toEqual({ kind: 'server', serverId: 'srv-h', tab: 'accounts' })
    // non si chiama nessuna RPC di scrittura
    expect(callsOf('mcpReplaceSecret')).toHaveLength(0)
    expect(callsOf('mcpSave')).toHaveLength(0)
  })

  it('senza server con un segreto lo dice (e non mostra righe)', () => {
    const root = parseHtml(renderHtml(createElement(VaultTab, { initial: { tab: 'plugins', plugins: { names: [], servers: [] } } } as never)))
    const panel = byId(root, 'vault-plugins')[0]!
    expect(textOf(panel!)).toContain('Nessun plugin con un segreto salvato')
    expect(findAll(panel!, (n) => (n.attrs['data-testid'] ?? '').startsWith('vault-plugin-open-'))).toHaveLength(0)
  })
})

describe('PP2: il punto della pagina Plugin porta la scheda interna', () => {
  it("openPlugin({ kind: 'server', serverId, tab }) ricorda la tab chiesta", async () => {
    setStoreStateForRender(useStore, { pluginOpen: true, pluginAt: null })
    useStore.getState().openPlugin({ kind: 'server', serverId: 'srv-h', tab: 'accounts' })
    expect(useStore.getState().pluginAt).toEqual({ kind: 'server', serverId: 'srv-h', tab: 'accounts' })
    // la tab è facoltativa: gli altri rimandi di oggi restano uguali
    useStore.getState().openPlugin({ kind: 'server', serverId: 'srv-h' })
    expect(useStore.getState().pluginAt).toEqual({ kind: 'server', serverId: 'srv-h' })
    expect(STORE_SRC).toMatch(/kind: 'server'; serverId: string; tab\?: PluginCardTab/)
  })

  it('la pagina apre la scheda del server sulla tab «Account e bot»', () => {
    const root = parseHtml(renderHtml(createElement(PluginPanel, {
      initial: {
        installed: { servers: SERVERS, plugins: [] },
        card: { serverId: 'srv-h', tab: 'accounts' },
        tools: [], permissions: { default: 'needs_approval', rules: [] }
      }
    } as never)))
    const card = byId(root, 'plugin-card')[0]
    expect(card).toBeTruthy()
    expect(textOf(card!)).toContain('registro')
    // la tab attiva è «Account e bot»: ha aria-selected, o nelle schede di oggi la pillola piena
    const tabs = byId(card!, 'plugin-card-tabs')[0]!
    const active = findAll(tabs, (n) => n.tag === 'button' && (n.attrs['aria-selected'] === 'true' || (n.attrs.class ?? '').includes('bg-foreground')))
    expect(active.map((a) => textOf(a))).toEqual(['Account e bot'])
  })

  it('senza tab chiesta la scheda si apre su «Panoramica», come oggi', () => {
    const root = parseHtml(renderHtml(createElement(PluginPanel, {
      initial: { installed: { servers: SERVERS, plugins: [] }, card: { serverId: 'srv-h' }, tools: [], permissions: { default: 'needs_approval', rules: [] } }
    } as never)))
    const tabs = byId(root, 'plugin-card-tabs')[0]!
    const active = findAll(tabs, (n) => n.tag === 'button' && (n.attrs['aria-selected'] === 'true' || (n.attrs.class ?? '').includes('bg-foreground')))
    expect(active.map((a) => textOf(a))).toEqual(['Panoramica'])
  })
})

describe("PP2: mai emoji nella Cassaforte — nella scheda «Segreti» 🔐 diventa l'icona KeyRound", () => {
  it('il sorgente di VaultSettings non ha più 🔐', () => {
    expect(VAULT_SRC).not.toContain('🔐')
    expect(VAULT_SRC).toMatch(/import \{[^}]*KeyRound[^}]*\} from 'lucide-react'/)
  })

  it("la riga di un secret mostra l'icona lucide KeyRound (il nome resta)", () => {
    const root = parseHtml(renderHtml(createElement(VaultTab, {
      initial: { tab: 'segreti', secrets: [{ kind: 'secret', key: 'API_KEY', label: 'API_KEY', createdAt: 1 }] }
    } as never)))
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('API_KEY')
    expect(texts).not.toContain('🔐')
    expect(findAll(root, (n) => n.tag === 'svg' && (n.attrs.class ?? '').includes('key-round')).length).toBeGreaterThanOrEqual(1)
  })
})
