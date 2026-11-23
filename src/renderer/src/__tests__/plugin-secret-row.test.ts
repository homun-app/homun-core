// PP2 (fase plugin-pulita): il token di un server si cambia DOVE VIVE il
// server — nella scheda del plugin, riga «Account». Prima era solo testo
// («token aziendale»), e l'editor che sapeva sostituire il segreto stava in
// un altro posto e rimandava TUTTA la config. Qui: «Cambia token» apre il
// campo password, «Salva» chiama mcp:replace-secret con {bearerToken}, poi la
// riga mostra l'esito del test («collegato» / il motivo); le intestazioni e
// le variabili segrete un campo per OGNI nome salvato (i nomi si vedono, i
// valori mai), si sostituiscono solo quelli scritti; OAuth ha «Ricollega»
// sempre. Lo stato dell'editor è un reducer PURO: il valore non resta dopo il
// salvataggio. Senza DOM: render vero (api finta) e handler catturati dal
// runtime JSX, come plugin-card.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import { stubApiMethod, callsOf } from './render-helper-install'
import type { McpServerInfo, McpServerSecret } from '../../../shared/types'
import type { SecretEditAction } from '../lib/plugin-secret'

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
const { ServerAccountRow: CapturedAccountRow } = await import('../components/plugin/ServerSecretRows')
const capturedRow = { ServerAccountRow: null as never }
const { useStore } = await import('../store')
const secret = await import('../lib/plugin-secret')

const HTTP: McpServerInfo = { id: 'srv-http', name: 'ufficio', transport: 'http', url: 'http://127.0.0.1:9/mcp', enabled: true, enabledFor: ['*'], auth: { kind: 'bearer' } }
const HEADERS: McpServerInfo = { ...HTTP, id: 'srv-h', name: 'registro', auth: { kind: 'headers' }, source: { kind: 'registry', name: 'registro' } }
const STDIO: McpServerInfo = { id: 'srv-env', name: 'env', transport: 'stdio', command: 'node', args: ['x.mjs'], enabled: true, enabledFor: ['*'], envSpec: [{ name: 'TOKEN', secret: true }, { name: 'API', secret: true }, { name: 'PIANO', secret: false }], envValues: { PIANO: 'v' } }
const OAUTH: McpServerInfo = { ...HTTP, id: 'srv-oauth', name: 'oauth', auth: { kind: 'oauth' }, needsReauth: false }
const NAMES = {
  'srv-http': { id: 'srv-http', bearer: true, headers: [], env: [] },
  'srv-h': { id: 'srv-h', bearer: false, headers: ['X-Api-Key', 'X-Tenant'], env: [] },
  'srv-env': { id: 'srv-env', bearer: false, headers: [], env: ['TOKEN', 'API'] },
  'srv-oauth': { id: 'srv-oauth', bearer: false, headers: [], env: [] }
}

beforeEach(() => {
  capture.els.length = 0
  stubApiMethod('getPermissions', () => ({ default: 'needs_approval', rules: [] }))
  stubApiMethod('setPermissions', () => undefined)
  stubApiMethod('connectorsSetEnabledFor', () => ({ ok: true }))
  stubApiMethod('mcpReplaceSecret', () => ({ ok: true, test: { ok: true, tools: ['mcp__ufficio__x'] } }))
  setStoreStateForRender(useStore, { agents: [] })
})

const render = (server: McpServerInfo, extra: Record<string, unknown> = {}): string => renderHtml(createElement(PluginCard, {
  server,
  initial: { tools: [], permissions: { default: 'needs_approval', rules: [] }, secretNames: NAMES, ...extra } as never,
  onClose: () => undefined,
  onChanged: () => undefined
} as never))
const byId = (root: ReturnType<typeof parseHtml>, id: string) => findAll(root, (n) => n.attrs['data-testid'] === id)
const el = (id: string) => capture.els.find((e) => e.props['data-testid'] === id)
/** Le chiamate all'api fatte DA QUI in poi (il registro dell'api finta dura per tutto il file). */
const replaceCallsFrom = (): (() => unknown[][]) => {
  const from = callsOf('mcpReplaceSecret').length
  return () => callsOf('mcpReplaceSecret').slice(from).map((c) => c.args)
}

