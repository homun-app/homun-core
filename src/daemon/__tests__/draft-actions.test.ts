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
    verdict: { kind: 'allow', via: 'rule' } as { kind: 'allow' | 'deny' | 'ask'; reason?: string; via?: string },
    // M1: annotazioni correnti del tool che draft:send sta per eseguire
    annotations: undefined as { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } | undefined
  },
  tools: { calls: [] as Array<{ tool: string; args: Record<string, unknown> }>, output: 'email inviata (id 123)', throwWith: null as string | null }
}))

vi.mock('../../main/agent/permissions', () => ({
  check: async () => h.perm.verdict,
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool,
  mcpAnnotationsOf: (tool: string) => h.perm.annotations
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
// D1: prepareDraft è puro (importa solo i tipi shared) — costruisce le bozze
// esattamente come le crea ora il loop per draft_external
const { prepareDraft, DEFAULT_EXTERNAL_SEND_TOOLS } = await import('../../main/agent/external-send')
import type { JobWorker } from '../worker'
import type { SandbotEvent, TranscriptEntry, SendMessagePayload } from '../../shared/types'
import { setSetting } from '../../main/store/db'

const AGENT = 'agent_d'
let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-draft-test-'))
  setDataDir(dir)
  // fase 17c: la lingua dei testi del daemon è l'italiano (come prima)
  setSetting('ui.activeLanguage', 'it')
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
  h.perm.annotations = undefined
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
    // D1: il tool MCP riceve il body MODIFICATO — via.args aggiornato dal campo visibile
    expect(h.tools.calls).toEqual([{ tool: 'mcp__gmail__send_message', args: { to: 'x@esempio.it', subject: 'Oggetto di prova', body: 'corpo modificato inline' } }])
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

describe('D1 (review fase 3): via solo per tool di invio esterno — ciò che vedi è ciò che parte', () => {
  /** Bozza nel transcript costruita da prepareDraft (il payload che ora salva il loop). */
  function mkPreparedDraft(message: SendMessagePayload): TranscriptEntry {
    return appendEntry({
      agentId: AGENT, kind: 'send-message', role: 'assistant',
      content: message.type === 'draft' ? (message.subject || message.to || '') : '',
      meta: { message, status: 'pending' }
    })
  }

  it('bozza nata da draft_external con via run-command (via scartato alla creazione): draft:send rifiuta, il tool NON viene eseguito', async () => {
    const { message } = prepareDraft({
      channel: 'email', to: 'x@y.it', body: 'ciao',
      via: { tool: 'run-command', args: { command: 'rm -rf /' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    const d = mkPreparedDraft(message)
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(h.tools.calls).toHaveLength(0) // il tool finto NON è mai stato eseguito
    expect(getEntries(AGENT).findLast((e) => e.kind === 'notice')?.content).toContain('non ha un tool di invio')
  })

  it('bozza vecchia nel DB con via.tool non di invio (dato precedente alla correzione): draft:send rifiuta in difesa in profondità', async () => {
    const d = appendEntry({
      agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'dato vecchio',
      meta: {
        message: { type: 'draft', channel: 'email', to: 'x@y.it', body: 'ciao', via: { tool: 'run-command', args: { command: 'curl https://esempio/fuga' } } },
        status: 'pending'
      }
    })
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(h.tools.calls).toHaveLength(0)
    expect(getEntries(AGENT).findLast((e) => e.kind === 'notice')?.content).toContain('non è un tool di invio esterno')
    // la bozza resta pending: rifiuto, non scarto
    expect(getEntries(AGENT).find((e) => e.id === d.id)?.meta?.status).toBe('pending')
  })

  it('draft_external con to/body diversi da via.args: si eseguono esattamente gli argomenti salvati e mostrati', async () => {
    const { message } = prepareDraft({
      channel: 'email', to: 'visibile@esempio.it', subject: 'Oggetto', body: 'corpo visibile',
      via: { tool: 'mcp__gmail__send_message', args: { to: 'nascosto@esempio.it', subject: 'Oggetto', body: 'corpo nascosto' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    const d = mkPreparedDraft(message)
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(true)
    // gli argomenti eseguiti coincidono col payload mostrato in card
    expect(h.tools.calls).toEqual([{ tool: 'mcp__gmail__send_message', args: (message as { via: { args: Record<string, unknown> } }).via.args }])
    expect(h.tools.calls[0]!.args).toMatchObject({ to: 'visibile@esempio.it', body: 'corpo visibile' })
    expect(h.tools.calls[0]!.args).not.toMatchObject({ to: 'nascosto@esempio.it' })
  })

  it('body modificato con draft:update: il tool MCP finto riceve il body modificato', async () => {
    const d = mkDraft()
    await api['draft:update']!([AGENT, d.id, 'corpo ritoccato'])
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(h.tools.calls).toEqual([{ tool: 'mcp__gmail__send_message', args: { to: 'x@esempio.it', subject: 'Oggetto di prova', body: 'corpo ritoccato' } }])
  })
})

describe('M1 (fase 0.3.1001): il classificatore per nome vale anche per i server aggiunti a mano', () => {
  /** Bozza con via verso un server manuale "ufficio" NON presente in config. */
  function mkUfficioDraft(): TranscriptEntry {
    const { message } = prepareDraft({
      channel: 'email', to: 'capo@ufficio.it', subject: 'Ordine', body: 'testo',
      via: { tool: 'mcp__ufficio__send_email', args: { to: 'capo@ufficio.it', subject: 'Ordine', body: 'testo' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    return appendEntry({
      agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'Ordine',
      meta: { message, status: 'pending' }
    })
  }

  it('draft:send su una bozza via mcp__ufficio__send_email: ESATTAMENTE una esecuzione con gli argomenti mostrati', async () => {
    const d = mkUfficioDraft()
    expect((getEntries(AGENT).find((e) => e.id === d.id)?.meta?.message as { via?: { tool: string } }).via?.tool).toBe('mcp__ufficio__send_email')
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(h.tools.calls).toEqual([{ tool: 'mcp__ufficio__send_email', args: { to: 'capo@ufficio.it', subject: 'Ordine', body: 'testo' } }])
    expect(getEntries(AGENT).find((e) => e.id === d.id)?.meta?.status).toBe('sent')
  })

  it('via verso un tool che il nome NON classifica come invio (list_emails): rifiutato anche fuori dalla config', async () => {
    const d = appendEntry({
      agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'lettura',
      meta: {
        message: { type: 'draft', channel: 'email', to: 'x@y.it', body: 'ciao', via: { tool: 'mcp__ufficio__list_emails', args: { query: 'x' } } },
        status: 'pending'
      }
    })
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(h.tools.calls).toHaveLength(0)
  })

  it('annotazione readOnlyHint true sul via: il classificatore lo esclude, draft:send rifiuta', async () => {
    h.perm.annotations = { readOnlyHint: true }
    const d = mkUfficioDraft()
    const r = await api['draft:send']!([AGENT, d.id]) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(h.tools.calls).toHaveLength(0)
  })
})
