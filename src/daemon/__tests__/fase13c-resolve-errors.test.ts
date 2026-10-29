// Test delle RPC di fase 13 correzioni 2 (M5): l'installazione che LANCIA
// un'eccezione non lascia la card in 'installing' per sempre — diventa status
// 'error' col messaggio, il bot riceve il [sistema] e il click successivo non
// risponde "installazione in corso". Store reale su directory temporanea,
// deps d'installazione iniettati che throwano, come in fase8-rpc.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  tools: { calls: [] as Array<{ tool: string; args: Record<string, unknown> }> }
}))

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async (_agentId: string, tool: string, args: Record<string, unknown>) => {
    h.tools.calls.push({ tool, args })
    return { output: 'ok', meta: {} }
  }
}))

const { setDataDir, dataDir, db, getEntries, appendEntry, getSetting, createAgent } = await import('../../main/store/db')
const { listJobs } = await import('../../main/store/jobs')
const { buildApiMethods } = await import('../api')
const { setInstallDeps } = await import('../../main/connectors/install-bridge')
import type { JobWorker } from '../worker'
import type { SandbotEvent, TranscriptEntry, SendMessagePayload } from '../../shared/types'

const AGENT = 'agent_m5'
let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-fase13c-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

/** Una card in chat (entry send-message col meta.message), come la crea il tool. */
function mkProposal(message: SendMessagePayload): TranscriptEntry {
  return appendEntry({ agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'proposta', meta: { message } })
}

/** I deps d'installazione che lanciano dove la specifica li vuole (M5). */
const throwingDeps = () => ({
  store: {
    read: async () => undefined,
    write: async () => undefined,
    remove: async () => undefined,
    removeAll: async () => undefined
  },
  marketplaces: {
    findPlugin: async (): Promise<never> => { throw new Error('boom del marketplace') },
    cloneOf: () => null,
    list: () => []
  },
  findRegistryEntry: async (): Promise<never> => { throw new Error('boom del registro') },
  listServers: () => [],
  saveServers: () => undefined,
  toolsOfServer: async () => [],
  openExternal: async () => undefined,
  hasUi: () => true,
  dockerMode: () => true,
  dataDir: () => dataDir(),
  onChange: () => undefined
})

beforeEach(() => {
  events = []
  db().exec('DELETE FROM entries')
  db().exec('DELETE FROM jobs')
  db().exec('DELETE FROM agents')
  db().exec("DELETE FROM settings WHERE key LIKE 'connectors.%'")
  createAgent('M5', '', { id: AGENT })
})

describe('M5: un\'installazione che lancia NON lascia la card in installing', () => {
  it('connectors:resolve-mcp-server: l\'eccezione diventa status error + [sistema] NON aggiunto; il click dopo non dice "in corso"', async () => {
    setInstallDeps(throwingDeps() as never)
    const p = mkProposal({
      type: 'mcp-server', id: 'registry:com.esempio/mcp', name: 'com.esempio/mcp', publisher: 'com.esempio',
      trust: 'non verificato', trustKind: 'unverified', runtime: { kind: 'remote', host: 'mcp.esempio.com' },
      needs: { kind: 'oauth' }, thirdPartyWarning: true
    })
    const r = await api['connectors:resolve-mcp-server']!([AGENT, p.id, 'add']) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom del registro')
    // la card è in stato ERROR (non installing) e l'errore è nel meta
    const entry = getEntries(AGENT).find((e) => e.id === p.id)!
    expect(entry.meta?.status).toBe('error')
    expect(String(entry.meta?.error)).toContain('boom del registro')
    // il bot riceve il [sistema]: accodato come job user-message (il testo
    // del messaggio che girrà al prossimo turno)
    const sys = listJobs(db()).find((j) => j.kind === 'user-message')
    expect(String((sys?.payload as { text?: string })?.text)).toContain('NON aggiunto: boom del registro')
    // il click SUCCESSIVO non dice "installazione in corso": la card in error
    // si può cliccare di nuovo (retry), non è incollata a installing (M5)
    const r2 = await api['connectors:resolve-mcp-server']!([AGENT, p.id, 'add']) as { ok: boolean }
    expect(r2.ok).toBe(false)
    expect(String(getEntries(AGENT).find((e) => e.id === p.id)!.meta?.status)).toBe('error')
  })

  it('plugins:resolve: l\'eccezione diventa status error + [sistema] NON installato; il click dopo non dice "in corso"', async () => {
    setInstallDeps(throwingDeps() as never)
    const p = mkProposal({
      type: 'plugin', id: 'plugin:demo@mp', name: 'demo', marketplace: 'mp', trust: 'marketplace aggiunto da te',
      sha12: 'abc123def456', skills: [], servers: [], settings: [], ignored: []
    })
    const r = await api['plugins:resolve']!([AGENT, p.id, 'install']) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom del marketplace')
    const entry = getEntries(AGENT).find((e) => e.id === p.id)!
    expect(entry.meta?.status).toBe('error')
    expect(String(entry.meta?.error)).toContain('boom del marketplace')
    const sys = listJobs(db()).find((j) => j.kind === 'user-message')
    expect(String((sys?.payload as { text?: string })?.text)).toContain('NON installato: boom del marketplace')
    // il click SUCCESSIVO riprova (niente "installazione in corso") e la card
    // resta in error, non in installing
    const r2 = await api['plugins:resolve']!([AGENT, p.id, 'install']) as { ok: boolean }
    expect(r2.ok).toBe(false)
    expect(String(getEntries(AGENT).find((e) => e.id === p.id)!.meta?.status)).toBe('error')
    // e i settings dei connettori non sono stati toccati dall'installazione morta
    expect(getSetting('connectors.plugins', [])).toEqual([])
  })
})
