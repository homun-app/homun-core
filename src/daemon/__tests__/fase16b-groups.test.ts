// Fase 16b (S1) — i tre aggiustamenti del daemon sulle squadre, con lo store
// REALE su directory temporanea:
//  S1.1 il coordinatore è obbligatorio (default il creatore, elezione quando
//       lascia, migrazione idempotente dei gruppi esistenti);
//  S1.2 il riepilogo di chiusura NON genera turni (guardia del planner);
//  S1.3 le RPC groups:create / groups:update / groups:delete della UI.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// fase 16b: le cartelle temporanee dei test di questa fase nascono con
// mkdtemp nella directory fissata per il lavoro (mai $TMPDIR/os.tmpdir)
const TMP_ROOT = TEST_TMP_BASE + '/'

const h = vi.hoisted(() => ({
  tools: { calls: [] as Array<{ tool: string; args: Record<string, unknown> }> }
}))

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async (_agentId: string, tool: string, args: Record<string, unknown>) => {
    h.tools.calls.push({ tool, args })
    return { output: 'ok', meta: {} }
  }
}))

const {
  setDataDir, dataDir, db, createAgent, updateAgent, appendEntry, getEntries
} = await import('../../main/store/db')
const storeGroups = await import('../../main/store/groups')
const { planGroupTurns, coordinatorNowText, parseCoordinatorNowText, hasSentToUserInChain, MAX_GROUP_MEMBERS } = await import('../../main/agent/group-turns')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent, GroupInfo } from '../../shared/types'
import { TEST_TMP_BASE } from '../../test-tmp'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-fase16b-'))
  setDataDir(dir)
  dataDir()
  db()
})
beforeEach(() => {
  events = []
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Tre bot col provider a posto, come li vuole il planner. */
function threeBots(): { a: string; b: string; c: string } {
  const a = createAgent('Nina', 'principale')
  const b = createAgent('Scout cibo', 'cibo')
  const c = createAgent('Scout luoghi', 'luoghi')
  for (const x of [a, b, c]) updateAgent(x.id, { providerId: 'prov', model: 'm1' })
  return { a: a.id, b: b.id, c: c.id }
}

const errOf = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

describe('S1.1: il coordinatore è obbligatorio', () => {
  it('create_group senza coordinatorId: il coordinatore è chi crea il gruppo', () => {
    const { a, b } = threeBots()
    const g = storeGroups.createGroup('Weekend', 'menu', a, [b])
    expect(g.coordinator_id).toBe(a)
  })

  it('se il coordinatore lascia il gruppo (o viene tolto), il nuovo è il primo membro rimasto, in ordine di ingresso', () => {
    const { a, b, c } = threeBots()
    const g = storeGroups.createGroup('Amministrazione', 'conti', a, [b, c], a)
    // ordine di ingresso: a (creatore), b, c — il coordinatore a esce
    const r = storeGroups.removeGroupMember(g.id, a)
    expect(r.coordinatorChanged).toBe(true)
    expect(storeGroups.getGroup(g.id)?.coordinator_id).toBe(b)
    // con created_by ancora membro, la migrazione/elegge riparte da lui
    const g2 = storeGroups.createGroup('Seconda', 'alt', a, [b, c], b)
    db().prepare('UPDATE groups SET coordinator_id = NULL WHERE id = ?').run(g2.id)
    storeGroups.ensureGroupCoordinator(g2.id)
    expect(storeGroups.getGroup(g2.id)?.coordinator_id).toBe(a)
  })

  it('la migrazione dei gruppi esistenti è idempotente e copre anche il coordinatore non più membro', () => {
    const { a, b, c } = threeBots()
    // gruppo VECCHIO: coordinatore nullo
    const g1 = storeGroups.createGroup('Vecchia', 'x', a, [b])
    db().prepare('UPDATE groups SET coordinator_id = NULL WHERE id = ?').run(g1.id)
    // gruppo VECCHIO: coordinatore che non è più membro
    const g2 = storeGroups.createGroup('Orfana', 'x', a, [b, c], c)
    storeGroups.removeGroupMember(g2.id, c)
    storeGroups.migrateGroupCoordinators()
    expect(storeGroups.getGroup(g1.id)?.coordinator_id).toBe(a) // created_by ancora membro
    expect(storeGroups.getGroup(g2.id)?.coordinator_id).toBe(a)
    // idempotente: rilanciare non cambia nulla
    storeGroups.migrateGroupCoordinators()
    expect(storeGroups.getGroup(g1.id)?.coordinator_id).toBe(a)
    expect(storeGroups.getGroup(g2.id)?.coordinator_id).toBe(a)
    // created_by NON membro → il primo membro rimasto
    const g3 = storeGroups.createGroup('Terza', 'x', a, [b])
    db().prepare('DELETE FROM group_members WHERE group_id = ? AND agent_id = ?').run(g3.id, a)
    db().prepare('UPDATE groups SET coordinator_id = NULL WHERE id = ?').run(g3.id)
    storeGroups.migrateGroupCoordinators()
    expect(storeGroups.getGroup(g3.id)?.coordinator_id).toBe(b)
  })

  it('planGroupTurns con un gruppo migrato: un messaggio dell\'utente senza @ dà il turno al coordinatore', () => {
    const { a, b } = threeBots()
    const g = storeGroups.createGroup('Migrata', 'x', a, [b])
    db().prepare('UPDATE groups SET coordinator_id = NULL WHERE id = ?').run(g.id)
    storeGroups.ensureGroupCoordinator(g.id)
    const msg = storeGroups.addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'user', text: 'chi organizza?', depth: 0 })
    const plan = planGroupTurns({
      group: { id: g.id, coordinatorId: storeGroups.getGroup(g.id)!.coordinator_id },
      message: { id: msg.id, authorKind: 'user', authorId: null, text: msg.text, depth: msg.depth },
      members: [
        { id: a, name: 'Nina' },
        { id: b, name: 'Scout cibo' }
      ],
      pendingNonces: [],
      existingNonces: [],
      postsLastHour: 0
    })
    // il coordinatore (Nina, migrata) riceve il turno; l'altro membro pure
    // (regola "tutti" del planner per i messaggi dell'utente senza menzioni)
    expect(plan.turns.map((t) => t.memberId)).toEqual(expect.arrayContaining([a]))
    expect(plan.turns.length).toBeGreaterThan(0)
  })
})

