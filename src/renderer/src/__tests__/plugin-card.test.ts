// PL2 (fase plugin): la scheda di un plugin (tavola 9) — clic su una riga di
// «I tuoi» e si apre la scheda con le schede interne Panoramica ·
// Autorizzazioni · Account e bot. Qui il render vero (api finta) della
// scheda di un SERVER MCP con annotazioni: la divisione Sola lettura /
// Scrittura, i selettori che scrivono le regole per strumento che esistono
// già (permissions), l'insieme fisso senza «Consenti sempre» e l'interruttore
// per bot che scrive enabledFor. Senza DOM: gli handler si invocano dal
// capture del runtime JSX, come mcp-window-card.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import { fakeApiCalls, stubApiMethod, callsOf } from './render-helper-install'
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

const { PluginCard } = await import('../components/PluginCard')
const { useStore } = await import('../store')

const SERVER: McpServerInfo = {
  id: 'srv-ufficio', name: 'ufficio', transport: 'stdio', command: 'node', args: ['ufficio-mcp.mjs'],
  enabled: true, enabledFor: ['*'],
  source: { kind: 'registry', name: 'ufficio' }
}

const TOOLS = [
  { name: 'search_emails', description: 'Cerca nella posta', annotations: { readOnlyHint: true } },
  { name: 'read_email', description: 'Legge un messaggio', annotations: { readOnlyHint: true } },
  { name: 'create_draft', description: 'Prepara una bozza', annotations: { destructiveHint: false } },
  { name: 'send_email', description: 'Invia un messaggio' },
  { name: 'delete_email', description: 'Cestina', annotations: { destructiveHint: true } }
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
  setStoreStateForRender(useStore, {
    agents: [
      { id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 },
      { id: 'a-2', name: 'Ricerche', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
    ]
  })
})

const render = (props: Record<string, unknown> = {}): string => renderHtml(createElement(PluginCard, {
  server: SERVER,
  initial: { tools: TOOLS, permissions: PERMS },
  onClose: () => undefined,
  onChanged: () => undefined,
  ...props
} as never))

describe('PL2: la scheda di un plugin — le schede interne', () => {
  it('header con nome e stato; le tre schede Panoramica · Autorizzazioni · Account e bot', () => {
    const root = parseHtml(render())
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('ufficio')
    expect(texts).toContain('Panoramica')
    expect(texts).toContain('Autorizzazioni')
    expect(texts).toContain('Account e bot')
  })
})

