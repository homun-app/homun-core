// Fase memoria-engramma (M2): la migrazione — ogni file markdown della
// memoria a file diventa una nota del motore (cella bot-<id> o utente, tag
// core/log, source migrated:homun, confidence dal source del file, date del
// file con quelle storte corrette a oggi e un avviso, extensions x-homun col
// passato di Homun). Idempotente col marcatore x-homun.id dentro la cella:
// una migrazione interrotta riprende. I file vecchi NON si cancellano: si
// spostano in <dataDir>/memory-legacy-<data>/.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-migrate-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

// file di memoria nel formato della fase 4 (frontmatter + corpo)
function mem(id: string, content: string, fields: Record<string, string> = {}): string {
  return [
    '---',
    `id: ${id}`,
    `created_at: ${fields.created_at ?? '1730000000000'}`,
    `updated_at: ${fields.updated_at ?? '1730000000000'}`,
    `tier: ${fields.tier ?? 'log'}`,
    `scope: ${fields.scope ?? 'agent'}`,
    `source: ${fields.source ?? 'agent'}`,
    '---',
    '',
    content
  ].join('\n')
}

beforeAll(async () => {
  const { setDataDir } = await import('../../store/db')
  setDataDir(join(ROOT, 'data'))
  const agentMem = join(ROOT, 'data', 'agents', 'agent_a1', 'memory')
  const userMem = join(ROOT, 'data', 'user', 'memory')
  mkdirSync(agentMem, { recursive: true })
  mkdirSync(userMem, { recursive: true })
  writeFileSync(join(agentMem, 'mem_core.md'), mem('mem_core', 'lavora sul progetto X', { tier: 'core', source: 'user', created_at: '1600000000000', updated_at: '1600000000001' }))
  writeFileSync(join(agentMem, 'mem_rule.md'), mem('mem_rule', 'rispondere in italiano', { tier: 'log', source: 'agent' }))
  writeFileSync(join(userMem, 'mem_shared.md'), mem('mem_shared', 'condivisa: silica Zero', { scope: 'user', source: 'user', tier: 'core' }))
  // file malformato: frontmatter rotto → saltato con avviso
  writeFileSync(join(agentMem, 'mem_rotto.md'), 'non c\'è frontmatter qui')
  // data futura → migrata con la data di OGGI e un avviso
  writeFileSync(join(agentMem, 'mem_futura.md'), mem('mem_futura', 'nota dal futuro', { updated_at: String(Date.now() + 86_400_000) }))
  // data storta (NaN) → come sopra
  writeFileSync(join(agentMem, 'mem_storta.md'), mem('mem_storta', 'nota con data storta', { created_at: 'pippo', updated_at: 'pippo' }))
  // id doppio nella STESSA cella: il secondo si salta con avviso
  writeFileSync(join(userMem, 'mem_shared_dup.md'), mem('mem_shared', 'copia con lo stesso id', { scope: 'user', source: 'user', tier: 'core' }))
})

