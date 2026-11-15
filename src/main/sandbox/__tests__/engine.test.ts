// Fase box-container (BX1): UN motore del box, DUE implementazioni.
// Le parti PURE della scelta del motore e degli stati del motore Apple, la
// migrazione di sandbox.mode ('docker' storico letto come 'box') e la regola
// del modulo: NESSUN resolveTool('docker') fuori dal modulo del motore Docker
// (ricerca nel sorgente, come le guardie N1/D4).
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(import.meta.dirname, '..', '..', '..')

/** I fatti della macchina per la scelta del motore (tutti iniettabili). */
const facts = (over: Partial<import('../engine').BoxEngineFacts> = {}): import('../engine').BoxEngineFacts => ({
  platform: 'darwin',
  arch: 'arm64',
  macOsMajor: 26,
  containerInstalled: true,
  containerServiceRunning: true,
  containerKernelOk: true,
  dockerInstalled: true,
  dockerResponds: true,
  ...over
})

// sandbox.mode pilotabile (la migrazione 'docker' → 'box' si prova SENZA store)
const mode = vi.hoisted(() => ({ value: 'host' as string }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key === 'sandbox.mode' ? mode.value : fallback),
  dataDir: () => '/tmp/sandbot-engine-test'
}))

const { selectBoxEngine, appleContainerState, macOsMajorFromDarwin, activeBoxEngine, setActiveEngineForTests, dockerEngine, appleContainerEngine } = await import('../engine')
import type { BoxEngineArgv } from '../engine'
const { sandboxMode } = await import('../index')

describe('BX1: la scelta del motore (selectBoxEngine, pura)', () => {
  it('auto: macOS 26 arm64 con container pronto → apple-container', () => {
    expect(selectBoxEngine('auto', facts())).toBe('apple-container')
  })

  it('auto: macOS 15 (darwin 24) → docker se risponde, MAI apple', () => {
    expect(selectBoxEngine('auto', facts({ macOsMajor: 15 }))).toBe('docker')
  })

  it('auto: Mac Intel (x64) → docker: container vuole il chip Apple', () => {
    expect(selectBoxEngine('auto', facts({ arch: 'x64' }))).toBe('docker')
  })

  it('auto: container non installato → docker se risponde', () => {
    expect(selectBoxEngine('auto', facts({ containerInstalled: false }))).toBe('docker')
  })

  it('auto: container installato ma servizio spento → docker se risponde', () => {
    expect(selectBoxEngine('auto', facts({ containerServiceRunning: false }))).toBe('docker')
  })

  it('auto: kernel mancante → NON pronto: docker se risponde (il kernel si installa solo col consenso)', () => {
    expect(selectBoxEngine('auto', facts({ containerKernelOk: false }))).toBe('docker')
  })

  it('auto: niente container e Docker non risponde → NESSUN motore (si resta in host)', () => {
    expect(selectBoxEngine('auto', facts({ containerInstalled: false, dockerResponds: false, dockerInstalled: false }))).toBeNull()
  })

  it('auto: docker installato ma SPENTO (non risponde) → nessun motore', () => {
    expect(selectBoxEngine('auto', facts({ containerInstalled: false, dockerResponds: false }))).toBeNull()
  })

  it('docker esplicito → docker SEMPRE (è il motore di riserva scelto dall\'utente)', () => {
    expect(selectBoxEngine('docker', facts())).toBe('docker')
    expect(selectBoxEngine('docker', facts({ dockerInstalled: false, dockerResponds: false }))).toBe('docker')
  })

  it('apple-container esplicito e USABILE → apple-container', () => {
    expect(selectBoxEngine('apple-container', facts())).toBe('apple-container')
  })

  it('apple-container esplicito ma NON installato → null (l\'utente lo vede dallo stato, si resta in host)', () => {
    expect(selectBoxEngine('apple-container', facts({ containerInstalled: false }))).toBeNull()
  })

  it('apple-container esplicito ma macOS < 26 → null (unsupported)', () => {
    expect(selectBoxEngine('apple-container', facts({ macOsMajor: 15 }))).toBeNull()
  })
})

describe('BX1: gli stati del motore Apple (appleContainerState, pura)', () => {
  it('macOS 15 o Intel → unsupported', () => {
    expect(appleContainerState(facts({ macOsMajor: 15 }))).toBe('unsupported')
    expect(appleContainerState(facts({ arch: 'x64' }))).toBe('unsupported')
    expect(appleContainerState(facts({ platform: 'linux' }))).toBe('unsupported')
  })

  it('CLI assente → not-installed', () => {
    expect(appleContainerState(facts({ containerInstalled: false }))).toBe('not-installed')
  })

  it('servizio spento → stopped', () => {
    expect(appleContainerState(facts({ containerServiceRunning: false }))).toBe('stopped')
  })

  it('kernel mancante → kernel-missing (chiede il consenso, MAI download nascosto)', () => {
    expect(appleContainerState(facts({ containerKernelOk: false }))).toBe('kernel-missing')
  })

  it('tutto a posto → ready', () => {
    expect(appleContainerState(facts())).toBe('ready')
  })

  it('l\'ordine dei controlli: unsupported prima di not-installed (un Intel senza CLI resta unsupported)', () => {
    expect(appleContainerState(facts({ arch: 'x64', containerInstalled: false }))).toBe('unsupported')
  })
})

