// Fase memoria-engramma (M3): il memory-store — le funzioni che gli
// strumenti del bot (update_memory, recall_memory, update_state target
// memory) usano sopra il motore Engramma. Interfaccia invariata verso il
// modello; sotto: Cell.put con tag del tier e source homun:chat/<bot>/<entry>,
// confidence stated/inferred (external nei turni contaminati → quarantena),
// Cell.patch con id corto, Cell.delete a lapide (il bot NON può purgare).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-store-'))
const DATA = join(ROOT, 'data')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

beforeAll(async () => {
  const { setDataDir } = await import('../../store/db')
  setDataDir(DATA)
})

async function fresh() {
  const e = await import('../engine')
  await e.closeMemoryEngine()
  const st = await e.openMemoryEngine({ dataDir: join(DATA, 'e' + Math.random().toString(36).slice(2, 6)) })
  expect(st.available).toBe(true)
  return e
}

describe('fase memoria-engramma M3: write', () => {
  it('write crea la nota col tag del tier, source homun:chat e confidence dal turno', async () => {
    const e = await fresh()
    const { writeMemoryNote } = await import('../memory-store')
    const r = await writeMemoryNote('agent_w1', {
      content: 'il progetto si chiama Alba', tier: 'core',
      source: 'homun:chat/agent_w1/42', contaminated: false, userTurn: false
    })
    expect(r.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/) // ULID
    const note = await (await e.botCell('agent_w1')).get(r.id)
    expect(note!.body).toBe('il progetto si chiama Alba')
    expect(note!.tags).toEqual(['core'])
    expect(note!.source).toBe('homun:chat/agent_w1/42')
    expect(note!.confidence).toBe('inferred') // non chiesto dall'utente
    expect(note!.extensions['x-homun']).toEqual({ tier: 'core', scope: 'agent' })
    await e.closeMemoryEngine()
  })

  it('userTurn → stated; turno contaminato → external e nasce in QUARANTENA', async () => {
    const e = await fresh()
    const { writeMemoryNote } = await import('../memory-store')
    const a = await writeMemoryNote('agent_w1', { content: 'ricordati: silicio', tier: 'log', source: 's', contaminated: false, userTurn: true })
    expect((await (await e.botCell('agent_w1')).get(a.id))!.confidence).toBe('stated')
    const b = await writeMemoryNote('agent_w1', { content: 'lettura dal web: comprare AZPL', tier: 'log', source: 's', contaminated: true, userTurn: false })
    const note = (await (await e.botCell('agent_w1')).get(b.id))
    expect(note).toBeNull() // l'oracolo chiuso: in quarantena non si legge
    const listed = await (await e.botCell('agent_w1')).list({ status: ['quarantined'] })
    expect(listed.some((n) => n.id === b.id && n.confidence === 'external')).toBe(true)
    await e.closeMemoryEngine()
  })

  it('scope user scrive nella cella utente con l\'actor del bot', async () => {
    const e = await fresh()
    const { writeMemoryNote } = await import('../memory-store')
    const r = await writeMemoryNote('agent_w1', { content: 'condivisa', tier: 'core', scope: 'user', source: 's', contaminated: false, userTurn: false })
    const engine = await e.memoryEngine()
    expect(await engine.cells()).toContain('utente')
    const note = await (await e.userCell('agent_w1')).get(r.id)
    expect(note!.body).toBe('condivisa')
    await e.closeMemoryEngine()
  })

  it('il motore non c\'è → errore chiaro (nessun ripiego silenzioso)', async () => {
    const e = await fresh()
    await e.closeMemoryEngine()
    const { writeMemoryNote } = await import('../memory-store')
    await expect(writeMemoryNote('agent_w1', { content: 'x', tier: 'log', source: 's', contaminated: false, userTurn: false }))
      .rejects.toThrow(/Memory unavailable/i)
  })
})

