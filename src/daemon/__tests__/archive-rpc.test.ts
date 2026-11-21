// K2 (fase team-bot): le RPC dell'archiviare ed eliminare — i percorsi veri
// che useranno il menu «⋯» della barra e il pannello di destra.
//  · agents:archive ferma il turno, cancella i job in coda, mette in pausa
//    le routine e segna archived_at: NESSUN dato si perde (le entry restano);
//  · il bot PRINCIPALE non si archivia né si elimina (rifiuto dal daemon);
//  · agents:delete è MORBIO: deleted_at, dati al loro posto, agents:restore
//    ripulisce; dopo 30 giorni purgeRemoved fa la cancellazione VERA;
//  · groups:archive/delete(+restore): un team archiviato non è più di
//    nessun membro (niente risvegli né deleghe) e non schedula turni;
//  · groups:delete con alsoDeleteMembers true segna SOLO i bot creati per
//    quel team (createdBy di un membro), non quelli dell'utente.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TMP_ROOT = TEST_TMP_BASE + '/'

const h = vi.hoisted(() => ({ interrupts: [] as string[] }))

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async () => { throw new Error('non chiamato in questi test') }
}))

vi.mock('../../main/agent/loop', () => ({
  interrupt: (id: string) => { h.interrupts.push(id) }
}))

vi.mock('../../main/agent/providers', () => ({
  getProvider: () => undefined,
  modelSupportsTools: async () => ({ ok: true, checked: true })
}))

const {
  setDataDir, dataDir, db, createAgent, createRoutine, appendEntry, getEntries,
  listAgentsIncludingRemoved, listRoutines, setSetting
} = await import('../../main/store/db')
const storeGroups = await import('../../main/store/groups')
const { buildApiMethods, purgeRemoved, REMOVED_RETENTION_MS } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent, Agent } from '../../shared/types'
import { TEST_TMP_BASE } from '../../test-tmp'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

let dir: string
const DAY = 86_400_000