describe('S1.2: il riepilogo NON genera turni', () => {
  it('planGroupTurns ignora un messaggio con summary: nessun turno, nessuna riga di sistema', () => {
    const { a, b } = threeBots()
    const plan = planGroupTurns({
      group: { id: 1, coordinatorId: a },
      message: { id: 99, authorKind: 'agent', authorId: a, text: 'RIEPILOGO finale per te', depth: 3, summary: true },
      members: [
        { id: a, name: 'Nina' },
        { id: b, name: 'Scout cibo' }
      ],
      pendingNonces: [],
      existingNonces: [],
      postsLastHour: 0
    })
    expect(plan.turns).toEqual([])
    expect(plan.systemNotice).toBeNull()
  })

  it('la riga di sistema del cambio coordinatore si riconosce (testo inglese → nome)', () => {
    expect(coordinatorNowText('Contabile')).toBe('Contabile now coordinates the team.')
    expect(parseCoordinatorNowText('Contabile now coordinates the team.')).toBe('Contabile')
    expect(parseCoordinatorNowText('Il giro si è chiuso.')).toBeNull()
  })
})

describe('S1.3: RPC groups:create / groups:update / groups:delete', () => {
  it('create: validazioni — nome, membri esistenti, coordinatore obbligatorio e membro, tetto 6', async () => {
    const { a, b } = threeBots()
    const e1 = await errOf(() => api['groups:create']!( ['', [b], a] ))
    expect((e1 as Error).message).toContain('name')
    const e2 = await errOf(() => api['groups:create']!(['Bella squadra', ['nope'], a]))
    expect((e2 as Error).message).toContain('nope')
    const e3 = await errOf(() => api['groups:create']!(['Bella squadra', [b], undefined]))
    expect((e3 as Error).message).toContain('coordinator')
    const e4 = await errOf(() => api['groups:create']!(['Bella squadra', [b], a]))
    expect((e4 as Error).message).toContain('member')
    const { c } = threeBots()
    // sette bot VERI: vale il tetto dei 6 (prima degli id inesistenti, il range)
    const more = [createAgent('D', ''), createAgent('E', ''), createAgent('E2', ''), createAgent('F', '')].map((x) => x.id)
    const e5 = await errOf(() => api['groups:create']!(['Troppo', [a, b, c, ...more], a]))
    expect((e5 as Error).message).toContain('6')
  })

  it('create: created_by utente, niente card, coordinatore membro', async () => {
    const { a, b } = threeBots()
    const g = await api['groups:create']!(['Weekend a Roma', [a, b], b, 'menu e luoghi']) as GroupInfo
    expect(g.createdBy).toBe('user')
    expect(g.coordinatorId).toBe(b)
    expect(g.members.map((m) => m.agentId).sort()).toEqual([a, b].sort())
    expect(g.lastMessageAt).toBeNull()
    // nessuna approval nel registro: è l'utente che crea
    const rows = db().prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('update: nome, descrizione, cambio coordinatore con la riga di sistema nel gruppo', async () => {
    const { a, b } = threeBots()
    const g = await api['groups:create']!(['Amministrazione', [a, b], a]) as GroupInfo
    const updated = await api['groups:update']!([g.id, { name: 'Amministrazione 2', description: 'conti', coordinatorId: b }]) as GroupInfo
    expect(updated.name).toBe('Amministrazione 2')
    expect(updated.coordinatorId).toBe(b)
    const row = storeGroups.groupMessages(g.id).find((m) => m.author_kind === 'system')
    expect(row?.text).toBe(coordinatorNowText('Scout cibo'))
  })

  it('update: togliere il coordinatore senza indicarne un altro non si può; se lascia, subentra il primo membro', async () => {
    const { a, b, c } = threeBots()
    const g = await api['groups:create']!(['Ricerche', [a, b, c], a]) as GroupInfo
    // niente coordinatorId nella patch e il coordinatore resta: ok, nessuna riga
    const same = await api['groups:update']!([g.id, { description: 'nuova' }]) as GroupInfo
    expect(same.coordinatorId).toBe(a)
    // coordinatorId che non è membro: rifiuto
    const e = await errOf(() => api['groups:update']!([g.id, { coordinatorId: 'nope' }]))
    expect((e as Error).message).toContain('member')
    // il coordinatore lascia: il primo membro rimasto (b) subentra, riga di sistema
    const after = await api['groups:update']!([g.id, { removeMemberIds: [a] }]) as GroupInfo
    expect(after.coordinatorId).toBe(b)
    expect(after.members.some((m) => m.agentId === a)).toBe(false)
    const row = storeGroups.groupMessages(g.id).findLast((m) => m.author_kind === 'system')
    expect(row?.text).toBe(coordinatorNowText('Scout cibo'))
  })

  it('delete: squadra e messaggi via, i bot restano', async () => {
    const { a, b } = threeBots()
    const g = await api['groups:create']!(['Effimera', [a, b], a]) as GroupInfo
    storeGroups.addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'user', text: 'ciao', depth: 0 })
    await api['groups:delete']!([g.id])
    expect(storeGroups.getGroup(g.id)).toBeNull()
    expect(db().prepare('SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ?').get(g.id) as { n: number }).toEqual({ n: 0 })
    // i bot restano
    expect(db().prepare('SELECT COUNT(*) AS n FROM agents WHERE id IN (?,?)').get(a, b) as { n: number }).toEqual({ n: 2 })
    const e = await errOf(() => api['groups:delete']!([g.id]))
    expect((e as Error).message).toContain('not found')
  })
})