describe("PP2: la riga Account dice che account c'è — e ha la sua azione", () => {
  it('un server col token: «token aziendale» e «Cambia token» a destra', () => {
    const root = parseHtml(render(HTTP))
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('token aziendale')
    const change = byId(root, 'plugin-token-change')[0]
    expect(change).toBeTruthy()
    expect(textOf(change!)).toBe('Cambia token')
    // il campo non c'è finché non si clicca
    expect(byId(root, 'plugin-token-input')).toHaveLength(0)
  })

  it('un server senza segreti: «nessun account», nessuna azione', () => {
    const root = parseHtml(render({ ...HTTP, id: 'srv-niente', auth: undefined }))
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('nessun account')
    expect(byId(root, 'plugin-token-change')).toHaveLength(0)
    expect(byId(root, 'plugin-reconnect')).toHaveLength(0)
  })

  it('OAuth: «con il tuo account» e «Ricollega» SEMPRE visibile, anche senza needsReauth', () => {
    const root = parseHtml(render(OAUTH))
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('con il tuo account')
    expect(byId(root, 'plugin-reconnect')).toHaveLength(1)
    // Ricollega rifà l'OAuth del server (connectors:reconnect-server)
    const r = el('plugin-reconnect')!
    stubApiMethod('connectorsReconnectServer', () => ({ ok: true }))
    ;(r.props.onClick as () => void)()
    expect(callsOf('connectorsReconnectServer').map((c) => c.args)).toEqual([['srv-oauth']])
  })

  it('un server con le intestazioni: «intestazioni: 2» e «Cambia»; uno stdio con segreti: «variabili segrete: 2» e «Cambia»', () => {
    const h = parseHtml(render(HEADERS))
    const th = findAll(h, () => true).map((n) => textOf(n)).join('\n')
    expect(th).toContain('intestazioni: 2')
    expect(byId(h, 'plugin-headers-change')).toHaveLength(1)
    expect(th).not.toContain('X-Api-Key')
    const e = parseHtml(render(STDIO))
    const te = findAll(e, () => true).map((n) => textOf(n)).join('\n')
    expect(te).toContain('variabili segrete: 2')
    expect(byId(e, 'plugin-env-change')).toHaveLength(1)
  })

  it('il server salvato col form PRIMA della correzione (token cifrato, auth.kind mai arrivato in config) ha lo stesso «Cambia token»', () => {
    // i NOMI dei segreti dallo store dicono che il token c'è: la riga lo offre, e sostituirlo ripara auth.kind
    const root = parseHtml(render({ ...HTTP, id: 'srv-http', auth: undefined }))
    expect(byId(root, 'plugin-token-change')).toHaveLength(1)
    expect(secret.accountKindOf({ auth: undefined }, NAMES['srv-http']!)).toBe('bearer')
  })
})

