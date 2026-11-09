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
