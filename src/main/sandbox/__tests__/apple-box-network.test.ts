// BR1 (fase box-rete): la modalità none col motore Apple fallisce CHIUSO.
// L'ensure gira con la CLI FINTA VERA (scripts/fake-container.mjs, spawn per
// argv: quello che usa la sonda) come runner del box: la sequenza run -d →
// link down come root → verifica si vede nel LOG degli argv, e i difetti si
// simulano con le variabili della CLI finta (verifica che risponde «up», rete
// isolata non creabile). Mai un box none che gira senza la verifica passata:
// il box si rimuove e l'azione del bot fallisce in parole.
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const FAKE = join(ROOT, 'scripts', 'fake-container.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'sandbot-apple-box-network-test-'))

/** I settings pilotabili dal test (sandbox.mode/network/engine). */
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: () => null
}))

const { execCommand, setDockerRunnerForTests } = await import('../index')
const { boxNetworkGateway, setBoxNetworkGateway } = await import('../apple-container-engine')

/** Il log degli argv della CLI finta (una riga JSON per chiamata). */
const readCliLog = (file: string): string[][] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv as string[])

/**
 * Il runner del box: OGNI argv va alla CLI FINTA VERA (process spawn), con
 * env di prova scelto dal test. La CLI finta ricorda nel suo log ciò che ha
 * «fatto» (container creati, reti create): ogni test parte da un log NUOVO.
 */
function fakeCliRunner(logFile: string, extraEnv: Record<string, string> = {}) {
  return async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: null }> => {
    const r = spawnSync(process.execPath, [FAKE, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile, ...extraEnv }
    })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status, signal: null }
  }
}

/** Un log nuovo in TMP per ogni test. */
let seq = 0
const newLog = () => join(TMP, `cli-${++seq}.jsonl`)

const boxRun = (log: string[][]) => log.find((a) => a[0] === 'run' && a.includes('-d'))
const rootExecs = (log: string[][]) => log.filter((a) => a[0] === 'exec' && a[1] === '-u' && a[2] === '0')

beforeAll(() => {
  settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container' }
})
afterEach(() => {
  setDockerRunnerForTests(null)
  setBoxNetworkGateway(null)
})
afterAll(() => {
  settings.value = {}
  rmSync(TMP, { recursive: true, force: true })
})