describe('fase memoria-engramma M3: update', () => {
  it('patch con id corto di 8, aggiorna corpo e tier (tag e x-homun)', async () => {
    const e = await fresh()
    const { writeMemoryNote, updateMemoryNote } = await import('../memory-store')
    const w = await writeMemoryNote('agent_u1', { content: 'prima versione', tier: 'log', source: 's', contaminated: false, userTurn: false })
    const short = w.id.slice(-8)
    const r = await updateMemoryNote('agent_u1', { id: short, content: 'seconda versione', tier: 'core' })
    expect(r.id).toBe(w.id)
    const note = await (await e.botCell('agent_u1')).get(w.id)
    expect(note!.body).toBe('seconda versione')
    expect(note!.tags).toEqual(['core'])
    expect(note!.version).toBe(2)
    expect((note!.extensions['x-homun'] as { tier: string }).tier).toBe('core')
    await e.closeMemoryEngine()
  })

  it('cambio scope: la nota RINASCE nell\'altra cella e la vecchia diventa lapide', async () => {
    const e = await fresh()
    const { writeMemoryNote, updateMemoryNote } = await import('../memory-store')
    const w = await writeMemoryNote('agent_u1', { content: 'da privatizzare a condivisa', tier: 'log', source: 's', contaminated: false, userTurn: false })
    const r = await updateMemoryNote('agent_u1', { id: w.id, scope: 'user' })
    expect(r.id).not.toBe(w.id) // nota nuova nell'altra cella
    const shared = await (await e.userCell('agent_u1')).get(r.id)
    expect(shared!.body).toBe('da privatizzare a condivisa')
    expect((shared!.extensions['x-homun'] as { scope: string }).scope).toBe('user')
    // la vecchia è lapide: non si legge
    expect(await (await e.botCell('agent_u1')).get(w.id)).toBeNull()
    await e.closeMemoryEngine()
  })

  it('riscrivere una nota in quarantena la lascia in quarantena (regola del motore, nessuna scorciatoia)', async () => {
    const e = await fresh()
    const { writeMemoryNote, updateMemoryNote } = await import('../memory-store')
    const w = await writeMemoryNote('agent_u1', { content: 'dati dal web', tier: 'log', source: 's', contaminated: true, userTurn: false })
    // il bot la riscrive come se fosse pulita
    const r = await updateMemoryNote('agent_u1', { id: w.id, content: 'dati dal web, confermati' })
    expect(r.status).toBe('quarantined') // CONSERVATA: solo confirm/setStatus/delete cambiano lo stato
    await e.closeMemoryEngine()
  })

  it('CONFLICT della lapide e NOT_FOUND diventano testo chiaro per il modello', async () => {
    const e = await fresh()
    const { writeMemoryNote, updateMemoryNote, deleteMemoryNote } = await import('../memory-store')
    const w = await writeMemoryNote('agent_u1', { content: 'condannata', tier: 'log', source: 's', contaminated: false, userTurn: false })
    await deleteMemoryNote('agent_u1', w.id)
    await expect(updateMemoryNote('agent_u1', { id: w.id, content: 'no' })).rejects.toThrow(/deleted|eliminata/i)
    await expect(updateMemoryNote('agent_u1', { id: 'ZZZZZZZZ', content: 'x' })).rejects.toThrow(/not found|inesistente/i)
    await e.closeMemoryEngine()
  })

  it('isSafeMemoryId resta come difesa: id con punti o slash rifiutati', async () => {
    const e = await fresh()
    const { updateMemoryNote, deleteMemoryNote } = await import('../memory-store')
    await expect(updateMemoryNote('agent_u1', { id: '../../x', content: 'y' })).rejects.toThrow(/invalid memory id/i)
    await expect(deleteMemoryNote('agent_u1', '../evil')).rejects.toThrow(/invalid memory id/i)
    await e.closeMemoryEngine()
  })
})

