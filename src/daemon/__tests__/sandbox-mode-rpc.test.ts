// MB3 (fase modalita-box): la RPC box:mode-set — la SCELTA dell'utente dalle
// Impostazioni scrive sandbox.mode ('box' | 'host') E sandbox.modeSet = true
// INSIEME (una scelta esplicita non si ribalta MAI: né dalla partenza della
// preparazione di MB1, né dalla migrazione di MB2). Store reale su
// temporanea, come subagents-rpc: nessuno spawn, nessuna rete.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../test-tmp'
import { setDataDir, dataDir, db, getSetting, setSetting } from '../../main/store/db'
import { sandboxMode } from '../../main/sandbox'
import { buildApiMethods } from '../api'
import type { SandbotEvent } from '../../shared/types'

const events: SandbotEvent[] = []
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(
  (e) => events.push(e),
  { poke: () => undefined } as unknown as Parameters<typeof buildApiMethods>[1]
)

beforeAll(() => {
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mb3-rpc-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

describe('MB3: RPC box:mode-set — la scelta scrive mode E modeSet', () => {
  it('«box»: sandbox.mode = \'box\' E sandbox.modeSet = true → sandboxMode() è box', async () => {
    const r = (await api['box:mode-set']!(['box'])) as { mode: string; modeSet: boolean }
    expect(r).toEqual({ mode: 'box', modeSet: true })
    expect(getSetting<string | null>('sandbox.mode', null)).toBe('box')
    expect(getSetting<boolean>('sandbox.modeSet', false)).toBe(true)
    expect(sandboxMode()).toBe('box')
  })

  it('«host»: stessa cosa, con host — e la scelta esplicita resta scritta', async () => {
    await api['box:mode-set']!(['host'])
    expect(getSetting<string | null>('sandbox.mode', null)).toBe('host')
    expect(getSetting<boolean>('sandbox.modeSet', false)).toBe(true)
    expect(sandboxMode()).toBe('host')
  })

  it('un valore che non vale → errore chiaro, NESSUNA scrittura', async () => {
    setSetting('sandbox.mode', 'box')
    await expect(api['box:mode-set']!(['docker'])).rejects.toThrow(/box \| host/)
    await expect(api['box:mode-set']!([42])).rejects.toThrow(/box \| host/)
    expect(getSetting<string | null>('sandbox.mode', null)).toBe('box') // intatto
  })
})
