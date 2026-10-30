// Fase 10 (punto 7) — test dello store dei gruppi su SQLite reale (directory
// temporanea): CRUD, cursori, registro dei turni con nonce univoco e la colla
// scheduleTurnsForMessage (job accodati, righe di sistema una volta sola).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir, db, createAgent } from '../db'
import { listJobs } from '../jobs'
import {
  createGroup, getGroup, updateGroup, listGroups, groupsOfMember, groupMemberIds,
  isGroupMember, addGroupMember, removeGroupMember, addGroupMessage, groupMessages,
  getGroupCursor, setGroupCursor, registerPlannedTurn, groupTurnByNonce,
  startGroupTurn, finishGroupTurn, pendingTurnNonces, groupTurnNonces,
  scheduleTurnsForMessage, botPostsLastHour, cancelGroupJobs
} from '../groups'
import { memberOfNonce } from '../../agent/group-turns'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-groups-'))
  setDataDir(dir)
  db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('gruppi e membri', () => {
  it('createGroup aggiunge il creatore se manca e rispetta i membri', () => {
    const a1 = createAgent('Bot', '')
    const a2 = createAgent('Cercatore', '')
    const g = createGroup('Cena', 'organizzare', a1.id, [a2.id])
    expect(groupMemberIds(g.id).sort()).toEqual([a1.id, a2.id].sort())
    expect(isGroupMember(g.id, a1.id)).toBe(true)
    expect(isGroupMember(g.id, 'agent_inesistente')).toBe(false)
  })

  it('updateGroup cambia nome, descrizione e coordinatore; groupsOfMember filtra', () => {
    const a1 = createAgent('Capo', '')
    const a2 = createAgent('Operaio', '')
    const g = createGroup('Team', 'd', a1.id, [a2.id], a2.id)
    updateGroup(g.id, { name: 'Team2', description: 'd2', coordinator_id: a1.id })
    const up = getGroup(g.id)!
    expect(up.name).toBe('Team2')
    expect(up.description).toBe('d2')
    expect(up.coordinator_id).toBe(a1.id)
    expect(groupsOfMember(a1.id).map((x) => x.id)).toContain(g.id)
    expect(groupsOfMember('agent_nessuno')).toHaveLength(0)
    expect(listGroups().map((x) => x.id)).toContain(g.id)
  })

  it('add/removeGroupMember aggiornano i membri', () => {
    const a1 = createAgent('Uno', '')
    const a2 = createAgent('Due', '')
    const g = createGroup('G', 'd', a1.id, [])
    addGroupMember(g.id, a2.id)
    expect(groupMemberIds(g.id)).toHaveLength(2)
    removeGroupMember(g.id, a2.id)
    expect(groupMemberIds(g.id)).toEqual([a1.id])
  })

  it('rimuovere un membro chiude i suoi turni pianificati (niente fusione fantasma alla ri-aggiunta)', () => {
    const a1 = createAgent('Uno', '')
    const a2 = createAgent('Due', '')
    const g = createGroup('Gp', 'd', a1.id, [a2.id])
    const m = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'via', depth: 0 })
    scheduleTurnsForMessage(m, () => undefined, 5000)
    // a2 ha un turno pianificato non partito
    expect(pendingTurnNonces(g.id).length).toBeGreaterThan(0)
    removeGroupMember(g.id, a2.id)
    // i turni di a2 sono chiusi; quelli degli ALTRI membri restano validi
    expect(pendingTurnNonces(g.id).map((n) => memberOfNonce(n))).not.toContain(a2.id)
    // ri-aggiunto, un messaggio nuovo genera di nuovo il suo turno
    addGroupMember(g.id, a2.id)
    const m2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'ancora', depth: 0 })
    const r = scheduleTurnsForMessage(m2, () => undefined, 6000)
    expect(r.jobs.some((j) => j.agentId === a2.id)).toBe(true)
  })
})

describe('messaggi e cursori', () => {
  it('i messaggi tornano in ordine e filtrati dall\'id; il cursore per membro', () => {
    const a1 = createAgent('Bot', '')
    const g = createGroup('G2', 'd', a1.id, [])
    const m1 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'ciao', depth: 0 })
    const m2 = addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: a1.id, authorName: 'Bot', text: 'rispondo', depth: 1, rootId: m1.id })
    expect(groupMessages(g.id).map((m) => m.id)).toEqual([m1.id, m2.id])
    expect(groupMessages(g.id, m1.id).map((m) => m.id)).toEqual([m2.id])
    expect(getGroupCursor(g.id, a1.id)).toBe(0)
    setGroupCursor(g.id, a1.id, m1.id)
    expect(getGroupCursor(g.id, a1.id)).toBe(m1.id)
    expect(groupMessages(g.id, getGroupCursor(g.id, a1.id)).map((m) => m.id)).toEqual([m2.id])
  })

  it('botPostsLastHour conta solo i post di bot nell\'ultima ora', () => {
    const a1 = createAgent('Bot3', '')
    const g = createGroup('G3', 'd', a1.id, [])
    addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'u', depth: 0 })
    addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: a1.id, authorName: 'Bot3', text: 'b1', depth: 1 })
    expect(botPostsLastHour(g.id, Date.now())).toBe(1)
    expect(botPostsLastHour(g.id, Date.now() + 2 * 3_600_000)).toBe(0)
  })
})