describe('BR1: l\'ensure in none con la CLI finta — isolata e verificata, o non nasce', () => {
  it('none: il run -d porta --network homun-box-isolated --no-dns; link down COME ROOT e verifica; il bot gira', async () => {
    const logFile = newLog()
    setDockerRunnerForTests(fakeCliRunner(logFile))
    settings.value['sandbox.network'] = 'none'
    const r = await execCommand('agent_x', 'echo ok')
    expect(r.exitCode).toBe(0)
    const log = readCliLog(logFile)
    // il run del box: rete isolata di Homun + no-dns, MAI senza --network
    const run = boxRun(log)!
    expect(run[run.indexOf('--network') + 1]).toBe('homun-box-isolated')
    expect(run).toContain('--no-dns')
    // la rete isolata si crea --internal se manca (inspect → create → inspect)
    expect(log.some((a) => a[0] === 'network' && a[1] === 'create' && a.includes('--internal') && a.includes('homun-box-isolated'))).toBe(true)
    // difesa in profondità: il link down come root, POI la verifica
    const execs = rootExecs(log)
    expect(execs.some((a) => (a[a.indexOf('-c') + 1] ?? '').includes('ip link set'))).toBe(true)
    const check = execs.find((a) => (a[a.indexOf('-c') + 1] ?? '').includes('operstate'))
    expect(check, 'la verifica operstate come root').toBeDefined()
    expect(log.indexOf(check!), 'la verifica DOPO il link down').toBeGreaterThan(execs.findIndex((a) => (a[a.indexOf('-c') + 1] ?? '').includes('ip link set')))
    // il box resta su (nessun rm) e il comando del bot è GIRATO
    expect(log.some((a) => a[0] === 'rm')).toBe(false)
    expect(log.some((a) => a[0] === 'exec' && a.includes('echo ok'))).toBe(true)
    // il gateway della rete ISOLATA non diventa il gateway del proxy (BR2)
    expect(boxNetworkGateway()).toBeNull()
  }, 20_000)

  it('verifica che risponde up: box RIMOSSO, errore in parole, NESSUN exec del bot, una riga nel daemon.log', async () => {
    const logFile = newLog()
    setDockerRunnerForTests(fakeCliRunner(logFile, { SANDBOT_TEST_CONTAINER_OPERSTATE: 'up' }))
    settings.value['sandbox.network'] = 'none'
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(execCommand('agent_x', 'echo ok')).rejects.toThrow('Non riesco a isolare il computer del bot dalla rete: per sicurezza non l\'ho avviato')
      const log = readCliLog(logFile)
      // il box era partito, la verifica è caduta, il box si È RIMOSSO
      expect(boxRun(log)).toBeDefined()
      expect(log.some((a) => a[0] === 'rm' && a.includes('sandbot-box'))).toBe(true)
      // MAI un exec del bot: né la home, né il comando
      expect(log.some((a) => a[0] === 'exec' && a.includes('mkdir'))).toBe(false)
      expect(log.some((a) => a[0] === 'exec' && a.includes('echo ok'))).toBe(false)
      // una riga nel log del daemon (console.error del daemon → daemon.log)
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/isolament|isolat/i))
    } finally {
      err.mockRestore()
    }
  }, 20_000)

  it('rete isolata NON creabile: stesso esito — nessun box, errore in parole, riga nel log', async () => {
    const logFile = newLog()
    setDockerRunnerForTests(fakeCliRunner(logFile, { SANDBOT_TEST_CONTAINER_ISOLATED_FAIL: '1' }))
    settings.value['sandbox.network'] = 'none'
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(execCommand('agent_x', 'echo ok')).rejects.toThrow('Non riesco a isolare il computer del bot dalla rete: per sicurezza non l\'ho avviato')
      const log = readCliLog(logFile)
      // la create della rete isolata è caduta: NESSUN run del box, MAI
      expect(log.some((a) => a[0] === 'network' && a[1] === 'create' && a.includes('homun-box-isolated'))).toBe(true)
      expect(boxRun(log)).toBeUndefined()
      expect(log.some((a) => a[0] === 'exec' && a.includes('echo ok'))).toBe(false)
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/isolament|isolat/i))
    } finally {
      err.mockRestore()
    }
  }, 20_000)
})

// ---- BR3 (fase box-rete): cambiare sandbox.network RICREA il box ----
//
// La rete si legge solo alla creazione: un box nato bridge resta bridge anche
// dopo il passaggio a none. L'ensure confronta la rete DEL box esistente con
// quella della modalità corrente (Docker: none/bridge; Apple: la rete di
// Homun) e ricrea col motivo 'rete-cambiata'. Fail closed: inspect della
// rete fallito in none → si ricrea; in bridge non si tocca (regola di oggi).

