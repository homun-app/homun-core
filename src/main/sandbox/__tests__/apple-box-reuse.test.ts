// BRR1 (fase box-rete-riavvio): l'isolamento vale anche per il box che si
// RIUSA. Con Apple ogni container è una VM: un box fermato e ripartito (il
// riavvio del Mac, `container system stop/start`) fa un boot NUOVO e le
// interfacce tornano SU — il box resta sulla rete host-only homun-box-isolated
// (Internet no) MA la seconda difesa cade. L'ensure che riusa il box VERIFICA
// prima di ogni exec del bot: la verifica (un solo exec come root) → non
// passa → link down e verifica di nuovo (isolateBoxNetwork) → non passa
// ancora → fail closed come alla creazione (box rimosso, riga nel log,
// errore in parole). Tutto con la CLI FINTA VERA (spawn per argv), il cui
// stato vive nel log: `stop` + lo `start` del box fermato simulano il
// riavvio (BRR5).
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const FAKE = join(ROOT, 'scripts', 'fake-container.mjs')
const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-apple-box-reuse-test-'))

/** I settings pilotabili dal test (sandbox.mode/network/engine). */
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: () => null
}))

const { setDiskSpaceProbeForTests } = await import('../disk-space')
const { execCommand, setDockerRunnerForTests } = await import('../index')

// fase design (verifica della suite): il probe dello spazio disco, come fa
// disk-space.test.ts — qui fingiamo TUTTO (la CLI del box, il runner) e il
// controllo dello spazio leggeva invece il disco VERO della macchina: la
// suite diventava verde o rossa secondo i GB liberi del momento (il prodotto
// chiede ~6,5 GB liberi prima di costruire l'immagine del box).
setDiskSpaceProbeForTests(() => 20_000_000_000)

/** Il log degli argv della CLI finta (una riga JSON per chiamata). */
const readCliLog = (file: string): string[][] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv as string[])

/**
 * Il runner del box: OGNI argv va alla CLI FINTA VERA (process spawn), con
 * env di prova scelto dal test. La CLI finta ricorda nel suo log container,
 * reti, e ora anche il RIAVVIO: uno `stop` seguito dallo `start` del box.
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

/** Il «riavvio» visto dalla CLI finta: il box si FERMA (il suo start sarà un boot nuovo). */
const fakeStopBox = (logFile: string) =>
  spawnSync(process.execPath, [FAKE, 'stop', 'sandbot-box'], {
    encoding: 'utf8',
    env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
  })

/** Un log nuovo in TMP per ogni test. */
let seq = 0
const newLog = () => join(TMP, `cli-${++seq}.jsonl`)

/** L'exec della VERIFICA operstate, COME ROOT (lo script che legge operstate). */
const isOperstateCheck = (a: string[]) => a[0] === 'exec' && a[1] === '-u' && a[2] === '0' && (a[a.indexOf('-c') + 1] ?? '').includes('operstate')
/** L'exec del LINK DOWN, COME ROOT (lo script che porta le interfacce giù). */
const isLinkDown = (a: string[]) => a[0] === 'exec' && a[1] === '-u' && a[2] === '0' && (a[a.indexOf('-c') + 1] ?? '').includes('ip link set')

beforeAll(() => {
  settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container' }
})
afterEach(() => {
  setDockerRunnerForTests(null)
})
afterAll(() => {
  settings.value = {}
  rmSync(TMP, { recursive: true, force: true })
})