// ---- fase 16b correzioni: P4 (una squadra non resta senza bot) e P1 ----

describe('fase 16b correzioni (P4): i membri finali si validano PRIMA di modificare', () => {
  it('RPC: togliere TUTTI i bot → rifiuto, squadra intatta (membri, nome e coordinatore)', async () => {
    const { a, b } = threeBots()
    const g = await api['groups:create']!(['Ricerca', [a, b], a, 'descrizione iniziale']) as GroupInfo
    const e = await errOf(() => api['groups:update']!([g.id, { removeMemberIds: [a, b], name: 'Nome nuovo' }]))
    expect((e as Error).message).toContain('1 to 6')
    // niente è stato toccato: membri, nome, descrizione e coordinatore
    expect(storeGroups.groupMemberIds(g.id).sort()).toEqual([a, b].sort())
    expect(storeGroups.getGroup(g.id)?.name).toBe('Ricerca')
    expect(storeGroups.getGroup(g.id)?.description).toBe('descrizione iniziale')
    expect(storeGroups.getGroup(g.id)?.coordinator_id).toBe(a)
  })

  it('RPC: il coordinatorId della patch deve stare fra i membri FINALI (dopo aggiunte e rimozioni)', async () => {
    const { a, b } = threeBots()
    const g = await api['groups:create']!(['Cena', [a, b], a]) as GroupInfo
    const e = await errOf(() => api['groups:update']!([g.id, { removeMemberIds: [b], coordinatorId: b }]))
    expect((e as Error).message).toContain('member')
    expect(storeGroups.groupMemberIds(g.id).sort()).toEqual([a, b].sort())
  })

  it('tool: togliere TUTTI i bot da una squadra dell\'UTENTE → rifiuto, squadra intatta', async () => {
    const { a, b } = threeBots()
    const g = await api['groups:create']!(['Squadra utente', [a, b], a]) as GroupInfo
    expect(g.createdBy).toBe('user')
    const { executeTool } = await vi.importActual<typeof import('../../main/agent/tools')>('../../main/agent/tools')
    const r = await executeTool(a, 'update_group', { groupId: g.id, removeMemberIds: [a, b] })
    expect(r.output).toBe(`A group needs between 1 and ${MAX_GROUP_MEMBERS} bots: nothing was changed.`)
    expect(storeGroups.groupMemberIds(g.id).sort()).toEqual([a, b].sort())
    expect(storeGroups.getGroup(g.id)?.coordinator_id).toBe(a)
  })

  it('aggiungere e togliere insieme restando nel range → applicato', async () => {
    const { a, b } = threeBots()
    const { c } = threeBots()
    const g = await api['groups:create']!(['Mista', [a, b], a]) as GroupInfo
    const updated = await api['groups:update']!([g.id, { addMemberIds: [c], removeMemberIds: [b] }]) as GroupInfo
    expect(updated.members.map((m) => m.agentId).sort()).toEqual([a, c].sort())
    expect(updated.coordinatorId).toBe(a)
  })
})

