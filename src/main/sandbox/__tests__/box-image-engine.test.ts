// OBV3 (fase onboarding-b-dal-vivo): l'immagine del box della PREPARAZIONE
// si costruisce SOLO col motore Apple, quello ESPlicitO — mai passando da
// activeBoxEngine() e dalla sua CACHE (che all'avvio, quando container non
// c'era ancora, diceva docker: dal vivo la build è caduta con «Cannot
// connect to the Docker daemon»). Il runner del modulo riceve il motore:
// qui si registra e si guarda con QUALE comando si sarebbe spawnato.
import { describe, expect, it, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

/** La cartella dati del test (reale: la build guarda lo spazio libero vero). */
const DATA_DIR = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-box-image-engine-'))

/** I settings pilotabili dal test (nessuno serve: la build non li legge). */
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => DATA_DIR,
  getAgent: () => null
}))

const { ensureBoxImage, setDockerRunnerForTests } = await import('../index')
const { setActiveEngineForTests, appleContainerEngine, dockerEngine } = await import('../engine')
import type { BoxEngine } from '../engine'
import type { BuildProgress } from '../build-progress'

afterEach(() => {
  setDockerRunnerForTests(null)
  setActiveEngineForTests(null)
})
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }))

describe('OBV3: ensureBoxImage col motore ESPlicitO (mai la cache dell\'auto)', () => {
  it('cache dell\'auto su Docker e motore Apple passato esplicito → la build parte col motore APPLE', async () => {
    // la sonda dell'avvio aveva fissato docker nella cache dell'auto (il
    // difetto del vivo): la preparazione passa apple-container e la build
    // NON deve guardare la cache
    setActiveEngineForTests('docker')
    const runs: { engine?: BoxEngine; argv: string[] }[] = []
    setDockerRunnerForTests((async (argv: string[], _opts: unknown, engine?: BoxEngine) => {
      runs.push({ engine, argv })
      // l'immagine non c'è → si parte per la build (che qui riesce subito)
      if (argv[0] === 'image' && argv[1] === 'inspect') return { stdout: '', stderr: 'not found', exitCode: 1, signal: null }
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    }) as unknown as Parameters<typeof setDockerRunnerForTests>[0])
    const ok = await ensureBoxImage(appleContainerEngine)
    expect(ok).toBe(true)
    const build = runs.find((r) => r.argv[0] === 'build')
    expect(build, `argv visti: ${JSON.stringify(runs.map((r) => r.argv))}`).toBeTruthy()
    expect(build!.engine?.id).toBe('apple-container') // APPLE, non la cache
  })

  it('senza motore esplicito resta il comportamento di oggi: il motore ATTIVO (cache dell\'auto)', async () => {
    setActiveEngineForTests('docker')
    const runs: { engine?: BoxEngine; argv: string[] }[] = []
    setDockerRunnerForTests((async (argv: string[], _opts: unknown, engine?: BoxEngine) => {
      runs.push({ engine, argv })
      if (argv[0] === 'image' && argv[1] === 'inspect') return { stdout: '', stderr: 'not found', exitCode: 1, signal: null }
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    }) as unknown as Parameters<typeof setDockerRunnerForTests>[0])
    await ensureBoxImage()
    const build = runs.find((r) => r.argv[0] === 'build')
    expect(build!.engine?.id).toBe('docker')
    expect(build!.engine).toBe(dockerEngine)
  })
})

// ---- OBD4c: il single-flight è PER MOTORE ----

