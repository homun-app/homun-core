// W2 (fase avvio-finestra): ensureDaemonRunning AVVISA quando ferma un daemon
// vivo per sostituirlo — il motivo ('update' versione/build, 'legacy' fase
// ≤16c, 'path' eseguibile di un'altra copia) arriva al main che lo dice al
// caricamento della finestra. Spawn finto e commandOf dichiarata come
// daemon-client-replace.test.ts: nessun daemon vero, nessuna socket.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { setDataDir } from '../../main/store/db'
import { writeDaemonInfo } from '../../daemon/daemon-files'
import { ensureDaemonRunning, setDaemonRestartListener } from '../../main/daemon-client'
import { setDaemonSpawnContext, resetDaemonSpawnContext } from '../../main/daemon-context'
import { TEST_TMP_BASE } from '../../test-tmp'

const GOOD_EXEC = '/Applications/Homun.app/Contents/MacOS/Homun'
const OTHER_EXEC = '/Applications/Homun vecchia.app/Contents/MacOS/Homun'

let dir: string
let live: ChildProcess

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-w2-restart-'))
  setDataDir(dir)
  live = spawn('sleep', ['30'])
  setDaemonSpawnContext({ isPackaged: true, appPath: '/Applications/Homun.app', version: '0.3.1001', buildId: 'b' })
})

afterAll(() => {
  live.kill('SIGKILL')
  resetDaemonSpawnContext()
  setDaemonRestartListener(null)
  rmSync(dir, { recursive: true, force: true })
})

function makeDeps(declaredCmd: string) {
  const askRestart = vi.fn(async () => undefined)
  const fakeSpawn = (() => {
    writeDaemonInfo(dir, { pid: 424242, port: 9, token: 'nuovo', startedAt: Date.now(), version: '0.3.1001', build: 'b' })
    return { unref(): void {} } as unknown as ChildProcess
  }) as unknown as typeof spawn
  return {
    askRestart,
    deps: {
      execPath: GOOD_EXEC,
      spawnFn: fakeSpawn,
      commandOf: async (pid: number) => (pid === live.pid ? declaredCmd : null),
      askRestart,
      sleep: () => Promise.resolve()
    }
  }
}

describe('W2: ensureDaemonRunning avvisa quando ferma il daemon vivo (per il caricamento)', () => {
  it('versione/build DIVERSI → motivo «update», PRIMA di chiedere l\'uscita', async () => {
    writeDaemonInfo(dir, { pid: live.pid!, port: 1, token: 'vecchio', startedAt: 1, version: '0.3.1000', build: 'altro' })
    const { askRestart, deps } = makeDeps(`${GOOD_EXEC} --homun-daemon`)
    const seen: string[] = []
    setDaemonRestartListener((reason) => seen.push(reason))
    await ensureDaemonRunning({ version: '0.3.1001', build: 'b' }, deps)
    setDaemonRestartListener(null)
    expect(seen).toEqual(['update'])
    expect(askRestart).toHaveBeenCalledTimes(1)
  })

  it('daemon VECCHIO stile (fase ≤16c) → motivo «legacy»', async () => {
    writeDaemonInfo(dir, { pid: live.pid!, port: 1, token: 'antico', startedAt: 1 })
    const { deps } = makeDeps(`${GOOD_EXEC} --type=renderer bundle/daemon.js`)
    const seen: string[] = []
    setDaemonRestartListener((reason) => seen.push(reason))
    await ensureDaemonRunning({ version: '0.3.1001', build: 'b' }, deps)
    setDaemonRestartListener(null)
    expect(seen).toEqual(['legacy'])
  })

  it('stessa build ma eseguibile DI UN\'ALTRA COPIA → motivo «path» (non è un aggiornamento)', async () => {
    writeDaemonInfo(dir, { pid: live.pid!, port: 1, token: 'spostato', startedAt: 1, version: '0.3.1001', build: 'b' })
    const { deps } = makeDeps(`${OTHER_EXEC} --homun-daemon`)
    const seen: string[] = []
    setDaemonRestartListener((reason) => seen.push(reason))
    await ensureDaemonRunning({ version: '0.3.1001', build: 'b' }, deps)
    setDaemonRestartListener(null)
    expect(seen).toEqual(['path'])
  })

  it('daemon GIUSTO riusato → nessun avviso', async () => {
    writeDaemonInfo(dir, { pid: live.pid!, port: 1, token: 'bravo', startedAt: 1, version: '0.3.1001', build: 'b' })
    const { deps } = makeDeps(`${GOOD_EXEC} --homun-daemon`)
    const seen: string[] = []
    setDaemonRestartListener((reason) => seen.push(reason))
    await ensureDaemonRunning({ version: '0.3.1001', build: 'b' }, deps)
    setDaemonRestartListener(null)
    expect(seen).toEqual([])
  })
})
