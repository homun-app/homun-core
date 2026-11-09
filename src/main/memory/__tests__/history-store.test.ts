// Fase memoria-engramma (M5) · correzioni (C2): il richiamo delle
// conversazioni — la storia di un bot vive nella CELLA storia-<id> (come le
// memorie in bot-<id>). Ogni messaggio dell'utente e ogni risposta finale del
// bot diventano una nota type event (source homun:chat/<bot>/<entry>, tag
// entry/<id>); i risultati dei tool e i contenuti esterni NON entrano. Poi i
// due strumenti dietro find_tools (search_history, read_history): senza bot si
// cerca la storia del bot che parla, bot: 'all' cerca in tutte le celle
// storia-* con un solo Engine.search, un id la storia di quel bot.
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

describe('fase memoria-engramma · correzioni C2: la storia per bot', () => {
  it('indexStoryNote: nota event nella cella storia-<id>, tag entry/<id> (niente bot/<id>), idempotente', async () => {
    const e = await fresh()
    const { indexStoryNote } = await import('../history-store')
    await indexStoryNote('agent_s1', 101, 'user', 'Ieri ti ho detto che il treno delle 8 era in ritardo', 1730000000000)
    await indexStoryNote('agent_s1', 102, 'assistant', 'Ho controllato: ritardo di 20 minuti, arrivo alle 8:20', 1730000100000)
    const cell = await e.memoryCell('storia-agent_s1', 'homun:story')
    const notes = await cell.list({ noteType: 'event', limit: 1000 })
    expect(notes).toHaveLength(2)
    expect(notes.every((n) => n.tags.includes('entry/101') || n.tags.includes('entry/102'))).toBe(true)
    expect(notes.every((n) => n.tags.every((t) => !t.startsWith('bot/')))).toBe(true)
    expect(notes.every((n) => n.source.startsWith('homun:chat/agent_s1/'))).toBe(true)
    expect(notes[0]!.noteType).toBe('event')
    // IDEMPOTENTE: lo stesso entry non si indicizza due volte
    await indexStoryNote('agent_s1', 101, 'user', 'Ieri ti ho detto che il treno delle 8 era in ritardo', 1730000000000)
    expect(await cell.list({ noteType: 'event', limit: 1000 })).toHaveLength(2)
    await e.closeMemoryEngine()
  })

  it('searchHistory: il DEFAULT è la storia del bot che parla; un altro bot SOLO con bot; all trova in due bot', async () => {
    const e = await fresh()
    const { indexStoryNote, searchHistory, storyRefOf } = await import('../history-store')
    await indexStoryNote('agent_s1', 201, 'user', 'mi sono iscritto in palestra, il martedì e il venerdì', 1730000000000)
    await indexStoryNote('agent_s1', 202, 'assistant', 'perfetto, segno gli allenamenti sul calendario', 1730000100000)
    await indexStoryNote('agent_s9', 203, 'user', 'la mia palestra preferita è quella di via Roma', 1730000200000)
    // agent_s9 cerca senza bot: vede SOLO la propria storia (il default è il
    // bot che parla — un bot esposto al web non legge le chat degli altri)
    const own = await searchHistory('palestra', 'agent_s9')
    expect(own.length).toBeGreaterThanOrEqual(1)
    expect(own.every((h) => h.cell === 'storia-agent_s9')).toBe(true)
    // la storia di un ALTRO bot solo con l'id
    const other = await searchHistory('palestra', 'agent_s9', 'agent_s1')
    expect(other.length).toBeGreaterThanOrEqual(1)
    expect(other.every((h) => h.cell === 'storia-agent_s1')).toBe(true)
    // un id senza storia: nessun risultato, nessun errore
    expect(await searchHistory('palestra', 'agent_s9', 'agent_zz')).toEqual([])
    // 'all': un solo Engine.search su più celle, trova in ENTRAMBI i bot
    const all = await searchHistory('palestra', 'agent_s9', 'all')
    expect(new Set(all.map((h) => h.cell))).toEqual(new Set(['storia-agent_s1', 'storia-agent_s9']))
    // il ref viene dalla CELLA (il tag bot/<id> non esiste più)
    for (const h of all) expect(storyRefOf(h)).toEqual({ entryId: expect.any(Number), agentId: h.cell.slice('storia-'.length), tainted: false })
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

describe('fase memoria-engramma · correzioni C2: riferimenti e indicizzazione iniziale', () => {
  it('le risposte contaminate sono tainted (il ref viene dalla cella, non dal tag)', async () => {
    const e = await fresh()
    const { indexStoryNote, searchHistory, storyRefOf } = await import('../history-store')
    await indexStoryNote('agent_r1', 555, 'assistant', 'secondo il sito, il museo apre alle 9', 1730000000000, { tainted: true })
    const [hit] = await searchHistory('museo apre', 'agent_r1')
    expect(storyRefOf(hit!)).toEqual({ entryId: 555, agentId: 'agent_r1', tainted: true })
    await e.closeMemoryEngine()
  })

  it('backfillStory indicizza i messaggi utente e le risposte finali di ogni bot, OGNIUNO nella sua cella', async () => {
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
    const engine = await e.memoryEngine()
    expect(await engine.cells()).toEqual(expect.arrayContaining(['storia-agent_b1', 'storia-agent_b2']))
    expect((await searchHistory('ferie agosto', 'agent_b1')).length).toBeGreaterThanOrEqual(1)
    expect(await searchHistory('risultato web', 'agent_b1')).toEqual([])
    expect(await searchHistory('apertura di sistema', 'agent_b1')).toEqual([])
    // il secondo bot NON vede la storia del primo senza bot: 'agent_b2'
    expect((await searchHistory('ferie agosto', 'agent_b2'))).toEqual([])
    // una seconda passata non duplica (id deterministico)
    await backfillStory(['agent_b1', 'agent_b2'])
    const cell = await e.memoryCell('storia-agent_b1', 'homun:story')
    expect(await cell.list({ noteType: 'event', limit: 1000 })).toHaveLength(2)
    await e.closeMemoryEngine()
  })

  it('la cella «storia» UNICA della fase precedente si dimentica e il backfill riparte', async () => {
    const e = await fresh()
    const { setSetting, getSetting } = await import('../../store/db')
    // la vecchia cella con dentro una nota, e il marcatore che dice «già fatto»
    await (await e.memoryCell('storia', 'homun:story')).put({ body: 'nota della vecchia cella unica', source: 'homun:chat/agent_x/1', confidence: 'stated', tags: ['entry/1'] })
    setSetting('memory.storyBackfilledAt', 123)
    const { dropLegacyStoryCell } = await import('../history-store')
    expect(await dropLegacyStoryCell()).toBe(true)
    const engine = await e.memoryEngine()
    expect(await engine.cells()).not.toContain('storia')
    expect(getSetting<number | null>('memory.storyBackfilledAt', null)).toBeNull()
    // senza la vecchia cella: no-op (false), il marcatore non si tocca
    setSetting('memory.storyBackfilledAt', 456)
    expect(await dropLegacyStoryCell()).toBe(false)
    expect(getSetting<number | null>('memory.storyBackfilledAt', null)).toBe(456)
    await e.closeMemoryEngine()
  })
})

describe('fase memoria-engramma · correzioni C3: la provenienza dei messaggi indicizzati a ritroso', () => {
  it('le risposte vecchie (senza meta.contaminated, prima di provenanceSince) nascono tainted; i messaggi utente no; le nuove pulite restano pulite', async () => {
    const { setDataDir, appendEntry, setSetting, db } = await import('../../store/db')
    const dir = join(DATA, 'c3' + Math.random().toString(36).slice(2, 6))
    setDataDir(dir)
    const e = await import('../engine')
    await e.closeMemoryEngine()
    expect((await e.openMemoryEngine({ dataDir: dir })).available).toBe(true)
    // il primo avvio della correzione salva la data: prima di lì, la
    // provenienza delle risposte è IGNOTA
    const since = 1_736_000_000_000
    setSetting('memory.provenanceSince', since)
    // appendEntry non accetta createdAt: le righe vecchie si datano a mano
    appendEntry({ agentId: 'agent_c3', kind: 'message', role: 'user', content: 'domanda vecchia sul treno oscillante' })
    appendEntry({ agentId: 'agent_c3', kind: 'send-message', role: 'assistant', content: 'risposta vecchia: il treno oscillante parte alle 7', meta: { final: true } })
    db().prepare('UPDATE entries SET created_at = ? WHERE agent_id = ?').run(since - 86_400_000, 'agent_c3')
    appendEntry({ agentId: 'agent_c3', kind: 'send-message', role: 'assistant', content: 'risposta nuova pulita: il traghetto luminoso salpa alle 9', meta: { final: true } })
    appendEntry({ agentId: 'agent_c3', kind: 'send-message', role: 'assistant', content: 'risposta nuova contaminata: il divertimento pendolare costa 5', meta: { final: true, contaminated: true } })

    const { backfillStory, searchHistory, storyRefOf, runStoryIndexJob } = await import('../history-store')
    const r = await backfillStory(['agent_c3'])
    expect(r.indexed).toBe(4)

    const oldHit = (await searchHistory('parte alle 7', 'agent_c3'))[0]!
    expect(storyRefOf(oldHit).tainted).toBe(true) // PRIMA: false — ignoto = pulito
    // e cercata dal tool contamina il turno (dato esterno)
    const { executeTool } = await import('../../agent/tools')
    const res = await executeTool('agent_c3', 'search_history', { query: 'parte alle 7' }, {})
    expect(res.meta.libraryTainted).toBe('history')

    // il messaggio utente VECCHIO resta pulito
    const oldUser = (await searchHistory('domanda vecchia', 'agent_c3'))[0]!
    expect(storyRefOf(oldUser).tainted).toBe(false)
    // la risposta NUOVA senza meta.contaminated resta pulita
    const newClean = (await searchHistory('traghetto luminoso', 'agent_c3'))[0]!
    expect(storyRefOf(newClean).tainted).toBe(false)
    const resClean = await executeTool('agent_c3', 'search_history', { query: 'traghetto luminoso' }, {})
    expect(resClean.meta.libraryTainted).toBeUndefined()
    // la risposta nuova con meta.contaminated è tainted (regola C1)
    const newTainted = (await searchHistory('divertimento pendolare', 'agent_c3'))[0]!
    expect(storyRefOf(newTainted).tainted).toBe(true)
    // la stessa regola vale per il job della coda (un entry VECCHIO che
    // arriva dal job non si lava)
    const queuedOld = appendEntry({ agentId: 'agent_c3', kind: 'send-message', role: 'assistant', content: 'dal job: la funicolare nascosta parte a mezzanotte', meta: { final: true } })
    db().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(since - 1000, queuedOld.id)
    expect(await runStoryIndexJob('agent_c3', queuedOld.id)).toBe('indexed')
    const jobHit = (await searchHistory('funicolare nascosta', 'agent_c3'))[0]!
    expect(storyRefOf(jobHit).tainted).toBe(true)
    await e.closeMemoryEngine()
  })
})
