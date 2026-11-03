// Fase app (A2–A5): i test del modulo Composio del daemon con il client
// FINTO iniettato (mai rete): chiave nello store cifrato, catalogo con
// paginazione e cache 24 h, unione con le curate (Gmail UNA riga), i tre
// flussi di collegamento (redirect, senza login, da sviluppatore), account
// non più ACTIVE → da ricollegare con strumenti tolti, execute con la
// versione dello schema, errori ripuliti (una chiave ak_… non compare MAI).
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectorsSecretStore, type ConnectorsSecretStore } from '../sealed-store'
import { createComposioManager, setActiveComposio, COMPOSIO_CACHE_TTL_MS } from '../composio'
import { FakeComposioClient, type FakeComposioSpec } from '../composio-fake'
import type { SandbotEvent, ToolDefLike } from '../../../shared/types'

// ---- l'ambiente del test ----

let DATA = ''
const now = { value: 1_000_000 }
const events: SandbotEvent[] = []
let settings = new Map<string, unknown>()
let store: ConnectorsSecretStore
let fake: FakeComposioClient
let opened: string[] = []

const spec = (): FakeComposioSpec => ({
  autoLoginMs: 40,
  toolkits: [
    { slug: 'GMAIL', name: 'Gmail', description: 'Posta in arrivo e bozze', category: 'Mail' },
    { slug: 'SLACK', name: 'Slack', description: 'Canali e messaggi del team', category: 'Chat' },
    { slug: 'WEATHER', name: 'Weather', description: 'Meteo della tua città', category: 'Tools', noAuth: true },
    { slug: 'OLDCRM', name: 'Old CRM', description: 'Richiede configurazione lato sviluppatore', category: 'CRM', developerConfig: true },
    { slug: 'HUBSPOT', name: 'HubSpot', description: 'Contatti e pipeline', category: 'CRM' },
    ...Array.from({ length: 120 }, (_, i) => ({ slug: `TOOL${String(i).padStart(3, '0')}`, name: `Toolkit ${i}`, description: `Toolkit numero ${i}`, category: 'Altro' }))
  ],
  tools: {
    SLACK: [
      {
        slug: 'SLACK_SEND_MESSAGE', name: 'Send message', description: 'Send a message to a channel', version: '20260101_00',
        inputParameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] }
      },
      { slug: 'SLACK_LIST_CHANNELS', name: 'List channels', description: 'List the channels', version: '20260101_00', inputParameters: { type: 'object', properties: {} } },
      { slug: 'SLACK_FAIL', name: 'Failing action', description: 'Always fails', version: '20260101_00', failWithError: 'unauthorized: key ak_live_SECRET123 rejected' }
    ],
    WEATHER: [{ slug: 'WEATHER_GET_TODAY', name: 'Get today', description: 'Today weather', version: '20260101_00', inputParameters: { type: 'object', properties: {} } }]
  }
})

function makeManager(specOverride?: FakeComposioSpec, fetchImpl?: typeof fetch): ReturnType<typeof createComposioManager> {
  fake = new FakeComposioClient(specOverride ?? spec())
  return createComposioManager({
    store,
    getSetting: <T>(k: string, fb: T): T => (settings.has(k) ? (settings.get(k) as T) : fb),
    setSetting: (k: string, v: unknown) => settings.set(k, v),
    openExternal: async (url) => { opened.push(url) },
    hasUi: () => true,
    emit: (e) => events.push(e),
    dataDir: () => DATA,
    now: () => now.value,
    clientFactory: async () => fake,
    ...(fetchImpl ? { fetchImpl } : {})
  })
}

