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
