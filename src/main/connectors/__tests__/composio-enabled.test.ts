// V5 (fase stato-vivo): l'interruttore Attivo dei connettori Composio. Un
// `enabled` sulla VOCE (setting per slug), distinto dagli enabledFor per bot
// e SENZA scollegare l'account (Scollega resta un gesto separato): spento,
// il toolkit non offre strumenti a NESSUN bot e non entra nell'elenco dei
// server Composio del prompt; l'account resta ACTIVE.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectorsSecretStore, type ConnectorsSecretStore } from '../sealed-store'
import { createComposioManager, setActiveComposio, composioToolsForAgent } from '../composio'
import { FakeComposioClient, type FakeComposioSpec } from '../composio-fake'
import type { SandbotEvent } from '../../../shared/types'
import { TEST_TMP_BASE } from '../../../test-tmp'

// ---- l'ambiente del test (come composio.test.ts, il minimo che serve) ----

let DATA = ''
const events: SandbotEvent[] = []
let settings = new Map<string, unknown>()
let store: ConnectorsSecretStore

const spec = (): FakeComposioSpec => ({
  autoLoginMs: 40,
  toolkits: [
    { slug: 'GMAIL', name: 'Gmail', description: 'Posta', category: 'Mail' },
    { slug: 'WEATHER', name: 'Weather', description: 'Meteo', category: 'Tools', noAuth: true }
  ],
  tools: {
    WEATHER: [{ slug: 'WEATHER_GET_TODAY', name: 'Get today', description: 'Today weather', version: '20260101_00', inputParameters: { type: 'object', properties: {} } }],
    GMAIL: [{ slug: 'GMAIL_SEARCH', name: 'Search', description: 'Cerca', version: '20260101_00', inputParameters: { type: 'object', properties: {} } }]
  }
})

function makeManager(): ReturnType<typeof createComposioManager> {
  const fake = new FakeComposioClient(spec())
  return createComposioManager({
    store,
    getSetting: <T>(k: string, fb: T): T => (settings.has(k) ? (settings.get(k) as T) : fb),
    setSetting: (k: string, v: unknown) => settings.set(k, v),
    openExternal: async () => undefined,
    hasUi: () => true,
    emit: (e) => events.push(e),
    dataDir: () => DATA,
    now: () => 1_000_000,
    clientFactory: async () => fake
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let envKey = randomBytes(32)

beforeEach(() => {
  DATA = mkdtempSync(join(TEST_TMP_BASE ?? tmpdir(), 'sandbot-composio-enabled-'))
  settings = new Map<string, unknown>()
  envKey = randomBytes(32)
  store = createConnectorsSecretStore({
    getKey: async () => envKey,
    getSetting: <T>(k: string, fb: T): T => (settings.has(k) ? (settings.get(k) as T) : fb),
    setSetting: (k: string, v: unknown) => settings.set(k, v)
  })
})
afterEach(() => {
  setActiveComposio(null)
  rmSync(DATA, { recursive: true, force: true })
})

describe('V5: setConnectorEnabled — il toolkit spento non offre strumenti, l\'account resta', () => {
  it('spento: nessuno strumento per NESSUN bot, fuori dai server del prompt; l\'account resta ACTIVE', async () => {
    const m = makeManager()
    m.setKey('ak_test_key_12345678')
    expect((await m.test()).ok).toBe(true)
    await m.catalog()
    m.connect('weather')
    await sleep(90)
    expect(m.toolsForAgent('bot1').map((t) => t.name)).toContain('composio__weather__WEATHER_GET_TODAY')

    m.setConnectorEnabled('weather', false)
    expect(m.toolsForAgent('bot1').map((t) => t.name)).not.toContain('composio__weather__WEATHER_GET_TODAY')
    expect(m.toolsForAgent(undefined).map((t) => t.name)).not.toContain('composio__weather__WEATHER_GET_TODAY')
    expect(m.serversForAgent('bot1').map((s) => s.id)).not.toContain('composio:weather')
    // l'ACCOUNT resta collegato: lo Scollega è un gesto separato
    const s = await m.status()
    expect(s.connected.find((a) => a.slug === 'weather')?.status).toBe('ACTIVE')
    // la status porta i spenti (per l'interruttore della UI)
    expect(s.disabled).toContain('weather')
    // riacceso: gli strumenti tornano per tutti
    m.setConnectorEnabled('weather', true)
    expect(m.toolsForAgent('bot1').map((t) => t.name)).toContain('composio__weather__WEATHER_GET_TODAY')
    expect((await m.status()).disabled ?? []).not.toContain('weather')
  })

  it('il modulo per il loop: composioToolsForAgent rispetta il spento (manager attivo)', async () => {
    const m = makeManager()
    m.setKey('ak_test_key_12345678')
    expect((await m.test()).ok).toBe(true)
    await m.catalog()
    m.connect('weather')
    await sleep(90)
    setActiveComposio(m)
    expect(composioToolsForAgent('bot1').map((t) => t.name)).toContain('composio__weather__WEATHER_GET_TODAY')
    m.setConnectorEnabled('weather', false)
    expect(composioToolsForAgent('bot1').map((t) => t.name)).not.toContain('composio__weather__WEATHER_GET_TODAY')
  })

  it('il enabled è DISTINCT dagli enabledFor: spento per tutti anche se il bot ce l\'ha tra i suoi', async () => {
    const m = makeManager()
    m.setKey('ak_test_key_12345678')
    expect((await m.test()).ok).toBe(true)
    await m.catalog()
    m.connect('weather')
    await sleep(90)
    m.setEnabledFor('weather', ['bot1'])
    expect(m.toolsForAgent('bot1').map((t) => t.name)).toContain('composio__weather__WEATHER_GET_TODAY')
    m.setConnectorEnabled('weather', false)
    expect(m.toolsForAgent('bot1').map((t) => t.name)).not.toContain('composio__weather__WEATHER_GET_TODAY')
    // il per-bot resta com\'era: riacceso il generale, il filtro per bot vale ancora
    m.setConnectorEnabled('weather', true)
    expect(m.toolsForAgent('bot1').map((t) => t.name)).toContain('composio__weather__WEATHER_GET_TODAY')
    expect(m.toolsForAgent('bot2').map((t) => t.name)).not.toContain('composio__weather__WEATHER_GET_TODAY')
  })
})
