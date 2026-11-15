// BRB1 (fase browser-riavvio-box): il pid file del server MCP del browser
// porta L'AVVIO accanto al pid — "$$ <boot_id>" col boot_id del kernel
// (/proc/sys/kernel/random/boot_id). Il volume /browser SOPRAVVIVE allo stop
// del box e i pid della VM nuova ripartono bassi e ripetibili (dal vivo:
// mcp.pid → 33, SingletonLock → sandbot-box-66): un pid file di un avvio
// PRECEDENTE non deve MAI generare un kill (il gruppo con quel numero, nella
// VM nuova, può essere di un altro processo di pwuser — per esempio il
// browser di un altro bot), e il pid file nel VECCHIO formato (solo il
// numero) conta come avvio SCONOSCIUTO: meglio un orfano mancato, che è già
// morto con la VM, che il gruppo di un altro processo ucciso. Il boot_id del
// box si legge nello STESSO exec della lettura del pid file: un solo exec,
// script COSTANTE, il path come argomento posizionale — mai dati composti
// in una shell. Il runner del box è la CLI FINTA VERA (come
// browser-gateway-reread); la sola lettura pid+boot si intercetta, per
// pilotarne l'uscita. Nessun Docker, nessuna CLI vera, rete solo su
// 127.0.0.1 (il proxy del browser).
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const FAKE_SRC = join(ROOT, 'scripts', 'fake-container.mjs')
const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-browser-restart-test-'))
const FAKE_CLI = join(TMP, 'container')

/** I settings pilotabili dal test (sandbox.*; i figli per il punto BRB2). */
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: (id: string) => (id.startsWith('sub_') ? { parentId: 'agent_padre' } : null)
}))

const { setDockerRunnerForTests } = await import('../../sandbox/index')
const { callBrowserTool, resetBrowserForTests } = await import('../browser')
const { resetBrowserProxyForTests } = await import('../browser-proxy')
const { setBoxNetworkGateway, setBoxNetworkSubnet } = await import('../../sandbox/apple-container-engine')

/** Il log degli argv della CLI finta (una riga JSON per chiamata). */
const readCliLog = (file: string): string[][] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv as string[])

/**
 * Il wrapper ESEGUIBILE della CLI finta: inietta SEMPRE l'env del log nella
 * finta, così nel log finisce ANCHE lo spawn del LAUNCHER MCP (il suo env è
 * quello ripulito del SDK e non lo porterebbe) — un solo log, in ordine.
 * Il path del log è COTTO DENTRO il wrapper: cambia il log, si riscrive.
 */
const writeFakeCli = (logFile: string): void => {
  writeFileSync(FAKE_CLI, [
    '#!/usr/bin/env node',
    `const { spawnSync } = require('node:child_process')`,
    `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_SRC)}, ...process.argv.slice(2)],`,
    `  { env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: ${JSON.stringify(logFile)} }, stdio: 'inherit' })`,
    'process.exit(r.status ?? 1)'
  ].join('\n'))
  chmodSync(FAKE_CLI, 0o755)
}

/** Lo script COSTANTE della lettura pid+boot, come lo manda il daemon. */
const pidBootScriptOf = (a: string[]): string => String(a[a.indexOf('-c') + 1] ?? '')

/**
 * Il runner del box: la CLI FINTA VERA per tutto, TRANNE la lettura pid+boot
 * (l'uscita la decide il test: pid file di un altro avvio, di questo, o nel
 * vecchio formato). Conta gli argv che passano.
 */
/** L'uscita del network inspect nella FORMA VERA, col gateway ascoltabile dei test. */
const netJson = (): string =>
  JSON.stringify([{
    configuration: { creationDate: '2026-11-14T07:30:36Z', labels: {}, mode: 'hostOnly', name: 'homun-box', options: {}, plugin: 'container-network-vmnet' },
    id: 'homun-box',
    status: { ipv4Gateway: '127.0.0.1', ipv4Subnet: '127.0.0.0/8', ipv6Subnet: 'fdcb:b3be:434:c533::/64' }
  }])

