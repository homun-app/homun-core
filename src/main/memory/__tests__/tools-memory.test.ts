// Fase memoria-engramma (M3): gli strumenti del bot sul motore — stessa
// interfaccia verso il modello (update_memory write/update/delete,
// recall_memory, update_state target memory, facciata memory), sotto il
// memory-store su Engramma. Qui executeTool con il contesto del turno VERO
// (contaminated, userTurn, turnEntryId) come lo passa il loop.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-tools-'))
const DATA = join(ROOT, 'data')
const AGENT = 'agent_t00l5'

beforeAll(async () => {
  const { setDataDir } = await import('../../store/db')
  setDataDir(DATA)
  const { openMemoryEngine } = await import('../engine')
  expect((await openMemoryEngine({ dataDir: DATA })).available).toBe(true)
})
afterAll(async () => {
  const { closeMemoryEngine } = await import('../engine')
  await closeMemoryEngine()
  rmSync(ROOT, { recursive: true, force: true })
})

const exec = async (tool: string, input: Record<string, unknown>, ctx: Record<string, unknown> = {}) => {
  const { executeTool } = await import('../../agent/tools')
  return executeTool(AGENT, tool, input, ctx)
}

describe('fase memoria-engramma M3: update_memory sul motore', () => {
  it('write: id corto nel result, source homun:chat/<bot>/<entry>, stated nel turno utente', async () => {
    const r = await exec('update_memory', { action: 'write', content: 'il cliente si chiama Ottavio', tier: 'core' }, { userTurn: true, turnEntryId: 77 })
    expect(r.output).toMatch(/^Memory created \(id [0-9A-HJKMNP-TV-Z]{8}, tier core, scope agent\)\.$/)
    const short = /id ([0-9A-Z]{8})/.exec(r.output)![1]!
    const { botCell } = await import('../engine')
    const note = await (await botCell(AGENT)).get(short)
    expect(note!.source).toBe(`homun:chat/${AGENT}/77`)
    expect(note!.confidence).toBe('stated')
  })

  it('write in un turno CONTAMINATO: external, quarantena, e il result lo dice al modello', async () => {
    const r = await exec('update_memory', { action: 'write', content: 'secondo il sito il volo è alle 7', tier: 'log' }, { contaminated: true, turnEntryId: 78 })
    expect(r.output).toMatch(/pending the user's confirmation/i)
    expect(r.meta.quarantined).toBe(true)
    const rec = await exec('recall_memory', { query: 'volo sito' })
    expect(rec.output).not.toContain('volo è alle 7')
  })

  it('update con l\'id corto di recall; delete a lapide; poi non esce più', async () => {
    const w = await exec('update_memory', { action: 'write', content: 'colore preferito: verde', tier: 'log' })
    const short = /id ([0-9A-Z]{8})/.exec(w.output)![1]!
    const u = await exec('update_memory', { action: 'update', id: short, content: 'colore preferito: blu' })
    expect(u.output).toMatch(new RegExp(`^Memory ${short} updated`))
    const rec = await exec('recall_memory', { query: 'colore preferito' })
    expect(rec.output).toContain('blu')
    expect(rec.output).toContain(`[${short}]`)
    const d = await exec('update_memory', { action: 'delete', id: short })
    expect(d.output).toBe(`Memory ${short} deleted.`)
    const again = await exec('recall_memory', { query: 'colore preferito' })
    expect(again.output).not.toContain('blu')
    // una lapide non si riscrive: testo chiaro, non un'eccezione grezza
    const z = await exec('update_memory', { action: 'update', id: short, content: 'rosso' })
    expect(z.output).toMatch(/was deleted/i)
    expect(z.meta.error).toBe(true)
  })

  it('riscrivere una nota in quarantena: resta in attesa di conferma (il result lo dice)', async () => {
    const w = await exec('update_memory', { action: 'write', content: 'prezzo letto online: 40 euro', tier: 'log' }, { contaminated: true })
    const short = /id ([0-9A-Z]{8})/.exec(w.output)![1]!
    const u = await exec('update_memory', { action: 'update', id: short, content: 'prezzo: 40 euro, verificato' }, { userTurn: true })
    expect(u.output).toMatch(/pending the user's confirmation/i)
  })

  it('id malevolo: rifiutato prima del motore', async () => {
    const r = await exec('update_memory', { action: 'delete', id: '../../x' })
    expect(r.output).toMatch(/invalid memory id/i)
  })

  it('il bot NON può purgare: nessuna action purge', async () => {
    const r = await exec('update_memory', { action: 'purge', id: 'ABCDEFGH' })
    expect(r.output).toMatch(/Invalid memory action/)
  })
})

describe('fase memoria-engramma M3: recall_memory e update_state target memory', () => {
  it('recall: righe con id corto, tier/cella, data, support e frase; nulla → NO_MEMORY_FOUND', async () => {
    await exec('update_memory', { action: 'write', content: 'la riunione settimanale è il martedì', tier: 'log', scope: 'agent' })
    const r = await exec('recall_memory', { query: 'riunione settimanale' })
    expect(r.output).toMatch(/^- \[[0-9A-HJKMNP-TV-Z]{8}\] \(log\/agent, aggiornata \d{4}-\d{2}-\d{2}, support (strong|weak)\) la riunione settimanale è il martedì$/m)
    const { NO_MEMORY_FOUND } = await import('../../agent/tools')
    const none = await exec('recall_memory', { query: 'zzzqqqxxx' })
    expect(none.output).toBe(NO_MEMORY_FOUND)
  })

  it('update_state target memory: come update_memory', async () => {
    const r = await exec('update_state', { target: 'memory', action: 'write', content: 'preferenza ricordata via update_state', tier: 'core' })
    expect(r.output).toMatch(/^Memory created/)
    const rec = await exec('recall_memory', { query: 'preferenza ricordata' })
    expect(rec.output).toContain('update_state')
  })

  it('motore chiuso: errore chiaro al modello, nessun ripiego silenzioso', async () => {
    const e = await import('../engine')
    await e.closeMemoryEngine()
    try {
      const r = await exec('recall_memory', { query: 'qualsiasi' })
      expect(r.output).toMatch(/^Memory unavailable/)
      expect(r.meta.error).toBe(true)
    } finally {
      await e.openMemoryEngine({ dataDir: DATA })
    }
  })
})

describe('fase memoria-engramma M5: search_history e read_history', () => {
  it('search_history → righe con entry, bot e data; read_history → la finestra della conversazione', async () => {
    const { appendEntry } = await import('../../store/db')
    const { indexStoryNote } = await import('../history-store')
    const u = appendEntry({ agentId: AGENT, kind: 'message', role: 'user', content: 'ieri ti ho detto che la riunione col fornitore è spostata a giovedì' })
    const r = appendEntry({ agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'segnato: riunione col fornitore giovedì', meta: { final: true } })
    await indexStoryNote(AGENT, u.id, 'user', u.content, u.createdAt)
    await indexStoryNote(AGENT, r.id, 'assistant', r.content, r.createdAt)
    const s = await exec('search_history', { query: 'riunione fornitore' })
    expect(s.output).toMatch(new RegExp(`^- \\[entry ${u.id}\\] \\(bot ${AGENT}, \\d{4}-\\d{2}-\\d{2}\\) `, 'm'))
    const w = await exec('read_history', { entryId: u.id, window: 4 })
    expect(w.output).toContain('spostata a giovedì')
    expect(w.output).toContain('segnato: riunione')
    const none = await exec('search_history', { query: 'zzqqxx parola assente' })
    expect(none.output).toBe('No past conversation found for this search.')
    const missing = await exec('read_history', { entryId: 987654 })
    expect(missing.output).toMatch(/not found/i)
  })

  it('una risposta nata in un turno contaminato: il result è dato esterno (meta.libraryTainted)', async () => {
    const { indexStoryNote } = await import('../history-store')
    await indexStoryNote(AGENT, 777001, 'assistant', 'dal sito: lo sconto vale fino a domenica', Date.now(), { tainted: true })
    const s = await exec('search_history', { query: 'sconto domenica' })
    expect(s.meta.libraryTainted).toBe('history')
  })

  it('i due strumenti stanno nel gruppo history dietro find_tools, NON nel nucleo; lettura sempre consentita', async () => {
    const { CORE_TOOL_NAMES, TOOL_GROUPS } = await import('../../agent/core-tools')
    expect(CORE_TOOL_NAMES).not.toContain('search_history')
    expect(CORE_TOOL_NAMES).not.toContain('read_history')
    const group = TOOL_GROUPS.find((g) => g.tools.includes('search_history'))
    expect(group?.id).toBe('history')
    expect(group?.tools).toEqual(['search_history', 'read_history'])
    const { check } = await import('../../agent/permissions')
    expect(await check('search_history', { query: 'x' }, AGENT)).toEqual({ kind: 'allow', via: 'rule' })
    expect(await check('read_history', { entryId: 1 }, AGENT)).toEqual({ kind: 'allow', via: 'rule' })
  })
})