beforeAll(() => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-archive-rpc-'))
  setDataDir(dir)
  dataDir()
  db()
  setSetting('ui.activeLanguage', 'it')
})
beforeEach(() => {
  events = []
  h.interrupts.length = 0
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// X1 (fase sicurezza-beta16): il roster esclude i rimossi — questi test
// guardano proprio loro, la strada esplicita li contiene
const agentById = (id: string): Agent | undefined => listAgentsIncludingRemoved().find((a) => a.id === id)
const call = async (ch: string, ...p: unknown[]): Promise<unknown> => api[ch]!(p)
const errText = async (fn: () => unknown): Promise<string | null> => {
  try { await fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
}

describe('K2: agents:archive — fermo tutto, nessun dato perso, mai il principale', () => {
  it('archivia: interrupt + routine in pausa + archivedAt, le entry restano', async () => {
    const a = createAgent('Competitoor', 'scrive')
    const r = createRoutine(a.id, 'Ogni ora', 'p', '0 * * * *')
    const e1 = appendEntry({ agentId: a.id, kind: 'message', role: 'user', content: 'ciao' })
    await call('agents:archive', a.id)
    expect(agentById(a.id)?.archivedAt).not.toBeNull()
    expect(listRoutines().find((x) => x.id === r.id)?.enabled).toBe(0)
    expect(h.interrupts).toContain(a.id)
    expect(getEntries(a.id).map((x) => x.id)).toContain(e1.id)
    expect(events.some((ev) => ev.type === 'agents')).toBe(true)
    // ripristina: il bot torna com'era, le routine restano in pausa
    await call('agents:unarchive', a.id)
    expect(agentById(a.id)?.archivedAt).toBeNull()
    expect(listRoutines().find((x) => x.id === r.id)?.enabled).toBe(0)
  })

  it('il bot principale si rifiuta (archivia ed elimina)', async () => {
    const main = createAgent('Principale', '')
    setSetting('mainAgentId', main.id)
    // il rifiuto è QUELLO (testo localizzato rpc.agentIsMain), non un errore generico
    expect(await errText(() => call('agents:archive', main.id))).toBe('Il bot principale non si archivia né si elimina.')
    expect(await errText(() => call('agents:delete', main.id))).toBe('Il bot principale non si archivia né si elimina.')
    expect(agentById(main.id)?.archivedAt).toBeNull()
    expect(agentById(main.id)?.deletedAt).toBeNull()
  })
})

describe('K2: agents:delete morbido + restore + pulizia dopo 30 giorni', () => {
  it('delete: deletedAt, dati al loro posto; restore ripulisce', async () => {
    const a = createAgent('Morbido', '')
    const e1 = appendEntry({ agentId: a.id, kind: 'message', role: 'user', content: 'resta' })
    await call('agents:delete', a.id)
    expect(agentById(a.id)?.deletedAt).not.toBeNull()
    expect(getEntries(a.id).map((x) => x.id)).toContain(e1.id)
    await call('agents:restore', a.id)
    expect(agentById(a.id)?.deletedAt).toBeNull()
  })

  it('purgeRemoved: dopo 30 giorni la cancellazione è VERA (righe, entry, disco)', async () => {
    const a = createAgent('Scaduto', '')
    appendEntry({ agentId: a.id, kind: 'message', role: 'user', content: 'via' })
    await call('agents:delete', a.id)
    const deletedAt = agentById(a.id)!.deletedAt!
    // un giorno prima dello scadere: nessuno tocca niente
    const poke = { poke: () => undefined }
    let purged = await purgeRemoved({ emit, worker: poke, now: deletedAt + REMOVED_RETENTION_MS - DAY })
    expect(purged.agents).toBe(0)
    expect(agentById(a.id)).toBeDefined()
    // oltre i 30 giorni: cancellazione dura
    purged = await purgeRemoved({ emit, worker: poke, now: deletedAt + REMOVED_RETENTION_MS + DAY })
    expect(purged.agents).toBe(1)
    expect(agentById(a.id)).toBeUndefined()
    expect(getEntries(a.id)).toEqual([])
    expect(existsSync(join(dataDir(), 'agents', a.id))).toBe(false)
  })
})

describe('K2: groups:archive/delete — il team archiviato dorme', () => {
  it('archivia: fuori da groupsOfMember, niente turni per un messaggio, restore', async () => {
    const capo = createAgent('Capo', '')
    const membro = createAgent('Membro', '')
    const g = storeGroups.createGroup('Weekend Torino', '', 'user', [capo.id, membro.id], capo.id)
    await call('groups:archive', g.id)
    expect(storeGroups.groupsOfMember(capo.id).map((x) => x.id)).not.toContain(g.id)
    expect(storeGroups.getGroup(g.id)?.archived_at ?? null).not.toBeNull()
    // un messaggio che arriva NON sveglia nessuno
    const msg = storeGroups.addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'ehi' })
    const sched = storeGroups.scheduleTurnsForMessage(msg, emit)
    expect(sched.jobs).toHaveLength(0)
    await call('groups:unarchive', g.id)
    expect(storeGroups.getGroup(g.id)?.archived_at ?? null).toBeNull()
    expect(storeGroups.groupsOfMember(capo.id).map((x) => x.id)).toContain(g.id)
  })

  it('delete morbido + restore; alsoDeleteMembers segna SOLO i bot creati per il team', async () => {
    const capo = createAgent('Capo team', '')
    const delBot = createAgent('Creato per il team', '', { createdBy: capo.id })
    const utenteBot = createAgent('Aggiunto dall\'utente', '')
    const g = storeGroups.createGroup('Team di prova', '', 'user', [capo.id, delBot.id, utenteBot.id], capo.id)
    await call('groups:delete', g.id, false)
    expect(storeGroups.getGroup(g.id)?.deleted_at ?? null).not.toBeNull()
    expect(storeGroups.groupsOfMember(capo.id).map((x) => x.id)).not.toContain(g.id)
    // i bot restano TUTTI
    for (const b of [capo, delBot, utenteBot]) expect(agentById(b.id)?.deletedAt ?? null).toBeNull()
    await call('groups:restore', g.id)
    expect(storeGroups.getGroup(g.id)?.deleted_at ?? null).toBeNull()
    // con la casella: via SOLO il bot creato da un membro del team
    await call('groups:delete', g.id, true)
    expect(agentById(delBot.id)?.deletedAt ?? null).not.toBeNull()
    expect(agentById(utenteBot.id)?.deletedAt ?? null).toBeNull()
    expect(agentById(capo.id)?.deletedAt ?? null).toBeNull()
  })

  it('purgeRemoved porta via anche i team scaduti (cancellazione dura)', async () => {
    const a = createAgent('Ultimo', '')
    const g = storeGroups.createGroup('Team scaduto', '', 'user', [a.id], a.id)
    await call('groups:delete', g.id)
    const deletedAt = storeGroups.getGroup(g.id)!.deleted_at!
    // (anche il team eliminato dal test precedente è scaduto: contano tutti)
    const purged = await purgeRemoved({ emit, worker: { poke: () => undefined }, now: deletedAt + REMOVED_RETENTION_MS + DAY })
    expect(purged.groups).toBeGreaterThanOrEqual(1)
    expect(storeGroups.getGroup(g.id)).toBeNull()
    // il bot resta
    expect(agentById(a.id)).toBeDefined()
  })
})
