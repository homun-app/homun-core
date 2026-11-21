// K2 (fase team-bot): archiviazione ed eliminazione MORBIA di bot e team,
// giù fino allo store. Colonne archived_at/deleted_at (niente si perde),
// le routine del bot archiviato si fermano, i team archiviati/eliminati non
// sono più «di un membro» (niente risvegli né deleghe), e la scansione della
// pulizia trova SOLO chi supera i 30 giorni. Store reale su temporanea.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'
import {
  setDataDir, db, createAgent, createRoutine, listAgentsIncludingRemoved, listRoutines,
  setAgentArchived, setAgentDeleted, pauseRoutinesOfAgent, expiredRemovedAgentIds
} from '../db'
import {
  createGroup, listGroups, groupsOfMember, groupWithMembers,
  setGroupArchived, setGroupDeleted
} from '../groups'

let dir: string
const DAY = 86_400_000

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE + '/', 'sandbot-archive-'))
  setDataDir(dir)
  db()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('K2: archivia il bot — flag, routine in pausa, nessun dato perso', () => {
  it('setAgentArchived/unarchive scrivono e cancellano archivedAt', () => {
    const a = createAgent('Competitoor', 'scrive')
    setAgentArchived(a.id, 1_000)
    // X1 (fase sicurezza-beta16): il roster esclude i rimossi — la riga si
    // legge dalla strada esplicita
    expect(listAgentsIncludingRemoved().find((x) => x.id === a.id)?.archivedAt).toBe(1_000)
    setAgentArchived(a.id, null)
    expect(listAgentsIncludingRemoved().find((x) => x.id === a.id)?.archivedAt).toBeNull()
  })

  it('pauseRoutinesOfAgent spegne le routine del bot (e SOLO le sue)', () => {
    const a = createAgent('Con routine', '')
    const b = createAgent('Altra routine', '')
    const ra = createRoutine(a.id, 'Ogni ora', 'p', '0 * * * *')
    const rb = createRoutine(b.id, 'Altra', 'p', '0 * * * *')
    pauseRoutinesOfAgent(a.id)
    const rs = listRoutines()
    expect(rs.find((r) => r.id === ra.id)?.enabled).toBe(0)
    expect(rs.find((r) => r.id === rb.id)?.enabled).toBe(1)
  })
})

describe('K2: elimina il bot — morbido, recuperabile, poi la pulizia', () => {
  it('setAgentDeleted segna deletedAt; a null lo ripulisce (Ripristina)', () => {
    const a = createAgent('Morbido', '')
    setAgentDeleted(a.id, 2_000)
    expect(listAgentsIncludingRemoved().find((x) => x.id === a.id)?.deletedAt).toBe(2_000)
    setAgentDeleted(a.id, null)
    expect(listAgentsIncludingRemoved().find((x) => x.id === a.id)?.deletedAt).toBeNull()
  })

  it('expiredRemovedAgentIds: solo chi supera i 30 giorni', () => {
    const now = 100 * DAY
    const vecchio = createAgent('Vecchio', '')
    const fresco = createAgent('Fresco', '')
    const archiviato = createAgent('Solo archiviato', '')
    setAgentDeleted(vecchio.id, now - 31 * DAY)
    setAgentDeleted(fresco.id, now - 29 * DAY)
    setAgentArchived(archiviato.id, now - 40 * DAY)
    expect(expiredRemovedAgentIds(now).sort()).toEqual([vecchio.id].sort())
  })
})

describe('K2: archivia il team — fuori dai membri, dentro listGroups col flag', () => {
  it('setGroupArchived: groupsOfMember non lo vede più, groupWithMembers porta archivedAt', () => {
    const a = createAgent('Capo', '')
    const g = createGroup('Weekend Torino', '', 'user', [a.id], a.id)
    expect(groupsOfMember(a.id).map((x) => x.id)).toContain(g.id)
    setGroupArchived(g.id, 3_000)
    expect(groupsOfMember(a.id).map((x) => x.id)).not.toContain(g.id)
    const listed = listGroups().find((x) => x.id === g.id)
    expect(listed?.archived_at).toBe(3_000)
    expect(groupWithMembers(listed!).archivedAt).toBe(3_000)
    expect(groupWithMembers(listed!).deletedAt).toBeNull()
    // ripristina
    setGroupArchived(g.id, null)
    expect(groupsOfMember(a.id).map((x) => x.id)).toContain(g.id)
  })

  it('setGroupDeleted segna deletedAt e toglie il team da groupsOfMember', () => {
    const a = createAgent('Membro', '')
    const g = createGroup('Team del teste', '', 'user', [a.id], a.id)
    setGroupDeleted(g.id, 4_000)
    expect(groupsOfMember(a.id).map((x) => x.id)).not.toContain(g.id)
    expect(listGroups().find((x) => x.id === g.id)?.deleted_at).toBe(4_000)
    expect(groupWithMembers(listGroups().find((x) => x.id === g.id)!).deletedAt).toBe(4_000)
    setGroupDeleted(g.id, null)
    expect(groupsOfMember(a.id).map((x) => x.id)).toContain(g.id)
  })
})