describe('BRR1: col box che si RIUSA la verifica non si salta (Apple, none)', () => {
  it('box none «riavviato» (stop → start del box fermato): la verifica cade, POI link down e verifica, e il comando del bot gira', async () => {
    const logFile = newLog()
    setDockerRunnerForTests(fakeCliRunner(logFile))
    settings.value['sandbox.network'] = 'none'
    // il box NASCE (creazione: link down + verifica, come sempre)
    await execCommand('agent_x', 'true')
    // il «riavvio»: il box si ferma — il suo start sarà un boot nuovo e le
    // interfacce torneranno SU (le vede la CLI finta nel suo log)
    expect(fakeStopBox(logFile).status).toBe(0)
    const before = readCliLog(logFile).length
    const r = await execCommand('agent_y', 'echo riavviato')
    expect(r.exitCode).toBe(0)
    const after = readCliLog(logFile).slice(before)
    // il box si RIUSA: nessun run -d nuovo, nessun rm
    expect(after.some((a) => a[0] === 'run' && a.includes('-d'))).toBe(false)
    expect(after.some((a) => a[0] === 'rm')).toBe(false)
    // la sequenza del riuso: UNA verifica che CADE (boot nuovo, interfacce
    // su), il link down COME ROOT, e UNA SECONDA verifica che PASSA
    const linkDownAt = after.findIndex(isLinkDown)
    const checksAt = after.map((a, i) => (isOperstateCheck(a) ? i : -1)).filter((i) => i >= 0)
    expect(linkDownAt, 'il link down come root').toBeGreaterThan(-1)
    expect(checksAt.length, 'DUE verifiche: una prima del link down, una dopo').toBe(2)
    expect(checksAt[0]).toBeLessThan(linkDownAt)
    expect(checksAt[1]).toBeGreaterThan(linkDownAt)
    // e il comando del bot è GIRATO dopo la verifica ripassata
    expect(after.some((a) => a[0] === 'exec' && a.includes('echo riavviato'))).toBe(true)
  }, 20_000)

  it('up che RESTA up dopo il link down: box RIMOSSO, errore in parole, NESSUN exec del bot, una riga nel log', async () => {
    const logFile = newLog()
    setDockerRunnerForTests(fakeCliRunner(logFile))
    settings.value['sandbox.network'] = 'none'
    // il box nasce pulito (creazione con link down e verifica passata)
    await execCommand('agent_x', 'true')
    // da qui la verifica risponde SEMPRE up: nemmeno il link down le abbassa
    setDockerRunnerForTests(fakeCliRunner(logFile, { SANDBOT_TEST_CONTAINER_OPERSTATE: 'up' }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const before = readCliLog(logFile).length
      await expect(execCommand('agent_y', 'echo non-partira')).rejects.toThrow('Non riesco a isolare il computer del bot dalla rete: per sicurezza non l\'ho avviato')
      const after = readCliLog(logFile).slice(before)
      // il box ESISTEVA già (nessun run -d nuovo) e si È RIMOSSO dal ramo del riuso
      expect(after.some((a) => a[0] === 'run' && a.includes('-d'))).toBe(false)
      expect(after.some((a) => a[0] === 'rm' && a.includes('sandbot-box'))).toBe(true)
      // il flusso è andato fino in fondo: verifica → link down → verifica
      expect(after.filter(isOperstateCheck).length, 'la verifica è GIRATA (e rigirata)').toBe(2)
      expect(after.some(isLinkDown), 'il link down è arrivato').toBe(true)
      // MAI un exec del bot: né la home, né il comando
      expect(after.some((a) => a[0] === 'exec' && a.includes('mkdir'))).toBe(false)
      expect(after.some((a) => a[0] === 'exec' && a.includes('echo non-partira'))).toBe(false)
      // una riga nel log del daemon (console.error del daemon → daemon.log)
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/isolament|isolat/i))
    } finally {
      err.mockRestore()
    }
  }, 20_000)

  it('box già GIÙ (nessun riavvio): UNA sola verifica, NESSUN link down, e il comando gira', async () => {
    const logFile = newLog()
    setDockerRunnerForTests(fakeCliRunner(logFile))
    settings.value['sandbox.network'] = 'none'
    await execCommand('agent_x', 'true')
    const before = readCliLog(logFile).length
    const r = await execCommand('agent_y', 'echo di-nuovo')
    expect(r.exitCode).toBe(0)
    const after = readCliLog(logFile).slice(before)
    // il box si riusa COM'ERA: le interfacce sono ancora giù, la verifica
    // passa al primo colpo e il link down NON serve
    expect(after.filter(isOperstateCheck).length, 'UNA sola verifica').toBe(1)
    expect(after.some(isLinkDown), 'NESSUN link down').toBe(false)
    expect(after.some((a) => a[0] === 'run' && a.includes('-d'))).toBe(false)
    expect(after.some((a) => a[0] === 'rm')).toBe(false)
    expect(after.some((a) => a[0] === 'exec' && a.includes('echo di-nuovo'))).toBe(true)
  }, 20_000)

  it('con bridge (Apple), e con Docker in none, NESSUNA verifica in più', async () => {
    // bridge col motore Apple: il riuso del box NON verifica nulla
    const bridgeLog = newLog()
    setDockerRunnerForTests(fakeCliRunner(bridgeLog))
    settings.value['sandbox.network'] = 'bridge'
    await execCommand('agent_x', 'true')
    const bBefore = readCliLog(bridgeLog).length
    const b = await execCommand('agent_y', 'echo in-bridge')
    expect(b.exitCode).toBe(0)
    const bAfter = readCliLog(bridgeLog).slice(bBefore)
    expect(bAfter.some(isOperstateCheck), 'nessuna verifica in bridge').toBe(false)
    expect(bAfter.some(isLinkDown)).toBe(false)
    expect(bAfter.some((a) => a[0] === 'exec' && a.includes('echo in-bridge'))).toBe(true)
    // Docker in none: la rete none è del runtime, già chiusa — NESSUNA verifica
    const dockerLog = newLog()
    setDockerRunnerForTests(fakeCliRunner(dockerLog))
    try {
      settings.value['sandbox.engine'] = 'docker'
      settings.value['sandbox.network'] = 'none'
      await execCommand('agent_x', 'true')
      const dBefore = readCliLog(dockerLog).length
      const d = await execCommand('agent_y', 'echo in-docker')
      expect(d.exitCode).toBe(0)
      const dAfter = readCliLog(dockerLog).slice(dBefore)
      expect(dAfter.some(isOperstateCheck), 'nessuna verifica col motore Docker').toBe(false)
      expect(dAfter.some(isLinkDown)).toBe(false)
      expect(dAfter.some((a) => a[0] === 'exec' && a.includes('echo in-docker'))).toBe(true)
    } finally {
      settings.value['sandbox.engine'] = 'apple-container'
    }
  }, 20_000)
})