describe('fase 16b correzioni (P1): la event del riepilogo non cambia catena né consumi', () => {
  it('la riga discreta NON è una send-message: hasSentToUserInChain e coordinatorLastSendAt restano come prima', () => {
    const { a, b } = threeBots()
    const g = storeGroups.createGroup('Cena P1', 'menu', a, [b], a)
    appendEntry({
      agentId: a, kind: 'event', role: 'system',
      content: 'Ho pubblicato il riepilogo nella squadra «Cena P1»',
      meta: {
        groupId: g.id, summaryMessageId: 77,
        call: { id: 'p1', name: 'send_to_user', arguments: JSON.stringify({ text: 'RIEPILOGO' }) },
        message: { type: 'text', text: 'RIEPILOGO' },
        resultText: 'delivered to the user: "RIEPILOGO". Do not repeat it.'
      }
    })
    const entries = getEntries(a)
    expect(entries.some((e) => e.kind === 'event' && e.meta?.summaryMessageId === 77)).toBe(true)
    // C3: la event non conta come messaggio all'utente nella catena
    expect(hasSentToUserInChain(entries, { groupId: g.id, rootId: 50 })).toBe(false)
    // e non consuma le consegne del coordinatore (conto solo le send-message
    // con meta.groupChain e i riepiloghi NEL GRUPPO, summary = 1)
    expect(storeGroups.coordinatorLastSendAt(g.id, 50, a)).toBeNull()
  })
})