describe('PL2: Autorizzazioni — la divisione e i selettori', () => {
  it('un server con annotazioni divide Sola lettura e Scrittura; senza annotazioni → Altro', () => {
    const root = parseHtml(render())
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toMatch(/Sola lettura · 2/)
    expect(texts).toContain('search_emails')
    expect(texts).toMatch(/Scrittura · 1/)
    expect(texts).toContain('delete_email')
    expect(texts).toMatch(/Altro · 2/)
    expect(texts).toContain('create_draft')
  })

  it('l\'insieme fisso (invii) mostra il lucchetto e NON offre «Consenti sempre»', () => {
    const root = parseHtml(render())
    const send = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-tool-send_email')[0]
    expect(send).toBeTruthy()
    expect(textOf(send!)).toContain('send_email')
    // il lucchetto (icona lucide Lock) accanto allo strumento fisso
    const lock = findAll(send!, (n) => n.attrs['aria-label'] === 'azione dell\'insieme fisso: chiede sempre')[0]
    expect(lock).toBeTruthy()
    // il selettore dello strumento fisso: Chiedi e Blocca, MAI Consenti sempre
    const sel = findAll(send!, (n) => n.tag === 'select')[0]
    const options = sel ? sel.children.map((c) => textOf(c)) : []
    expect(options).toContain('Chiedi')
    expect(options).toContain('Blocca')
    expect(options).not.toContain('Consenti sempre')
    // uno strumento normale ha le tre scelte
    const normal = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-tool-search_emails')[0]
    const selNormal = normal ? findAll(normal, (n) => n.tag === 'select')[0] : null
    const optionsNormal = selNormal ? selNormal.children.map((c) => textOf(c)) : []
    expect(optionsNormal).toContain('Consenti sempre')
  })

  it('la frase F8 sta sotto i selettori (contenuti non fidati → le scritture tornano a chiedere)', () => {
    const root = parseHtml(render())
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toMatch(/Dopo che un bot ha letto contenuti non fidati, le azioni di scrittura tornano a chiedere/)
  })

  it('cambiare un selettore SCRIVE la regola per strumento (permissions:set)', async () => {
    render()
    const sel = capture.els.find((e) => typeof e.type === 'string' && (e.type as string) === 'select' && String(e.props['data-testid'] ?? '') === 'plugin-tool-select-search_emails')
    expect(sel).toBeDefined()
    const before = callsOf('setPermissions').length
    ;(sel!.props.onChange as (v: { target: { value: string } }) => void)({ target: { value: 'always_allow' } })
    await new Promise((r) => setTimeout(r, 0))
    const calls = callsOf('setPermissions').slice(before)
    expect(calls).toHaveLength(1)
    const cfg = calls[0]!.args[0] as PermissionsConfig
    expect(cfg.rules).toContainEqual({ tool: 'mcp__ufficio__search_emails', pattern: '*', mode: 'always_allow' })
  })

  it('il selettore di GRUPPO scrive la regola per tutti gli strumenti del gruppo', async () => {
    render()
    const sel = capture.els.find((e) => typeof e.type === 'string' && (e.type as string) === 'select' && String(e.props['data-testid'] ?? '') === 'plugin-group-select-read')
    expect(sel).toBeDefined()
    const before = callsOf('setPermissions').length
    ;(sel!.props.onChange as (v: { target: { value: string } }) => void)({ target: { value: 'always_allow' } })
    await new Promise((r) => setTimeout(r, 0))
    const calls = callsOf('setPermissions').slice(before)
    expect(calls).toHaveLength(1)
    const cfg = calls[0]!.args[0] as PermissionsConfig
    expect(cfg.rules).toContainEqual({ tool: 'mcp__ufficio__search_emails', pattern: '*', mode: 'always_allow' })
    expect(cfg.rules).toContainEqual({ tool: 'mcp__ufficio__read_email', pattern: '*', mode: 'always_allow' })
  })
})

