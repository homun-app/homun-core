// Fase memoria-engramma (M5): il richiamo delle conversazioni — la cella
// «storia»: ogni messaggio dell'utente e ogni risposta finale del bot
// diventano una nota type event (source homun:chat/<bot>/<entry>, tag
// bot/<id>); i risultati dei tool e i contenuti esterni NON entrano. Poi i
// due strumenti dietro find_tools (search_history, read_history) e la purga
// delle note di un bot quando la sua conversazione si cancella.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-story-'))
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

describe('fase memoria-engramma M5: la cella storia', () => {
  it('indexStoryNote: nota event con tag bot/<id>, source homun:chat/<bot>/<entry>, idempotente', async () => {
    const e = await fresh()
    const { indexStoryNote } = await import('../history-store')
    await indexStoryNote('agent_s1', 101, 'user', 'Ieri ti ho detto che il treno delle 8 era in ritardo', 1730000000000)
    await indexStoryNote('agent_s1', 102, 'assistant', 'Ho controllato: ritardo di 20 minuti, arrivo alle 8:20', 1730000100000)
    const cell = await e.memoryCell('storia', 'homun:story')
    const notes = await cell.list({ noteType: 'event', limit: 1000 })
    expect(notes).toHaveLength(2)
    expect(notes.every((n) => n.tags.includes('bot/agent_s1'))).toBe(true)
    expect(notes.every((n) => n.source.startsWith('homun:chat/agent_s1/'))).toBe(true)
    expect(notes[0]!.noteType).toBe('event')
    // IDEMPOTENTE: lo stesso entry non si indicizza due volte
    await indexStoryNote('agent_s1', 101, 'user', 'Ieri ti ho detto che il treno delle 8 era in ritardo', 1730000000000)
    expect(await cell.list({ noteType: 'event', limit: 1000 })).toHaveLength(2)
    await e.closeMemoryEngine()
  })

  it('searchHistory: trova per parafrasi tra i messaggi, filtra per bot quando chiesto', async () => {
    const e = await fresh()
    const { indexStoryNote, searchHistory } = await import('../history-store')
    await indexStoryNote('agent_s1', 201, 'user', 'mi sono iscritto in palestra, il martedì e il venerdì', 1730000000000)
    await indexStoryNote('agent_s1', 202, 'assistant', 'perfetto, segno gli allenamenti sul calendario', 1730000100000)
    await indexStoryNote('agent_s9', 203, 'user', 'argomento completamente diverso di un altro bot', 1730000200000)
    // senza modello la ricerca è testo+grafo: le parole chiave bastano (la
    // PARAFRASI la aggiunge il modello ibrido, provata dal vivo in M8)
    const hits = await searchHistory('palestra iscritto')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.some((h) => h.snippet.includes('palestra'))).toBe(true)
    expect(hits.every((h) => h.tags.includes('bot/agent_s1') || h.tags.includes('bot/agent_s9'))).toBe(true)
    // con bot: SOLO quel bot
    const only = await searchHistory('palestra', 'agent_s1')
    expect(only.length).toBeGreaterThanOrEqual(1)
    expect(only.every((h) => h.tags.includes('bot/agent_s1'))).toBe(true)
    const none = await searchHistory('palestra', 'agent_zz')
    expect(none).toEqual([])
    await e.closeMemoryEngine()
  })

  it('purgeStoryOf: le note di un bot spariscono (oblio vero), le altre restano', async () => {
    const e = await fresh()
    const { indexStoryNote, searchHistory, purgeStoryOf } = await import('../history-store')
    await indexStoryNote('agent_s1', 301, 'user', 'il codice del citofono è 4512', 1730000000000)
    await indexStoryNote('agent_s2', 302, 'user', 'una nota che deve restare', 1730000100000)
    expect((await purgeStoryOf('agent_s1')).forgotten).toBe(1)
    const hits = await searchHistory('citofono')
    expect(hits).toEqual([])
    expect((await searchHistory('nota che deve restare')).length).toBeGreaterThanOrEqual(1)
    await e.closeMemoryEngine()
  })

  it('readHistoryWindow: la finestra del transcript attorno a un entry id', async () => {
    const { setDataDir, appendEntry } = await import('../../store/db')
    const dir = join(DATA, 'w' + Math.random().toString(36).slice(2, 6))
    setDataDir(dir)
    const e = await import('../engine')
    await e.closeMemoryEngine()
    expect((await e.openMemoryEngine({ dataDir: dir })).available).toBe(true)
    const { readHistoryWindow } = await import('../history-store')
    const a1 = appendEntry({ agentId: 'agent_w', kind: 'message', role: 'user', content: 'primo messaggio' })
    appendEntry({ agentId: 'agent_w', kind: 'tool-call', role: 'assistant', content: '', meta: { name: 'web_search' } })
    const a3 = appendEntry({ agentId: 'agent_w', kind: 'message', role: 'user', content: 'secondo messaggio' })
    appendEntry({ agentId: 'agent_w', kind: 'send-message', role: 'assistant', content: 'risposta finale', meta: { final: true } })
    appendEntry({ agentId: 'agent_w', kind: 'send-message', role: 'assistant', content: 'messaggio intermedio' })
    const out = await readHistoryWindow('agent_w', a3.id, 6)
    expect(out).toMatch(/primo messaggio/)
    expect(out).toMatch(/secondo messaggio/)
    expect(out).toMatch(/risposta finale/)
    expect(out).not.toMatch(/messaggio intermedio/) // i tool e i non-finali NON sono conversazione
    expect(out).not.toMatch(/web_search/)
    // la finestra: con window 2 si vede solo il messaggio chiesto
    const small = await readHistoryWindow('agent_w', a3.id, 2)
    expect(small).toMatch(/secondo messaggio/)
    expect(small).not.toMatch(/primo messaggio/)
    // entry che non esiste: null (il tool lo dice al modello)
    expect(await readHistoryWindow('agent_w', 999999, 6)).toBeNull()
    await e.closeMemoryEngine()
  })
})

