// Fase box-container (BX6): la verifica del ticket di notarizzazione
// (stapler validate) RIPROVA fino a 3 volte con attesa crescente (10 s,
// 30 s), SOLO per gli errori di RETE di CloudKit — la CI della beta.4 è
// caduta solo per quello (errore 68, NSURLErrorDomain -1005, «network
// connection was lost») e il rilancio è passato. Classificazione PURA e
// piano di retry con exec e sleep INIETTABILI: nessuna firma, nessuna rete.
import { describe, expect, it } from 'vitest'
import {
  isNotarizationNetworkError,
  STAPLER_RETRY_DELAYS_MS,
  runStaplerValidate
} from '../verify-release.mjs'

/** L'exec del validate (stessa forma di defaultExec dello script). */
type ExecLike = (cmd: string, args: string[]) => { status: number; out: string }

/** Un exec finto con uno script di risposte (per chiamata). */
const fakeExec = (script: Array<{ status: number; out: string }>): { exec: ExecLike; calls: string[][]; sleeps: number[] } => {
  const calls: string[][] = []
  const sleeps: number[] = []
  let i = 0
  const exec: ExecLike = (cmd, args) => {
    calls.push([cmd, ...args])
    const step = script[Math.min(i++, script.length - 1)]!
    return { status: step.status, out: step.out }
  }
  const sleep = async (ms: number) => { sleeps.push(ms) }
  return { exec, calls, sleeps, sleep }
}

describe('BX6: la classificazione degli errori di rete di stapler (pura)', () => {
  it('i guasti di RETE si riprovano: -1005, -1001, «network connection was lost», timeout', () => {
    expect(isNotarizationNetworkError('…NSURLErrorDomain error -1005…')).toBe(true)
    expect(isNotarizationNetworkError('Error Domain=NSURLErrorDomain Code=-1001')).toBe(true)
    expect(isNotarizationNetworkError('the network connection was lost.')).toBe(true)
    expect(isNotarizationNetworkError('The request timed out.')).toBe(true)
    expect(isNotarizationNetworkError('xcrun: error: stapler validate timed out')).toBe(true)
  })

  it('TUTTO il resto fallisce SUBITO come oggi: mai retry alla cieca', () => {
    expect(isNotarizationNetworkError('Could not find ticket')).toBe(false)
    expect(isNotarizationNetworkError('the staple and validate transaction failed')).toBe(false)
    expect(isNotarizationNetworkError('')).toBe(false)
    // -1005 dentro un numero d'errore DIVERSO non è rete (errore 68 di
    // CloudKit col dominio NSURLErrorDomain lo è; qui il testo conta)
    expect(isNotarizationNetworkError('exit 68')).toBe(false)
    // un -10050 non è -1005: il numero va intero
    expect(isNotarizationNetworkError('code -10050')).toBe(false)
  })
})

describe('BX6: il piano di retry (10 s, 30 s — fino a 3 corse in tutto)', () => {
  it('le attese crescenti sono 10 s e 30 s', () => {
    expect(STAPLER_RETRY_DELAYS_MS).toEqual([10_000, 30_000])
  })

  it('errore di rete Poi OK: seconda corsa dopo 10 s, validate riuscito', async () => {
    const f = fakeExec([
      { status: 68, out: 'Error Domain=NSURLErrorDomain Code=-1005 "network connection was lost"' },
      { status: 0, out: 'The validate action worked!' }
    ])
    const r = await runStaplerValidate({ exec: f.exec, sleep: f.sleep, appPath: '/x/Homun.app' })
    expect(r.ok).toBe(true)
    expect(f.calls.length).toBe(2)
    expect(f.sleeps).toEqual([10_000])
  })

  it('rete giù per TUTTE le corse: 3 chiamate (10 s, 30 s), poi fallisce col testo ultimo', async () => {
    const f = fakeExec([
      { status: 68, out: 'NSURLErrorDomain -1005 network connection was lost' },
      { status: 68, out: 'NSURLErrorDomain -1001 timed out' },
      { status: 68, out: 'NSURLErrorDomain -1005 network connection was lost (ancora)' }
    ])
    const r = await runStaplerValidate({ exec: f.exec, sleep: f.sleep, appPath: '/x/Homun.app' })
    expect(r.ok).toBe(false)
    expect(f.calls.length).toBe(3)
    expect(f.sleeps).toEqual([10_000, 30_000])
    expect(r.error).toContain('network connection was lost (ancora)')
  })

  it('errore che NON è di rete: UNA sola corsa, fallisce subito (come oggi)', async () => {
    const f = fakeExec([{ status: 65, out: 'Could not find ticket' }])
    const r = await runStaplerValidate({ exec: f.exec, sleep: f.sleep, appPath: '/x/Homun.app' })
    expect(r.ok).toBe(false)
    expect(f.calls.length).toBe(1)
    expect(f.sleeps).toEqual([])
    expect(r.error).toContain('Could not find ticket')
  })

  it('il comando è sempre xcrun stapler validate <app>', async () => {
    const f = fakeExec([{ status: 0, out: 'ok' }])
    await runStaplerValidate({ exec: f.exec, sleep: f.sleep, appPath: '/x/Homun.app' })
    expect(f.calls[0]).toEqual(['xcrun', 'stapler', 'validate', '/x/Homun.app'])
  })
})