/** attiva Composio col finto (set-key + test) e aspette il catalogo caldo */
async function activate(m: ReturnType<typeof createComposioManager>): Promise<void> {
  m.setKey('ak_test_key_12345678')
  const r = await m.test()
  expect(r.ok).toBe(true)
  await m.catalog()
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let envKey = randomBytes(32)

beforeEach(() => {
  DATA = mkdtempSync(join(tmpdir(), 'sandbot-composio-test-'))
  now.value = 1_000_000
  events.length = 0
  settings = new Map()
  envKey = randomBytes(32)
  store = createConnectorsSecretStore({
    getKey: async () => envKey,
    getSetting: <T>(k: string, fb: T): T => (settings.has(k) ? (settings.get(k) as T) : fb),
    setSetting: (k: string, v: unknown) => settings.set(k, v)
  })
  opened = []
})

afterEach(() => {
  setActiveComposio(null)
  fake?.dispose()
  rmSync(DATA, { recursive: true, force: true })
})

// ---- A2: la chiave ----

describe('A2 — attivazione con la chiave dell\'utente', () => {
  it('set-key + test riuscito → attivo, chiave CIFRATA nello store (mai nei settings), hint con le ultime 4', async () => {
    const m = makeManager()
    m.setKey('ak_test_key_12345678')
    const r = await m.test()
    expect(r.ok).toBe(true)
    const s = await m.status()
    expect(s.active).toBe(true)
    expect(s.hasKey).toBe(true)
    expect(s.keyHint).toBe('…5678')
    // NESSUN valore in chiaro nei setting (solo envelope cifrato)
    const raw = JSON.stringify([...settings.keys().map((k) => [k, settings.get(k)])])
    expect(raw).not.toContain('ak_test_key_12345678')
    // la chiave NON torna mai dallo status (solo hint)
    expect(JSON.stringify(s)).not.toContain('ak_test_key_12345678')
  })

  it('test fallito → la chiave NON resta salvata', async () => {
    const failing = spec()
    const m = createComposioManager({
      store,
      getSetting: <T>(k: string, fb: T): T => (settings.has(k) ? (settings.get(k) as T) : fb),
      setSetting: (k: string, v: unknown) => settings.set(k, v),
      openExternal: async () => undefined,
      hasUi: () => true,
      emit: (e) => events.push(e),
      dataDir: () => DATA,
      now: () => now.value,
      clientFactory: async () => {
        throw new Error('fetch failed: backend.composio.dev ENOTFOUND')
      }
    })
    m.setKey('ak_sbagliata_000000')
    const r = await m.test()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('unreachable')
    const s = await m.status()
    expect(s.active).toBe(false)
    // lo store cifrato non contiene la chiave
    expect(await store.read<string>('composio', 'apiKey')).toBeUndefined()
  })

  it('disable toglie chiave, strumenti e righe (ma NON cancella gli account su Composio)', async () => {
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    let s = await m.status()
    expect(s.connected.map((a) => a.slug)).toContain('slack')
    await m.disable()
    s = await m.status()
    expect(s.active).toBe(false)
    expect(s.connected).toEqual([])
    expect(await store.read<string>('composio', 'apiKey')).toBeUndefined()
    // il finto conserva l'account remoto: lo scollegamento su Composio lo fa l'utente
    expect(fake.accounts.length).toBe(1)
    // gli strumenti spariscono dai bot
    expect(m.toolsForAgent('bot1')).toEqual([])
  })

  it('userId = homun-<uuid> generato UNA volta e stabile (mai email o nome)', async () => {
    const m = makeManager()
    m.setKey('ak_test_key_12345678')
    await m.test()
    const id1 = settings.get('composio.userId') as string
    expect(id1).toMatch(/^homun-[0-9a-f-]{36}$/)
    const m2 = makeManager()
    await activate(m2)
    expect(settings.get('composio.userId')).toBe(id1)
  })
})

// ---- A3: catalogo, paginazione, cache, unione ----

describe('A3 — catalogo in cache, paginazione, unione con le curate', () => {
  it('il catalogo segue TUTTE le pagine del client (120+ toolkit, 50 per pagina nel finto)', async () => {
    const m = makeManager()
    await activate(m)
    const c = await m.catalog()
    // tutte le voci del finto tranne GMAIL (curata: vince lei)
    expect(c.count).toBe(spec().toolkits.length - 1)
    // ordine alfabetico: HubSpot prima di Old CRM
    const names = c.rows.map((r) => r.name)
    expect(names.indexOf('HubSpot')).toBeLessThan(names.indexOf('Old CRM'))
  })

  it('GMAIL sta UNA riga sola: la curata vince, il toolkit Composio NON compare', async () => {
    const m = makeManager()
    await activate(m)
    const c = await m.catalog()
    expect(c.rows.some((r) => r.slug.toLowerCase() === 'gmail')).toBe(false)
  })

  it('la ricerca è LOCALE sulla cache: nome, slug, categoria', async () => {
    const m = makeManager()
    await activate(m)
    const byName = await m.catalog('hubspot')
    expect(byName.rows.map((r) => r.slug)).toEqual(['hubspot'])
    const bySlug = await m.catalog('tool012')
    expect(bySlug.rows.length).toBeGreaterThan(0)
    const byCategory = await m.catalog('CRM')
    expect(byCategory.rows.map((r) => r.name)).toContain('Old CRM')
  })

  it('cache su disco 24 h: scaduta si riscarica, prima no', async () => {
    const m = makeManager()
    await activate(m)
    expect(existsSync(join(DATA, 'composio', 'catalog.json'))).toBe(true)
    const before = fake.authorizeCalls.length
    void before
    // entro le 24 h: stessa istantanea (il file non cambia)
    const fetchedAt1 = (JSON.parse(readFileSync(join(DATA, 'composio', 'catalog.json'), 'utf8')) as { fetchedAt: number }).fetchedAt
    now.value += 60_000
    await m.catalog()
    const fetchedAt2 = (JSON.parse(readFileSync(join(DATA, 'composio', 'catalog.json'), 'utf8')) as { fetchedAt: number }).fetchedAt
    expect(fetchedAt2).toBe(fetchedAt1)
    // oltre le 24 h: si riscarica
    now.value += COMPOSIO_CACHE_TTL_MS + 1
    await m.catalog()
    const fetchedAt3 = (JSON.parse(readFileSync(join(DATA, 'composio', 'catalog.json'), 'utf8')) as { fetchedAt: number }).fetchedAt
    expect(fetchedAt3).toBe(now.value)
  })

  it('il logo si scarica SOLO https, dal dominio Composio, ≤256 KB, solo immagini → data: URL', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const withLogo = spec()
    withLogo.toolkits[1] = { ...withLogo.toolkits[1]!, logo: 'https://cdn.composio.dev/slack.png' }
    const fetchLogo = (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === 'https://cdn.composio.dev/slack.png') {
        return new Response(Buffer.from(png, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const m = makeManager(withLogo, fetchLogo)
    await activate(m)
    const c = await m.catalog()
    const slack = c.rows.find((r) => r.slug === 'slack')
    expect(slack?.logo?.startsWith('data:image/png;base64,')).toBe(true)
    // gli altri senza logo restano null (il renderer disegna l'iniziale)
    expect(c.rows.find((r) => r.slug === 'hubspot')?.logo).toBeNull()
    // un dominio fuori da Composio non si scarica proprio
    const evil = spec()
    evil.toolkits[4] = { ...evil.toolkits[4]!, logo: 'https://evil.example.com/hubspot.png' }
    const m2 = makeManager(evil, fetchLogo)
    await activate(m2)
    const c2 = await m2.catalog()
    expect(c2.rows.find((r) => r.slug === 'hubspot')?.logo).toBeNull()
  })

  // ---- R5 (ritocchi): niente redirect fuori dominio, lettura in streaming ----

  it('R5 un redirect verso un altro host NON si segue: 3xx → logo null', async () => {
    const withLogo = spec()
    withLogo.toolkits[1] = { ...withLogo.toolkits[1]!, logo: 'https://cdn.composio.dev/slack.png' }
    const fetchRedirect = (async (url: string | URL | Request) => {
      const href = String(url)
      // redirect «manual»: la risposta È il 302 con il Location verso l'host estraneo
      if (href === 'https://cdn.composio.dev/slack.png') {
        return new Response('', { status: 302, headers: { location: 'https://evil.example.com/slack.png' } })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const m = makeManager(withLogo, fetchRedirect)
    await activate(m)
    const c = await m.catalog()
    expect(c.rows.find((r) => r.slug === 'slack')?.logo).toBeNull()
  })

  it('R5 anche un 200 che finisce su un altro host (res.url) viene rifiutato', async () => {
    const withLogo = spec()
    withLogo.toolkits[1] = { ...withLogo.toolkits[1]!, logo: 'https://cdn.composio.dev/slack.png' }
    const fetchOtherHost = (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === 'https://cdn.composio.dev/slack.png') {
        const r = new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': 'image/png' } })
        return { ...r, url: 'https://evil.example.com/slack.png' }
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const m = makeManager(withLogo, fetchOtherHost)
    await activate(m)
    const c = await m.catalog()
    expect(c.rows.find((r) => r.slug === 'slack')?.logo).toBeNull()
  })

  it('R5 corpo da 1 MB SENZA content-length → null, senza leggerlo tutto (stream interrotto a 256 KB)', async () => {
    const withLogo = spec()
    withLogo.toolkits[1] = { ...withLogo.toolkits[1]!, logo: 'https://cdn.composio.dev/big.png' }
    const CHUNK = 4096
    let pulled = 0 // chunk generati dallo stream
    const fetchHuge = (async (url: string | URL | Request) => {
      if (String(url) !== 'https://cdn.composio.dev/big.png') return new Response('', { status: 404 })
      // 1 MB di corpo, NESSUN content-length; corpo nudo (senza il pump di
      // Response) così i chunk contati sono ESATTAMENTE quelli letti dal logo
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++
          controller.enqueue(new Uint8Array(CHUNK))
        },
        cancel() { /* il consumer ha smesso: niente altri chunk */ }
      })
      return {
        status: 200, ok: true, url: String(url),
        headers: new Headers({ 'content-type': 'image/png' }),
        body: stream
      }
    }) as unknown as typeof fetch
    const m = makeManager(withLogo, fetchHuge)
    await activate(m)
    pulled = 0 // activate() scalda già il catalogo: si conta UNA passata
    const c = await m.catalog()
    expect(c.rows.find((r) => r.slug === 'slack')?.logo).toBeNull()
    // il limite è 256 KB: chunk letti al massimo limite/CHUNK + 2 di abbondo,
    // mai tutto il megabyte (256 chunk da 4 KB)
    expect(pulled).toBeGreaterThanOrEqual(Math.ceil((256 * 1024) / CHUNK))
    expect(pulled).toBeLessThan(70)
  })
})

// ---- A4: collegare e scollegare ----

describe('A4 — collega e scollega', () => {
  it('con redirectUrl: browser di sistema + waitForConnection → collegato con account', async () => {
    const m = makeManager()
    await activate(m)
    const r = m.connect('slack')
    expect(r.started).toBe(true)
    // il foglio d'attesa: pending visibile finché il login (finto) non completa
    let s = await m.status()
    expect(s.pending?.slug).toBe('slack')
    await sleep(150)
    s = await m.status()
    expect(s.pending).toBeNull()
    expect(s.connected.find((a) => a.slug === 'slack')?.status).toBe('ACTIVE')
    expect(opened[0]).toMatch(/^https:\/\//)
    // gli strumenti del toolkit sono disponibili
    const tools = m.toolsForAgent('bot1')
    expect(tools.map((t) => t.name)).toContain('composio__slack__SLACK_SEND_MESSAGE')
  })

  it('toolkit senza login → collegato subito, senza browser', async () => {
    const m = makeManager()
    await activate(m)
    m.connect('weather')
    await sleep(80)
    const s = await m.status()
    expect(s.connected.find((a) => a.slug === 'weather')?.status).toBe('ACTIVE')
    expect(s.connected.find((a) => a.slug === 'weather')?.accountId).toBeNull()
    expect(opened).toEqual([])
    expect(m.toolsForAgent('bot1').map((t) => t.name)).toContain('composio__weather__WEATHER_GET_TODAY')
  })

  it('toolkit che su Composio richiede lo sviluppatore → riga developer-config, non un errore generico', async () => {
    const m = makeManager()
    await activate(m)
    // il finto lo DICHIARA nei dati del toolkit (managedAuth false, come
    // l'API vera): il manager risponde subito senza partire, e la riga del
    // catalogo dice «da sviluppatore»
    const r = m.connect('oldcrm')
    expect(r).toEqual({ started: false, developerConfig: true })
    await sleep(80)
    const s = await m.status()
    expect(s.connected.find((a) => a.slug === 'oldcrm')).toBeUndefined()
    const c = await m.catalog('Old CRM')
    expect(c.rows[0]?.connectable).toBe('developer-config')
  })

  it('se i dati NON lo dicono, lo si scopre dall\'errore di authorize → comunque developer-config', async () => {
    // wrapper del finto: il catalogo NON dichiara managedAuth, ma authorize
    // rifiuta con l'errore «no managed auth» dell'API diretta
    const surprise = spec()
    const base = new FakeComposioClient(surprise)
    const m = createComposioManager({
      store,
      getSetting: <T>(k: string, fb: T): T => (settings.has(k) ? (settings.get(k) as T) : fb),
      setSetting: (k: string, v: unknown) => settings.set(k, v),
      openExternal: async () => undefined,
      hasUi: () => true,
      emit: (e) => events.push(e),
      dataDir: () => DATA,
      now: () => now.value,
      clientFactory: async () => ({
        toolkits: {
          ...base.toolkits,
          authorize: async () => {
            throw new Error('ToolRouterV2_NoManagedAuth: no Composio-managed auth config for this toolkit')
          }
        },
        connectedAccounts: base.connectedAccounts,
        tools: base.tools
      })
    })
    m.setKey('ak_test_key_12345678')
    expect((await m.test()).ok).toBe(true)
    await m.catalog()
    const r2 = m.connect('hubspot')
    expect(r2.started).toBe(true)
    await sleep(150)
    const c2 = await m.catalog('HubSpot')
    expect(c2.rows[0]?.connectable).toBe('developer-config')
    expect((await m.status()).connected.find((a) => a.slug === 'hubspot')).toBeUndefined()
    base.dispose()
  })

  it('account non più ACTIVE → «da ricollegare» e strumenti SPARITI dai bot', async () => {
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    expect(m.toolsForAgent('bot1').length).toBeGreaterThan(0)
    // l'account scade su Composio (stesso utente, stesso servizio: mai un
    // account diverso da quello collegato)
    fake.expireAccount(fake.accounts[0]!.id)
    await m.refreshAccounts()
    const s = await m.status()
    expect(s.connected.find((a) => a.slug === 'slack')?.status).toBe('RECONNECT')
    expect(m.toolsForAgent('bot1')).toEqual([])
    // e l'esecuzione rifiuta con l'errore chiaro (gli strumenti sono spariti
    // dal registro: il nome non si risolve più e il messaggio dice di ricollegare)
    const out = await m.execute('composio__slack__SLACK_SEND_MESSAGE', { channel: '#x', text: 'ciao' })
    expect(out).toContain('reconnect')
  })

  it('scollega → connectedAccounts.delete, strumenti tolti, riga torna in «Tutte le app»', async () => {
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    const accountId = fake.accounts[0]?.id
    await m.disconnect('slack')
    expect(fake.accounts.length).toBe(0)
    void accountId
    const s = await m.status()
    expect(s.connected).toEqual([])
    const c = await m.catalog('slack')
    expect(c.rows.map((r) => r.slug)).toContain('slack')
  })

  it('annulla mentre aspetta il login: la richiesta INITIATED viene cancellata', async () => {
    const slow = spec()
    slow.autoLoginMs = 10_000 // il login non completa da solo
    const m = makeManager(slow)
    await activate(m)
    m.connect('slack')
    await sleep(60)
    expect((await m.status()).pending?.slug).toBe('slack')
    await m.disconnect('slack')
    await sleep(80)
    const s = await m.status()
    expect(s.pending).toBeNull()
    expect(s.connected).toEqual([])
    expect(fake.accounts.length).toBe(0) // l'INITIATED è stato cancellato
  })

  it('enabledFor per toolkit: predefinito tutti, poi solo un bot', async () => {
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    expect(m.toolsForAgent('qualunque-bot').length).toBeGreaterThan(0)
    m.setEnabledFor('slack', ['bot2'])
    expect(m.toolsForAgent('bot1')).toEqual([])
    expect(m.toolsForAgent('bot2').length).toBeGreaterThan(0)
  })
})

// ---- A5: esecuzione ----

describe('A5 — execute con la versione dello schema', () => {
  it('usa la STESSA versione dello schema scaricato', async () => {
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    const out = await m.execute('composio__slack__SLACK_SEND_MESSAGE', { channel: '#generale', text: 'ciao' })
    expect(out).toContain('"ok":true')
    const call = fake.executions[fake.executions.length - 1]!
    expect(call.slug).toBe('SLACK_SEND_MESSAGE')
    expect(call.version).toBe('20260101_00')
    expect(call.arguments).toEqual({ channel: '#generale', text: 'ciao' })
  })

  it('una chiave finta ak_… NON compare MAI nell\'errore ripulito', async () => {
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    const out = await m.execute('composio__slack__SLACK_FAIL', {})
    expect(out).not.toContain('ak_live_SECRET123')
    expect(out).toContain('[redacted]')
  })

  it('strumento sconosciuto o disattivato → errore chiaro, mai un turno bloccato', async () => {
    const m = makeManager()
    await activate(m)
    const out = await m.execute('composio__slack__SLACK_SEND_MESSAGE', {})
    expect(out).toContain('not available')
  })
})

// ---- R4 (ritocchi): describeTool e lo status col nome delle azioni localizzato ----

describe('R4 — describeTool e status: nomi delle azioni nella lingua della UI', () => {
  it('describeTool: in italiano «Invia messaggio», con slug e versione per la card', async () => {
    settings.set('ui.activeLanguage', 'it')
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    const d = m.describeTool('composio__slack__SLACK_SEND_MESSAGE')
    expect(d).toEqual({ app: 'Slack', action: 'Invia messaggio', slug: 'SLACK_SEND_MESSAGE', version: '20260101_00', original: 'Send message' })
  })

  it('describeTool: in inglese il nome originale di Composio («Send message»)', async () => {
    settings.set('ui.activeLanguage', 'en')
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    const d = m.describeTool('composio__slack__SLACK_SEND_MESSAGE')
    expect(d?.action).toBe('Send message')
  })

  it('describeTool: parola fuori glossario → il nome originale, mai una mezza traduzione', async () => {
    settings.set('ui.activeLanguage', 'it')
    const withCanvas = spec()
    withCanvas.tools = {
      ...(withCanvas.tools ?? {}),
      SLACK: [
        ...(withCanvas.tools?.SLACK ?? []),
        { slug: 'SLACK_CREATE_CANVAS_SECTION', name: 'Create canvas section', description: 'x', version: '20260101_00', inputParameters: { type: 'object', properties: {} } }
      ]
    }
    const m = makeManager(withCanvas)
    await activate(m)
    m.connect('slack')
    await sleep(150)
    const d = m.describeTool('composio__slack__SLACK_CREATE_CANVAS_SECTION')
    expect(d?.action).toBe('Create canvas section')
  })

  it('status: le azioni del toolkit collegato col nome localizzato (per la tabella del dettaglio)', async () => {
    settings.set('ui.activeLanguage', 'it')
    const m = makeManager()
    await activate(m)
    m.connect('slack')
    await sleep(150)
    const s = await m.status()
    const slack = s.connected.find((a) => a.slug === 'slack')
    expect(slack?.tools.map((t) => t.name)).toEqual(['Invia messaggio', 'Elenca canali', 'Failing action'])
    expect(slack?.tools.map((t) => t.slug)).toEqual(['SLACK_SEND_MESSAGE', 'SLACK_LIST_CHANNELS', 'SLACK_FAIL'])
  })
})

// ---- il registro modulo (punti d'ingresso per loop/mcp) ----

describe('registro modulo: setActiveComposio', () => {
  it('toolsForAgent/serversForAgent/appsOfAgent raggiungono il manager registrato', async () => {
    const m = makeManager()
    setActiveComposio(m)
    await activate(m)
    m.connect('slack')
    await sleep(150)
    // senza importare il manager: i punti d'ingresso del modulo
    const { composioToolsForAgent, composioServersForAgent, composioAppsOf } = await import('../composio')
    const tools: ToolDefLike[] = composioToolsForAgent('bot9')
    expect(tools.length).toBeGreaterThan(0)
    const servers = composioServersForAgent('bot9')
    expect(servers[0]?.name).toBe('Slack')
    expect(composioAppsOf('bot9')).toEqual(['Slack'])
  })
})

describe('prova con chiave vera: le cause degli errori della prova', () => {
  const mk = (err: unknown) => createComposioManager({
    store: { read: async () => undefined, write: async () => undefined, remove: async () => undefined } as never,
    getSetting: <T>(_k: string, fb: T): T => fb,
    setSetting: () => undefined,
    openExternal: async () => undefined,
    hasUi: () => true,
    emit: () => undefined,
    dataDir: () => '/nonexistent-composio-test',
    now: () => 0,
    clientFactory: async () => { throw err }
  })
  it('«Failed to fetch toolkits» con causa 401 è una chiave rifiutata, non la rete', async () => {
    const e = Object.assign(new Error('Failed to fetch toolkits'), { cause: Object.assign(new Error('401 Invalid API key: ak_**0000'), { status: 401 }) })
    const m = mk(e)
    m.setKey('ak_sbagliata_000000')
    const r = await m.test()
    expect(r.reason).toBe('invalid-key')
    expect(r.error).toContain('Invalid API key')
  })
  it('una chiave ck_ (Composio «For You») si riconosce senza chiamare Composio', async () => {
    let called = false
    const m = createComposioManager({
      store: { read: async () => undefined, write: async () => undefined, remove: async () => undefined } as never,
      getSetting: <T>(_k: string, fb: T): T => fb,
      setSetting: () => undefined,
      openExternal: async () => undefined,
      hasUi: () => true,
      emit: () => undefined,
      dataDir: () => '/nonexistent-composio-test',
      now: () => 0,
      clientFactory: async () => { called = true; throw new Error('no') }
    })
    m.setKey('ck_qualcosa_000000')
    const r = await m.test()
    expect(r.reason).toBe('consumer-key')
    expect(called).toBe(false)
  })
})
