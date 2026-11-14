// CC2 (fase computer-card): lo STATO DEL BOX nel daemon — { state, since }
// in memoria, l'evento `box` SOLO al cambio, la LETTURA con le reads del
// motore (Apple: il `ls -a --format json` di oggi col parse PURO della
// fixture VERA ls-a-json.txt, cioè status.state; Docker: il ps di oggi più
// l'inspect .State.Running), e il tick che RILEGGE ogni 60 s SOLO mentre
// c'è un client UI connesso — MAI un polling a vuoto con l'app chiusa.
// Nessun `container` vero: il runner è sempre finto.
import { describe, expect, it, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-box-runtime-test-'))
const FIXTURES = join(import.meta.dirname, 'fixtures', 'container-1.7.1')
/** la fixture VERA senza la riga `$ container …` e senza `[exit N]`. */
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('$') && !l.startsWith('[exit')).join('\n')

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: () => null
}))

const { appleBoxStateFromLsJson } = await import('../apple-container-argv')
const { appleContainerEngine } = await import('../apple-container-engine')
const {
  initBoxRuntime, boxRuntime, setBoxRuntime, refreshBoxRuntime, tickBoxRuntime,
  resetBoxRuntimeForTests, BOX_RUNTIME_REFRESH_MS
} = await import('../box-runtime')
const { ensureBoxContainer, setDockerRunnerForTests } = await import('../index')
import type { SandbotEvent } from '../../../shared/types'

/** il runner finto: registra gli argv e risponde come la fixture di turno. */
const fakeRun = (calls: string[][], answer?: (argv: string[]) => { stdout: string; stderr: string; exitCode: number } | undefined) =>
  async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    calls.push(argv)
    return answer?.(argv) ?? { stdout: '', stderr: '', exitCode: 0 }
  }

afterAll(() => {
  settings.value = {}
  rmSync(TMP, { recursive: true, force: true })
})

describe('CC2: il parse PURO dello stato del box (fixture vera ls-a-json.txt)', () => {
  it('sandbot-box è RUNNING: status.state dell\'elenco della fixture', () => {
    expect(appleBoxStateFromLsJson(fixture('ls-a-json.txt'), 'sandbot-box')).toBe('running')
  })
  it('il box ASSENTE dall\'elenco → missing', () => {
    expect(appleBoxStateFromLsJson(fixture('ls-a-json.txt'), 'un-altro-box')).toBe('missing')
  })
  it('status.state ≠ running → stopped (la stessa fixture, cambiato SOLO lo stato)', () => {
    const arr = JSON.parse(fixture('ls-a-json.txt')) as Array<{ id?: string; status?: { state?: string } }>
    const box = arr.find((c) => c.id === 'sandbot-box')
    expect(box?.status?.state).toBe('running') // la parte di partenza è la fixture vera
    box!.status!.state = 'stopped'
    expect(appleBoxStateFromLsJson(JSON.stringify(arr), 'sandbot-box')).toBe('stopped')
  })
  it('JSON illeggibile → unknown, mai un errore', () => {
    expect(appleBoxStateFromLsJson('<non json>', 'sandbot-box')).toBe('unknown')
    expect(appleBoxStateFromLsJson('{"oggetto":1}', 'sandbot-box')).toBe('unknown')
  })
  it('le reads del motore Apple espongono boxState (il registro, non un doppione)', () => {
    expect(appleContainerEngine.reads?.boxState).toBe(appleBoxStateFromLsJson)
  })
})

describe('CC2: setBoxRuntime — l\'evento box parte SOLO se lo stato cambia', () => {
  afterEach(() => resetBoxRuntimeForTests())
  it('due set uguali → UN evento; il cambio → il secondo', () => {
    const events: SandbotEvent[] = []
    initBoxRuntime({ emit: (e) => { events.push(e) }, run: fakeRun([]), boxMode: () => true, now: () => 1_000 })
    setBoxRuntime('running')
    setBoxRuntime('running')
    expect(events).toEqual([{ type: 'box', runtime: { state: 'running', since: 1_000 } }])
    setBoxRuntime('stopped')
    expect(events).toHaveLength(2)
    expect(boxRuntime()).toEqual({ state: 'stopped', since: 1_000 })
  })
})

