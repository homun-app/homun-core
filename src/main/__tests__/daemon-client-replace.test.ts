// RV1 (fase beta.2), punto 5: un daemon VIVO avviato da un eseguibile DIVERSO
// dal bundle corrente — il caso vero dell'installazione beta.1, il daemon
// staccato rimasto acceso dal percorso di App Translocation — viene
// SOSTITUITO, come già i daemon di versione/build diversa (A2). Qui lo si
// prova con lo spawn FINTO iniettato e la riga di comando dichiarata: nessun
// daemon vero, nessuna socket.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { setDataDir, dataDir } from '../../main/store/db'
import { writeDaemonInfo } from '../../daemon/daemon-files'
import { ensureDaemonRunning } from '../../main/daemon-client'
import { setDaemonSpawnContext, resetDaemonSpawnContext } from '../../main/daemon-context'
import { TEST_TMP_BASE } from '../../test-tmp'

// l'eseguibile della UI «buona» e quello della copia translocata (sola lettura)
const GOOD_EXEC = '/Applications/Homun.app/Contents/MacOS/Homun'
const TRANSLOCATED_EXEC =
  '/private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/AppTranslocation/d/Homun.app/Contents/MacOS/Homun'

let dir: string
let live: ChildProcess

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-rv1-replace-'))
  setDataDir(dir)
  dataDir()
  // un processo VIVO qualsiasi: il suo pid sta in daemon.json e commandOf
  // dichiara la riga di comando che avrebbe il daemon translocato
  live = spawn('sleep', ['30'])
  setDaemonSpawnContext({ isPackaged: true, appPath: '/Applications/Homun.app', version: '0.3.1001', buildId: 'b' })
})

afterAll(() => {
  live.kill('SIGKILL')
  resetDaemonSpawnContext()
  rmSync(dir, { recursive: true, force: true })
})

/** Il contesto di ensure con spawn finto e commandOf dichiarata. */
function makeDeps(declaredCmd: string) {
  const askRestart = vi.fn(async () => undefined)
  const spawned: Array<{ command: string; args: string[] }> = []
  const fakeSpawn = ((command: string, args: string[]) => {
    spawned.push({ command, args })
    // il daemon nuovo scrive il suo daemon.json (build GIUSTA, startedAt fresco)
    writeDaemonInfo(dir, { pid: 424242, port: 9, token: 'nuovo', startedAt: Date.now(), version: '0.3.1001', build: 'b' })
    return { unref(): void {} } as unknown as ChildProcess
  }) as typeof spawn
  return {
    askRestart,
    spawned,
    deps: {
      execPath: GOOD_EXEC,
      spawnFn: fakeSpawn,
      commandOf: async (pid: number) => (pid === live.pid ? declaredCmd : null),
      askRestart,
      sleep: () => Promise.resolve()
    }
  }
}

describe('RV1: il daemon vivo da un ALTRO eseguibile viene sostituito', () => {
  it('daemon.json della build GIUSTA ma eseguibile di App Translocation → esce bene e riparte dal bundle corrente', async () => {
    writeDaemonInfo(dir, { pid: live.pid!, port: 1, token: 'vecchio', startedAt: 1, version: '0.3.1001', build: 'b' })
    const { askRestart, spawned, deps } = makeDeps(`${TRANSLOCATED_EXEC} --homun-daemon`)
    const info = await ensureDaemonRunning({ version: '0.3.1001', build: 'b' }, deps)
    // «lo sostituisce con quello giusto»: daemon:restart al vecchio, spawn dal
    // bundle CORRENTE (che in app impacchettata è solo --homun-daemon)
    expect(askRestart).toHaveBeenCalledTimes(1)
    expect(spawned).toEqual([{ command: GOOD_EXEC, args: ['--homun-daemon'] }])
    expect(info.token).toBe('nuovo')
  })

  it('daemon.json con lo STESSO eseguibile del bundle corrente → si riusa, niente restart né spawn', async () => {
    writeDaemonInfo(dir, { pid: live.pid!, port: 1, token: 'bravo', startedAt: 1, version: '0.3.1001', build: 'b' })
    const { askRestart, spawned, deps } = makeDeps(`${GOOD_EXEC} --homun-daemon`)
    const info = await ensureDaemonRunning({ version: '0.3.1001', build: 'b' }, deps)
    expect(askRestart).not.toHaveBeenCalled()
    expect(spawned).toEqual([])
    expect(info.token).toBe('bravo')
  })
})
