// BRV4 (fase box-apple-rete-vera): col motore Apple in bridge, gateway o
// sottorete di homun-box non letti alla partenza del browser → UNA rilettura
// della rete (ensureAppleBoxNetwork ripopola la cache); se mancano ANCORA lo
// strumento del browser fallisce IN PAROLE dal catalogo it/en e Chromium NON
// parte — mai un browser avviato verso un proxy irraggiungibile, il difetto
// visto dal vivo (console.warn e via col browser rotto). Il runner del box è
// la CLI FINTA VERA come nei test apple-box: SOLO il network inspect si
// intercetta, per pilotare cosa l'ensure e la rilettura ci leggono. Il
// gateway del caso che PARTe è 127.0.0.1 (l'host INIETTABILE dei test del
// proxy: il secondo ascolto deve potersi aprire DAVVERO per davvero).
// Visto FALLIRE il 2026-11-14: nessuna rilettura, nessun errore in parole.
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const FAKE = join(ROOT, 'scripts', 'fake-container.mjs')
const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-browser-gateway-test-'))

/** I settings pilotabili dal test (sandbox.* e la lingua dell'interfaccia). */
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: () => null
}))

const { setDockerRunnerForTests } = await import('../../sandbox/index')
const { setBoxNetworkGateway, setBoxNetworkSubnet, boxNetworkGateway } = await import('../../sandbox/apple-container-engine')
const { callBrowserTool, resetBrowserForTests } = await import('../browser')
const { resetBrowserProxyForTests } = await import('../browser-proxy')
const { formatUi, ui } = await import('../../../shared/ui-text')
const { UI } = await import('../../../shared/ui-messages')

/** L'uscita di un network inspect nella FORMA VERA, col gateway scelto. */
const netJson = (gateway: string | null, subnet: string | null): string =>
  JSON.stringify([{
    configuration: { creationDate: '2026-11-14T07:30:36Z', labels: {}, mode: 'hostOnly', name: 'homun-box', options: {}, plugin: 'container-network-vmnet' },
    id: 'homun-box',
    status: { ...(gateway ? { ipv4Gateway: gateway } : {}), ...(subnet ? { ipv4Subnet: subnet } : {}), ipv6Subnet: 'fdcb:b3be:434:c533::/64' }
  }])

/**
 * Il runner del box: la CLI FINTA VERA per tutto, TRANNE il network inspect
 * (deciso dal test: la prima lettura senza gateway, la rilettura piena — o
 * tutte senza). Conta gli argv che passano: il test li vuole nel log.
 */
function runner(logFile: string, inspectOut: () => string, calls: string[][]) {
  return async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: null }> => {
    calls.push(argv)
    if (argv[0] === 'network' && argv[1] === 'inspect') {
      return { stdout: inspectOut(), stderr: '', exitCode: 0, signal: null }
    }
    const r = spawnSync(process.execPath, [FAKE, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status, signal: null }
  }
}

/** Il controllo come 1001 della radice di /browser: il passaggio DOPO il gateway. */
const isBrowserWritable = (a: string[]): boolean => a.includes('test') && a.includes('-O') && a.includes('/browser')

let seq = 0
beforeAll(() => {
  // la lingua dell'interfaccia dei test: le PAROLE del messaggio sono le italiane
  settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container', 'sandbox.network': 'bridge', 'ui.activeLanguage': 'it' }
})
afterEach(async () => {
  setDockerRunnerForTests(null)
  setBoxNetworkGateway(null)
  setBoxNetworkSubnet(null)
  await resetBrowserForTests()
  await resetBrowserProxyForTests()
})
afterAll(() => {
  settings.value = {}
  rmSync(TMP, { recursive: true, force: true })
})

describe('BRV4: gateway assente col motore Apple in bridge — rilettura, poi parole', () => {
  it('cache VUOTA e rilettura che la RIEMPIE: il browser PARTE (controllo della radice di /browser, gateway del secondo ascolto)', async () => {
    const logFile = join(TMP, `cli-brv4-${++seq}.jsonl`)
    const calls: string[][] = []
    // il PRIMO network inspect (l'ensure della rete) non dice il gateway; la
    // RILETTURA sì — e con un indirizzo che il test può ascoltare davvero
    let inspections = 0
    setBoxNetworkGateway(null)
    setBoxNetworkSubnet(null)
    setDockerRunnerForTests(runner(logFile, () => (inspections++ === 0 ? netJson(null, '192.168.128.0/24') : netJson('127.0.0.1', '127.0.0.0/8')), calls))
    // il browser parte: il fallimento che resta è lo spawn del launcher (nel
    // test HOMUN_CONTAINER_PATH non esiste) — NON il messaggio del catalogo
    const err = await callBrowserTool('agent_brv4a', 'browser_open', { url: 'https://example.com/' }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toBe(formatUi(ui(UI.browserBoxNetwork), 'it'))
    // UNA rilettura: due network inspect in tutto (l'ensure + la rilettura)
    expect(inspections).toBe(2)
    expect(calls.filter((a) => a[0] === 'network' && a[1] === 'inspect')).toHaveLength(2)
    // la cache ORMAI piena: il gateway dichiarato dalla rilettura
    expect(boxNetworkGateway()).toBe('127.0.0.1')
    // e la partenza è ANDATA AVANTI: il controllo della radice di /browser è
    // il passaggio che segue il blocco del gateway
    expect(calls.some(isBrowserWritable)).toBe(true)
  }, 60_000)

  it('rilettura VUOTA: errore IN PAROLE dal catalogo, NESSUN Chromium (mai il controllo di /browser, mai il launcher)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logFile = join(TMP, `cli-brv4-${++seq}.jsonl`)
    const calls: string[][] = []
    let inspections = 0
    setBoxNetworkGateway(null)
    setBoxNetworkSubnet(null)
    setDockerRunnerForTests(runner(logFile, () => { inspections++; return netJson(null, null) }, calls))
    // le parole del catalogo it/en (qui interfaccia in italiano)
    await expect(callBrowserTool('agent_brv4b', 'browser_open', { url: 'https://example.com/' }))
      .rejects.toThrow(formatUi(ui(UI.browserBoxNetwork), 'it'))
    // UNA rilettura sola, poi l'errore: due network inspect in tutto
    expect(inspections).toBe(2)
    // NESSUN Chromium: niente controllo della radice di /browser (il passo
    // dopo il gateway), niente launcher del browser
    expect(calls.some(isBrowserWritable)).toBe(false)
    // e il motivo TECNICO sta nel log del daemon (una riga), non in chat
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('homun-box'))
    errSpy.mockRestore()
    warnSpy.mockRestore()
  }, 60_000)
})
