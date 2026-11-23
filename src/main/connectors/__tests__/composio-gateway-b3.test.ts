// B3 (fase b20-bug): connectApp — l'AVVIO di un collegamento dice PERCHÉ non
// è partito (reason, oltre all'error grezzo): un'app senza configurazione di
// accesso gestita da Composio, il browser che non si apre, la scadenza
// passata. E oltre la scadenza il link NON si apre più nel browser (nessuna
// finestra minuti dopo che la riga ha detto «nessuna risposta»). Con callMcp
// e openExternal FINTI in memoria, come composio-gateway.test.ts.
import { describe, expect, it } from 'vitest'
import { createComposioGatewayManager } from '../composio-gateway'

const NO_MANAGED_AUTH =
  'ToolRouterV2_NoManagedAuth: no Composio-managed auth config for this toolkit; the developer must configure authentication'

/** Il fake del gateway: risponde per strumento e azione di toolkits[0]. */
const makeManager = (respond: (tool: string, args: Record<string, unknown>) => string, over: { now?: () => number; open?: () => Promise<void> } = {}) => {
  const opened: string[] = []
  const settings = new Map<string, unknown>()
  const manager = createComposioGatewayManager({
    callMcp: async (_tool, args) => respond(_tool, args),
    gatewayActive: () => true,
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key, value) => settings.set(key, value),
    openExternal: over.open ?? (async (url) => { opened.push(url) }),
    hasUi: () => true,
    emit: () => undefined,
    retryDelayMs: () => 0,
    ...(over.now ? { now: over.now } : {})
  })
  return { manager, opened }
}

const original = (tool: string): string => tool.split('__').slice(2).join('__')
const actionOf = (args: Record<string, unknown>): string =>
  (args.toolkits as Array<{ action?: string }> | undefined)?.[0]?.action ?? 'add'

/** `list` senza account + `add` con il link (il collegamento parte). */
const linkOk = (slug: string) => (tool: string, args: Record<string, unknown>): string => {
  if (original(tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS') return JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ id: 'a', status: 'ACTIVE' }] }] })
  if (actionOf(args) === 'list') return JSON.stringify({ data: { results: { [slug]: { toolkit: slug, status: 'initiated', accounts: [] } } } })
  return JSON.stringify({ toolkits: [{ toolkit: slug, status: 'success', redirect_url: `https://mcp.example/authorize?tk=${slug}` }] })
}

/** `list` senza account + `add` SENZA link, con l'errore del server (o senza). */
const addWithoutLink = (slug: string, error?: string) => (tool: string, args: Record<string, unknown>): string => {
  if (actionOf(args) === 'list') return JSON.stringify({ data: { results: { [slug]: { toolkit: slug, status: 'initiated', accounts: [] } } } })
  return JSON.stringify({ toolkits: [{ toolkit: slug, status: 'failed', ...(error ? { error } : {}) }] })
}

describe('B3 — connectApp dice PERCHÉ non è partito', () => {
  it('l\'app non ha una configurazione di accesso gestita da Composio → reason «not-connectable», nessun browser', async () => {
    const { manager, opened } = makeManager(addWithoutLink('spotify', NO_MANAGED_AUTH))
    const r = await manager.connectApp('spotify', { name: 'Spotify' })
    expect(r).toMatchObject({ ok: false, reason: 'not-connectable' })
    expect(opened).toHaveLength(0)
    // senza quelle parole nella risposta resta l'errore generico di sempre, senza reason
    const plain = makeManager(addWithoutLink('spotify'))
    const generic = await plain.manager.connectApp('spotify', { name: 'Spotify' })
    expect(generic).toMatchObject({ ok: false, error: 'no authorization link in the response' })
    expect('reason' in (generic as object)).toBe(false)
    expect(plain.opened).toHaveLength(0)
  })

  it('il browser non si apre → reason «browser», e l\'attesa NON parte (nessun pending)', async () => {
    const { manager } = makeManager(linkOk('spotify'), { open: async () => { throw new Error('URL non apribile') } })
    const r = await manager.connectApp('spotify', { name: 'Spotify' })
    expect(r).toMatchObject({ ok: false, reason: 'browser' })
    expect(manager.status().pending).toBeNull()
  })

  it('la scadenza (notAfter): entro il tempo il link si apre e l\'attesa parte; oltre NO (reason «timeout», niente browser)', async () => {
    const clock = { t: 1_000 }
    const { manager, opened } = makeManager(linkOk('spotify'), { now: () => clock.t })
    const inTime = await manager.connectApp('spotify', { name: 'Spotify', notAfter: 60_000 })
    expect(inTime).toEqual({ ok: true })
    expect(opened).toHaveLength(1)
    expect(manager.status().pending).toMatchObject({ slug: 'spotify' })
    manager.cancelWait()
    // la prova successiva arriva quando il tempo è già scaduto: il link si trova, ma non si apre
    clock.t = 70_000
    const late = await manager.connectApp('spotify', { name: 'Spotify', notAfter: 60_000 })
    expect(late).toMatchObject({ ok: false, reason: 'timeout' })
    expect(opened).toHaveLength(1)
    expect(manager.status().pending).toBeNull()
  })
})
