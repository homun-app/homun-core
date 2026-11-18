// Q5 (fase squadra): il pannello del team — RPC groups:overview. Stati che
// cambiano con gli eventi (un membro con una card in attesa = «aspetta te»),
// contatori (pagine lette, file scritti, sottoagenti), ruolo, e «Prodotto
// dalla squadra» (i documenti creati nei turni della squadra).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as store from '../db'
import { createGroup, squadOverviewForGroup, addGroupMessage, finishGroupTurn, registerPlannedTurn } from '../groups'
import { TEST_TMP_BASE } from '../../../test-tmp'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-squad-overview-'))
  store.setDataDir(dir)
  store.db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const t of ['entries', 'agents', 'groups', 'group_members', 'group_messages', 'group_turns']) {
    store.db().exec(`DELETE FROM ${t}`)
  }
})

describe('Q5: squadOverviewForGroup — gli stati', () => {
  it('un membro con una card IN ATTESA = «aspetta te»; chi lavora = «lavora»; il coordinatore fermo = «coordina»', () => {
    const capo = store.createAgent('Capo', 'Unisce i file e controlla i conti')
    const treni = store.createAgent('Treni', 'Orari e prezzi A/R')
    const alloggio = store.createAgent('Alloggio', 'Dormire')
    const g = createGroup('Weekend', '', capo.id, [treni.id, alloggio.id], capo.id)
    // Treni ha una card pendente
    store.appendEntry({ agentId: treni.id, kind: 'approval', role: 'system', content: 'x', meta: { approvalId: 'a1', tool: 'fill_credential', status: 'pending', squadId: g.id } })
    // Alloggio sta lavorando
    store.updateAgent(alloggio.id, { status: 'thinking' })
    // Turismo nato e già finito: ultimo turno SENT → finito
    const turismo = store.createAgent('Turismo', 'Itinerari')
    store.db().prepare('INSERT INTO group_members(group_id, agent_id, joined_at) VALUES(?,?,?)').run(g.id, turismo.id, 1)
    registerPlannedTurn({ nonce: 'n1', groupId: g.id, memberId: turismo.id, sourceMessageId: 1 })
    finishGroupTurn('n1', 'SENT', 2)
    const ov = squadOverviewForGroup(g.id)
    const byName = Object.fromEntries(ov.members.map((m) => [m.name, m]))
    expect(byName['Capo']!.state).toBe('coordina')
    expect(byName['Treni']!.state).toBe('aspetta-te')
    expect(byName['Alloggio']!.state).toBe('lavora')
    expect(byName['Turismo']!.state).toBe('finito')
    // il ruolo è la descrizione del bot
    expect(byName['Capo']!.role).toBe('Unisce i file e controlla i conti')
  })

  it('senza consegne l\'ultimo turno è «fermo», e chi non ha turni pure', () => {
    const capo = store.createAgent('Capo fermo', '')
    const m = store.createAgent('Membro fermo', '')
    const g = createGroup('Weekend', '', capo.id, [m.id], capo.id)
    registerPlannedTurn({ nonce: 'n2', groupId: g.id, memberId: m.id, sourceMessageId: 1 })
    finishGroupTurn('n2', 'PASS', 2)
    const ov = squadOverviewForGroup(g.id)
    expect(ov.members.find((x) => x.name === 'Membro fermo')!.state).toBe('fermo')
    expect(ov.members.find((x) => x.name === 'Capo fermo')!.state).toBe('coordina')
  })
})

describe('Q5: i contatori e «Prodotto dalla squadra»', () => {
  it('pagine lette, file scritti e sottoagenti contano i turni della squadra (meta.squadId)', () => {
    const capo = store.createAgent('Capo conti', '')
    const t = store.createAgent('Treni conti', '')
    const g = createGroup('Weekend', '', capo.id, [t.id], capo.id)
    const tc = (name: string, squadId?: number) =>
      store.appendEntry({ agentId: t.id, kind: 'tool-call', role: 'assistant', content: name, meta: { name, ...(squadId !== undefined ? { squadId } : {}) } })
    tc('web_fetch', g.id)
    tc('web_fetch', g.id)
    tc('web_fetch', 999)
    tc('write-file', g.id)
    tc('write-file', g.id)
    tc('spawn_subagent', g.id)
    const ov = squadOverviewForGroup(g.id)
    const m = ov.members.find((x) => x.name === 'Treni conti')!
    expect(m.pagesRead).toBe(2)
    expect(m.filesWritten).toBe(2)
    expect(m.subagents).toBe(1)
  })

  it('«Prodotto dalla squadra»: le card artifact dei documenti (e i file condivisi)', () => {
    const capo = store.createAgent('Capo prod', '')
    const t = store.createAgent('Treni prod', '')
    const g = createGroup('Weekend', '', capo.id, [t.id], capo.id)
    addGroupMessage({ groupId: g.id, authorKind: 'artifact', authorId: capo.id, authorName: 'Capo prod', text: JSON.stringify({ kind: 'document', id: 'doc-1', title: 'Torino weekend — guida definitiva' }) })
    addGroupMessage({ groupId: g.id, authorKind: 'artifact', authorId: t.id, authorName: 'Treni prod', text: JSON.stringify({ kind: 'file', title: '01_treni.md', path: 'workspace/torino/01_treni.md' }) })
    addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: t.id, authorName: 'Treni prod', text: 'un post normale' })
    const ov = squadOverviewForGroup(g.id)
    expect(ov.produced.length).toBe(2)
    expect(ov.produced[0]!.title).toBe('Torino weekend — guida definitiva')
    expect(ov.produced[0]!.authorName).toBe('Capo prod')
    expect(ov.produced[1]!.kind).toBe('file')
  })
})
