// Fase box-container (BX4): il motore nelle Impostazioni. La RPC
// box:engine-status (motore in uso, stato del motore Apple in parole,
// selettore), box:engine-set (il selettore cambia il setting), «Accendi»
// (system start --disable-kernel-install, MAI download nascosto) e il
// consenso esplicito al kernel (system kernel set --recommended). La sonda
// dei fatti è SOSTITUIBILE: nessun spawn nei test.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

const { setDataDir, dataDir, db } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
const engine = await import('../../main/sandbox/engine')

const h = vi.hoisted(() => ({ calls: [] as string[][] }))
// la CLI finta: --version e system status rispondono PRONTI (il runner della
// sonda è sostituibile — nessuno spawn nei test)
engine.engineProbeDeps.runCli = async (_file, argv) => {
  h.calls.push(argv)
  if (argv[0] === '--version') return { stdout: 'container 1.7.1', stderr: '', exitCode: 0 }
  if (argv[0] === 'system' && argv[1] === 'status') return { stdout: 'running: true', stderr: '', exitCode: 0 }
  return { stdout: '', stderr: '', exitCode: 0 }
}

import type { JobWorker } from '../worker'
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(() => undefined, { poke: () => undefined } as unknown as JobWorker)

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-box-engine-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

interface EngineStatus {
  setting: string
  chosen: string | null
  appleState: string
}

describe('BX4: la RPC del motore (box:engine-status / engine-set / start / kernel)', () => {
  it('box:engine-status: il motore scelto e lo stato del motore Apple', async () => {
    const r = (await api['box:engine-status']!([])) as EngineStatus
    expect(r.setting).toBe('auto')
    expect(r.appleState).toBe('ready')
    // il Mac di CI/test può non avere docker: chosen dipende da lui, ma con
    // apple READY in auto la scelta è apple-container
    expect(r.chosen).toBe('apple-container')
  })

  it('box:engine-set: il selettore cambia il setting (e un valore assurdo si rifiuta)', async () => {
    const r = (await api['box:engine-set']!(['docker'])) as EngineStatus
    expect(r.setting).toBe('docker')
    expect(r.chosen).toBe('docker')
    const back = (await api['box:engine-set']!(['auto'])) as EngineStatus
    expect(back.setting).toBe('auto')
    await expect(api['box:engine-set']!(['minchia'])).rejects.toThrow()
  })

  it('«Accendi» lancia system start --disable-kernel-install: MAI scaricare il kernel di nascosto', async () => {
    h.calls.length = 0
    const r = await api['box:engine-start']!([])
    expect(r).toEqual({ ok: true })
    expect(h.calls.some((a) => a.join(' ') === 'system start --disable-kernel-install')).toBe(true)
  })

  it('il kernel si installa SOLO col consenso: system kernel set --recommended', async () => {
    h.calls.length = 0
    const r = await api['box:engine-kernel-install']!([])
    expect(r).toEqual({ ok: true })
    expect(h.calls.some((a) => a.join(' ') === 'system kernel set --recommended')).toBe(true)
  })
})

describe('BX4: la sonda dei fatti con la CLI runner finta', () => {
  it('probeBoxEngineFacts: da --version e system status ai fatti (running, kernel)', async () => {
    const facts = await engine.probeBoxEngineFacts()
    expect(facts.containerInstalled).toBe(true)
    expect(facts.containerServiceRunning).toBe(true)
    expect(facts.containerKernelOk).toBe(true)
    expect(facts.platform).toBe('darwin')
    expect(facts.macOsMajor).toBeGreaterThanOrEqual(26) // il Mac di sviluppo
  })
})

describe('OB1 (fase onboarding-b): le RPC della preparazione del computer del bot', () => {
  it('box:setup-*: il controller registrato dal runtime risponde (senza: null)', async () => {
    const calls: string[] = []
    const state: import('../../shared/types').BoxSetupState = { phase: 'awaiting-installer', bytes: null, total: null, buildPhase: null, error: null, startedAt: 1, neededBytes: 1 }
    const stub = {
      state: () => state,
      start: async () => { calls.push('start'); return state },
      cancel: async () => { calls.push('cancel'); return state },
      retry: async () => { calls.push('retry'); return state },
      openInstallerNow: async () => { calls.push('open'); return state },
      resumeAtBoot: async () => undefined
    }
    const withCtl = buildApiMethods(() => undefined, { poke: () => undefined } as unknown as JobWorker, undefined, undefined, { boxSetup: stub })
    expect(await withCtl['box:setup-state']!([])).toBe(state)
    await withCtl['box:setup-start']!([])
    await withCtl['box:setup-cancel']!([])
    await withCtl['box:setup-retry']!([])
    await withCtl['box:setup-open-installer']!([])
    expect(calls).toEqual(['start', 'cancel', 'retry', 'open'])
    // senza controller (daemon vecchio / test minimale): null, mai un crash
    expect(await api['box:setup-state']!([])).toBeNull()
  })
})
