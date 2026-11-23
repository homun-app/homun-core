// B3 (fase b20-bug): i pezzi PURI dell'avvio di un collegamento «in un
// passo» — l'esito di connectApp diventa un motivo in parole (id del
// catalogo UI + valori), l'attesa dell'esito ha un tempo massimo (mai una
// promessa orfana), il dettaglio tecnico si ripulisce (mai link, mai
// segreti) e la sonda può accorciare il tempo del daemon.
import { describe, expect, it, vi } from 'vitest'
import {
  awaitAppStart, connectStartOutcomeOf, appStartTimeoutMs, connectDetailOf, noManagedAuthIn
} from '../app-connect-start'
import { APP_CONNECT_DAEMON_TIMEOUT_MS, APP_CONNECT_MAX_MS } from '../../../shared/app-connect'

const NO_MANAGED_AUTH =
  'ToolRouterV2_NoManagedAuth: no Composio-managed auth config for this toolkit; the developer must configure authentication'

describe('B3 — noManagedAuthIn: la risposta di Composio dice che il login non lo gestisce', () => {
  it('riconosce l\'errore di Composio (e le sue parole), in qualunque forma arrivi', () => {
    expect(noManagedAuthIn(NO_MANAGED_AUTH)).toBe(true)
    expect(noManagedAuthIn('Error: no managed auth for toolkit spotify')).toBe(true)
    expect(noManagedAuthIn('use_custom_app is required: pass your own client_id and client_secret')).toBe(true)
    expect(noManagedAuthIn('auth config not found for SPOTIFY')).toBe(true)
  })
  it('NON scatta su un\'altra risposta senza link', () => {
    expect(noManagedAuthIn('')).toBe(false)
    expect(noManagedAuthIn(JSON.stringify({ toolkits: [{ toolkit: 'spotify' }] }))).toBe(false)
    expect(noManagedAuthIn('rate limit exceeded, retry later')).toBe(false)
    expect(noManagedAuthIn('account limit reached: 5 accounts')).toBe(false)
  })
})

describe('B3 — connectStartOutcomeOf: dall\'esito di connectApp al motivo in parole', () => {
  it('ok → partito', () => {
    expect(connectStartOutcomeOf({ ok: true, already: true }, 'Spotify')).toEqual({ ok: true })
  })
  it('not-connectable → il messaggio del catalogo con il nome dell\'app, senza dettaglio grezzo', () => {
    const o = connectStartOutcomeOf({ ok: false, error: 'x', reason: 'not-connectable' }, 'Spotify')
    expect(o).toMatchObject({ ok: false, reason: 'not-connectable', message: { id: 'appConnect.notConnectable' }, values: { name: 'Spotify' } })
    expect((o as { detail?: string }).detail).toBeUndefined()
  })
  it('browser, account-limit, non più collegato → ciascuno il suo messaggio', () => {
    expect(connectStartOutcomeOf({ ok: false, error: 'e', reason: 'browser' }, 'Spotify')).toMatchObject({ reason: 'connect-failed', message: { id: 'appConnect.browser' } })
    expect(connectStartOutcomeOf({ ok: false, error: 'account-limit', accountCount: 3 }, 'Spotify')).toMatchObject({ message: { id: 'appConnect.accountLimit' }, values: { count: 3, name: 'Spotify' } })
    expect(connectStartOutcomeOf({ ok: false, error: 'not-active' }, 'Spotify')).toMatchObject({ message: { id: 'appConnect.notActive' } })
  })
  it('timeout → reason «timeout»', () => {
    expect(connectStartOutcomeOf({ ok: false, error: 't', reason: 'timeout' }, 'Spotify')).toMatchObject({ ok: false, reason: 'timeout', message: { id: 'appConnect.timeout' } })
  })
  it('altro errore → motivo generico + il dettaglio (ripulito: mai link, mai segreti, tagliato)', () => {
    const o = connectStartOutcomeOf({ ok: false, error: 'Request timed out for https://mcp.composio.example/link?token=abc123 keep' }, 'Spotify')
    expect(o).toMatchObject({ ok: false, reason: 'connect-failed', message: { id: 'appConnect.failed' } })
    const detail = (o as { detail?: string }).detail ?? ''
    expect(detail).toContain('Request timed out')
    expect(detail).toContain('keep')
    expect(detail).not.toContain('https://')
    expect(detail).not.toContain('token=')
  })
  it('connectDetailOf: via i link e i segreti, tagliato; il vuoto non c\'è', () => {
    expect(connectDetailOf('api_key=ak_segreta123 resto')).toBe('api_key="[redacted]" resto')
    expect(connectDetailOf('https://x.example/a')).toBeUndefined()
    expect(connectDetailOf('   ')).toBeUndefined()
    expect(connectDetailOf(undefined)).toBeUndefined()
    expect(connectDetailOf('x'.repeat(400))!.length).toBeLessThanOrEqual(301)
  })
})