describe('OBD4c: una richiesta con ALTRO motore aspetta la build in corso, poi parte col SUO', () => {
  it('build docker in corso, richiesta apple → DUE build, la seconda col motore APPLE', async () => {
    setActiveEngineForTests('docker')
    const enginesOf: Array<string | undefined> = []
    const releases: Array<() => void> = []
    setDockerRunnerForTests((async (argv: string[], opts: { onStderrLine?: (l: string) => void } | undefined, engine?: BoxEngine) => {
      if (argv[0] === 'image' && argv[1] === 'inspect') return { stdout: '', stderr: 'not found', exitCode: 1, signal: null }
      if (argv[0] === 'build') {
        enginesOf.push(engine?.id)
        await new Promise<void>((r) => releases.push(r))
        opts?.onStderrLine?.('#8 exporting to oci image format')
        return { stdout: '', stderr: '', exitCode: 0, signal: null }
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    }) as unknown as Parameters<typeof setDockerRunnerForTests>[0])
    const pDocker = ensureBoxImage(dockerEngine)
    for (let i = 0; i < 100 && enginesOf.length < 1; i++) await new Promise((r) => setTimeout(r, 20))
    expect(enginesOf).toEqual(['docker'])
    // la richiesta con ALTRO motore: NON si aggancia alla build docker —
    // aspetta che finisca e poi parte COL SUO motore
    const pApple = ensureBoxImage(appleContainerEngine)
    releases.shift()?.()
    expect(await pDocker).toBe(true)
    for (let i = 0; i < 100 && enginesOf.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    expect(enginesOf).toEqual(['docker', 'apple-container'])
    releases.shift()?.()
    expect(await pApple).toBe(true)
  })
})

// ---- OBD3 (fase onboarding-b-dettagli): il build condivide gli aggiornamenti ----

describe('OBD3: chi si aggancia a un build già in corso riceve gli aggiornamenti (elenco di ascoltatori)', () => {
  it('un SECONDO chiamante della STESSA build riceve gli stessi aggiornamenti, una sola build gira', async () => {
    setActiveEngineForTests('apple-container')
    const builds: string[][] = []
    const releases: Array<() => void> = []
    let firstGate: Promise<void> | null = null
    let secondGate: Promise<void> | null = null
    setDockerRunnerForTests((async (argv: string[], opts: { onStderrLine?: (l: string) => void } | undefined, engine?: BoxEngine) => {
      if (argv[0] === 'image' && argv[1] === 'inspect') return { stdout: '', stderr: 'not found', exitCode: 1, signal: null }
      if (argv[0] === 'build') {
        builds.push(argv)
        opts?.onStderrLine?.('#5 [linux/arm64 1/4] RUN echo uno')
        // il primo aggiornamento è partito: qui il test aggancia il secondo
        firstGate = new Promise<void>((r) => releases.push(r))
        await firstGate
        opts?.onStderrLine?.(`#4 sha256:${'a'.repeat(64)} 1.05MB / 4.09MB 0.2s`)
        secondGate = new Promise<void>((r) => releases.push(r))
        await secondGate
        return { stdout: '', stderr: '', exitCode: 0, signal: null }
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    }) as unknown as Parameters<typeof setDockerRunnerForTests>[0])
    const first: BuildProgress[] = []
    const p1 = ensureBoxImage(appleContainerEngine, (p) => first.push(p))
    // la build parte e manda il primo aggiornamento
    for (let i = 0; i < 100 && first.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(first.map((p) => p.activity)).toEqual(['running'])
    // il secondo chiamante si aggancia alla build GIÀ in corsa
    const second: BuildProgress[] = []
    const p2 = ensureBoxImage(appleContainerEngine, (p) => second.push(p))
    // si rilasciano ENTRAMBI i gate (il secondo aggiornamento, poi la fine):
    // le promise si aspettano DOPO, quando la build può finire
    releases.shift()?.()
    await new Promise((r) => setTimeout(r, 100))
    releases.shift()?.()
    expect(await p1).toBe(true)
    expect(await p2).toBe(true)
    // UNA build sola, DUE ascoltatori: entrambi hanno visto il download
    expect(builds.length).toBe(1)
    expect(first.map((p) => p.activity)).toEqual(['running', 'downloading'])
    expect(second.map((p) => p.activity)).toEqual(['downloading'])
    expect(second[0]).toEqual(first[1])
  })
})