describe('fase memoria-engramma M2: la migrazione', () => {
  it('migra con i conti giusti e i file finiscono nella copia di sicurezza', async () => {
    const { openMemoryEngine, closeMemoryEngine, botCell, userCell } = await import('../engine')
    const { migrateLegacyMemories } = await import('../migrate')
    await openMemoryEngine({ dataDir: join(ROOT, 'data') })
    const s = await migrateLegacyMemories(['agent_a1'])
    // 5 note: core, rule, shared, futura, storta (rotto saltato, dup saltato)
    expect(s.migrated).toBe(5)
    expect(s.warnings.some((w) => w.includes('mem_rotto'))).toBe(true)
    expect(s.warnings.some((w) => w.includes('mem_futura'))).toBe(true)
    expect(s.warnings.some((w) => w.includes('mem_storta'))).toBe(true)
    expect(s.warnings.some((w) => w.includes('mem_shared'))).toBe(true)
    expect(s.warnings.every((w) => !w.includes('progetto X') && !w.includes('silica'))).toBe(true) // mai il contenuto
    // la copia di sicurezza esiste e i file ORIGINALI non ci sono più
    expect(s.backupDir).toMatch(/memory-legacy-\d{4}-\d{2}-\d{2}$/)
    expect(existsSync(join(s.backupDir!, 'agents', 'agent_a1', 'memory', 'mem_core.md'))).toBe(true)
    expect(existsSync(join(s.backupDir!, 'user', 'memory', 'mem_shared.md'))).toBe(true)
    expect(existsSync(join(ROOT, 'data', 'agents', 'agent_a1', 'memory', 'mem_core.md'))).toBe(false)
    expect(readdirSync(join(ROOT, 'data', 'agents', 'agent_a1', 'memory'))).toEqual([])
    // le celle: bot-agent_a1 (4) e utente (1)
    const bot = await botCell('agent_a1')
    const user = await userCell(null)
    const botNotes = await bot.list({ limit: 100 })
    const userNotes = await user.list({ limit: 100 })
    expect(botNotes).toHaveLength(4)
    expect(userNotes).toHaveLength(1)
    // campi di Homun: cella, tag, source, confidence, date, extensions
    const hid = (n: (typeof botNotes)[number]): string => (n.extensions['x-homun'] as { id: string }).id
    const core = botNotes.find((n) => hid(n) === 'mem_core')!
    expect(core.tags).toEqual(['core'])
    expect(core.source).toBe('migrated:homun')
    expect(core.confidence).toBe('stated') // source del file: user
    // il motore tiene le date al secondo
    expect(new Date(core.createdAt).getTime()).toBe(1600000000000)
    expect(new Date(core.updatedAt).getTime()).toBeGreaterThanOrEqual(1600000000000)
    expect(new Date(core.updatedAt).getTime()).toBeLessThanOrEqual(1600000001000)
    expect(core.extensions['x-homun']).toEqual({ id: 'mem_core', tier: 'core', scope: 'agent', source: 'user' })
    const rule = botNotes.find((n) => hid(n) === 'mem_rule')!
    expect(rule.confidence).toBe('inferred') // source del file: agent
    expect(rule.tags).toEqual(['log'])
    const shared = userNotes.find((n) => hid(n) === 'mem_shared')!
    expect(shared.extensions['x-homun']).toEqual({ id: 'mem_shared', tier: 'core', scope: 'user', source: 'user' })
    // data futura e storta → OGGI
    const today = new Date().toISOString().slice(0, 10)
    // solo il campo storto si corregge: mem_futura ha updated_at nel futuro
    const futura = botNotes.find((n) => hid(n) === 'mem_futura')!
    expect(new Date(futura.createdAt).getTime()).toBe(1730000000000)
    expect(futura.updatedAt.slice(0, 10)).toBe(today)
    // mem_storta ha entrambe le date illeggibili: entrambe a oggi
    const storta = botNotes.find((n) => hid(n) === 'mem_storta')!
    expect(storta.createdAt.slice(0, 10)).toBe(today)
    expect(storta.updatedAt.slice(0, 10)).toBe(today)
    await closeMemoryEngine()
  })

  it('la seconda apertura non ha effetti (idempotente), e un file rimasto riprende da lì', async () => {
    const { openMemoryEngine, closeMemoryEngine, botCell } = await import('../engine')
    const { migrateLegacyMemories } = await import('../migrate')
    await openMemoryEngine({ dataDir: join(ROOT, 'data') })
    const before = await (await botCell('agent_a1')).list({ limit: 100 })
    const s = await migrateLegacyMemories(['agent_a1'])
    expect(s.migrated).toBe(0)
    expect(s.warnings).toEqual([])
    expect(await (await botCell('agent_a1')).list({ limit: 100 })).toHaveLength(before.length)
    // migrazione interrotta simulata: un file resta al suo posto (come se il
    // processo fosse morto prima di spostarlo) — la ripresa lo porta via
    // SENZA creare una seconda nota (il marcatore x-homun.id è nella cella)
    const memDir = join(ROOT, 'data', 'agents', 'agent_a1', 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'mem_core.md'), mem('mem_core', 'lavora sul progetto X', { tier: 'core', source: 'user' }))
    const s2 = await migrateLegacyMemories(['agent_a1'])
    expect(s2.migrated).toBe(0)
    expect(s2.warnings).toEqual([])
    expect(existsSync(join(memDir, 'mem_core.md'))).toBe(false)
    expect(await (await botCell('agent_a1')).list({ limit: 100 })).toHaveLength(before.length)
    await closeMemoryEngine()
  })
})