describe('registro dei turni', () => {
  it('registerPlannedTurn deduplica per nonce; start/finish aggiornano gli istanti', () => {
    const a1 = createAgent('Bot4', '')
    const g = createGroup('G4', 'd', a1.id, [])
    const m = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'via', depth: 0 })
    const nonce = `g${g.id}:${a1.id}:msg${m.id}`
    expect(registerPlannedTurn({ nonce, groupId: g.id, memberId: a1.id, sourceMessageId: m.id })).toBe(true)
    expect(registerPlannedTurn({ nonce, groupId: g.id, memberId: a1.id, sourceMessageId: m.id })).toBe(false)
    expect(pendingTurnNonces(g.id)).toEqual([nonce])
    startGroupTurn(nonce, 100)
    expect(pendingTurnNonces(g.id)).toEqual([])
    finishGroupTurn(nonce, 'PASS', 200)
    const t = groupTurnByNonce(nonce)!
    expect(t.outcome).toBe('PASS')
    expect(t.started_at).toBe(100)
    expect(t.ended_at).toBe(200)
    expect(groupTurnNonces(g.id)).toEqual([nonce])
  })
})

describe('scheduleTurnsForMessage (la colla)', () => {
  it('un messaggio utente senza menzioni accoda un job group-turn per ogni membro', () => {
    const a1 = createAgent('Bot5', '')
    const a2 = createAgent('Cinque', '')
    const a3 = createAgent('Sei', '')
    const g = createGroup('G5', 'd', a1.id, [a2.id, a3.id])
    const m = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'si parte', depth: 0 })
    const jobsBefore = listJobs(db()).length
    const r = scheduleTurnsForMessage(m, () => undefined, 1000)
    const jobs = listJobs(db()).slice(jobsBefore)
    expect(jobs).toHaveLength(3)
    expect(jobs.every((j) => j.kind === 'group-turn')).toBe(true)
    expect(new Set(jobs.map((j) => j.agent_id))).toEqual(new Set([a1.id, a2.id, a3.id]))
    expect(r.jobs).toHaveLength(3)
    // i nonce sono registrati: lo stesso messaggio non riaccoda nulla
    const again = scheduleTurnsForMessage(m, () => undefined, 1000)
    expect(again.jobs).toHaveLength(0)
    expect(listJobs(db())).toHaveLength(jobsBefore + 3)
  })

  it('FUSIONE: un secondo messaggio mentre i turni sono ancora pianificati non raddoppia', () => {
    const a1 = createAgent('Bot6', '')
    const a2 = createAgent('Altro6', '')
    const g = createGroup('G6', 'd', a1.id, [a2.id])
    const m1 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'uno', depth: 0 })
    scheduleTurnsForMessage(m1, () => undefined, 2000)
    const jobs1 = listJobs(db()).filter((j) => j.kind === 'group-turn')
    const m2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'due', depth: 0 })
    scheduleTurnsForMessage(m2, () => undefined, 2001)
    const jobs2 = listJobs(db()).filter((j) => j.kind === 'group-turn')
    expect(jobs2).toHaveLength(jobs1.length)
  })

  it('chiusura della catena: depth ≥ 6 scrive la riga di sistema e non accoda', () => {
    const a1 = createAgent('Bot7', '')
    const g = createGroup('G7', 'd', a1.id, [])
    const m = addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: a1.id, authorName: 'Bot7', text: 'ultimo', depth: 6, rootId: 1 })
    const jobsBefore = listJobs(db()).length
    scheduleTurnsForMessage(m, () => undefined, 3000)
    expect(listJobs(db())).toHaveLength(jobsBefore)
    const sys = groupMessages(g.id).find((x) => x.author_kind === 'system')
    expect(sys?.text).toContain('closed')
  })

  it('tetto orario: la riga di sistema compare UNA volta sola all\'ora', () => {
    const a1 = createAgent('Bot8', '')
    const g = createGroup('G8', 'd', a1.id, [])
    // 40 post di bot nell'ultima ora
    for (let i = 0; i < 40; i++) {
      addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: a1.id, authorName: 'Bot8', text: `p${i}`, depth: 1, rootId: 1 })
    }
    const m = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'ancora', depth: 0 })
    const now = Date.now()
    scheduleTurnsForMessage(m, () => undefined, now)
    scheduleTurnsForMessage(addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'e ancora', depth: 0 }), () => undefined, now + 1000)
    const capLines = groupMessages(g.id).filter((x) => x.author_kind === 'system' && x.text.includes('Hourly cap reached'))
    expect(capLines).toHaveLength(1)
  })

  it('cancelGroupJobs toglie i job del gruppo dalla coda', () => {
    const a1 = createAgent('Bot9', '')
    const g = createGroup('G9', 'd', a1.id, [])
    const m = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'x', depth: 0 })
    scheduleTurnsForMessage(m, () => undefined, 4000)
    expect(listJobs(db()).some((j) => j.kind === 'group-turn' && (j.payload as { groupId: number }).groupId === g.id)).toBe(true)
    cancelGroupJobs(db(), g.id)
    expect(listJobs(db()).some((j) => j.kind === 'group-turn' && (j.payload as { groupId: number }).groupId === g.id)).toBe(false)
  })
})

