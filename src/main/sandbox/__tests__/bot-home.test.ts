// H2: la home del bot ESISTE prima di ogni exec in docker. Runner docker
// INIETTABILE (setDockerRunnerForTests): si prova la sequenza container →
// home → comando e la memoria per agente SENZA Docker — il runner finto
// risponde come il client vero a ps/inspect/start/test -w/exec.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-bothome-test-'))
const mode = vi.hoisted(() => ({ value: 'host' as string }))
// come host-files.test.ts: directory dati iniettata (mai la home reale);
// sandbox.mode pilotabile dal test per girare in docker senza Docker
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key === 'sandbox.mode' ? mode.value : fallback),
  dataDir: () => TMP
}))

const { execCommand, ensureBotHome, setDockerRunnerForTests, resetBotHomesForTests } = await import('../index')

/**
 * Runner finto del client docker: container SANO di default (ps lo vede,
 * init true, scrivibile); registra ogni argv. `state.inspect` si può girare
 * a 'false' per simulare il container nato senza --init e forzare la
 * RICREAZIONE (G2); `state.mkdirExit` fa fallire il mkdir della home.
 */
function fakeDocker(state: { inspect: string; mkdirExit?: number }) {
  const calls: string[][] = []
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, signal: null })
  const runner = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> => {
    calls.push(argv)
    if (argv[0] === 'ps') return ok('sandbot-box') // il container esiste
    if (argv[0] === 'inspect') return ok(state.inspect)
    if (argv[0] === 'exec' && argv[2] === 'mkdir') {
      return state.mkdirExit ? { stdout: '', stderr: 'mkdir: Permission denied', exitCode: state.mkdirExit, signal: null } : ok()
    }
    if (argv[0] === 'exec') return ok('output-del-comando') // il comando del bot
    return ok() // start / rm / run (one-shot) / create / test -w
  }
  // i mkdir delle home visti, in ordine (argv: exec <container> mkdir -p <home>)
  const homes = () => calls.filter((a) => a[0] === 'exec' && a[2] === 'mkdir').map((a) => a[a.length - 1]!)
  return { calls, homes, runner }
}

beforeAll(() => { mode.value = 'docker' })
beforeEach(() => resetBotHomesForTests()) // ogni test parte da un container fresco
afterEach(() => setDockerRunnerForTests(null))
afterAll(() => {
  mode.value = 'host'
  rmSync(TMP, { recursive: true, force: true })
})

describe('H2: la home del bot prima dell\'exec in docker', () => {
  it('execCommand: il mkdir della home arriva PRIMA dell\'exec del comando, che gira -w nella home', async () => {
    const f = fakeDocker({ inspect: 'true' })
    setDockerRunnerForTests(f.runner)
    const r = await execCommand('agent_x', 'echo ok')
    expect(r.stdout).toBe('output-del-comando')
    const mkdirAt = f.calls.findIndex((a) => a[0] === 'exec' && a[2] === 'mkdir')
    const cmdAt = f.calls.findIndex((a) => a.includes('echo ok'))
    expect(mkdirAt).toBeGreaterThanOrEqual(0)
    expect(cmdAt).toBeGreaterThan(mkdirAt) // prima la home, POI il comando
    expect(f.calls[cmdAt]).toContain('/box/home/agent_x')
    expect(f.homes()).toEqual(['/box/home/agent_x'])
  })

  it('la memoria per agente: il secondo exec NON rifà il mkdir; un ALTRO bot sì', async () => {
    const f = fakeDocker({ inspect: 'true' })
    setDockerRunnerForTests(f.runner)
    await execCommand('agent_x', 'true')
    await execCommand('agent_x', 'true')
    await execCommand('agent_y', 'true')
    expect(f.homes()).toEqual(['/box/home/agent_x', '/box/home/agent_y'])
  })

  it('la memoria si AZZERA alla ricreazione del container (G2: nato senza --init)', async () => {
    const state = { inspect: 'true' }
    const f = fakeDocker(state)
    setDockerRunnerForTests(f.runner)
    await execCommand('agent_x', 'true')
    expect(f.homes()).toEqual(['/box/home/agent_x'])
    // il container esiste ma è nato senza --init → UNA ricreazione
    state.inspect = 'false'
    await execCommand('agent_x', 'true')
    expect(f.calls.some((a) => a[0] === 'rm')).toBe(true) // è davvero passato di lì
    expect(f.homes()).toEqual(['/box/home/agent_x', '/box/home/agent_x']) // e ha rifatto il mkdir
  })

  it('mkdir fallito: errore CHIARO e niente memoria (il tentativo si ripete)', async () => {
    const f = fakeDocker({ inspect: 'true', mkdirExit: 1 })
    setDockerRunnerForTests(f.runner)
    await expect(execCommand('agent_x', 'echo ok')).rejects.toThrow(/creazione della home \/box\/home\/agent_x/)
    await expect(execCommand('agent_x', 'echo ok')).rejects.toThrow()
    expect(f.homes()).toEqual(['/box/home/agent_x', '/box/home/agent_x'])
  })

  it('in modalità host ensureBotHome non tocca il runner (la home la crea boxDir)', async () => {
    const f = fakeDocker({ inspect: 'true' })
    setDockerRunnerForTests(f.runner)
    mode.value = 'host'
    try {
      await ensureBotHome('agent_x')
      expect(f.calls).toHaveLength(0)
    } finally {
      mode.value = 'docker'
    }
  })
})