describe('fase memoria-engramma · correzioni C6: la migrazione non si blocca su un file', () => {
  it('una cartella con un SOLO file malformato: avviso, copia di sicurezza, nessuna eccezione (prima: ENOENT)', async () => {
    const { setDataDir } = await import('../../store/db')
    const dir = join(ROOT, 'solo-rotto')
    setDataDir(dir)
    const { openMemoryEngine, closeMemoryEngine } = await import('../engine')
    await closeMemoryEngine()
    await openMemoryEngine({ dataDir: dir })
    const memDir = join(dir, 'agents', 'agent_solo', 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'rotto.md'), 'frontmatter assente del tutto')
    const { migrateLegacyMemories } = await import('../migrate')
    // PRIMA della correzione: renameSync verso una cartella di backup mai
    // creata → ENOENT, l'eccezione saliva e la migrazione si ripeteva uguale
    // a ogni avvio, bloccando anche gli agenti dopo nel ciclo
    const s = await migrateLegacyMemories(['agent_solo'])
    expect(s.migrated).toBe(0)
    expect(s.warnings.some((w) => w.includes('rotto.md'))).toBe(true)
    expect(existsSync(join(memDir, 'rotto.md'))).toBe(false)
    expect(existsSync(join(s.backupDir!, 'agents', 'agent_solo', 'memory', 'rotto.md'))).toBe(true)
    await closeMemoryEngine()
  })

  it('un put che FALLISCE diventa un avviso col nome del file e il codice (mai il contenuto); gli altri file e il secondo agente migrano', async () => {
    const { setDataDir } = await import('../../store/db')
    const dir = join(ROOT, 'put-fallito')
    setDataDir(dir)
    const { openMemoryEngine, closeMemoryEngine } = await import('../engine')
    await closeMemoryEngine()
    await openMemoryEngine({ dataDir: dir })
    const x = join(dir, 'agents', 'agent_x', 'memory')
    const y = join(dir, 'agents', 'agent_y', 'memory')
    mkdirSync(x, { recursive: true })
    mkdirSync(y, { recursive: true })
    // il file che NON passa: primo nell'ordine alfabetico
    writeFileSync(join(x, 'a-che-spegne.md'), mem('a_fail', 'contenuto segreto che non entra nei log'))
    writeFileSync(join(x, 'b-buona.md'), mem('b_ok', 'prima nota buona'))
    writeFileSync(join(x, 'c-buona.md'), mem('c_ok', 'seconda nota buona'))
    writeFileSync(join(y, 'd-buona.md'), mem('d_ok', 'nota del secondo agente'))
    // il finto motore: put rifiuta SOLO per a_fail (code IO), il resto passa
    const { migrateLegacyMemories } = await import('../migrate')
    const fakeCell = () => ({
      list: async () => [],
      put: async (note: { extensions?: Record<string, unknown> }) => {
        const id = ((note.extensions?.['x-homun'] as { id?: string } | undefined)?.id) ?? ''
        if (id === 'a_fail') {
          const err = new Error('simulated engine failure')
          ;(err as Error & { code: string }).code = 'IO'
          throw err
        }
        return { id: 'fake_' + id } as never
      }
    })
    const s = await migrateLegacyMemories(['agent_x', 'agent_y'], { openCell: () => Promise.resolve(fakeCell() as never) })
    expect(s.migrated).toBe(3) // b, c e il secondo agente: TUTTI gli altri
    expect(s.warnings.some((w) => w.includes('a-che-spegne.md') && w.includes('IO'))).toBe(true)
    expect(s.warnings.every((w) => !w.includes('contenuto segreto'))).toBe(true) // mai il contenuto
    // il file che non si è potuto migrare RESTA al suo posto: si riprova al prossimo avvio
    expect(existsSync(join(x, 'a-che-spegne.md'))).toBe(true)
    expect(existsSync(join(x, 'b-buona.md'))).toBe(false)
    await closeMemoryEngine()
  })

  it('l\'id doppio finisce anche lui nella copia di sicurezza: niente avviso a ogni avvio', async () => {
    const { setDataDir } = await import('../../store/db')
    const dir = join(ROOT, 'doppio')
    setDataDir(dir)
    const { openMemoryEngine, closeMemoryEngine } = await import('../engine')
    await closeMemoryEngine()
    await openMemoryEngine({ dataDir: dir })
    const memDir = join(dir, 'agents', 'agent_dup', 'memory')
    mkdirSync(memDir, { recursive: true })
    // ordine alfabetico: due.md migra, uno.md è il DOPPIO che si scarta
    writeFileSync(join(memDir, 'uno.md'), mem('stesso_id', 'la copia che si scarta'))
    writeFileSync(join(memDir, 'due.md'), mem('stesso_id', 'la prima che vale'))
    const { migrateLegacyMemories } = await import('../migrate')
    const s = await migrateLegacyMemories(['agent_dup'])
    expect(s.migrated).toBe(1)
    expect(s.warnings.some((w) => w.includes('uno.md') && w.includes('stesso_id'))).toBe(true)
    // ENTRAMBI fuori dalla cartella di origine (il doppio in copia di sicurezza)
    expect(readdirSync(memDir)).toEqual([])
    expect(existsSync(join(s.backupDir!, 'agents', 'agent_dup', 'memory', 'uno.md'))).toBe(true)
    // la seconda corsa: nessun avviso (niente più file con l'id doppio)
    const s2 = await migrateLegacyMemories(['agent_dup'])
    expect(s2.warnings).toEqual([])
    expect(s2.migrated).toBe(0)
    await closeMemoryEngine()
  })
})