describe('CC2: ensureBoxContainer riuscito → running, UNA volta sola', () => {
  it('due ensure di fila → UN solo evento box con running', async () => {
    resetBoxRuntimeForTests()
    const events: SandbotEvent[] = []
    const calls: string[][] = []
    settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container', 'sandbox.network': 'bridge' }
    initBoxRuntime({ emit: (e) => { events.push(e) }, run: fakeRun(calls), boxMode: () => true, now: () => 2_000 })
    // il runner finto: l'elenco dei container è la FIXTURE VERA (il box c'è e
    // gira), l'inspect quello di sempre, tutto il resto exit 0
    setDockerRunnerForTests(async (argv) => {
      calls.push(argv)
      if (argv[0] === 'ls') return { stdout: fixture('ls-a-json.txt'), stderr: '', exitCode: 0, signal: null }
      if (argv[0] === 'inspect') return { stdout: fixture('inspect-box.txt'), stderr: '', exitCode: 0, signal: null }
      if (argv[0] === 'image' && argv[1] === 'ls') return { stdout: fixture('image-ls-json.txt'), stderr: '', exitCode: 0, signal: null }
      if (argv[0] === 'network' && argv[1] === 'ls') return { stdout: fixture('network-ls-json.txt'), stderr: '', exitCode: 0, signal: null }
      if (argv[0] === 'network' && argv[1] === 'inspect') return { stdout: fixture('network-inspect-homun-box.txt'), stderr: '', exitCode: 0, signal: null }
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    })
    await ensureBoxContainer()
    await ensureBoxContainer()
    setDockerRunnerForTests(null)
    const boxes = events.filter((e) => e.type === 'box')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({ runtime: { state: 'running' } })
  })
  afterAll(() => { settings.value = {} })
})

describe('CC2: refreshBoxRuntime — la LETTURA col motore di turno', () => {
  beforeEach(() => resetBoxRuntimeForTests())
  afterEach(() => { resetBoxRuntimeForTests(); settings.value = {} })
  it('Apple: UN solo `ls -a --format json`, la fixture → running', async () => {
    settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container' }
    const calls: string[][] = []
    initBoxRuntime({
      emit: () => undefined,
      run: fakeRun(calls, (argv) => argv[0] === 'ls' ? { stdout: fixture('ls-a-json.txt'), stderr: '', exitCode: 0 } : undefined),
      boxMode: () => true, now: () => 3_000
    })
    await refreshBoxRuntime()
    expect(boxRuntime()).toEqual({ state: 'running', since: 3_000 })
    expect(calls).toEqual([['ls', '-a', '--format', 'json']])
  })
  it('Apple: il box assente → missing; la lettura caduta → unknown', async () => {
    settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container' }
    initBoxRuntime({
      emit: () => undefined,
      run: fakeRun([], (argv) => argv[0] === 'ls' ? { stdout: '[]', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 1 }),
      boxMode: () => true, now: () => 3_000
    })
    await refreshBoxRuntime()
    expect(boxRuntime().state).toBe('missing')
    resetBoxRuntimeForTests()
    initBoxRuntime({ emit: () => undefined, run: fakeRun([], () => ({ stdout: '', stderr: '', exitCode: 1 })), boxMode: () => true, now: () => 3_000 })
    await refreshBoxRuntime()
    expect(boxRuntime().state).toBe('unknown')
  })
  it('Docker: il ps di oggi + l\'inspect .State.Running', async () => {
    settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'docker' }
    const calls: string[][] = []
    initBoxRuntime({
      emit: () => undefined,
      run: fakeRun(calls, (argv) => {
        if (argv[0] === 'ps') return { stdout: 'sandbot-box\n', stderr: '', exitCode: 0 }
        if (argv[0] === 'inspect') return { stdout: 'true', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      }),
      boxMode: () => true, now: () => 4_000
    })
    await refreshBoxRuntime()
    expect(boxRuntime()).toEqual({ state: 'running', since: 4_000 })
    expect(calls[0][0]).toBe('ps')
    expect(calls[1]).toEqual(['inspect', '-f', '{{.State.Running}}', 'sandbot-box'])
  })
  it('fuori dalla modalità box NON si legge niente (l\'evento resta unknown)', async () => {
    const calls: string[][] = []
    initBoxRuntime({ emit: () => undefined, run: fakeRun(calls), boxMode: () => false, now: () => 5_000 })
    await refreshBoxRuntime()
    expect(calls).toEqual([])
    expect(boxRuntime().state).toBe('unknown')
  })
})

describe('CC2: il tick — MAI polling senza client UI connessi (orologio finto)', () => {
  afterEach(() => resetBoxRuntimeForTests())
  it('senza UI: NESSUNA lettura, comunque vadano gli orologi', async () => {
    const calls: string[][] = []
    initBoxRuntime({ emit: () => undefined, run: fakeRun(calls), boxMode: () => true, now: () => 10_000 })
    await tickBoxRuntime(10_000, false)
    await tickBoxRuntime(10_000 + BOX_RUNTIME_REFRESH_MS, false)
    await tickBoxRuntime(10_000 + 10 * BOX_RUNTIME_REFRESH_MS, false)
    expect(calls).toEqual([])
  })
  it('con la UI: una lettura ogni 60 s, non a ogni tick da 30 s', async () => {
    const calls: string[][] = []
    let clock = 10_000
    initBoxRuntime({ emit: () => undefined, run: fakeRun(calls), boxMode: () => true, now: () => clock })
    await tickBoxRuntime(clock, true) // la prima lettura
    expect(calls).toHaveLength(1)
    await tickBoxRuntime(clock + 30_000, true) // tick a metà: NO
    expect(calls).toHaveLength(1)
    clock += BOX_RUNTIME_REFRESH_MS
    await tickBoxRuntime(clock, true) // ora sì
    expect(calls).toHaveLength(2)
  })
})