describe('correzioni fase 10: instradamento C4 e sospensione C5', () => {
  it('C4: il post dello specialista senza menzioni va SOLO al coordinatore; con 3 post nella catena non riceve più turni', async () => {
    const main = createAgent('Main9', '')
    const coord = createAgent('Coord9', '')
    const spec = createAgent('Spec9', '')
    const g = createGroup('G9', 'd', main.id, [coord.id, spec.id], coord.id)
    // il post dello specialista SENZA menzioni: turno solo al coordinatore
    const m1 = addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: spec.id, authorName: 'Spec9', text: 'consegno il menu', depth: 1, rootId: 1 })
    const jobsBefore = listJobs(db()).length
    const r1 = scheduleTurnsForMessage(m1, () => undefined, Date.now())
    expect(r1.jobs.map((j) => j.agentId)).toEqual([coord.id])
    expect(listJobs(db())).toHaveLength(jobsBefore + 1)

    // il tetto per catena: lo specialista ha già 3 post nella catena → escluso
    // (gruppo a parte: il coordinatore qui sopra ha ancora un turno in coda e
    // la fusione lo salterebbe per un'altra ragione)
    const main2 = createAgent('Main9b', '')
    const coord2 = createAgent('Coord9b', '')
    const spec2 = createAgent('Spec9b', '')
    const g2 = createGroup('G9b', 'd', main2.id, [coord2.id, spec2.id], coord2.id)
    for (let i = 0; i < 3; i++) {
      addGroupMessage({ groupId: g2.id, authorKind: 'agent', authorId: spec2.id, authorName: 'Spec9b', text: `v${i}`, depth: 1, rootId: 2 })
    }
    const m2 = addGroupMessage({ groupId: g2.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'come va?', depth: 1, rootId: 2 })
    const r2 = scheduleTurnsForMessage(m2, () => undefined, Date.now())
    const planned = r2.jobs.map((j) => j.agentId)
    expect(planned).not.toContain(spec2.id)
    // il coordinatore e chi è sotto il tetto restano
    expect(planned).toContain(coord2.id)
    expect(r2.plan.skipped.find((s) => s.memberId === spec2.id)?.reason).toContain('per-chain cap reached')
  })

  it('C5: suspendGroupTurns annulla i job del gruppo e registra SKIPPED col motivo (il job in corso si esclude)', async () => {
    const a1 = createAgent('Bot10', '')
    const g = createGroup('G10', 'd', a1.id, [])
    const u = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: 'x', depth: 0 })
    scheduleTurnsForMessage(u, () => undefined, Date.now())
    const jobs = listJobs(db()).filter((j) => j.kind === 'group-turn' && j.payload.groupId === g.id)
    expect(jobs.length).toBeGreaterThan(0)
    const { suspendGroupTurns, groupTurnByNonce } = await import('../groups')
    // il primo job è "in corso": si esclude, gli altri si annullano
    const n = suspendGroupTurns(db(), g.id, 'rate limit del provider: giro sospeso', jobs[0]!.id)
    expect(n).toBe(jobs.length - 1)
    const remaining = listJobs(db()).filter((j) => j.kind === 'group-turn' && j.payload.groupId === g.id)
    expect(remaining.map((j) => j.id)).toEqual([jobs[0]!.id])
    for (const j of jobs.slice(1)) {
      const row = groupTurnByNonce(String(j.payload.nonce))
      expect(row?.outcome).toBe('SKIPPED')
      expect(row?.reason).toContain('rate limit')
    }
  })
})