function runner(logFile: string, pidBootOut: () => string, calls: string[][]) {
  return async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: null }> => {
    calls.push(argv)
    if (argv[0] === 'network' && argv[1] === 'inspect') {
      return { stdout: netJson(), stderr: '', exitCode: 0, signal: null }
    }
    if (pidBootScriptOf(argv).includes('/proc/sys/kernel/random/boot_id')) {
      return { stdout: pidBootOut(), stderr: '', exitCode: 0, signal: null }
    }
    const r = spawnSync(process.execPath, [FAKE_SRC, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status, signal: null }
  }
}

beforeAll(() => {
  settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container', 'sandbox.network': 'bridge' }
  // il launcher MCP passa dalla CLI finta: SANDBOT_TEST_USER_DATA +
  // SANDBOT_TEST_CONTAINER_CLI vincono su HOMUN_CONTAINER_PATH (containerCliPath)
  process.env.SANDBOT_TEST_USER_DATA = TMP
  process.env.SANDBOT_TEST_CONTAINER_CLI = FAKE_CLI
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
  delete process.env.SANDBOT_TEST_USER_DATA
  delete process.env.SANDBOT_TEST_CONTAINER_CLI
  rmSync(TMP, { recursive: true, force: true })
})

/** Il browser_open del test: il launcher FINTO chiude subito la connessione → l'esito è l'errore, non il catalogo. */
const openBrowser = async (agent: string): Promise<string> =>
  callBrowserTool(agent, 'browser_open', { url: 'https://example.com/' }).then(
    () => 'ok',
    (e: unknown) => `err: ${e instanceof Error ? e.message : String(e)}`
  )

let seq = 0