describe('BX1: la versione di macOS da os.release() (macOsMajorFromDarwin, pura)', () => {
  it('darwin 24 → macOS 15 (numerazione vecchia: major − 9)', () => {
    expect(macOsMajorFromDarwin('24.5.0')).toBe(15)
    expect(macOsMajorFromDarwin('23.0.0')).toBe(14)
  })

  it('darwin 25 → macOS 26 (la numerazione a anno: Tahoe); darwin 27 → 28', () => {
    expect(macOsMajorFromDarwin('25.0.0')).toBe(26)
    expect(macOsMajorFromDarwin('27.0.0')).toBe(28)
  })

  it('output assurdo → 0 (mai NaN: il confronto ≥ 26 resta falso)', () => {
    expect(macOsMajorFromDarwin('')).toBe(0)
    expect(macOsMajorFromDarwin('pippo')).toBe(0)
    // la numerazione a anno è una regola (darwin N → macOS N+1), non una
    // tabella: un darwin futuro prosegue la serie
    expect(macOsMajorFromDarwin('99')).toBe(100)
  })
})

describe('BX1: sandbox.mode — il valore storico \'docker\' si legge come \'box\'', () => {
  it('\'docker\' salvato dalle versioni precedenti → \'box\' (migrazione in lettura)', () => {
    mode.value = 'docker'
    expect(sandboxMode()).toBe('box')
  })

  it('\'box\' → \'box\', qualunque altro valore → \'host\'', () => {
    mode.value = 'box'
    expect(sandboxMode()).toBe('box')
    mode.value = 'host'
    expect(sandboxMode()).toBe('host')
  })
})

describe('BX1: il motore attivo (activeBoxEngine) e i due moduli motore', () => {
  it('il motore Docker delega OGNI argv alle funzioni di oggi: stesso contenuto byte per byte', async () => {
    const a = dockerEngine.argv
    const d = await import('../docker-argv')
    expect(a.exec('c', 'echo', { workdir: '/w' })).toEqual(d.dockerExecArgv('c', 'echo', { workdir: '/w' }))
    expect(a.boxCreate('c', 'v', 'bridge', d.DEFAULT_BOX_LIMITS, 'img')).toEqual(d.dockerBoxCreateArgv('c', 'v', 'bridge', d.DEFAULT_BOX_LIMITS, 'img'))
    expect(a.terminal('own')).toEqual(d.dockerTerminalArgv('own'))
    expect(a.browserMcp('ag', 8085)).toEqual(d.dockerBrowserMcpArgv('ag', 8085))
    // OBD3: la build chiede --progress plain ESPLICITO — Docker col =
    expect(a.build('t', '/df', '/ctx')).toEqual(d.dockerBuildArgv('t', '/df', '/ctx'))
    expect(a.build('t', '/df', '/ctx')).toEqual(['build', '--progress=plain', '-t', 't', '-f', '/df', '/ctx'])
  })

  it('i due motori hanno id diversi e argv per TUTTE le operazioni dell\'interfaccia', () => {
    expect(dockerEngine.id).toBe('docker')
    expect(appleContainerEngine.id).toBe('apple-container')
    for (const e of [dockerEngine, appleContainerEngine]) {
      expect(typeof e.command()).toBe('string')
      expect(typeof e.childEnv({ PATH: '/x' })).toBe('object')
      const missing = ['exec', 'boxCreate', 'cpFromBox', 'df', 'pruneSafe', 'removeImage', 'removeVolumes', 'terminal', 'browserMcp', 'screenBridge', 'build', 'volumeLs'].filter(
        (op) => typeof e.argv[op as keyof BoxEngineArgv] !== 'function'
      )
      expect(missing).toEqual([])
    }
  })

  it('auto non ancora sondato → il motore di DEFAULT è docker (comportamento di oggi)', () => {
    setActiveEngineForTests(null)
    expect(activeBoxEngine().id).toBe('docker')
  })

  it('la sonda dell\'auto può fissare apple-container e poi tornare', () => {
    setActiveEngineForTests('apple-container')
    expect(activeBoxEngine().id).toBe('apple-container')
    setActiveEngineForTests(null)
    expect(activeBoxEngine().id).toBe('docker')
  })
})

