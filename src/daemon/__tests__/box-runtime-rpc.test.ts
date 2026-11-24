// CC2 (fase computer-card): le RPC che FERMANO il box aggiornano lo stato —
// «Rimuovi immagine» → stopped, «Elimina i file dei bot» → missing, la
// disinstallazione → stopped già dal system stop; box:runtime RILEGGE e
// risponde. Il runner è finto, la CLI `container` non viene MAI chiamata.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../test-tmp'
import { join } from 'node:path'

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

const { setDataDir, dataDir, db } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
const engine = await import('../../main/sandbox/engine')
const u = await import('../../main/sandbox/apple-uninstall')
const { initBoxRuntime, boxRuntime, setBoxRuntime, resetBoxRuntimeForTests } = await import('../../main/sandbox/box-runtime')
const { setDockerRunnerForTests } = await import('../../main/sandbox')
import type { SandbotEvent } from '../../shared/types'

const h = vi.hoisted(() => ({ calls: [] as string[][] }))
// la CLI finta del motore (come box-engine-rpc.test.ts): system stop esce 0
engine.engineProbeDeps.runCli = async (file, argv) => {
  h.calls.push(argv)
  return { stdout: '', stderr: '', exitCode: 0 }
}

const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(() => undefined, { poke: () => undefined } as never)
const events: SandbotEvent[] = []

beforeAll(() => {
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-box-runtime-rpc-'))
  setDataDir(dir)
  dataDir()
  db()
  initBoxRuntime({
    emit: (e) => { events.push(e) },
    // il runner del refresh (Docker di default nei test: ps + inspect true)
    run: async (argv) => argv[0] === 'ps'
      ? { stdout: 'sandbot-box\n', stderr: '', exitCode: 0 }
      : { stdout: 'true', stderr: '', exitCode: 0 },
    boxMode: () => true
  })
  setDockerRunnerForTests(async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null }))
})
afterAll(() => {
  setDockerRunnerForTests(null)
  rmSync(dataDir(), { recursive: true, force: true })
})

describe('CC2: gli stop espliciti aggiornano lo stato del box', () => {
  it('«Rimuovi immagine» riuscito → stopped (evento box)', async () => {
    resetBoxRuntimeForTests()
    events.length = 0
    setBoxRuntime('running') // parte acceso
    const r = (await api['box:image-remove']!([])) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(boxRuntime().state).toBe('stopped')
    expect(events.some((e) => e.type === 'box' && e.runtime.state === 'stopped')).toBe(true)
  })

  it('«Elimina i file dei bot» riuscito → missing (evento box)', async () => {
    resetBoxRuntimeForTests()
    events.length = 0
    setBoxRuntime('running')
    const r = (await api['box:box-files-remove']!([])) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(boxRuntime().state).toBe('missing')
    expect(events.some((e) => e.type === 'box' && e.runtime.state === 'missing')).toBe(true)
  })

  it('la disinstallazione: GIÀ dal system stop lo stato dice stopped (la guardia può anche fermare tutto dopo)', async () => {
    resetBoxRuntimeForTests()
    events.length = 0
    setBoxRuntime('running')
    // lo script di disinstallazione ASSENTE: la guardia ferma TUTTO, ma il
    // system stop è già corso — il box non gira più
    const fileStat = { exists: true, isFile: true, isDirectory: false, uid: 0, gid: 0, mode: 0o755 }
    const dirStat = { exists: true, isFile: false, isDirectory: true, uid: 0, gid: 0, mode: 0o755 }
    u.setUninstallStatProbeForTests((path: string) =>
      path === u.UNINSTALL_CONTAINER_SCRIPT ? null
        : path === u.UNINSTALL_SCRIPT_DIR || path === u.UNINSTALL_SCRIPT_PARENT_DIR ? dirStat as never
        : fileStat as never)
    h.calls.length = 0
    const r = (await api['box:engine-uninstall']!([])) as { ok: boolean; error?: string }
    u.setUninstallStatProbeForTests(null)
    expect(r.ok).toBe(false)
    expect(h.calls.some((c) => c.join(' ') === 'system stop')).toBe(true)
    expect(boxRuntime().state).toBe('stopped')
  })
})

describe('CC2: la RPC box:runtime', () => {
  it('RILEGGE e risponde (qui Docker: ps + inspect .State.Running → running)', async () => {
    resetBoxRuntimeForTests()
    const r = (await api['box:runtime']!([])) as { state: string; since: number }
    expect(r.state).toBe('running')
    expect(typeof r.since).toBe('number')
  })
})
