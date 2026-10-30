// Test delle RPC dei template (fase 7): templates:list restituisce il catalogo
// validato; agents:create-from-template crea il bot e accoda il job del
// kickstart (initiator TEMPLATE_IMPORT, testo con context e istruzioni);
// agents:set-main imposta l'unico bot principale. Store reale su directory
// temporanea, nessun LLM.
// Fase 9 (punto 1): al bot da template vanno provider attivo e defaultModel,
// con la capability "tools" verificata (providers mockato, niente rete).
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

// fase 9 (punto 1): il capability check è controllabile dai test
const capability = vi.hoisted(() => ({ ok: true }))
vi.mock('../../main/agent/providers', () => ({
  getProvider: (id: string) =>
    id === 'ollama'
      ? { id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true }
      : undefined,
  modelSupportsTools: async (_p: unknown, model: string) =>
    capability.ok
      ? { ok: true, checked: true }
      : { ok: false, checked: true, error: `il modello "${model}" non supporta i tool (capability "tools" assente)` }
}))

const { setDataDir, db, listAgents, getSetting, saveProviders } = await import('../../main/store/db')
const { listJobs } = await import('../../main/store/jobs')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import { setSetting } from '../../main/store/db'

const fakeWorker = { poke: () => undefined, drain: async () => undefined, start: () => undefined, stop: () => undefined } as unknown as JobWorker

let dir: string
let api: Record<string, (p: unknown[]) => unknown>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-tmpl-'))
  setDataDir(dir)
  // fase 17c: la lingua dei testi del daemon è l'italiano (come prima)
  setSetting('ui.activeLanguage', 'it')
  db()
  saveProviders([{ id: 'ollama', name: 'Ollama (locale)', kind: 'ollama', baseUrl: 'http://x', apiKey: '', enabled: true, discovered: true }])
  api = buildApiMethods(() => undefined, fakeWorker)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('templates:list', () => {
  it('restituisce i 6 template validati', () => {
    const all = api['templates:list']!([]) as Array<{ id: string }>
    expect(all.map((t) => t.id).sort()).toEqual(
      ['chief-of-staff', 'daily-briefing', 'executive-assistant', 'inbox-manager', 'meeting-prep', 'mention-monitor']
    )
  })
})

function jobsOf(agentId: string) {
  const rows = db().prepare('SELECT kind, payload_json FROM jobs WHERE agent_id = ? ORDER BY id').all(agentId) as Array<{ kind: string; payload_json: string }>
  return rows.map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload_json) as Record<string, unknown> }))
}

