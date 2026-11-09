// Fase memoria-engramma · correzioni (C5): nessun elenco «tutto» che si
// ferma a metà. La v0.4.1 tagliava list a 1000 in silenzio e Homun chiedeva
// limit: 100_000 ovunque: l'oblio di un bot si fermava a 1000 note, il
// marcatore della migrazione e i conteggi pure. La v0.4.2 rispetta i limit;
// qui si chiede DI PIÙ: dove serve tutto, pagine da 1000 (listAll); dove
// serve una pagina (l'elenco della sezione), pagina nel MOTORE, non con
// slice in JS.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-listall-'))
const DATA = join(ROOT, 'data')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const AGENT = 'agent_big'
const N = 1500

beforeAll(async () => {
  const { setDataDir } = await import('../../store/db')
  setDataDir(DATA)
})

describe('fase memoria-engramma · correzioni C5: con 1500 note in una cella', () => {
  it('i conteggi della sezione dicono 1500 e una nota in quarantena oltre la millesima si trova per id corto', async () => {
    const e = await import('../engine')
    await e.closeMemoryEngine()
    expect((await e.openMemoryEngine({ dataDir: DATA })).available).toBe(true)
    const { writeMemoryNote } = await import('../memory-store')
    const { locateMemoryNote } = await import('../memory-store')
    const { memoryOverview } = await import('../memory-rpc')
    const { getSetting } = await import('../../store/db')
    // 1495 attive + 5 in quarantena (OLTRE la millesima)
    let quarantinedId = ''
    for (let i = 0; i < N; i++) {
      const q = i >= N - 5
      const n = await writeMemoryNote(AGENT, {
        content: `nota numero ${i} del bot grande: resoconto ${i}`,
        tier: i % 5 === 0 ? 'core' : 'log', source: 'test', userTurn: true,
        ...(q ? { contaminated: true } : {})
      })
      if (i === N - 1) quarantinedId = n.id
    }
    const ov = await memoryOverview(AGENT, getSetting)
    expect(ov.counts.own).toBe(N)
    expect(ov.counts.pending).toBe(5)
    // la nota in quarantena oltre la millesima si TROVA per id corto
    const found = await locateMemoryNote(AGENT, quarantinedId.slice(-8))
    expect(found?.state).toBe('quarantined')
    expect(found?.id).toBe(quarantinedId)
    // e l'elenco della sezione pagina nel MOTORE: prima pagina 100, «more»
    const { memoryList } = await import('../memory-rpc')
    const page = await memoryList(AGENT, { owner: 'bot', status: 'active', limit: 100 })
    expect(page.notes).toHaveLength(100)
    expect(page.more).toBe(true)
    const last = await memoryList(AGENT, { owner: 'bot', status: 'active', limit: 100, offset: 1494 })
    expect(last.notes.every((n) => n.status === 'active')).toBe(true)
    await e.closeMemoryEngine()
  })

  it('la seconda migrazione non duplica nulla: il marcatore vede OLTRE la millesima', async () => {
    const e = await import('../engine')
    await e.closeMemoryEngine()
    expect((await e.openMemoryEngine({ dataDir: DATA })).available).toBe(true)
    const { serializeMemory, memoryDir } = await import('../../agent/memory')
    const { migrateLegacyMemories } = await import('../migrate')
    const { botCellName } = e
    // PRIMA si migra davvero: 1100 file (OLTRE il tetto dei 1000)
    const M = 1100
    const dir = memoryDir(AGENT, 'agent')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < M; i++) {
      const id = `mem_${i.toString(16).padStart(12, '0')}`
      writeFileSync(join(dir, `${id}.md`), serializeMemory({
        id, content: `memoria migrata numero ${i}`, tier: 'log', scope: 'agent', source: 'user',
        createdAt: 1_700_000_000_000 + i * 60_000, updatedAt: 1_700_000_000_000 + i * 60_000
      }))
    }
    const first = await migrateLegacyMemories([AGENT])
    expect(first.migrated).toBe(M)
    // la SECONDA: i file NON ci sono più (spostati nella copia di sicurezza) —
    // ma il marcatore vero si prova in un altro modo: si SCRIVE di nuovo un
    // file con un id GIÀ migrato (come un backup ripristinato a mano) e la
    // migrazione NON lo riscrive (id noto oltre la millesima nota)
    const cell = await e.memoryCell(botCellName(AGENT), 'homun:bot-' + botCellName(AGENT))
    expect(await cell.list({ limit: 1 })).toHaveLength(1)
    for (const i of [0, M - 1, 500]) {
      const id = `mem_${i.toString(16).padStart(12, '0')}`
      writeFileSync(join(dir, `${id}.md`), serializeMemory({
        id, content: `memoria rimessa al suo posto numero ${i}`, tier: 'log', scope: 'agent', source: 'user',
        createdAt: 1_700_000_000_000 + i * 60_000, updatedAt: 1_700_000_000_000 + i * 60_000
      }))
    }
    const second = await migrateLegacyMemories([AGENT])
    expect(second.migrated).toBe(0)
    // la cella contiene anche le 1500 note del test sopra: 1500 + 1100, ZERO doppioni
    const total = (await cell.list({ limit: 100_000 })).length
    expect(total).toBe(N + M)
    await e.closeMemoryEngine()
  })
})