describe('BX1: la regola del modulo — resolveTool(\'docker\') SOLO nel motore Docker', () => {
  /** Tutti i file .ts/.tsx del src (senza test), ricorsivo. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue
        sourceFiles(p, out)
      } else if (/\.(ts|tsx|mts|mjs)$/.test(name)) {
        out.push(p)
      }
    }
    return out
  }

  it('nessuna chiamata resolveTool(\'docker\') fuori da src/main/sandbox/docker-engine.ts', () => {
    const offenders: string[] = []
    for (const f of sourceFiles(SRC)) {
      const rel = f.slice(SRC.length + 1)
      if (rel === join('main', 'sandbox', 'docker-engine.ts')) continue
      if (readFileSync(f, 'utf8').includes("resolveTool('docker')")) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})

// ---- OBV1 (fase onboarding-b-dal-vivo): la sonda legge i formati VERI e il kernel dal FILE ----
import { TEST_TMP_BASE } from '../../../test-tmp'
import {
  NEUTRAL_APP_ROOT, SYSTEM_STATUS_JSON, SYSTEM_STATUS_TABLE,
  KERNEL_LINK_NAME, KERNEL_TARGET_NAME
} from './system-status-fixtures'

const { probeBoxEngineFacts, engineProbeDeps, appleKernelFileOk } = await import('../engine')

describe('OBV1: la sonda dei fatti — PRIMA il JSON, poi la tabella; il kernel dal FILE', () => {
  const realRunCli = engineProbeDeps.runCli
  const realStatFile = engineProbeDeps.statFile
  const KERNEL_TARGET_BYTES_SAFE = 30_564_864
  const asked: string[] = []

  // CB2 (fase ci-beta5): la sonda legge la MACCHINA se non la si fissa — sul
  // Mac di sviluppo (macOS 26) questi test passavano per caso, sulla CI
  // (macos-15) l'Apple motore sarebbe «unsupported» e i rossi erano sette.
  // La macchina descritta è FISSA (darwin, arm64, macOS 26) e ripristinata:
  // MAI la versione vera del Mac che gira i test.
  beforeEach(() => {
    vi.stubEnv('SANDBOT_TEST_FAKE_PLATFORM', 'darwin')
    vi.stubEnv('SANDBOT_TEST_FAKE_ARCH', 'arm64')
    vi.stubEnv('SANDBOT_TEST_FAKE_MACOS_MAJOR', '26')
  })

  /** la CLI finta della sonda: --version ok, gli status come decisi dal test */
  const stubCli = (answers: { json?: string; jsonExit?: number; table?: string; tableExit?: number }): void => {
    engineProbeDeps.runCli = (async (_file: string, argv: string[]) => {
      asked.push(argv.join(' '))
      if (argv[0] === '--version') return { stdout: 'container version 1.7.1 (fake)', stderr: '', exitCode: 0 }
      if (argv.join(' ') === 'system status --format json') return { stdout: answers.json ?? '', stderr: '', exitCode: answers.jsonExit ?? 0 }
      if (argv.join(' ') === 'system status') return { stdout: answers.table ?? '', stderr: '', exitCode: answers.tableExit ?? 0 }
      return { stdout: '', stderr: `unsupported: ${argv.join(' ')}`, exitCode: 1 }
    }) as typeof realRunCli
  }

  /** la lettura del file del kernel: presente (file non vuoto) o assente */
  const stubKernel = (present: boolean): void => {
    engineProbeDeps.statFile = ((p: string) =>
      present && p === join(NEUTRAL_APP_ROOT, 'kernels', KERNEL_LINK_NAME) ? { isFile: true, size: KERNEL_TARGET_BYTES_SAFE } : null
    ) as typeof realStatFile
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    engineProbeDeps.runCli = realRunCli
    engineProbeDeps.statFile = realStatFile
    asked.length = 0
  })

  it('il JSON vero → running, kernel dal file → appleContainerState ready (PRIMA diceva «stopped» col servizio acceso)', async () => {
    stubCli({ json: SYSTEM_STATUS_JSON })
    stubKernel(true)
    const f = await probeBoxEngineFacts()
    expect(f.containerInstalled).toBe(true)
    expect(f.containerServiceRunning).toBe(true)
    expect(f.containerKernelOk).toBe(true)
    expect(appleContainerState(f)).toBe('ready')
    // lo status si è chiesto in JSON, per primo
    expect(asked.filter((a) => a.startsWith('system status'))[0]).toBe('system status --format json')
  })

  it('JSON non valido → si prova la TABELLA vera → running (prima la tabella dava SEMPRE false)', async () => {
    stubCli({ json: 'uniframe non json', jsonExit: 0, table: SYSTEM_STATUS_TABLE })
    stubKernel(true)
    const f = await probeBoxEngineFacts()
    expect(f.containerServiceRunning).toBe(true)
    expect(f.containerKernelOk).toBe(true)
    expect(appleContainerState(f)).toBe('ready')
    expect(asked.filter((a) => a.startsWith('system status'))).toEqual(['system status --format json', 'system status'])
  })

  it('il flag --format json rifiutato (exit ≠ 0) → la tabella vera risponde lo stesso', async () => {
    stubCli({ jsonExit: 1, table: SYSTEM_STATUS_TABLE })
    stubKernel(true)
    const f = await probeBoxEngineFacts()
    expect(f.containerServiceRunning).toBe(true)
    expect(appleContainerState(f)).toBe('ready')
  })

  it('il kernel ASSENTE (il file non c\'è) → kernel-missing col servizio ACCESO (prima «ok» per euristiche sul testo)', async () => {
    stubCli({ json: SYSTEM_STATUS_JSON })
    stubKernel(false)
    const f = await probeBoxEngineFacts()
    expect(f.containerServiceRunning).toBe(true)
    expect(f.containerKernelOk).toBe(false)
    expect(appleContainerState(f)).toBe('kernel-missing')
  })

  it('servizio SPENTO (status stopped) → stopped: il kernel non decide più niente', async () => {
    stubCli({ json: SYSTEM_STATUS_JSON.replace('"status":"running"', '"status":"stopped"') })
    stubKernel(true)
    const f = await probeBoxEngineFacts()
    expect(f.containerServiceRunning).toBe(false)
    expect(appleContainerState(f)).toBe('stopped')
  })

  it('uscita VUOTA da entrambi i formati → fermo: né servizio né kernel (mai ottimisti)', async () => {
    stubCli({})
    stubKernel(true)
    const f = await probeBoxEngineFacts()
    expect(f.containerInstalled).toBe(true)
    expect(f.containerServiceRunning).toBe(false)
    expect(f.containerKernelOk).toBe(false)
  })

  it('CB2 (fase ci-beta5): macOS 15 FINTO con la CLI pronta → unsupported — è ciò che vede la CI (macos-15) ed è giusto così', async () => {
    // il beforeEach fissa macOS 26: QUI si finge 15, come il runner della CI.
    // La CLI risponde a tutto (installata, servizio acceso, kernel ok), ma la
    // MACCHINA non regge il motore Apple: lo stato in parole è unsupported
    stubCli({ json: SYSTEM_STATUS_JSON })
    stubKernel(true)
    vi.stubEnv('SANDBOT_TEST_FAKE_MACOS_MAJOR', '15')
    const f = await probeBoxEngineFacts()
    expect(f.containerInstalled).toBe(true)
    expect(f.containerServiceRunning).toBe(true)
    expect(f.containerKernelOk).toBe(true)
    expect(f.macOsMajor).toBe(15)
    expect(appleContainerState(f)).toBe('unsupported')
  })
})