describe('agents:create-from-template (kickstart)', () => {
  it('crea il bot dal template e accoda il job TEMPLATE_IMPORT con context e istruzioni', async () => {
    capability.ok = true
    const a = (await api['agents:create-from-template']!(['inbox-manager'])) as { id: string; name: string; description: string }
    expect(a.name).toBe('Gestore della posta in arrivo')
    expect(a.description).toContain('posta')
    const created = listAgents().find((x) => x.id === a.id)!
    expect(listAgents().some((x) => x.id === a.id)).toBe(true)
    // fase 9 (punto 1): provider attivo + defaultModel (capability verificata)
    expect(created.providerId).toBe('ollama')
    expect(created.model).toBe('kimi-k3:cloud')
    // il kickstart è un job della coda: un riavvio lo riprende (fase 2)
    const jobs = listJobs(db()).filter((j) => j.agent_id === a.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.kind).toBe('user-message')
    expect(jobs[0]!.payload.initiator).toBe('TEMPLATE_IMPORT')
    expect(jobs[0]!.payload.extraMeta).toEqual({ templateName: 'Gestore della posta in arrivo' })
    const text = String(jobs[0]!.payload.text)
    expect(text).toContain('<bot_template_setup_context>')
    expect(text).toContain('"routines"')
    expect(text).toContain('<bot_template_setup_instructions>')
    expect(text).toMatch(/1\. Presentati/)
  })

  it('fase 9 (punto 1): default SENZA capability "tools" → provider sì, modello NON assegnato', async () => {
    capability.ok = false
    try {
      const a = (await api['agents:create-from-template']!(['daily-briefing'])) as { id: string }
      const created = listAgents().find((x) => x.id === a.id)!
      expect(created.providerId).toBe('ollama')
      expect(created.model).toBeNull()
    } finally {
      capability.ok = true
    }
  })

  it('fase 17c (C4/C5): con agent.userLanguage=en il bot nasce inglese e il kickstart è inglese', async () => {
    setSetting('agent.userLanguage', 'en')
    try {
      const api = buildApiMethods(() => undefined, fakeWorker)
      const a = await (api['agents:create-from-template'] as (p: unknown[]) => Promise<{ id: string; name: string; description: string }>)(['inbox-manager'])
      expect(a.name).toBe('Inbox manager')
      expect(a.description).toContain('Sorts the morning mail')
      const job = jobsOf(a.id)[0]!
      expect(job.kind).toBe('user-message')
      expect((job.payload as { initiator?: string }).initiator).toBe('TEMPLATE_IMPORT')
      const text = (job.payload as { text: string }).text
      expect(text).toContain('Hi Inbox manager.')
      expect(text).toContain('1. Introduce yourself')
      // in italiano resta italiano
      setSetting('agent.userLanguage', 'it')
      const it = await (api['agents:create-from-template'] as (p: unknown[]) => Promise<{ id: string; name: string }>)(['inbox-manager'])
      expect(it.name).toBe('Gestore della posta in arrivo')
      expect(jobsOf(it.id)[0]!.payload).toMatchObject({ text: expect.stringContaining('Ciao Gestore della posta in arrivo.') })
    } finally {
      setSetting('agent.userLanguage', 'it')
    }
  })

  it('template sconosciuto → errore, nessun agente creato', async () => {
    const before = listAgents().length
    await expect(api['agents:create-from-template']!(['manca'])).rejects.toThrow(/template sconosciuto/)
    expect(listAgents()).toHaveLength(before)
  })
})

describe('agents:set-main (un solo bot principale)', () => {
  it('imposta mainAgentId e il cambio SOSTITUISCE (mai due principali)', () => {
    const [first] = listAgents()
    const second = api['agents:create']!(['Secondo', '']) as { id: string }
    api['agents:set-main']!([second.id])
    expect(getSetting<string | null>('mainAgentId', null)).toBe(second.id)
    api['agents:set-main']!([first!.id])
    expect(getSetting<string | null>('mainAgentId', null)).toBe(first!.id) // uno solo
    expect(() => api['agents:set-main']!(['agent_manca'])).toThrow(/non trovato/)
  })
})

// fase 9 (punto 1): prima di assegnare un modello a un agente la capability
// "tools" viene verificata; senza → errore leggibile e nessuna assegnazione
describe('agents:update: capability "tools" del modello', () => {
  it('modello senza "tools" → errore leggibile, il modello non cambia', async () => {
    capability.ok = false
    try {
      const agent = listAgents().find((a) => a.providerId === 'ollama')!
      const before = agent.model
      await expect(api['agents:update']!([agent.id, { model: 'emb-only' }])).rejects.toThrow(/non supporta i tool/)
      const after = listAgents().find((a) => a.id === agent.id)!
      expect(after.model).toBe(before)
    } finally {
      capability.ok = true
    }
  })

  it('modello con "tools" → assegnato; patch senza modello non fa controlli', async () => {
    const agent = listAgents().find((a) => a.providerId === 'ollama')!
    await api['agents:update']!([agent.id, { model: 'kimi-k3:cloud' }])
    expect(listAgents().find((a) => a.id === agent.id)!.model).toBe('kimi-k3:cloud')
    // una patch che non tocca provider/modello non chiama il check
    capability.ok = false
    try {
      await api['agents:update']!([agent.id, { description: 'solo descrizione' }])
      expect(listAgents().find((a) => a.id === agent.id)!.description).toBe('solo descrizione')
    } finally {
      capability.ok = true
    }
  })
})