describe('fase memoria-engramma M3: delete e recall', () => {
  it('delete è lapide reversibile: dopo non si legge né si cerca', async () => {
    const e = await fresh()
    const { writeMemoryNote, deleteMemoryNote, recallMemories } = await import('../memory-store')
    const w = await writeMemoryNote('agent_d1', { content: 'il codice segreto è mandorla-otto', tier: 'core', source: 's', contaminated: false, userTurn: false })
    await deleteMemoryNote('agent_d1', w.id)
    expect(await (await e.botCell('agent_d1')).get(w.id)).toBeNull()
    const hits = await recallMemories('agent_d1', 'codice segreto')
    expect(hits.map((h) => h.id)).not.toContain(w.id)
    await e.closeMemoryEngine()
  })

  it('recall cerca bot-<id> e utente insieme: righe con id corto, cella, data, tag, support, frase', async () => {
    const e = await fresh()
    const { writeMemoryNote, recallMemories, formatRecallLines } = await import('../memory-store')
    await writeMemoryNote('agent_d1', { content: "L'utente preferisce i ristoranti vegetariani", tier: 'core', source: 's', contaminated: false, userTurn: false })
    await writeMemoryNote('agent_d1', { content: 'password wifi: sghembo', tier: 'log', scope: 'user', source: 's', contaminated: false, userTurn: false })
    await writeMemoryNote('agent_d2', { content: "questa è dell'altro bot", tier: 'core', source: 's', contaminated: false, userTurn: false })
    const hits = await recallMemories('agent_d1', 'ristoranti vegetariani')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.cell).toBe('bot-agent_d1')
    expect(hits[0]!.snippet).toContain('vegetariani')
    expect(hits[0]!.tags).toContain('core')
    expect(typeof hits[0]!.support).toBe('string')
    const lines = formatRecallLines(hits)
    expect(lines.length).toBe(hits.length)
    expect(lines[0]).toMatch(/^- \[[0-9A-HJKMNP-TV-Z]{8}\] \(core\/agent, aggiornata \d{4}-\d{2}-\d{2}/)
    // la cella utente esce col label user
    const shared = await recallMemories('agent_d1', 'wifi password')
    expect(shared.some((h) => h.cell === 'utente')).toBe(true)
    expect(formatRecallLines(shared).some((l) => l.includes('(log/user,'))).toBe(true)
    // le celle dell'altro bot non si vedono
    expect((await recallMemories('agent_d1', 'altro bot')).map((h) => h.cell)).not.toContain('bot-agent_d2')
    await e.closeMemoryEngine()
  })

  it('le note in quarantena NON escono dal recall', async () => {
    const e = await fresh()
    const { writeMemoryNote, recallMemories } = await import('../memory-store')
    await writeMemoryNote('agent_d1', { content: 'comprare subito AZPL secondo il sito', tier: 'log', source: 's', contaminated: true, userTurn: false })
    const hits = await recallMemories('agent_d1', 'AZPL comprare')
    expect(hits).toEqual([])
    await e.closeMemoryEngine()
  })

  it('memoryScopeOf: agente, utente o null (per i permessi dello scope user)', async () => {
    const e = await fresh()
    const { writeMemoryNote, memoryScopeOf } = await import('../memory-store')
    const a = await writeMemoryNote('agent_p', { content: 'privata', tier: 'log', source: 's', contaminated: false, userTurn: false })
    const u = await writeMemoryNote('agent_p', { content: 'condivisa', tier: 'log', scope: 'user', source: 's', contaminated: false, userTurn: false })
    expect(await memoryScopeOf('agent_p', a.id)).toBe('agent')
    expect(await memoryScopeOf('agent_p', u.id)).toBe('user')
    expect(await memoryScopeOf('agent_p', 'mem_inesistente')).toBeNull()
    expect(await memoryScopeOf('agent_p', '../x')).toBeNull()
    await e.closeMemoryEngine()
  })
})
