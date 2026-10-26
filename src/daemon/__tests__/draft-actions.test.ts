// Test delle RPC delle bozze (fase 3, §3bis L5): l'invio vero avviene SOLO al
// click su Invia, eseguendo via.tool passando dal gate dei permessi; il
// risultato diventa una notice nel transcript. Store reale su directory
// temporanea, permessi e tool MCP finti.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// stato condiviso coi mock (hoisted)
const h = vi.hoisted(() => ({
  perm: {
    verdict: { kind: 'allow', via: 'rule' } as { kind: 'allow' | 'deny' | 'ask'; reason?: string; via?: string }
  },
  tools: { calls: [] as Array<{ tool: string; args: Record<string, unknown> }>, output: 'email inviata (id 123)', throwWith: null as string | null }
}))

vi.mock('../../main/agent/permissions', () => ({
  check: async () => h.perm.verdict,
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async (_agentId: string, tool: string, args: Record<string, unknown>) => {
    h.tools.calls.push({ tool, args })
    if (h.tools.throwWith) throw new Error(h.tools.throwWith)
    return { output: h.tools.output, meta: { mcp: true } }
  }
}))

const { setDataDir, dataDir, db, getEntries, appendEntry } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent, TranscriptEntry } from '../../shared/types'

const AGENT = 'agent_d'
let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-draft-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

/** Crea una bozza nel transcript e la ritorna. */
function mkDraft(): TranscriptEntry {
  return appendEntry({
    agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'Oggetto di prova',
    meta: {
      message: {
        type: 'draft', channel: 'email', to: 'x@esempio.it', subject: 'Oggetto di prova', body: 'corpo originale',
        via: { tool: 'mcp__gmail__send_message', args: { to: 'x@esempio.it', subject: 'Oggetto di prova', body: 'corpo originale' } }
      },
      status: 'pending'
    }
  })
}

beforeEach(() => {
  events = []
  h.perm.verdict = { kind: 'allow', via: 'rule' }
  h.tools.calls = []
  h.tools.output = 'email inviata (id 123)'
  h.tools.throwWith = null
  const d = db()
  d.exec('DELETE FROM jobs')
  d.exec('DELETE FROM entries')
})

describe('draft:send — l\'invio avviene SOLO al click, via gate', () => {
  it('click su Invia: esegue via.tool, status sent, esito come notice', async () => {
    const d = mkDraft()
    const r = await api['draft:send']!([AGENT, d.id, 'corpo modificato inline']) as { ok: boolean }
    expect(r.ok).toBe(true)
    // il tool MCP è stato chiamato CON GLI ARGOMENTI ORIGINALI della bozza
    expect(h.tools.calls).toEqual([{ tool: 'mcp__gmail__send_message', args: { to: 'x@esempio.it', subject: 'Oggetto di prova', body: 'corpo originale' } }])
    const after = getEntries(AGENT).find((e) => e.id === d.id)!
    expect(after.meta?.status).toBe('sent')
    expect((after.meta?.message as { body: string }).body).toBe('corpo modificato inline') // body editato persistito
    const notice = getEntries(AGENT).findLast((e) => e.kind === 'notice')!
    expect(notice.content).toContain('Bozza inviata')
    expect(notice.content).toContain('email inviata (id 123)')
  })

  it('gate deny: il tool NON parte, la bozza resta pending, notice di blocco', async () => {
    h.perm.verdict = { kind: 'deny', reason: 'regola blocked' }
    const d = mkDraft()
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(h.tools.calls).toHaveLength(0)
    expect(getEntries(AGENT).find((e) => e.id === d.id)?.meta?.status).toBe('pending')
    expect(getEntries(AGENT).findLast((e) => e.kind === 'notice')?.content).toContain('bloccato dai permessi')
  })

  it('errore del tool: status error, notice con l\'errore, nessun crash', async () => {
    h.tools.throwWith = 'quota Gmail esaurita'
    const d = mkDraft()
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(h.tools.calls).toHaveLength(1) // ci ha provato
    expect(getEntries(AGENT).find((e) => e.id === d.id)?.meta?.status).toBe('error')
    const notice = getEntries(AGENT).findLast((e) => e.kind === 'notice')!
    expect(notice.content).toContain('quota Gmail esaurita')
    // e si può riprovare: status error non chiude la bozza
    h.tools.throwWith = null
    const again = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(again.ok).toBe(true)
    expect(getEntries(AGENT).find((e) => e.id === d.id)?.meta?.status).toBe('sent')
  })

  it('bozza senza via: notice esplicita, nessuna esecuzione', async () => {
    const d = appendEntry({
      agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'bozza testuale',
      meta: { message: { type: 'draft', channel: 'other', to: '', body: 'solo testo' }, status: 'pending' }
    })
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(h.tools.calls).toHaveLength(0)
    expect(getEntries(AGENT).findLast((e) => e.kind === 'notice')?.content).toContain('non ha un tool di invio')
  })
})

describe('draft:discard / draft:update', () => {
  it('discard: status discarded e la successiva send rifiuta', async () => {
    const d = mkDraft()
    await api['draft:discard']!([AGENT, d.id])
    expect(getEntries(AGENT).find((e) => e.id === d.id)?.meta?.status).toBe('discarded')
    await expect(api['draft:send']!([AGENT, d.id])).rejects.toThrow('già scartata')
    expect(h.tools.calls).toHaveLength(0)
  })

  it('update: persiste il body modificato senza inviare', async () => {
    const d = mkDraft()
    await api['draft:update']!([AGENT, d.id, 'nuovo corpo'])
    const after = getEntries(AGENT).find((e) => e.id === d.id)!
    expect((after.meta?.message as { body: string }).body).toBe('nuovo corpo')
    expect(after.meta?.status).toBe('pending') // ancora in attesa
    expect(h.tools.calls).toHaveLength(0)
  })
})
