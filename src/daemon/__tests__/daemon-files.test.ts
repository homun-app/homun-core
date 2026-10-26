// Test del file del token: daemon.json (e il lock) devono nascere già con i
// permessi 0600 — file temporaneo creato ristretto + rename atomico — così il
// token non è mai leggibile ad altri utenti, nemmeno per un istante.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// si osserva il rename per dimostrare che il file NASCE già 0600 (il chmod
// a valle arriverebbe troppo tardi: tra write e chmod il token è leggibile)
const renames: Array<{ from: string; to: string; fromMode: number }> = []
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      renames.push({ from, to, fromMode: statSync(from).mode & 0o777 })
      real.renameSync(from, to)
    }
  }
})

const { writeDaemonInfo, acquireDaemonLock, readDaemonInfo } = await import('../daemon-files')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-daemonfiles-'))
  renames.length = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('daemon.json: scrittura atomica e già ristretta', () => {
  it('il file finale è 0600, nasce da un temp 0600 rinominato, nessun residuo', () => {
    writeDaemonInfo(dir, { pid: 1, port: 2, token: 'segreto', startedAt: 3 })
    expect(statSync(join(dir, 'daemon.json')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['daemon.json']) // nessun file temporaneo
    const r = renames.find((x) => x.to === join(dir, 'daemon.json'))
    expect(r).toBeTruthy()
    expect(r!.from).toContain('.tmp')
    expect(r!.fromMode).toBe(0o600) // il contenuto col token non è mai stato leggibile
  })

  it('round-trip readDaemonInfo', () => {
    writeDaemonInfo(dir, { pid: 11, port: 22, token: 'tk', startedAt: 33 })
    expect(readDaemonInfo(dir)).toEqual({ pid: 11, port: 22, token: 'tk', startedAt: 33 })
  })
})

describe('daemon.lock: stesso trattamento', () => {
  it('lock 0600 via temp+rename, nessun residuo', () => {
    expect(acquireDaemonLock(dir)).toEqual({ ok: true })
    expect(statSync(join(dir, 'daemon.lock')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['daemon.lock'])
    expect(renames.some((x) => x.to === join(dir, 'daemon.lock') && x.fromMode === 0o600 && x.from.includes('.tmp'))).toBe(true)
  })
})