describe('fase memoria-engramma M5: riferimenti e indicizzazione iniziale', () => {
  it('il SearchHit porta entry e bot nei tag (niente get per riga); le risposte contaminate sono tainted', async () => {
    const e = await fresh()
    const { indexStoryNote, searchHistory, storyRefOf } = await import('../history-store')
    await indexStoryNote('agent_r1', 555, 'assistant', 'secondo il sito, il museo apre alle 9', 1730000000000, { tainted: true })
    const [hit] = await searchHistory('museo apre')
    expect(storyRefOf(hit!)).toEqual({ entryId: 555, agentId: 'agent_r1', tainted: true })
    await e.closeMemoryEngine()
  })

  it('backfillStory indicizza i messaggi utente e le risposte finali di ogni bot, con avanzamento', async () => {
    const { setDataDir, appendEntry } = await import('../../store/db')
    const dir = join(DATA, 'b' + Math.random().toString(36).slice(2, 6))
    setDataDir(dir)
    const e = await import('../engine')
    await e.closeMemoryEngine()
    expect((await e.openMemoryEngine({ dataDir: dir })).available).toBe(true)
    appendEntry({ agentId: 'agent_b1', kind: 'message', role: 'user', content: 'domanda sulle ferie di agosto' })
    appendEntry({ agentId: 'agent_b1', kind: 'tool-result', role: 'system', content: 'risultato web che NON entra' })
    appendEntry({ agentId: 'agent_b1', kind: 'send-message', role: 'assistant', content: 'le ferie partono il 5', meta: { final: true } })
    appendEntry({ agentId: 'agent_b1', kind: 'message', role: 'user', content: '[recurring routine: x] apertura di sistema', meta: { routineTitle: 'x' } })
    appendEntry({ agentId: 'agent_b2', kind: 'message', role: 'user', content: 'messaggio del secondo bot' })
    const seen: Array<[number, number]> = []
    const { backfillStory, searchHistory } = await import('../history-store')
    const r = await backfillStory(['agent_b1', 'agent_b2'], (d, t) => seen.push([d, t]))
    expect(r.indexed).toBe(3)
    expect(seen[0]).toEqual([0, 3])
    expect(seen.at(-1)).toEqual([3, 3])
    expect((await searchHistory('ferie agosto')).length).toBeGreaterThanOrEqual(1)
    expect(await searchHistory('risultato web')).toEqual([])
    expect(await searchHistory('apertura di sistema')).toEqual([])
    // una seconda passata non duplica (id deterministico)
    await backfillStory(['agent_b1', 'agent_b2'])
    const cell = await e.memoryCell('storia', 'homun:story')
    expect(await cell.list({ noteType: 'event', limit: 1000 })).toHaveLength(3)
    await e.closeMemoryEngine()
  })
})
