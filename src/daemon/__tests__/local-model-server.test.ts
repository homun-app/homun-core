// Fase locale (L2): il processo llama-server affiancato, nel daemon. Tutto con
// spawn e fetch FINTI e orologio iniettabile: avvio unico con richieste
// concorrenti, attesa di /health, spegnimento dopo 10 minuti di inattività,
// UN SOLO riavvio dopo un crash, pidfile orfano ucciso solo se è nostro.
// Nessun processo vero, nessuna porta aperta, nessun file fuori da mkdtemp.
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLocalModelServer, LOCAL_MODEL_CRASHED_ERROR, IDLE_SHUTDOWN_MS, HEALTH_TIMEOUT_MS,
  type LocalModelServerDeps, type LocalModelServer
} from '../local-model-server'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-local-model-'))
const SERVER_BIN = join(ROOT, 'llama-server') // finto: non parte mai davvero
const MODEL_FILE = join(ROOT, 'models', 'Qwen3.5-4B-Q4_K_M.gguf')
const PID_FILE = join(ROOT, 'llama-server.pid')

interface FakeChild {
  pid: number
  cmd: string
  args: string[]
  env?: NodeJS.ProcessEnv
  killed: string[]
  exitListeners: Array<(code: number | null) => void>
  stdout: { on: (ev: string, cb: (d: Buffer) => void) => void }
  stderr: { on: (ev: string, cb: (d: Buffer) => void) => void }
  on(ev: 'exit', cb: (code: number | null) => void): void
  on(ev: 'error', cb: (err: Error) => void): void
  exit(code: number | null): void
  kill(sig?: string): boolean
}

function makeDeps(over: Partial<LocalModelServerDeps> = {}) {
  let clock = 1_000_000
  let pidSeq = 100
  const spawned: FakeChild[] = []
  const healthCalls: string[] = []
  let healthyAfter = 0 // /health risponde ok dal poll numero N (1-based)
  let polls = 0
  const logs: string[] = []
  const killedPids: number[] = []
  const pathsByPid = new Map<number, string | null>()
  const files = new Map<string, string>()
  const deps: LocalModelServerDeps = {
    now: () => clock,
    async sleep(ms: number) { clock += ms },
    spawn: ((cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const c: FakeChild = {
        pid: ++pidSeq, cmd, args, env: opts?.env, killed: [], exitListeners: [],
        stdout: { on: () => undefined }, stderr: { on: () => undefined },
        on(ev, cb) { if (ev === 'exit') this.exitListeners.push(cb as (code: number | null) => void) },
        exit(code) { for (const l of this.exitListeners.splice(0)) l(code) },
        kill(sig = 'SIGTERM') { this.killed.push(sig); this.exit(0); return true }
      }
      spawned.push(c)
      return c as unknown as ReturnType<LocalModelServerDeps['spawn']>
    }) as LocalModelServerDeps['spawn'],
    fetch: (async (url: string) => {
      healthCalls.push(url)
      polls++
      return { ok: polls >= healthyAfter, status: healthyAfter > 0 && polls < healthyAfter ? 503 : 200 }
    }) as LocalModelServerDeps['fetch'],
    findFreePort: async () => 8431,
    newApiKey: () => 'key-' + (spawned.length + 1),
    processPathOf: async (pid) => pathsByPid.get(pid) ?? null,
    killPid: (pid) => { killedPids.push(pid) },
    logLine: (l) => logs.push(l),
    readFileText: (p) => files.get(p) ?? null,
    writeFileText: (p, t) => { files.set(p, t) },
    removeFile: (p) => { files.delete(p) },
    fileSize: () => null,
    ...over
  }
  return {
    deps, spawned, healthCalls, logs, killedPids, files, pathsByPid,
    tick: (ms: number) => { clock += ms },
    setClock: (ms: number) => { clock = ms },
    setHealthyAfter: (n: number) => { healthyAfter = n },
    get polls() { return polls }
  }
}

