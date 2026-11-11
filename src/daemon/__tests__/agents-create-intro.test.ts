// B2 (fase beta.4): agents:create (il dialogo «Nuovo») accoda UNA presentazione.
// Il bot creato dal dialogo — SOLO da lì — parte col turno BOT_INTRO se c'è un
// modello utilizzabile; i modelli (agents:create-from-template) e il tool
// create_agent no (quest'ultimo lo prova loop.test.ts). Store reale su
// directory temporanea, providers mockati, nessun LLM, nessuna rete.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async () => { throw new Error('non chiamato in questi test') }
}))

vi.mock('../../main/agent/providers', () => ({
  getProvider: (id: string) =>
    id === 'ollama'
      ? { id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true }
      : undefined,
  modelSupportsTools: async () => ({ ok: true, checked: true })
}))

const { setDataDir, db, listAgents, getAgent, saveProviders, setSetting } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'

const fakeWorker = { poke: () => undefined, drain: async () => undefined, start: () => undefined, stop: () => undefined } as unknown as JobWorker

let dir: string
let api: Record<string, (p: unknown[]) => unknown>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-intro-'))
  setDataDir(dir)
  setSetting('ui.activeLanguage', 'it')
  db()
  saveProviders([{ id: 'ollama', name: 'Ollama (locale)', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true, discovered: true }])
  api = buildApiMethods(() => undefined, fakeWorker)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function introJobsOf(agentId: string) {
  const rows = db().prepare('SELECT kind, payload_json FROM jobs WHERE agent_id = ?').all(agentId) as Array<{ kind: string; payload_json: string }>
  return rows
    .map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload_json) as Record<string, unknown> }))
    .filter((j) => j.payload.initiator === 'BOT_INTRO')
}

describe('B2: agents:create (dialogo) accoda UNA presentazione', () => {
  it('con models.main il bot nasce col nome del dialogo (birthName) e UN job BOT_INTRO', async () => {
    setSetting('models.main', { providerId: 'ollama', model: 'kimi-k3:cloud' })
    const a = (await api['agents:create']!(['Prova', ''])) as { id: string; name: string }
    expect(a.name).toBe('Prova')
    expect(getAgent(a.id)!.birthName).toBe('Prova')
    const jobs = introJobsOf(a.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.kind).toBe('user-message')
    const text = String(jobs[0]!.payload.text)
    expect(text).toContain('You were just created')
    expect(text).toContain('Prova')
  })

  it('SENI modello utilizzabile non parte nessuna presentazione (la chat resta com\'è)', async () => {
    setSetting('models.main', null)
    const a = (await api['agents:create']!(['SenzaModello', ''])) as { id: string }
    expect(introJobsOf(a.id)).toHaveLength(0)
  })

  it('i MODELLI non accodano presentazioni (hanno il loro kickstart)', async () => {
    setSetting('models.main', { providerId: 'ollama', model: 'kimi-k3:cloud' })
    const t = (await api['agents:create-from-template']!(['inbox-manager'])) as { id: string }
    expect(introJobsOf(t.id)).toHaveLength(0)
    const kickstart = db()
      .prepare('SELECT payload_json FROM jobs WHERE agent_id = ?')
      .all(t.id)
      .map((r) => JSON.parse((r as { payload_json: string }).payload_json) as Record<string, unknown>)
      .filter((p) => p.initiator === 'TEMPLATE_IMPORT')
    expect(kickstart).toHaveLength(1)
  })
})
