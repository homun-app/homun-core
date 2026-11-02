// Fase rilascio (A2): il daemon.json porta version e build; la UI confronta
// i SUOI con quelli e, diversi, chiede al daemon di uscire BENE (RPC
// daemon:restart) e lo rilancia. Qui: il confronto PURO, il giro di
// daemon.json e la SEQUENZA con un daemon finto (server ws reale su
// 127.0.0.1 che risponde alla RPC e muore).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonMatchesBuild, writeDaemonInfo, readDaemonInfo, type DaemonBuild } from '../daemon-files'
import { askDaemonToRestart } from '../../main/daemon-client'
import { startWsServer } from '../ws-server'
import { spawn } from 'node:child_process'

// cartelle temporanee SOLO con mkdtemp nella directory fissata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'

describe('fase rilascio (A2): confronto version/build (puro)', () => {
  const mine: DaemonBuild = { version: '0.3.0', build: 'b1' }

  it('stessa versione e stesso build → si riusa il daemon', () => {
    expect(daemonMatchesBuild({ version: '0.3.0', build: 'b1' }, mine)).toBe(true)
  })

  it('versione diversa → si riavvia (0.2.1004 → 0.3.0 è il caso vero)', () => {
    expect(daemonMatchesBuild({ version: '0.2.1004', build: 'b1' }, mine)).toBe(false)
    expect(daemonMatchesBuild({ version: '0.3.0', build: 'altro' }, mine)).toBe(false)
  })

  it('daemon.json SENZA versione/build (fase ≤16c) non coincide MAI', () => {
    expect(daemonMatchesBuild({}, mine)).toBe(false)
    expect(daemonMatchesBuild({ version: '0.3.0' }, mine)).toBe(false)
  })
})

describe('fase rilascio (A2): daemon.json porta version e build', () => {
  const dir = mkdtempSync(join(TMP_BASE, 'sandbot-a2-'))

  it('scrittura e rilettura complete (0600, campi compresi)', () => {
    writeDaemonInfo(dir, { pid: 42, port: 1234, token: 't', startedAt: 1, version: '0.3.0', build: 'xyz' })
    const info = readDaemonInfo(dir)
    expect(info).toEqual({ pid: 42, port: 1234, token: 't', startedAt: 1, version: '0.3.0', build: 'xyz' })
  })

  it('i file vecchi (senza version/build) si leggono lo stesso', () => {
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ pid: 7, port: 8, token: 'x', startedAt: 9 }))
    const info = readDaemonInfo(dir)
    expect(info?.pid).toBe(7)
    expect(info?.version).toBeUndefined()
    expect(info?.build).toBeUndefined()
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})

describe('fase rilascio (A2): sequenza con un daemon finto', () => {
  const dir = mkdtempSync(join(TMP_BASE, 'sandbot-a2-seq-'))
  let restartAsked = 0
  // un processo che MUORE subito: il suo pid resta come «daemon in vita no»
  const dead = spawn('true')
  const deadPid: number = dead.pid!

  beforeAll(async () => {
    const server = await startWsServer({
      token: 'tok',
      onUiChange: () => undefined
    })
    server.methods = {
      'daemon:describe': () => ({ pid: process.pid, version: '0.2.1004', build: 'old' }),
      'daemon:restart': () => {
        restartAsked++
        return { ok: true }
      }
    }
    writeDaemonInfo(dir, { pid: deadPid, port: server.port, token: 'tok', startedAt: Date.now(), version: '0.2.1004', build: 'old' })
    // chiudi il server alla fine della suite
    afterAll(() => void server.close())
  })

  it("la UI chiede daemon:restart al daemon vecchio e ne aspetta l'uscita", async () => {
    const info = readDaemonInfo(dir)!
    expect(daemonMatchesBuild(info, { version: '0.3.0', build: 'new' })).toBe(false)
    await askDaemonToRestart(dir, info, 5_000)
    expect(restartAsked).toBe(1)
  })

  it('un pid già morto: la richiesta va comunque ma l\'attesa finisce subito', async () => {
    const info = readDaemonInfo(dir)!
    await askDaemonToRestart(dir, info, 5_000)
    expect(restartAsked).toBe(2)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})
