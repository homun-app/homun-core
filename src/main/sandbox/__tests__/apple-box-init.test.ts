// Fase box-apple-cli-vera (BAV4): il box nasce con --init. La help VERA
// della CLI 1.7.1 (run-help.txt) lo dichiara: «Run an init process inside
// the container that forwards signals and reaps processes» — la stessa
// ragione di G2 per Docker: PID 1 raccoglie gli zombie dei comandi in
// background. Il box nato senza (useInit:false, come quello creato dal vivo
// il 2026-11-14) si ricrea UNA volta, con la ragione 'senza-init' nel log.
// VISTO FALLIRE: l'argv non portava --init (il test vecchio pretendeva
// proprio che NON ci fosse).
import { describe, expect, it, afterAll, afterEach, vi } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const FAKE = join(ROOT, 'scripts', 'fake-container.mjs')
const FIXTURES = join(import.meta.dirname, 'fixtures', 'container-1.7.1')
const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-apple-box-init-test-'))

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: () => null
}))

const { appleBoxRunArgv } = await import('../apple-container-argv')
const { appleContainerEngine } = await import('../apple-container-engine')
const { boxEnsurePlan, DEFAULT_BOX_LIMITS, BOX_VOLUME, BOX_CONTAINER } = await import('../docker-argv')
const { boxImage, execCommand, setDockerRunnerForTests } = await import('../index')

const fixture = (name: string): string => {
  const text = readFileSync(join(FIXTURES, name), 'utf8')
  return text.replace(/^\$ container[^\n]*\n/, '').replace(/\[exit \d+\]\n?$/, '').trim()
}

describe('BAV4: il box nasce con --init', () => {
  it('appleBoxRunArgv porta --init (la help vera della 1.7.1 lo dichiara)', () => {
    const argv = appleBoxRunArgv(BOX_CONTAINER, BOX_VOLUME, 'bridge', DEFAULT_BOX_LIMITS, 'sandbot-box:abc')
    expect(argv).toContain('--init')
    expect(argv.slice(0, 3)).toEqual(['run', '-d', '--init'])
  })

  it('il piano: inspect con useInit FALSE (il box del vivo) → recreate senza-init; con TRUE → use', () => {
    const reads = appleContainerEngine.reads!
    const opts = { expectedImage: 'sandbot-box:abab9640c765', imageKnown: true, networkName: 'homun-box' }
    // la fixture inspect-box è il box VERO del vivo: nato SENZA --init
    const senzaInit = reads.boxFacts(fixture('inspect-box.txt'), opts)!
    expect(senzaInit.initOk).toBe(false)
    expect(boxEnsurePlan({ exists: true, initOk: senzaInit.initOk })).toEqual({ kind: 'recreate', reason: 'senza-init' })
    // lo stesso inspect con useInit true: il box si USA (tutto il resto a posto)
    const conInit = reads.boxFacts(fixture('inspect-box.txt').replace('"useInit" : false', '"useInit" : true'), opts)!
    expect(conInit.initOk).toBe(true)
    expect(boxEnsurePlan({
      exists: true,
      initOk: conInit.initOk,
      imageOk: conInit.imageOk,
      pluginsMountOk: conInit.pluginsMountOk,
      browserMountOk: conInit.browserMountOk,
      networkOk: conInit.networkOk,
      writable: true
    })).toEqual({ kind: 'use' })
  })
})

// ---- l'ensure integrale: il box VECCHIO senza --init si ricrea UNA volta ----
const readCliLog = (file: string): string[][] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv as string[])

describe('BAV4: il box nato senza --init si ricrea UNA volta (ragione nel log), poi si RIUSA', () => {
  it('run -d senza --init nel log → il comando del bot lo RICREA con --init (una riga senza-init), il giro dopo lo riusa', async () => {
    const logFile = join(TMP, 'cli-senza-init.jsonl')
    // il mondo del vivo: un box già nato SENZA --init (l'argv di prima della
    // fase), con l'immagine GIUSTA e i volumi già presenti
    const natoSenzaInit = appleBoxRunArgv(BOX_CONTAINER, BOX_VOLUME, 'bridge', DEFAULT_BOX_LIMITS, boxImage()).filter((t) => t !== '--init')
    const seed = (argv: string[]) =>
      spawnSync(process.execPath, [FAKE, ...argv], {
        encoding: 'utf8',
        env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
      })
    seed(['build', '-t', boxImage(), '.'])
    seed(['volume', 'create', 'sandbot-box'])
    seed(['volume', 'create', 'sandbot-plugins'])
    seed(['volume', 'create', 'sandbot-browser'])
    expect(seed(natoSenzaInit).status).toBe(0)

    const runner = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: null }> => {
      const r = seed(argv)
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status, signal: null }
    }
    settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container', 'sandbox.network': 'bridge' }
    setDockerRunnerForTests(runner)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const seededAt = readCliLog(logFile).length
      const primo = await execCommand('agent_x', 'echo uno')
      expect(primo.exitCode).toBe(0)
      const dopoIlPrimo = readCliLog(logFile).slice(seededAt)
      // il box vecchio è STATO ricreato: rm del container e UN nuovo run -d
      // COL --init, con la ragione nel log del daemon (N1)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('ricreazione del container sandbot-box: senza-init'))
      expect(dopoIlPrimo.some((a) => a[0] === 'rm' && a.includes('sandbot-box'))).toBe(true)
      const rinato = dopoIlPrimo.find((a) => a[0] === 'run' && a.includes('-d'))!
      expect(rinato).toContain('--init')
      // NESSUN volume create nella ricreazione (BAV3): i volumi restano
      expect(dopoIlPrimo.some((a) => a[0] === 'volume' && a[1] === 'create')).toBe(false)

      // il giro DOPO: il box nato CON --init si RIUSA (nessun rm, nessun run)
      const before = readCliLog(logFile).length
      const secondo = await execCommand('agent_y', 'echo due')
      expect(secondo.exitCode).toBe(0)
      const dopoIlSecondo = readCliLog(logFile).slice(before)
      expect(dopoIlSecondo.some((a) => a[0] === 'rm')).toBe(false)
      expect(dopoIlSecondo.some((a) => a[0] === 'run' && a.includes('-d'))).toBe(false)
      expect(dopoIlSecondo.some((a) => a[0] === 'exec' && a.includes('echo due'))).toBe(true)
    } finally {
      err.mockRestore()
    }
  }, 20_000)
})

afterEach(() => {
  setDockerRunnerForTests(null)
})
afterAll(() => {
  settings.value = {}
  rmSync(TMP, { recursive: true, force: true })
})
