// Test delle RPC dei template (fase 7): templates:list restituisce il catalogo
// validato; agents:create-from-template crea il bot e accoda il job del
// kickstart (initiator TEMPLATE_IMPORT, testo con context e istruzioni);
// agents:set-main imposta l'unico bot principale. Store reale su directory
// temporanea, nessun LLM.
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

const { setDataDir, db, listAgents, getSetting } = await import('../../main/store/db')
const { listJobs } = await import('../../main/store/jobs')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'

const fakeWorker = { poke: () => undefined, drain: async () => undefined, start: () => undefined, stop: () => undefined } as unknown as JobWorker

let dir: string
let api: Record<string, (p: unknown[]) => unknown>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-tmpl-'))
  setDataDir(dir)
  db()
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

describe('agents:create-from-template (kickstart)', () => {
  it('crea il bot dal template e accoda il job TEMPLATE_IMPORT con context e istruzioni', () => {
    const a = api['agents:create-from-template']!(['inbox-manager']) as { id: string; name: string; description: string }
    expect(a.name).toBe('Gestore della posta in arrivo')
    expect(a.description).toContain('posta')
    expect(listAgents().some((x) => x.id === a.id)).toBe(true)
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

  it('template sconosciuto → errore, nessun agente creato', () => {
    const before = listAgents().length
    expect(() => api['agents:create-from-template']!(['manca'])).toThrow(/template sconosciuto/)
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
