// A4 (fase approvazioni-chiare): i ritocchi della pagina Plugin trovati
// nella verifica di fase-plugin — (1) le descrizioni della scheda
// Autorizzazioni senza il prefisso interno [MCP:<nome>]; (2) gli strumenti
// dell'insieme fisso (es. send_email) nel gruppo SCRITTURA col lucchetto,
// non in «Altro»; (3) il selettore di gruppo mostra «Misto» quando le
// regole del gruppo differiscono, e sceglierlo vale per tutti; (4) «Per
// sviluppatori» in fondo alla pagina è CHIUSO di default (una riga che si
// apre).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import { stubApiMethod, callsOf } from './render-helper-install'
import type { McpServerInfo, PermissionsConfig } from '../../../shared/types'

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
vi.mock('../components/ui/dialog', () => ({}) as never)

const { PluginCard } = await import('../components/PluginCard')
const { PluginPanel } = await import('../components/PluginPanel')
const { useStore } = await import('../store')

const SERVER: McpServerInfo = {
  id: 'srv-ufficio', name: 'ufficio', transport: 'stdio', command: 'node', args: ['ufficio-mcp.mjs'],
  enabled: true, enabledFor: ['*'],
  source: { kind: 'registry', name: 'ufficio' }
}

// le descrizioni come arrivano da mcp:tools, col tag [MCP:<nome>] davanti
const TOOLS = [
  { name: 'search_emails', description: '[MCP:ufficio] Cerca nella posta', annotations: { readOnlyHint: true } },
  { name: 'read_email', description: '[MCP:ufficio] Legge un messaggio', annotations: { readOnlyHint: true } },
  { name: 'create_draft', description: '[MCP:ufficio] Prepara una bozza' },
  { name: 'send_email', description: '[MCP:ufficio] Invia un messaggio' }
]

const PERMS: PermissionsConfig = {
  default: 'needs_approval',
  rules: [{ tool: 'mcp__*', pattern: '*', mode: 'needs_approval' }]
}

beforeEach(() => {
  capture.els.length = 0
  stubApiMethod('getPermissions', () => PERMS)
  stubApiMethod('setPermissions', () => undefined)
  stubApiMethod('connectorsSetEnabledFor', () => ({ ok: true }))
  setStoreStateForRender(useStore, { agents: [] })
})

const renderCard = (permissions: PermissionsConfig = PERMS): ReturnType<typeof parseHtml> =>
  parseHtml(renderHtml(createElement(PluginCard, {
    server: SERVER,
    initial: { tools: TOOLS, permissions },
    onClose: () => undefined,
    onChanged: () => undefined
  } as never)))

describe('A4.1: le descrizioni della scheda Autorizzazioni non mostrano il prefisso interno', () => {
  it('niente «[MCP:…]» nelle righe degli strumenti', () => {
    const root = renderCard()
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).not.toContain('[MCP:')
    // il testo della descrizione resta, senza il tag
    expect(texts).toContain('Cerca nella posta')
    expect(texts).toContain('Invia un messaggio')
  })
})

describe('A4.2: gli strumenti dell\'insieme fisso nel gruppo Scrittura, col lucchetto', () => {
  it('send_email sta in Scrittura (con il lucchetto), non in «Altro»', () => {
    const root = renderCard()
    const write = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-group-write')[0]
    const other = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-group-other')[0]
    expect(write).toBeTruthy()
    expect(textOf(write!)).toContain('send_email')
    expect(textOf(write!)).toContain('Invia un messaggio')
    // il lucchetto dell'insieme fisso accanto a send_email
    const sendRow = findAll(write!, (n) => n.attrs['data-testid'] === 'plugin-tool-send_email')[0]
    expect(findAll(sendRow!, (n) => n.attrs['aria-label'] === 'azione dell\'insieme fisso: chiede sempre').length).toBe(1)
    // create_draft (non fisso, non annotato) resta in Altro
    expect(textOf(other!)).toContain('create_draft')
    expect(textOf(other!)).not.toContain('send_email')
  })
})