describe('BRB1: il pid file porta l\'avvio — il kill dell\'orfano parte SOLO col boot di adesso', () => {
  it('il parse puro del pid file: "<pgid> <boot_id>" → {pgid, bootId}; il NUMERO da solo → avvio SCONOSCIUTO; vuoto o spazzatura → NESSUN kill', async () => {
    const { parseBrowserPidFile } = await import('../shells')
    expect(parseBrowserPidFile('33 7f05a2b1-1111-4222-8333-444455556666\n')).toEqual({ ok: true, pgid: 33, bootId: '7f05a2b1-1111-4222-8333-444455556666' })
    expect(parseBrowserPidFile(' 7 x-boot-2 ')).toEqual({ ok: true, pgid: 7, bootId: 'x-boot-2' })
    // il VECCHIO formato (solo il numero): avvio SCONOSCIUTO, ma il pid è valido
    expect(parseBrowserPidFile('33\n')).toEqual({ ok: true, pgid: 33, bootId: null })
    expect(parseBrowserPidFile('33')).toEqual({ ok: true, pgid: 33, bootId: null })
    for (const bad of ['', null, 'x-y', '-5', '33 7 8']) {
      expect(parseBrowserPidFile(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: expect.stringContaining('no kill') })
    }
  })

  it('il parse puro della lettura pid+boot (UN exec): l\'ultima riga è «boot <id>», sopra il pid file (assente → solo il boot; boot illeggibile → sconosciuto)', async () => {
    const { parsePidBootRead } = await import('../shells')
    expect(parsePidBootRead('33 7f05\nboot 7f05\n')).toEqual({ pidRaw: '33 7f05', bootId: '7f05' })
    expect(parsePidBootRead('boot 7f05\n')).toEqual({ pidRaw: null, bootId: '7f05' })
    expect(parsePidBootRead('33 7f05\nboot \n')).toEqual({ pidRaw: '33 7f05', bootId: null })
    expect(parsePidBootRead('33 7f05\n')).toEqual({ pidRaw: null, bootId: null })
    expect(parsePidBootRead('')).toEqual({ pidRaw: null, bootId: null })
  })

  it('i wrapper SCRIVONO "$$ <boot_id>" (browser, desktop e vnc-control) e la lettura pid+boot è UN exec con lo script COSTANTE, il path come $1', async () => {
    const d = await import('../../sandbox/docker-argv')
    const write = 'echo "$$ $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" >"$1"'
    expect(d.DOCKER_BROWSER_WRAPPER_SH).toContain(write)
    expect(d.DOCKER_BROWSER_DESKTOP_WRAPPER_SH).toContain(write)
    expect(d.DOCKER_SCREEN_CONTROL_VNC_SH).toContain('echo "$$ $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" >./vnc-control.pid')
    // lo script COSTANTE della lettura: il pid file come $1, il boot_id del box
    expect(d.DOCKER_BROWSER_PID_BOOT_SH).toContain('if [ -f "$1" ]; then cat "$1"; fi')
    expect(d.DOCKER_BROWSER_PID_BOOT_SH).toContain("printf 'boot %s\\n' \"$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)\"")
    // argv puri: come 1001 (il pid file sta nella cartella 0700 di pwuser),
    // -w /browser (esiste sempre), script costante e il path come argomento posizionale
    expect(d.dockerBrowserPidBootReadArgv('sandbot-box', '/browser/agent_x/mcp.pid')).toEqual([
      'exec', '-i', '-u', '1001:1001', '-w', '/browser', 'sandbot-box',
      'sh', '-c', d.DOCKER_BROWSER_PID_BOOT_SH, 'sh', '/browser/agent_x/mcp.pid'
    ])
  })

  it('pid file con un boot_id DIVERSO da quello di adesso → NESSUN argv di kill (il volume sopravvive allo stop: il gruppo 33 può essere di un altro processo)', async () => {
    const logFile = join(TMP, `cli-brb1-div-${++seq}.jsonl`)
    writeFakeCli(logFile)
    const calls: string[][] = []
    setDockerRunnerForTests(runner(logFile, () => '33 boot-della-scora-scorsa\nboot boot-di-adesso\n', calls))
    const out = await openBrowser('agent_brba')
    expect(out).toMatch(/^err:/)
    // la lettura è UN exec solo (lo script pid+boot), MAI un cat a parte del pid file
    expect(calls.some((a) => pidBootScriptOf(a).includes('/proc/sys/kernel/random/boot_id'))).toBe(true)
    expect(calls.some((a) => a.includes('cat') && a.includes('/browser/agent_brba/mcp.pid'))).toBe(false)
    // NESSUN kill, di nessun segnale, sul gruppo del pid file vecchio
    expect(calls.some((a) => a.includes('kill'))).toBe(false)
    // e il flusso è arrivato fino al launcher (lo spawn della CLI finta sta nel log)
    expect(readCliLog(logFile).some((a) => pidBootScriptOf(a).includes('exec playwright-mcp'))).toBe(true)
  }, 60_000)

  it('pid file con lo STESSO boot_id di adesso → il kill di OGGI (TERM al GRUPPO come 1001)', async () => {
    const logFile = join(TMP, `cli-brb1-stesso-${++seq}.jsonl`)
    writeFakeCli(logFile)
    const calls: string[][] = []
    setDockerRunnerForTests(runner(logFile, () => '33 boot-di-adesso\nboot boot-di-adesso\n', calls))
    const out = await openBrowser('agent_brba')
    expect(out).toMatch(/^err:/)
    const kills = calls.filter((a) => a.includes('kill'))
    expect(kills.length).toBeGreaterThanOrEqual(1)
    expect(kills[0]).toEqual(['exec', '-u', '1001:1001', 'sandbot-box', 'kill', '-TERM', '--', '-33'])
  }, 60_000)

  it('pid file nel VECCHIO formato (solo il numero) → avvio SCONOSCIUTO: NESSUN kill', async () => {
    const logFile = join(TMP, `cli-brb1-vecchio-${++seq}.jsonl`)
    writeFakeCli(logFile)
    const calls: string[][] = []
    setDockerRunnerForTests(runner(logFile, () => '33\nboot boot-di-adesso\n', calls))
    const out = await openBrowser('agent_brba')
    expect(out).toMatch(/^err:/)
    expect(calls.some((a) => a.includes('kill'))).toBe(false)
  }, 60_000)
})
