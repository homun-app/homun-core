// Test della validazione dei trigger (fase 7, residuo 0a): un connector_poll
// su un server MCP NON del catalogo (aggiunto a mano) viene rifiutato senza
// la conferma esplicita userConfirmedReadOnly; per i server del catalogo la
// conferma non serve. Store reale su directory temporanea, client MCP finto.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// server MCP finti: uno del catalogo (catalogId) e uno manuale
const h = vi.hoisted(() => ({
  mcp: {
    servers: [] as Array<{ id: string; name: string; catalogId?: string }>,
    tools: {} as Record<string, Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean } }>>
  }
}))

vi.mock('../../main/mcp', () => ({
  listServers: () => h.mcp.servers,
  toolsOfServer: async (id: string) => {
    if (!h.mcp.servers.some((s) => s.id === id)) throw new Error('server not found')
    return h.mcp.tools[id] ?? []
  }
}))

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async () => { throw new Error('non chiamato in questi test') }
}))

const { setDataDir, db } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import { setSetting } from '../../main/store/db'

const fakeWorker = { poke: () => undefined, drain: async () => undefined, start: () => undefined, stop: () => undefined } as unknown as JobWorker

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-triggerval-'))
  setDataDir(dir)
  // fase 17c: la lingua dei testi del daemon è l'italiano (come prima)
  setSetting('ui.activeLanguage', 'it')
  db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const READ_ONLY_TOOL = [{ name: 'mcp__demo__search', description: 'cerca', annotations: { readOnlyHint: true } }]

describe('validateTrigger: poll su server non del catalogo (residuo 0a)', () => {
  it('server del catalogo con tool readOnly: trigger ammesso senza conferma', async () => {
    h.mcp.servers = [{ id: 'cloudflare', name: 'Cloudflare', catalogId: 'cloudflare' }]
    h.mcp.tools = { cloudflare: READ_ONLY_TOOL }
    const api = buildApiMethods(() => undefined, fakeWorker)
    const trigger = {
      type: 'connector_poll', connectorId: 'cloudflare', tool: 'mcp__demo__search',
      intervalMin: 5, idField: 'items[].id'
    }
    await expect(
      (api['routines:create-trigger'] as (p: unknown[]) => Promise<unknown>)(['a1', 'T', 'p', trigger, ''])
    ).resolves.toBeTruthy()
  })

  it('server manuale SENZA userConfirmedReadOnly: rifiuto con messaggio chiaro', async () => {
    h.mcp.servers = [{ id: 'mio-server', name: 'Mio Server' }] // nessun catalogId
    h.mcp.tools = { 'mio-server': READ_ONLY_TOOL }
    const api = buildApiMethods(() => undefined, fakeWorker)
    const trigger = {
      type: 'connector_poll', connectorId: 'mio-server', tool: 'mcp__demo__search',
      intervalMin: 5, idField: 'items[].id'
    }
    await expect(
      (api['routines:create-trigger'] as (p: unknown[]) => Promise<unknown>)(['a1', 'T', 'p', trigger, ''])
    ).rejects.toThrow(/userConfirmedReadOnly/)
  })

  it('server manuale CON userConfirmedReadOnly e tool readOnly: ammesso', async () => {
    h.mcp.servers = [{ id: 'mio-server', name: 'Mio Server' }]
    h.mcp.tools = { 'mio-server': READ_ONLY_TOOL }
    const api = buildApiMethods(() => undefined, fakeWorker)
    const trigger = {
      type: 'connector_poll', connectorId: 'mio-server', tool: 'mcp__demo__search',
      intervalMin: 5, idField: 'items[].id', userConfirmedReadOnly: true
    }
    await expect(
      (api['routines:create-trigger'] as (p: unknown[]) => Promise<unknown>)(['a1', 'T', 'p', trigger, ''])
    ).resolves.toBeTruthy()
  })

  it('la modifica di un trigger esistente segue la stessa regola (update-trigger)', async () => {
    h.mcp.servers = [{ id: 'cloudflare', name: 'Cloudflare', catalogId: 'cloudflare' }]
    h.mcp.tools = { cloudflare: READ_ONLY_TOOL }
    const api = buildApiMethods(() => undefined, fakeWorker)
    const created = await (api['routines:create-trigger'] as (p: unknown[]) => Promise<{ id: number }>)([
      'a1', 'T', 'p', { type: 'connector_poll', connectorId: 'cloudflare', tool: 'mcp__demo__search', intervalMin: 5, idField: 'items[].id' }, ''
    ])
    // spostato su un server manuale senza conferma → rifiuto
    await expect(
      (api['routines:update-trigger'] as (p: unknown[]) => Promise<unknown>)([
        created.id, { trigger: { type: 'connector_poll', connectorId: 'altro', tool: 'mcp__demo__search', intervalMin: 5, idField: 'items[].id' } }
      ])
    ).rejects.toThrow(/non raggiungibile|userConfirmedReadOnly/)
  })
})