describe('A4.3: il selettore di gruppo mostra «Misto» quando le regole differiscono', () => {
  const MIXED: PermissionsConfig = {
    default: 'needs_approval',
    rules: [
      { tool: 'mcp__ufficio__search_emails', pattern: '*', mode: 'always_allow' },
      { tool: 'mcp__ufficio__read_email', pattern: '*', mode: 'needs_approval' }
    ]
  }

  it('regole diverse nel gruppo → il valore è «Misto» (e l\'opzione c\'è, spenta)', () => {
    renderCard(MIXED)
    const sel = capture.els.find((e) => typeof e.type === 'string' && (e.type as string) === 'select' && String(e.props['data-testid'] ?? '') === 'plugin-group-select-read')
    expect(sel).toBeDefined()
    expect(sel!.props.value).toBe('mixed')
    const options = (sel!.props.children as unknown[]).filter((c): c is { props: Record<string, unknown> } => typeof c === 'object' && c !== null && 'props' in (c as object))
    const mixed = options.find((o) => o.props.value === 'mixed')
    expect(mixed).toBeTruthy()
  })

  it('scegliere dal gruppo vale per TUTTI (anche misto): sempre → entrambe le letture sempre', async () => {
    renderCard(MIXED)
    const sel = capture.els.find((e) => typeof e.type === 'string' && (e.type as string) === 'select' && String(e.props['data-testid'] ?? '') === 'plugin-group-select-read')
    const before = callsOf('setPermissions').length
    ;(sel!.props.onChange as (v: { target: { value: string } }) => void)({ target: { value: 'always_allow' } })
    await new Promise((r) => setTimeout(r, 0))
    const calls = callsOf('setPermissions').slice(before)
    expect(calls).toHaveLength(1)
    const cfg = calls[0]!.args[0] as PermissionsConfig
    expect(cfg.rules).toContainEqual({ tool: 'mcp__ufficio__search_emails', pattern: '*', mode: 'always_allow' })
    expect(cfg.rules).toContainEqual({ tool: 'mcp__ufficio__read_email', pattern: '*', mode: 'always_allow' })
  })

  it('sempre dal gruppo con l\'insieme fisso dentro: i fissi RESTANO senza sempre (il daemon li rifiuta)', async () => {
    // gruppo Scrittura: delete_email (distruttivo, non fisso) + send_email (fisso)
    const TOOLS2 = [
      { name: 'delete_email', description: 'Cestina', annotations: { destructiveHint: true } },
      { name: 'send_email', description: 'Invia un messaggio' }
    ]
    parseHtml(renderHtml(createElement(PluginCard, {
      server: SERVER,
      initial: { tools: TOOLS2, permissions: PERMS },
      onClose: () => undefined,
      onChanged: () => undefined
    } as never)))
    const sel = capture.els.find((e) => typeof e.type === 'string' && (e.type as string) === 'select' && String(e.props['data-testid'] ?? '') === 'plugin-group-select-write')
    expect(sel).toBeDefined()
    ;(sel!.props.onChange as (v: { target: { value: string } }) => void)({ target: { value: 'always_allow' } })
    await new Promise((r) => setTimeout(r, 0))
    const cfg = callsOf('setPermissions').slice(-1)[0]!.args[0] as PermissionsConfig
    expect(cfg.rules).toContainEqual({ tool: 'mcp__ufficio__delete_email', pattern: '*', mode: 'always_allow' })
    expect(cfg.rules).not.toContainEqual({ tool: 'mcp__ufficio__send_email', pattern: '*', mode: 'always_allow' })
    // «Blocca» dal gruppo vale anche per i fissi (solo «Consenti sempre» è vietato)
    ;(capture.els.filter((e) => String(e.props['data-testid'] ?? '') === 'plugin-group-select-write').slice(-1)[0]!.props.onChange as (v: { target: { value: string } }) => void)({ target: { value: 'blocked' } })
    await new Promise((r) => setTimeout(r, 0))
    const cfg2 = callsOf('setPermissions').slice(-1)[0]!.args[0] as PermissionsConfig
    expect(cfg2.rules).toContainEqual({ tool: 'mcp__ufficio__send_email', pattern: '*', mode: 'blocked' })
    expect(cfg2.rules).toContainEqual({ tool: 'mcp__ufficio__delete_email', pattern: '*', mode: 'blocked' })
  })
})

describe('A4.4: «Per sviluppatori» chiuso di default', () => {
  it('la pagina Plugin: il contenuto per sviluppatori NON c\'è finché la riga non si apre', () => {
    stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
    stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
    stubApiMethod('pluginsUsage', () => [])
    stubApiMethod('getPermissions', () => PERMS)
    stubApiMethod('skillsCatalog', () => [])
    setStoreStateForRender(useStore, {
      connectors: [], composio: null, composioGateway: null, agents: [], skillsFilterAgent: null,
      pluginAt: null, composerPrefill: null
    })
    const html = renderHtml(createElement(PluginPanel, {}))
    const root = parseHtml(html)
    // la RIGA c'è, chiusa di default
    const row = findAll(root, (n) => (n.attrs['data-testid'] ?? '') === 'plugin-developers-toggle')[0]
    expect(row).toBeTruthy()
    expect(textOf(row!)).toContain('Per sviluppatori')
    // il contenuto (gateway, marketplace, registro, chiave) NON è aperto
    const adv = findAll(root, (n) => (n.attrs['data-testid'] ?? '') === 'plugin-advanced')
    expect(adv.length).toBe(1)
    expect(adv.map((n) => textOf(n)).join('\n')).not.toContain('Chiave Composio')
  })
})
