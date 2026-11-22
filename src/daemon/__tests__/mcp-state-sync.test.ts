// V3 (fase stato-vivo): la nota U5 arriva anche quando un server ESISTENTE
// diventa funzionante (o si rompe). Il daemon ricorda in settings, senza
// tabelle nuove, l'ULTIMO STATO NOTIFICATO di ogni server ('ok' / 'fail'):
// all'avvio e a ogni test periodico, se lo stato cambia — mai notificato,
// si ripara, si rompe — parte la nota ai bot abilitati, UNA volta sola per
// cambio. È il caso dei server importati con la beta.15, prima di U5: la
// nota partiva solo su import/aggiunta/modifica, mai quando un server già
// presente diventava funzionante (per esempio dopo un aggiornamento).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../test-tmp'

const { setDataDir, dataDir, getSetting, createAgent, db } = await import('../../main/store/db')
const { syncMcpServerStates, NOTIFIED_STATE_SETTING } = await import('../mcp-state-sync')
const { notifyMcpServerState } = await import('../api')

let root: string
beforeAll(() => {
  root = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mcpstatesync-test-'))
  setDataDir(root)
  dataDir()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Le dipendenze iniettate: server, esiti dei test e stato notificato finti. */
const mk = (
  servers: Array<{ id: string; enabled?: boolean; needsAuth?: boolean }>,
  tests: Record<string, { ok: boolean; tools?: string[]; error?: string; category?: 'unreachable' | 'startup-error' | 'command-not-found' | 'unknown-error' }>,
  store: Record<string, 'ok' | 'fail'>,
  notifyImpl?: () => Promise<void>
) => {
  const notes: Array<{ cfg: { id: string }; test: { ok: boolean } }> = []
  const tested: string[] = []
  return {
    notes,
    tested,
    deps: {
      listServers: () => servers.map((s) => ({ id: s.id, name: s.id, transport: 'stdio' as const, command: 'x', enabled: s.enabled ?? true, ...(s.needsAuth ? { needsAuth: { kind: 'key' as const, keys: ['K'] } } : {}) })),
      testServer: async (id: string) => {
        tested.push(id)
        return tests[id] ?? { ok: false, error: 'manca' }
      },
      notify: async (cfg: { id: string }, test: { ok: boolean }) => {
        if (notifyImpl) await notifyImpl()
        notes.push({ cfg, test })
      },
      getNotified: () => store,
      setNotified: (m: Record<string, 'ok' | 'fail'>) => {
        for (const k of Object.keys(m)) store[k] = m[k]!
      }
    }
  }
}

describe('V3: syncMcpServerStates — la nota quando un server ESISTENTE cambia stato', () => {
  it('server importato senza notifica, poi il daemon parte e il server FUNZIONA → una nota; lo stato si ricorda', async () => {
    const store: Record<string, 'ok' | 'fail'> = {}
    const tests: Record<string, { ok: boolean; tools?: string[] }> = { 'srv-orion': { ok: true, tools: ['a', 'b'] } }
    const h = mk([{ id: 'srv-orion' }], tests, store)
    const r = await syncMcpServerStates(h.deps, undefined, undefined)
    expect(r).toEqual({ checked: 1, notes: 1 })
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]!.cfg.id).toBe('srv-orion')
    expect(store['srv-orion']).toBe('ok')
  })

  it('riavvio SENZA cambi → NESSUNA nuova nota', async () => {
    const store: Record<string, 'ok' | 'fail'> = {}
    const tests: Record<string, { ok: boolean; tools?: string[] }> = { 'srv-orion': { ok: true, tools: ['a'] } }
    const h = mk([{ id: 'srv-orion' }], tests, store)
    await syncMcpServerStates(h.deps, undefined, undefined)
    const r2 = await syncMcpServerStates(h.deps, undefined, undefined)
    expect(r2.notes).toBe(0)
    expect(h.notes).toHaveLength(1)
  })

  it('server che SI ROMPE → nota «non parte» (categoria X2), una volta sola per cambio', async () => {
    const store: Record<string, 'ok' | 'fail'> = {}
    const tests: Record<string, { ok: boolean; tools?: string[]; error?: string; category?: 'unreachable' | 'startup-error' | 'command-not-found' | 'unknown-error' }> = { 'srv-mm': { ok: true, tools: ['a'] } }
    const h = mk([{ id: 'srv-mm' }], tests, store)
    await syncMcpServerStates(h.deps, undefined, undefined)
    tests['srv-mm'] = { ok: false, error: 'boom', category: 'unreachable' }
    const r3 = await syncMcpServerStates(h.deps, undefined, undefined)
    expect(r3.notes).toBe(1)
    expect(h.notes[1]!.test.ok).toBe(false)
    expect(store['srv-mm']).toBe('fail')
    // e di nuovo: nessuna raffica, il terzo giro non nota
    const r4 = await syncMcpServerStates(h.deps, undefined, undefined)
    expect(r4.notes).toBe(0)
    expect(h.notes).toHaveLength(2)
  })

  it('i server SPENTI e needsAuth non si toccano (né test né nota)', async () => {
    const store: Record<string, 'ok' | 'fail'> = {}
    const h = mk([{ id: 'srv-ok' }, { id: 'srv-off', enabled: false }, { id: 'srv-auth', needsAuth: true }], { 'srv-ok': { ok: true, tools: ['a'] } }, store)
    const r = await syncMcpServerStates(h.deps, undefined, undefined)
    expect(r.checked).toBe(1)
    expect(h.tested).toEqual(['srv-ok'])
  })

  it('nota fallita → lo stato NON si segna: il prossimo giro riprova', async () => {
    const store: Record<string, 'ok' | 'fail'> = {}
    const h = mk([{ id: 'srv-n' }], { 'srv-n': { ok: true, tools: ['a'] } }, store, () => Promise.reject(new Error('queue piena')))
    const r = await syncMcpServerStates(h.deps, undefined, undefined)
    expect(r.notes).toBe(0)
    expect(store['srv-n']).toBeUndefined()
  })
})

describe('V3: notifyMcpServerState ricorda l\'ultimo stato notificato', () => {
  it('dopo la nota il setting mcp.serverNotifiedState porta il nuovo stato', async () => {
    createAgent('Bot stato')
    db().prepare('DELETE FROM jobs').run()
    await notifyMcpServerState({ id: 'srv-stato', name: 'stato', enabledFor: ['*'] }, { ok: true, tools: ['t1'] }, () => undefined, { poke: () => undefined } as never)
    expect(getSetting<Record<string, string>>(NOTIFIED_STATE_SETTING, {})['srv-stato']).toBe('ok')
    await notifyMcpServerState({ id: 'srv-stato', name: 'stato', enabledFor: ['*'] }, { ok: false, error: 'x', category: 'startup-error' }, () => undefined, { poke: () => undefined } as never)
    expect(getSetting<Record<string, string>>(NOTIFIED_STATE_SETTING, {})['srv-stato']).toBe('fail')
  })

  it('il daemon la chiama ALL\'AVVIO e dal tick periodico (guardia sul wiring)', () => {
    const RT = readFileSync(fileURLToPath(new URL('../runtime.ts', import.meta.url)), 'utf8')
    expect(RT).toMatch(/syncDaemonMcpServerStates/)
  })
})