describe('B3 — awaitAppStart: l\'attesa dell\'esito non resta mai appesa', () => {
  it('l\'esito arriva → è quello', async () => {
    expect(await awaitAppStart(Promise.resolve({ ok: true, already: true }), 1_000)).toEqual({ ok: true })
  })
  it('la promessa rifiuta → esito d\'errore (nessuna rejection verso l\'alto)', async () => {
    const o = await awaitAppStart(Promise.reject(new Error('boom')), 1_000)
    expect(o).toMatchObject({ ok: false, reason: 'connect-failed', message: { id: 'appConnect.failed' }, detail: 'boom' })
  })
  it('nessuna risposta → allo scadere del tempo massimo risponde «timeout» (orologio finto)', async () => {
    vi.useFakeTimers()
    try {
      let lateReject!: (e: Error) => void
      const never = new Promise<{ ok: true }>((_res, rej) => { lateReject = rej })
      const pending = awaitAppStart(never, 5_000)
      const at = await Promise.race([pending.then((o) => o.ok), vi.advanceTimersByTimeAsync(4_999).then(() => 'ancora in attesa' as const)])
      expect(at).toBe('ancora in attesa')
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toMatchObject({ ok: false, reason: 'timeout' })
      // la risposta tardiva (qui: un rifiuto) resta catturata: nessuna rejection dispersa
      lateReject(new Error('late'))
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('B3 — il tempo massimo del daemon (appStartTimeoutMs)', () => {
  it('valore di serie: STA SOTTO quello della riga (così la risposta col motivo vero arriva prima)', () => {
    expect(APP_CONNECT_MAX_MS).toBe(25_000)
    expect(APP_CONNECT_DAEMON_TIMEOUT_MS).toBeLessThan(APP_CONNECT_MAX_MS)
    expect(APP_CONNECT_DAEMON_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
  })
  it('senza variabili di prova: il valore di serie', () => {
    expect(appStartTimeoutMs({})).toBe(APP_CONNECT_DAEMON_TIMEOUT_MS)
  })
  it('la sonda lo accorcia con SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS (millisecondi), SOLO insieme a SANDBOT_TEST_USER_DATA', () => {
    expect(appStartTimeoutMs({ SANDBOT_TEST_USER_DATA: '/x', SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS: '1500' })).toBe(1500)
    expect(appStartTimeoutMs({ SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS: '1500' })).toBe(APP_CONNECT_DAEMON_TIMEOUT_MS)
  })
  it('un valore non valido non conta; uno più lungo del tempo della riga viene tagliato', () => {
    expect(appStartTimeoutMs({ SANDBOT_TEST_USER_DATA: '/x', SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS: 'abc' })).toBe(APP_CONNECT_DAEMON_TIMEOUT_MS)
    expect(appStartTimeoutMs({ SANDBOT_TEST_USER_DATA: '/x', SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS: '0' })).toBe(APP_CONNECT_DAEMON_TIMEOUT_MS)
    expect(appStartTimeoutMs({ SANDBOT_TEST_USER_DATA: '/x', SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS: '999999' })).toBe(APP_CONNECT_MAX_MS)
  })
})
