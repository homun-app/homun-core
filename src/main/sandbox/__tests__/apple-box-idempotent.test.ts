// Fase box-apple-cli-vera (BAV3): le scritture IDEMPOTENTI, il kernel di
// OBV2. La `volume create` della CLI di Apple NON è idempotente (dal vivo:
// «Error: volume 'sandbot-plugins' already exists», exit 1 — OGNI comando
// moriva al secondo giro): ensureAppleVolume LEGGE l'elenco, crea se manca,
// RILEGGE se la create esce male; la RETE segue la stessa regola. I test
// unitari con runner finti (le sequenze di argv), l'ensure integrale con la
// CLI FINTA SEVERA: i volumi già presenti e DUE ensureBox di fila → ZERO
// volume create al secondo giro e nessun errore. VISTO FALLIRE il
// 2026-11-14: il secondo giro moriva su «already exists».
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const FAKE = join(ROOT, 'scripts', 'fake-container.mjs')
const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-apple-box-idempotent-test-'))

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: () => null
}))

const { ensureAppleVolume, ensureAppleBoxNetwork, setBoxNetworkGateway, setBoxNetworkSubnet } = await import('../apple-container-engine')
const { execCommand, setDockerRunnerForTests } = await import('../index')

const readCliLog = (file: string): string[][] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv as string[])

beforeAll(() => {
  settings.value = { 'sandbox.mode': 'box', 'sandbox.engine': 'apple-container', 'sandbox.network': 'bridge' }
})
afterEach(() => {
  setDockerRunnerForTests(null)
})
afterAll(() => {
  settings.value = {}
  rmSync(TMP, { recursive: true, force: true })
})