function makeServer(d: ReturnType<typeof makeDeps>, over: Partial<Parameters<typeof createLocalModelServer>[0]> = {}): LocalModelServer {
  mkdirSync(join(ROOT, 'models'), { recursive: true })
  if (!existsSync(MODEL_FILE)) writeFileSync(MODEL_FILE, 'gguf finto')
  return createLocalModelServer({
    deps: d.deps,
    serverBin: SERVER_BIN,
    modelFile: MODEL_FILE,
    pidFile: PID_FILE,
    ...over
  })
}

describe('fase locale (L2.2): avvio su richiesta', () => {
  it('ensureRunning avvia il processo con gli argomenti fissati e aspetta /health', async () => {
    const d = makeDeps()
    d.setHealthyAfter(3) // ok dal terzo poll
    const s = makeServer(d)
    const r = await s.ensureRunning()
    expect(r).toEqual({ baseUrl: 'http://127.0.0.1:8431', apiKey: 'key-1' })
    // gli argomenti della spec, esatti — LC4: la chiave NON sta tra gli
    // argomenti (visibile con ps a ogni processo dell'utente)
    expect(d.spawned[0]!.cmd).toBe(SERVER_BIN)
    expect(d.spawned[0]!.args).toEqual([
      '--host', '127.0.0.1', '--port', '8431', '--jinja', '-c', '32768',
      '-ngl', '99', '--parallel', '1', '-m', MODEL_FILE
    ])
    // ha aspettato /health su 127.0.0.1
    expect(d.healthCalls.every((u) => u.startsWith('http://127.0.0.1:'))).toBe(true)
    expect(d.polls).toBeGreaterThanOrEqual(3)
    // il pid sta nel pidfile
    expect(JSON.parse(d.files.get(PID_FILE)!)).toEqual({ pid: d.spawned[0]!.pid, port: 8431 })
  })

  it('più chiamate concorrenti condividono lo STESSO avvio (un solo spawn)', async () => {
    const d = makeDeps()
    d.setHealthyAfter(2)
    const s = makeServer(d)
    const [a, b, c] = await Promise.all([s.ensureRunning(), s.ensureRunning(), s.ensureRunning()])
    expect(d.spawned).toHaveLength(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    // e la chiamata successiva non riavvia
    await s.ensureRunning()
    expect(d.spawned).toHaveLength(1)
  })

  it('un nuovo avvio ha una PORTA e una API-KEY nuove (mai riusate)', async () => {
    const d = makeDeps()
    let port = 8431
    let keyN = 0
    d.deps.findFreePort = async () => ++port
    d.deps.newApiKey = () => 'k' + ++keyN
    const s = makeServer(d)
    const a = await s.ensureRunning()
    await s.stop()
    const b = await s.ensureRunning()
    expect(a).toEqual({ baseUrl: 'http://127.0.0.1:8432', apiKey: 'k1' })
    expect(b).toEqual({ baseUrl: 'http://127.0.0.1:8433', apiKey: 'k2' })
    expect(d.spawned).toHaveLength(2)
  })

  it('/health che non risponde entro il timeout (120 s) → errore, processo fermato', async () => {
    const d = makeDeps()
    d.setHealthyAfter(1_000_000) // mai ok
    const s = makeServer(d)
    await expect(s.ensureRunning()).rejects.toThrow(/health|risponde/i)
    expect(d.spawned[0]!.killed.length).toBeGreaterThan(0)
    expect(d.files.has(PID_FILE)).toBe(false)
  })
})

describe('fase locale (L2.3): spegnimento per inattività (10 minuti)', () => {
  it('senza richieste per 10 minuti il processo si spegne; poi riparte pulito', async () => {
    const d = makeDeps()
    const s = makeServer(d)
    await s.ensureRunning()
    expect(s.status().running).toBe(true)
    // prima del limite NON si spegne
    d.tick(IDLE_SHUTDOWN_MS - 1_000)
    expect(s.maybeShutdownIdle()).toBe(false)
    expect(s.status().running).toBe(true)
    // dopo il limite sì, e libera il pidfile
    d.tick(2_000)
    expect(s.maybeShutdownIdle()).toBe(true)
    expect(s.status().running).toBe(false)
    expect(d.spawned[0]!.killed).toContain('SIGTERM')
    expect(d.files.has(PID_FILE)).toBe(false)
    // e riparte al turno dopo
    const r = await s.ensureRunning()
    expect(r.baseUrl).toBe('http://127.0.0.1:8431')
    expect(d.spawned).toHaveLength(2)
  })

  it('una richiesta posticipa lo spegnimento (come il keep_alive di Ollama)', async () => {
    const d = makeDeps()
    const s = makeServer(d)
    await s.ensureRunning()
    d.tick(9 * 60_000)
    s.noteRequest()
    d.tick(9 * 60_000)
    expect(s.maybeShutdownIdle()).toBe(false) // 18 min dall'avvio ma 9 dall'ultima richiesta
    d.tick(2 * 60_000)
    expect(s.maybeShutdownIdle()).toBe(true)
  })
})

describe('fase locale (L2.4): crash — un solo riavvio, poi errore chiaro', () => {
  it('il processo muore: UN riavvio, e se muore ancora l\'errore parla di memoria', async () => {
    const d = makeDeps()
    const s = makeServer(d)
    await s.ensureRunning()
    // primo crash (durante una richiesta): riavvio concesso
    d.spawned[0]!.exit(11)
    const r = await s.ensureRunning()
    expect(d.spawned).toHaveLength(2)
    expect(r.baseUrl).toBeTruthy()
    // secondo crash: NESSUN nuovo riavvio, errore chiaro
    d.spawned[1]!.exit(11)
    await expect(s.ensureRunning()).rejects.toThrow(LOCAL_MODEL_CRASHED_ERROR)
    expect(d.spawned).toHaveLength(2)
    // e l'errore resta: il terzo tentativo non spawn più (niente loop)
    await expect(s.ensureRunning()).rejects.toThrow(/memoria/i)
    expect(d.spawned).toHaveLength(2)
  })

  it('lo spegnimento per inattività NON è un crash: il riavvio resta disponibile', async () => {
    const d = makeDeps()
    const s = makeServer(d)
    await s.ensureRunning()
    d.spawned[0]!.exit(11) // un crash vero
    await s.ensureRunning() // riavvio (1/1)
    d.tick(IDLE_SHUTDOWN_MS + 1_000)
    expect(s.maybeShutdownIdle()).toBe(true) // spegnimento pulito
    // dopo lo spegnimento pulito il contatore dei crash riparte da zero
    const r = await s.ensureRunning()
    expect(r.baseUrl).toBeTruthy()
    d.spawned[2]!.exit(11)
    const r2 = await s.ensureRunning() // il riavvio è di nuovo concesso
    expect(r2.baseUrl).toBeTruthy()
    expect(d.spawned).toHaveLength(4)
  })
})

describe('fase locale (L2.3): pidfile orfano all\'avvio del daemon', () => {
  it('uccide l\'orfano SOLO se il pid è davvero un nostro llama-server', async () => {
    const d = makeDeps()
    const s = makeServer(d)
    // pid di un processo VIVO il cui eseguibile è il NOSTRO binario → ucciso
    d.files.set(PID_FILE, JSON.stringify({ pid: 4242, port: 8431 }))
    d.pathsByPid.set(4242, '/Applications/Homun.app/Contents/Resources/vendor/llama/llama-server')
    expect(await s.killOrphanIfOurs()).toBe(true)
    expect(d.killedPids).toEqual([4242])
    expect(d.files.has(PID_FILE)).toBe(false)
  })

  it('un pid il cui eseguibile è ALTRO (per esempio l\'Homebrew) NON si tocca', async () => {
    const d = makeDeps()
    const s = makeServer(d)
    d.files.set(PID_FILE, JSON.stringify({ pid: 4243, port: 11434 }))
    d.pathsByPid.set(4243, '/opt/homebrew/bin/llama-server')
    expect(await s.killOrphanIfOurs()).toBe(false)
    expect(d.killedPids).toEqual([])
  })

  it('pid morto o pidfile assente: niente da fare, nessun errore', async () => {
    const d = makeDeps()
    const s = makeServer(d)
    d.files.set(PID_FILE, JSON.stringify({ pid: 9999, port: 8431 }))
    d.pathsByPid.set(9999, null) // ps non lo trova: morto
    expect(await s.killOrphanIfOurs()).toBe(false)
    d.files.delete(PID_FILE)
    expect(await s.killOrphanIfOurs()).toBe(false)
    expect(d.killedPids).toEqual([])
  })
})

describe('fase locale (L2.4): log con rotazione', () => {
  it('stdout/stderr vanno nel log iniettabile, con prefisso di riga', async () => {
    const d = makeDeps()
    const chunks: Array<(data: Buffer) => void> = []
    ;(d.deps as { spawn: unknown }).spawn = (cmd: string, args: string[]) => {
      const c: FakeChild = {
        pid: 777, cmd, args, killed: [], exitListeners: [],
        stdout: { on: (_ev: string, cb: (data: Buffer) => void) => { chunks.push(cb) } },
        stderr: { on: () => undefined },
        on(ev, cb) { if (ev === 'exit') this.exitListeners.push(cb as (code: number | null) => void) },
        exit(code) { for (const l of this.exitListeners.splice(0)) l(code) },
        kill(sig = 'SIGTERM') { this.killed.push(sig); this.exit(0); return true }
      }
      d.spawned.push(c)
      return c as unknown as ReturnType<LocalModelServerDeps['spawn']>
    }
    const s = makeServer(d)
    await s.ensureRunning()
    for (const cb of chunks) cb(Buffer.from('llama-server: caricamento modello\n'))
    expect(d.logs.some((l) => l.includes('caricamento modello'))).toBe(true)
  })
})

describe('fase locale (L2): stop del daemon spegne SEMPRE', () => {
  it('stop uccide il processo e toglie il pidfile', async () => {
    const d = makeDeps()
    const s = makeServer(d)
    await s.ensureRunning()
    await s.stop()
    expect(s.status().running).toBe(false)
    expect(d.spawned[0]!.killed.length).toBeGreaterThan(0)
    expect(d.files.has(PID_FILE)).toBe(false)
    // idempotente
    await s.stop()
    expect(d.spawned).toHaveLength(1)
  })
})

// il temporaneo di questo file si cancella a fine corsa (vincolo: 0 processi,
// 0 file lasciati); i fake spawn non aprono nulla di vero
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

// ---- fase locale correzioni (LC4): la chiave non sta nella riga di comando ----

describe('fase locale correzioni (LC4): la chiave di llama-server non si vede con ps', () => {
  it('nessun --api-key negli argomenti: LLAMA_API_KEY passa SOLO nell\'env del figlio', async () => {
    const d = makeDeps()
    d.setHealthyAfter(1)
    const s = makeServer(d)
    const r = await s.ensureRunning()
    expect(r.apiKey).toBe('key-1') // la chiave esiste ancora, per il turno
    const argv = d.spawned[0]!.args.join(' ')
    expect(argv).not.toContain('--api-key')
    expect(argv).not.toContain('key-1') // da ps non si legge NIENTE della chiave
    expect(d.spawned[0]!.cmd).not.toContain('key-1')
    // l'env del figlio ha la chiave; il processo del daemon NO
    expect(d.spawned[0]!.env?.LLAMA_API_KEY).toBe('key-1')
    expect(process.env.LLAMA_API_KEY).toBeUndefined()
  })

  it('ogni avvio ha la SUA chiave nell\'env del figlio (porta e chiave nuove a ogni start)', async () => {
    const d = makeDeps()
    d.setHealthyAfter(1)
    const s = makeServer(d)
    await s.ensureRunning()
    await s.stop()
    await s.ensureRunning()
    expect(d.spawned).toHaveLength(2)
    expect(d.spawned[0]!.env?.LLAMA_API_KEY).toBe('key-1')
    expect(d.spawned[1]!.env?.LLAMA_API_KEY).toBe('key-2')
  })
})