describe('OBV1: appleKernelFileOk — il kernel è un FILE vero, seguito il symlink', () => {
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-obv1-kernel-'))
  const kernels = join(dir, 'kernels')
  beforeAll(() => {
    mkdirSync(kernels)
    writeFileSync(join(kernels, KERNEL_TARGET_NAME), Buffer.alloc(1_024))
    symlinkSync(KERNEL_TARGET_NAME, join(kernels, KERNEL_LINK_NAME))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('symlink → file NON vuoto → ok: è il layout vero di Apple dopo kernel set --recommended', () => {
    expect(appleKernelFileOk(dir, 'arm64')).toBe(true)
  })

  it('bersaglio VUOTO → no; symlink APPESO → no; nome di un\'altra architettura → no', () => {
    const other = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-obv1-kernel-b-'))
    try {
      mkdirSync(join(other, 'kernels'))
      writeFileSync(join(other, 'kernels', KERNEL_TARGET_NAME), Buffer.alloc(0)) // vuoto
      symlinkSync(KERNEL_TARGET_NAME, join(other, 'kernels', KERNEL_LINK_NAME))
      expect(appleKernelFileOk(other, 'arm64')).toBe(false)
      symlinkSync('bersaglio-che-non-esiste', join(other, 'kernels', 'default.kernel-x86_64'))
      expect(appleKernelFileOk(other, 'x86_64')).toBe(false) // symlink appeso
      expect(appleKernelFileOk(dir, 'x86_64')).toBe(false) // in dir c'è solo arm64
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('senza appRoot o senza arch → no (il kernel è SCONOSCIUTO, mai ottimista)', () => {
    expect(appleKernelFileOk(null, 'arm64')).toBe(false)
    expect(appleKernelFileOk(dir, null)).toBe(false)
    expect(appleKernelFileOk(null, null)).toBe(false)
  })
})