describe('BR3: il passaggio bridge → none ricrea il box (CLI finta, stato nel log)', () => {
  it('APPLE: box nato su homun-box, modalità none → RICREATO su homun-box-isolated col motivo nel log', async () => {
    const logFile = newLog()
    setDockerRunnerForTests(fakeCliRunner(logFile))
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      settings.value['sandbox.network'] = 'bridge'
      await execCommand('agent_x', 'true')
      const nato = boxRun(readCliLog(logFile))!
      expect(nato[nato.indexOf('--network') + 1]).toBe('homun-box')
      // cambia la modalità: la rete del box non è più quella richiesta
      settings.value['sandbox.network'] = 'none'
      const before = readCliLog(logFile).length
      await execCommand('agent_x', 'echo di-nuovo')
      const log = readCliLog(logFile)
      // RICREATO: rm del SOLO container (mai volumi), nuovo run -d sulla rete
      // isolata, e di nuovo link down + verifica (un box none è VERIFICATO)
      const rm = log.slice(before).find((a) => a[0] === 'rm' && a.includes('sandbot-box'))
      expect(rm, 'il box bridge viene rimosso').toBeDefined()
      expect(log.slice(before).some((a) => a[0] === 'volume' && (a[1] === 'rm' || a[1] === 'delete'))).toBe(false)
      const ricreato = log.slice(before).find((a) => a[0] === 'run' && a.includes('-d'))!
      expect(ricreato[ricreato.indexOf('--network') + 1]).toBe('homun-box-isolated')
      expect(ricreato).toContain('--no-dns')
      expect(rootExecs(log.slice(before)).some((a) => (a[a.indexOf('-c') + 1] ?? '').includes('ip link set'))).toBe(true)
      expect(log.some((a) => a[0] === 'exec' && a.includes('echo di-nuovo'))).toBe(true)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('ricreazione del container sandbot-box: rete-cambiata'))
    } finally {
      err.mockRestore()
    }
  }, 20_000)

  it('DOCKER: box nato su bridge, modalità none → RICREATO con --network none (niente rm di volumi)', async () => {
    const logFile = newLog()
    setDockerRunnerForTests(fakeCliRunner(logFile))
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      settings.value['sandbox.engine'] = 'docker'
      settings.value['sandbox.network'] = 'bridge'
      await execCommand('agent_x', 'true')
      const nato = readCliLog(logFile).find((a) => a[0] === 'create')!
      expect(nato[nato.indexOf('--network') + 1]).toBe('bridge')
      settings.value['sandbox.network'] = 'none'
      const before = readCliLog(logFile).length
      await execCommand('agent_x', 'echo di-nuovo')
      const log = readCliLog(logFile)
      expect(log.slice(before).some((a) => a[0] === 'rm' && a.includes('sandbot-box'))).toBe(true)
      expect(log.slice(before).some((a) => a[0] === 'volume' && (a[1] === 'rm' || a[1] === 'delete'))).toBe(false)
      const ricreato = log.slice(before).find((a) => a[0] === 'create')!
      expect(ricreato[ricreato.indexOf('--network') + 1]).toBe('none')
      expect(log.some((a) => a[0] === 'exec' && a.includes('echo di-nuovo'))).toBe(true)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('ricreazione del container sandbot-box: rete-cambiata'))
    } finally {
      settings.value['sandbox.engine'] = 'apple-container'
      err.mockRestore()
    }
  }, 20_000)

  it('DOCKER fail closed: inspect della rete CADUTO in none → si ricrea lo stesso; in bridge NON si tocca', async () => {
    const logFile = newLog()
    // la CLI finta risponde a TUTTO tranne che all'inspect della rete del box
    const base = fakeCliRunner(logFile)
    const runner = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: null }> => {
      if (argv[0] === 'inspect' && argv.some((a) => typeof a === 'string' && /network/i.test(a))) {
        return { stdout: '', stderr: 'Error: No such object', exitCode: 1, signal: null }
      }
      return base(argv)
    }
    setDockerRunnerForTests(runner)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      settings.value['sandbox.engine'] = 'docker'
      settings.value['sandbox.network'] = 'none'
      // il box NASCE (il percorso di creazione non ispeziona la rete del box)
      await execCommand('agent_x', 'true')
      const dopoLaNascita = readCliLog(logFile).length
      expect(readCliLog(logFile).some((a) => a[0] === 'create' && a[a.indexOf('--network') + 1] === 'none')).toBe(true)
      // secondo giro col box che ESISTE e l'inspect della rete che CADE: in
      // none si ricrea (fail closed), col motivo nel log
      await execCommand('agent_x', 'echo due')
      const log2 = readCliLog(logFile)
      expect(log2.slice(dopoLaNascita).some((a) => a[0] === 'rm' && a.includes('sandbot-box'))).toBe(true)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('ricreazione del container sandbot-box: rete-cambiata'))
      // e la regola di oggi in bridge: inspect fallito NON ricrea (networkOk ignoto)
      settings.value['sandbox.network'] = 'bridge'
      const before = log2.length
      await execCommand('agent_x', 'true')
      expect(readCliLog(logFile).slice(before).some((a) => a[0] === 'rm')).toBe(false)
    } finally {
      settings.value['sandbox.engine'] = 'apple-container'
      err.mockRestore()
    }
  }, 20_000)
})