describe('BAV3: ensureAppleVolume — leggi, crea se manca, RILEGGI se la create cade', () => {
  it('il volume C\'È: SOLO la lettura, nessuna create', async () => {
    const calls: string[][] = []
    const run = async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'volume' && argv[1] === 'ls') {
        return { stdout: JSON.stringify([{ configuration: { name: 'sandbot-plugins' } }]), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await ensureAppleVolume(run, 'sandbot-plugins')
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['volume ls'])
    expect(calls.some((c) => c[0] === 'volume' && c[1] === 'create')).toBe(false)
  })

  it('il volume MANCA: lettura → create → fatto', async () => {
    const calls: string[][] = []
    const run = async (argv: string[]) => {
      calls.push(argv)
      return { stdout: '[]', stderr: '', exitCode: 0 }
    }
    await ensureAppleVolume(run, 'sandbot-browser')
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['volume ls', 'volume create'])
    expect(calls[1]).toEqual(['volume', 'create', 'sandbot-browser'])
  })

  it('la create esce 1 («already exists»): si RILEGGE, ora c\'è — FATTO lo stesso, nessun errore', async () => {
    const calls: string[][] = []
    let created = false
    const run = async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'volume' && argv[1] === 'ls') {
        return {
          stdout: created ? JSON.stringify([{ configuration: { name: 'sandbot-box' } }]) : '[]',
          stderr: '', exitCode: 0
        }
      }
      if (argv[0] === 'volume' && argv[1] === 'create') {
        created = true // una corsa parallela l'ha fatto prima di noi
        return { stdout: '', stderr: "Error: volume 'sandbot-box' already exists", exitCode: 1 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await expect(ensureAppleVolume(run, 'sandbot-box')).resolves.toBeUndefined()
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['volume ls', 'volume create', 'volume ls'])
  })

  it('la create esce male e il volume NON c\'è: ERRORE chiaro (solo se manca davvero)', async () => {
    const run = async (argv: string[]) => {
      if (argv[0] === 'volume' && argv[1] === 'ls') return { stdout: '[]', stderr: '', exitCode: 0 }
      if (argv[0] === 'volume' && argv[1] === 'create') return { stdout: '', stderr: 'Error: disco pieno', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await expect(ensureAppleVolume(run, 'sandbot-box')).rejects.toThrow('creation of volume sandbot-box failed: Error: disco pieno')
  })
})

describe('BAV3: la RETE segue la stessa regola (create fallita → RILETTURA prima di arrendersi)', () => {
  it('create esce 1 ma la rete ORMAI c\'è (corsa parallela): nessun errore, il gateway si legge', async () => {
    setBoxNetworkGateway(null)
    setBoxNetworkSubnet(null)
    let created = false
    const run = async (argv: string[]) => {
      if (argv[0] === 'network' && argv[1] === 'inspect') {
        return created
          ? { stdout: '{"subnets":[{"subnet":"192.0.15.0/24","gateway":"192.0.15.1"}]}', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'network not found', exitCode: 1 }
      }
      if (argv[0] === 'network' && argv[1] === 'create') {
        created = true
        return { stdout: '', stderr: 'Error: network already exists', exitCode: 1 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await expect(ensureAppleBoxNetwork(run, 'bridge')).resolves.toBe('192.0.15.1')
    setBoxNetworkGateway(null)
    setBoxNetworkSubnet(null)
  })

  it('create fallita e la rete NON c\'è: errore (fail closed, come sempre in none)', async () => {
    const run = async (argv: string[]) => {
      if (argv[0] === 'network' && argv[1] === 'inspect') return { stdout: '', stderr: 'network not found', exitCode: 1 }
      if (argv[0] === 'network' && argv[1] === 'create') return { stdout: '', stderr: 'Error: vsock occupato', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await expect(ensureAppleBoxNetwork(run, 'none')).rejects.toThrow('creation of the internal network homun-box-isolated failed')
  })
})

// ---- l'ensure integrale con la CLI finta SEVERA: il caso che dal vivo moriva ----

/** Il runner che passa OGNI argv alla CLI finta vera (spawn), log condiviso. */
function fakeCliRunner(logFile: string) {
  return async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: null }> => {
    const r = spawnSync(process.execPath, [FAKE, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status, signal: null }
  }
}

const isVolumeCreate = (a: string[]) => a[0] === 'volume' && a[1] === 'create'

describe('BAV3: due ensureBox di fila con la finta severa — zero volume create al secondo giro', () => {
  it('i volumi GIÀ PRESENTI (il caso del vivo): il PRIMO ensure non crea e non muore', async () => {
    const logFile = join(TMP, 'cli-vivi-presenti.jsonl')
    // il mondo del vivo: i volumi restano dai giri di prima, il box NO
    for (const v of ['sandbot-box', 'sandbot-plugins', 'sandbot-browser']) {
      spawnSync(process.execPath, [FAKE, 'volume', 'create', v], {
        encoding: 'utf8',
        env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
      })
    }
    const seededAt = readCliLog(logFile).length
    setDockerRunnerForTests(fakeCliRunner(logFile))
    const r = await execCommand('agent_x', 'echo primo')
    expect(r.exitCode).toBe(0)
    const ensureCalls = readCliLog(logFile).slice(seededAt)
    // NESSUN volume create nell'ensure: c'erano già, si è SOLO letto l'elenco
    expect(ensureCalls.filter(isVolumeCreate)).toEqual([])
    expect(ensureCalls.some((a) => a[0] === 'run' && a.includes('-d'))).toBe(true)
    expect(ensureCalls.some((a) => a[0] === 'exec' && a.includes('echo primo'))).toBe(true)
  }, 20_000)

  it('il SECONDO ensureBox di fila: zero volume create, nessun errore, il comando del bot gira', async () => {
    const logFile = join(TMP, 'cli-due-giri.jsonl')
    setDockerRunnerForTests(fakeCliRunner(logFile))
    const primo = await execCommand('agent_x', 'true')
    expect(primo.exitCode).toBe(0)
    const before = readCliLog(logFile).length
    const secondo = await execCommand('agent_y', 'echo secondo')
    expect(secondo.exitCode).toBe(0)
    const after = readCliLog(logFile).slice(before)
    expect(after.filter(isVolumeCreate), 'ZERO volume create al secondo giro').toEqual([])
    expect(after.some((a) => a[0] === 'exec' && a.includes('echo secondo'))).toBe(true)
  }, 20_000)
})
