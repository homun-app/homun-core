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

const { execCommand, ensureBotHome, ensureBoxContainer, setDockerRunnerForTests, resetBotHomesForTests, boxImage } = await import('../index')

/**
 * Runner finto del client docker: container SANO di default (ps lo vede,
 * init true, IMMAGINE CORRENTE, mount dei plugin :ro, scrivibile); registra
 * ogni argv. `state.inspect` si può girare a 'false' per simulare il container
 * nato senza --init e forzare la RICREAZIONE (G2); `state.image` cambia
 * l'immagine con cui il container è nato (punto 1); `state.mounts` cambia i
 * mount EFFETTIVI del container (M4: senza /plugins:ro si ricrea) e di
 * default è l'output VERO del template .Mounts sul box (N1);
 * `state.mkdirExit` fa fallire il mkdir della home.
 */
function fakeDocker(state: { inspect: string; image?: string; mounts?: string; mkdirExit?: number }) {
  const calls: string[][] = []
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, signal: null })
  const runner = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> => {
    calls.push(argv)
    if (argv[0] === 'ps') return ok('sandbot-box') // il container esiste
    // punto 1: init e immagine del container si leggono con inspect -f diversi
    if (argv[0] === 'inspect' && argv[2] === '{{.Config.Image}}') return ok(state.image ?? boxImage())
    // M4/N1: i mount EFFETTIVI del container (inspect -f {{range .Mounts}}…) —
    // il matcher segue il template VERO: un ritorno a .HostConfig.Mounts non
    // viene riconosciuto, cade nell'inspect generico e la guardia N1 fallisce
    if (argv[0] === 'inspect' && argv[2]?.startsWith('{{range .Mounts}}')) return ok(state.mounts ?? '/box:rw /plugins:ro ')
    if (argv[0] === 'inspect') return ok(state.inspect)
    if (argv[0] === 'image') return ok() // l'immagine del box c'è già
    if (argv[0] === 'exec' && argv[2] === 'mkdir') {
      return state.mkdirExit ? { stdout: '', stderr: 'mkdir: Permission denied', exitCode: state.mkdirExit, signal: null } : ok()
    }
    if (argv[0] === 'exec') return ok('output-del-comando') // il comando del bot
    return ok() // start / rm / run (one-shot) / create / volume create / test -w
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

  it("punto 1: container nato con un'immagine DIVERSA → ricreazione del SOLO container (il volume non si tocca) con l'immagine corrente", async () => {
    const f = fakeDocker({ inspect: 'true', image: 'sandbot-box:vecchiotag' })
    setDockerRunnerForTests(f.runner)
    await execCommand('agent_x', 'true')
    // ricreato davvero: rm del container e create con l'immagine CORRENTE
    expect(f.calls.some((a) => a[0] === 'rm')).toBe(true)
    expect(f.calls.some((a) => a[0] === 'create' && a.includes(boxImage()))).toBe(true)
    // MAI rm del volume: i dati dei bot restano
    expect(f.calls.some((a) => a[0] === 'volume' && a.includes('rm'))).toBe(false)
    expect(f.homes()).toEqual(['/box/home/agent_x'])
  })

  it('M4: container nato SENZA il mount /plugins:ro → ricreazione del SOLO container, volume creato, sandbot-box MAI rimosso', async () => {
    const f = fakeDocker({ inspect: 'true', mounts: '/box:rw ' }) // nato prima della correzione
    setDockerRunnerForTests(f.runner)
    await execCommand('agent_x', 'true')
    // ricreato: rm del solo container, NON del volume sandbot-box
    expect(f.calls.some((a) => a[0] === 'rm' && a.includes('sandbot-box'))).toBe(true)
    expect(f.calls.some((a) => a[0] === 'volume' && a.includes('rm'))).toBe(false)
    // il volume dei plugin si crea se manca (idempotente) e il create monta :ro
    expect(f.calls.some((a) => a[0] === 'volume' && a.includes('create') && a.includes('sandbot-plugins'))).toBe(true)
    const create = f.calls.find((a) => a[0] === 'create' && a.includes(boxImage()))!
    expect(create).toContain('-v')
    expect(create).toContain('sandbot-plugins:/plugins:ro')
    expect(create).toContain('sandbot-box:/box:nocopy')
    // e la home del bot è stata rifatta nel container nuovo
    expect(f.homes()).toEqual(['/box/home/agent_x'])
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

// N1 (fase 13 correzioni 3): GUARDIA di non-regressione. Su 498c365
// l'inspect leggeva .HostConfig.Mounts (SEMPRE vuoto per un container creato
// con -v): ensureBoxContainer ricreava il box a OGNI comando — rm del
// container, one-shot chown -R di tutto /box, create e start — con browser,
// server MCP stdio e processi in background del box che morivano ogni volta.
describe('N1: il box già a posto NON si ricrea a ogni comando', () => {
  it('due ensureBoxContainer consecutive su un box sano: NESSUN rm/create/chown, solo i controlli', async () => {
    const f = fakeDocker({ inspect: 'true' }) // Docker vero a un box a posto: init ok, stessa immagine, mount /box:rw /plugins:ro, scrivibile
    setDockerRunnerForTests(f.runner)
    await ensureBoxContainer()
    await ensureBoxContainer()
    // NESSUN rm del container, NESSUN create, NESSUN one-shot di init (`run`)
    // e NESSUN volume: la ricreazione a ogni comando (il difetto N1) salterebbe fuori qui
    expect(f.calls.some((a) => a[0] === 'rm')).toBe(false)
    expect(f.calls.some((a) => a[0] === 'create')).toBe(false)
    expect(f.calls.some((a) => a[0] === 'run')).toBe(false)
    expect(f.calls.some((a) => a[0] === 'volume')).toBe(false)
    // SOLO controlli: image inspect, ps, inspect (init/immagine/mount), start
    // e il test -w — una corsa completa per chiamata
    expect(new Set(f.calls.map((a) => a[0]))).toEqual(new Set(['image', 'ps', 'inspect', 'start', 'exec']))
    expect(f.calls.filter((a) => a[0] === 'inspect')).toHaveLength(6) // init, immagine e mount × 2
    expect(f.calls.filter((a) => a[0] === 'start')).toHaveLength(2)
    expect(f.calls.filter((a) => a[0] === 'exec' && a[2] === 'test')).toHaveLength(2) // test -w /box/workspace
  })

  it('il box NATO PRIMA del mount :ro si ricrea UNA volta col motivo nel log (N1.4), poi non più', async () => {
    const state = { inspect: 'true', mounts: '/box:rw ' } // container pre-M4: -v ma senza /plugins:ro
    const f = fakeDocker(state)
    setDockerRunnerForTests(f.runner)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await ensureBoxContainer() // ricreazione: mount-plugin-mancante
      expect(err).toHaveBeenCalledWith(expect.stringContaining('ricreazione del container sandbot-box: mount-plugin-mancante'))
      // dopo la ricreazione il container vero avrebbe il mount: la seconda
      // chiamata NON ricrea più (nessun secondo rm)
      state.mounts = '/box:rw /plugins:ro '
      await ensureBoxContainer()
      expect(f.calls.filter((a) => a[0] === 'rm')).toHaveLength(1)
      expect(err).toHaveBeenCalledTimes(1) // una riga per ricreazione, non una per comando
    } finally {
      err.mockRestore()
    }
  })
})