describe('PL2: Account e bot', () => {
  it('lo stato, l\'account onesto («nessun account» per un server stdio senza variabili) e i bot', () => {
    const root = parseHtml(render())
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('attivo')
    expect(texts).toContain('nessun account')
    expect(texts).toContain('Bot che lo usano')
    expect(texts).toContain('Tutti i bot')
    expect(texts).toContain('Competitoor')
  })

  it('l\'interruttore per bot scrive enabledFor (connectors:set-enabled-for)', async () => {
    render()
    // il bottone del singolo bot: la riga di Competitoor nella scheda Account e bot
    const btn = capture.els.filter((e) => typeof e.type === 'string' && (e.type as string) === 'button' && e.props['role'] === 'switch')
    expect(btn.length).toBeGreaterThanOrEqual(2)
    const first = btn.find((e) => e.props['aria-label'] === 'Competitoor')!
    const beforeEnabled = callsOf('connectorsSetEnabledFor').length
    ;(first.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    const calls = callsOf('connectorsSetEnabledFor').slice(beforeEnabled)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(['server', 'srv-ufficio', ['a-2']])
    void fakeApiCalls
  })
})

// ---- V4 (fase stato-vivo): il server spento da Homun ha il bottone Riaccendi ----

describe('V4: server spento non dall\'utente — stato onesto e bottone Riaccendi che accende e testa', () => {
  it('la testata dice «spento da Homun: non rispondeva» e il bottone Riaccendi c\'è', () => {
    const html = render({ server: { ...SERVER, enabled: false, firstOkAt: 1732227960000 } as never })
    const root = parseHtml(html)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('spento da Homun: non rispondeva')
    const btn = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-card-reenable')[0]
    expect(btn).toBeTruthy()
    expect(textOf(btn!)).toBe('Riaccendi')
  })

  it('spento dall\'utente: nessun bottone Riaccendi (lo stato è «spento» e basta)', () => {
    const html = render({ server: { ...SERVER, enabled: false, disabledReason: 'user' } as never })
    const root = parseHtml(html)
    expect(findAll(root, (n) => n.attrs['data-testid'] === 'plugin-card-reenable')).toHaveLength(0)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('spento')
  })

  it('il click chiama mcpSave con enabled true e SENZA disabledReason (il test U5 parte da lì)', () => {
    stubApiMethod('mcpSave', () => [])
    render({ server: { ...SERVER, enabled: false, firstOkAt: 1 } as never })
    // l'handler VERO sta nell'elemento catturato dal runtime JSX (come i toggle per bot)
    const btn = capture.els.find((e) => e.props['data-testid'] === 'plugin-card-reenable')!
    expect(btn).toBeTruthy()
    const before = callsOf('mcpSave').length
    ;(btn.props.onClick as () => void)()
    const calls = callsOf('mcpSave').slice(before)
    expect(calls).toHaveLength(1)
    const saved = calls[0]!.args[0] as { enabled: boolean; disabledReason?: string }
    expect(saved.enabled).toBe(true)
    expect(saved.disabledReason).toBeUndefined()
  })
})

// ---- V5 (fase stato-vivo): l'interruttore Attivo in cima alla scheda ----

describe('V5: l\'interruttore Attivo del server in cima alla scheda', () => {
  it('c\'è, con l\'etichetta Attivo, e riflette lo stato del server', () => {
    render()
    const sw = capture.els.find((e) => e.props['data-testid'] === 'plugin-card-active')
    expect(sw).toBeTruthy()
    expect(sw!.props['aria-checked']).toBe(true)
    expect(sw!.props['aria-label']).toBe('Attivo')
    const html = render({ server: { ...SERVER, enabled: false, disabledReason: 'user' } as never })
    void html
    const sw2 = capture.els.filter((e) => e.props['data-testid'] === 'plugin-card-active')
    expect(sw2.length).toBeGreaterThan(0)
  })

  it('SPEGNERE: mcpSave con enabled false e disabledReason \'user\' (la riparazione V4 non lo riaccenderà)', () => {
    stubApiMethod('mcpSave', () => [])
    render()
    const sw = capture.els.find((e) => e.props['data-testid'] === 'plugin-card-active')!
    const before = callsOf('mcpSave').length
    ;(sw.props.onClick as () => void)()
    const calls = callsOf('mcpSave').slice(before)
    expect(calls).toHaveLength(1)
    const saved = calls[0]!.args[0] as { enabled: boolean; disabledReason?: string }
    expect(saved.enabled).toBe(false)
    expect(saved.disabledReason).toBe('user')
  })

  it('ACCENDERE: mcpSave con enabled true e SENZA motivo (il test U5 parte da lì)', () => {
    stubApiMethod('mcpSave', () => [])
    render({ server: { ...SERVER, enabled: false, disabledReason: 'user' } as never })
    const sw = capture.els.find((e) => e.props['data-testid'] === 'plugin-card-active')!
    const before = callsOf('mcpSave').length
    ;(sw.props.onClick as () => void)()
    const calls = callsOf('mcpSave').slice(before)
    expect(calls).toHaveLength(1)
    const saved = calls[0]!.args[0] as { enabled: boolean; disabledReason?: string }
    expect(saved.enabled).toBe(true)
    expect(saved.disabledReason).toBeUndefined()
  })

  it('connettore Composio: l\'interruttore chiama composioSetConnectorEnabled, l\'account non si scollega', () => {
    stubApiMethod('composioSetConnectorEnabled', () => ({ ok: true }))
    stubApiMethod('composioDisconnect', () => undefined)
    const app = { row: { app: { id: 'gmail', name: 'Gmail', logo: null, composioSlug: 'gmail', via: 'composio' }, tagline: null, connected: 'connected' } } as never
    setStoreStateForRender(useStore, {
      composio: { active: true, hasKey: true, keyHint: null, pending: null, disabled: [], connected: [{ slug: 'gmail', name: 'Gmail', status: 'ACTIVE', accountId: 'a1', toolsCount: 5, enabledFor: ['*'] }] }
    })
    render({ server: undefined, app })
    const sw = capture.els.find((e) => e.props['data-testid'] === 'plugin-card-active')!
    expect(sw).toBeTruthy()
    const before = callsOf('composioSetConnectorEnabled').length
    ;(sw.props.onClick as () => void)()
    const calls = callsOf('composioSetConnectorEnabled').slice(before)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(['gmail', false])
    // MAI uno Scollega implicito
    expect(callsOf('composioDisconnect').slice(before)).toHaveLength(0)
  })
})