describe("PP2: «Cambia token» — il campo, «Salva», l'esito", () => {
  it("il clic su «Cambia token» chiede di aprire l'editor sul token (e il reducer lo apre, vuoto)", () => {
    const { ServerAccountRow } = capturedRow
    void ServerAccountRow
    const actions: SecretEditAction[] = []
    renderHtml(createElement(CapturedAccountRow, { server: HTTP, names: NAMES['srv-http'], state: secret.SECRET_EDIT_INITIAL, onAction: (a: SecretEditAction) => actions.push(a) } as never))
    ;(el('plugin-token-change')!.props.onClick as () => void)()
    expect(actions).toEqual([{ type: 'open', kind: 'bearer' }])
    expect(secret.secretEditReducer(secret.SECRET_EDIT_INITIAL, actions[0]!)).toEqual({ kind: 'bearer', values: {}, saving: false, result: null })
  })

  it("l'editor aperto: un campo password «Nuovo token — sostituisce quello salvato», «Salva» e «Annulla»; il valore vecchio non si legge (il campo è vuoto)", () => {
    const root = parseHtml(render(HTTP, { secretEdit: { kind: 'bearer', values: {}, saving: false, result: null } }))
    const input = byId(root, 'plugin-token-input')[0]!
    expect(input.attrs.type).toBe('password')
    expect(input.attrs.placeholder).toBe('Nuovo token — sostituisce quello salvato')
    expect(input.attrs.value).toBe('')
    expect(textOf(byId(root, 'plugin-token-save')[0]!)).toBe('Salva')
    expect(textOf(byId(root, 'plugin-token-cancel')[0]!)).toBe('Annulla')
    // con il campo vuoto «Salva» non si può cliccare
    expect('disabled' in byId(root, 'plugin-token-save')[0]!.attrs).toBe(true)
  })

  it('«Salva» chiama mcpReplaceSecret con {bearerToken} del valore scritto (spazi tolti)', async () => {
    const replaceCalls = replaceCallsFrom()
    render(HTTP, { secretEdit: { kind: 'bearer', values: { token: '  nuovo-token  ' }, saving: false, result: null } })
    const save = el('plugin-token-save')!
    expect(save.props['disabled']).toBe(false)
    ;(save.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    expect(replaceCalls()).toEqual([['srv-http', { bearerToken: 'nuovo-token' }]])
  })

  it("l'esito dopo il salvataggio: «collegato» quando il test passa, il motivo onesto quando non passa", () => {
    expect(secret.secretResultOf({ ok: true, tools: ['a'] })).toEqual({ outcome: 'ok' })
    expect(secret.secretResultOf({ ok: false, error: 'Streamable HTTP error: Error POSTing to endpoint (HTTP 401)' })).toEqual({ outcome: 'fail', reason: 'Streamable HTTP error: Error POSTing to endpoint (HTTP 401)' })
    // niente test (server spento, o aspetta ancora dei valori): salvato e basta
    expect(secret.secretResultOf(null)).toEqual({ outcome: 'saved' })
    const ok = parseHtml(render(HTTP, { secretEdit: { kind: null, values: {}, saving: false, result: { outcome: 'ok', kind: 'bearer' } } }))
    expect(textOf(byId(ok, 'plugin-secret-result')[0]!)).toBe('collegato')
    const no = parseHtml(render(HTTP, { secretEdit: { kind: null, values: {}, saving: false, result: { outcome: 'fail', kind: 'bearer', reason: 'non risponde (HTTP 401)' } } }))
    // l'esito di un'ALTRA riga (le variabili) non compare sulla riga dell'account
    const alt = parseHtml(render(HTTP, { secretEdit: { kind: null, values: {}, saving: false, result: { outcome: 'ok', kind: 'env' } } }))
    expect(byId(alt, 'plugin-secret-result')).toHaveLength(0)
    expect(textOf(byId(no, 'plugin-secret-result')[0]!)).toBe('non risponde (HTTP 401)')
  })

  it('il valore NON resta nello stato dopo il salvataggio (reducer puro): il campo si chiude e i valori si svuotano', () => {
    let s = secret.secretEditReducer(secret.SECRET_EDIT_INITIAL, { type: 'open', kind: 'bearer' })
    s = secret.secretEditReducer(s, { type: 'type', name: 'token', value: 'nuovo-token' })
    expect(s.values).toEqual({ token: 'nuovo-token' })
    s = secret.secretEditReducer(s, { type: 'saving' })
    expect(s.saving).toBe(true)
    s = secret.secretEditReducer(s, { type: 'saved', result: { outcome: 'ok', kind: 'bearer' } })
    expect(s).toEqual({ kind: null, values: {}, saving: false, result: { outcome: 'ok', kind: 'bearer' } })
    // riaprire il campo pulisce l'esito vecchio
    expect(secret.secretEditReducer(s, { type: 'open', kind: 'bearer' })).toEqual({ kind: 'bearer', values: {}, saving: false, result: null })
    // Annulla: idem, senza esito
    let c = secret.secretEditReducer(secret.secretEditReducer(secret.SECRET_EDIT_INITIAL, { type: 'open', kind: 'bearer' }), { type: 'type', name: 'token', value: 'x' })
    c = secret.secretEditReducer(c, { type: 'cancel' })
    expect(c).toEqual(secret.SECRET_EDIT_INITIAL)
  })

  it("se l'RPC fallisce la riga mostra l'errore (e il valore non resta)", async () => {
    stubApiMethod('mcpReplaceSecret', () => { throw new Error('impossibile salvare il segreto del server') })
    const replaceCalls = replaceCallsFrom()
    render(HTTP, { secretEdit: { kind: 'bearer', values: { token: 'nuovo' }, saving: false, result: null } })
    ;(el('plugin-token-save')!.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    expect(replaceCalls()).toHaveLength(1)
    const dispatches: SecretEditAction[] = []
    await secret.submitSecret({ id: 'srv-http', kind: 'bearer', values: { token: 'nuovo' }, api: { mcpReplaceSecret: async () => { throw new Error('impossibile salvare il segreto del server') } } as never, dispatch: (a: SecretEditAction) => dispatches.push(a), onChanged: () => undefined })
    expect(dispatches[dispatches.length - 1]).toEqual({ type: 'saved', result: { outcome: 'error', kind: 'bearer', reason: 'impossibile salvare il segreto del server' } })
  })

  it('«Annulla» chiude il campo senza chiamare nessuno', async () => {
    const replaceCalls = replaceCallsFrom()
    render(HTTP, { secretEdit: { kind: 'bearer', values: { token: 'x' }, saving: false, result: null } })
    ;(el('plugin-token-cancel')!.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    expect(replaceCalls()).toHaveLength(0)
  })
})

describe('PP2: intestazioni e variabili — un campo per OGNI nome salvato, solo quelli scritti si sostituiscono', () => {
  it('intestazioni: i nomi si vedono, i valori mai (campi password vuoti, uno per nome)', () => {
    const root = parseHtml(render(HEADERS, { secretEdit: { kind: 'headers', values: {}, saving: false, result: null } }))
    const a = byId(root, 'plugin-headers-input-X-Api-Key')[0]
    const b = byId(root, 'plugin-headers-input-X-Tenant')[0]
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a!.attrs.type).toBe('password')
    expect(a!.attrs.value).toBe('')
    expect(a!.attrs.placeholder).toBe('Nuovo valore — sostituisce quello salvato')
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('X-Api-Key')
    expect(texts).toContain('X-Tenant')
  })

  it('intestazioni: «Salva» manda SOLO le chiavi scritte', async () => {
    const replaceCalls = replaceCallsFrom()
    render(HEADERS, { secretEdit: { kind: 'headers', values: { 'X-Tenant': 'nuovo' }, saving: false, result: null } })
    ;(el('plugin-headers-save')!.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    expect(replaceCalls()).toEqual([['srv-h', { headers: { 'X-Tenant': 'nuovo' } }]])
  })

  it('variabili segrete: un campo per nome; «Salva» manda solo quelle scritte', async () => {
    const root = parseHtml(render(STDIO, { secretEdit: { kind: 'env', values: { API: 'nuovo' }, saving: false, result: null } }))
    expect(byId(root, 'plugin-env-input-TOKEN')[0]!.attrs.value).toBe('')
    expect(byId(root, 'plugin-env-input-API')[0]!.attrs.value).toBe('nuovo')
    const replaceCalls = replaceCallsFrom()
    ;(el('plugin-env-save')!.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    expect(replaceCalls()).toEqual([['srv-env', { env: { API: 'nuovo' } }]])
  })

  it('secretPayloadOf: il payload dal campo — bearer, il record delle intestazioni o delle variabili, mai le stringhe vuote', () => {
    expect(secret.secretPayloadOf('bearer', { token: ' t ' })).toEqual({ bearerToken: 't' } as McpServerSecret)
    expect(secret.secretPayloadOf('headers', { A: '1', B: '', C: '  ' })).toEqual({ headers: { A: '1' } })
    expect(secret.secretPayloadOf('env', { X: 'y', Z: '' })).toEqual({ env: { X: 'y' } })
    expect(secret.secretPayloadOf('headers', { B: '' })).toEqual({})
  })
})
