// Q2 (fase squadra): la raccolta delle card pendenti della squadra dallo
// store VERO (mkdtemp): membri + sottoagenti, frasi, perché, e la RPC di
// risoluzione con la missione (grant di 8 ore per OGNI membro, solo per le
// categorie sito-interattivo e squadra, mai per l'insieme fisso).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as store from '../db'
import { createGroup, pendingApprovalsForGroup, applyMissionGrant } from '../groups'
import { listGrants } from '../db'
import { TEST_TMP_BASE } from '../../../test-tmp'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-squad-pending-'))
  store.setDataDir(dir)
  store.db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const t of ['entries', 'agents', 'grants', 'groups', 'group_members', 'group_messages']) {
    store.db().exec(`DELETE FROM ${t}`)
  }
})

describe('Q2: pendingApprovalsForGroup', () => {
  it('la card di un MEMBRO compare nella coda della squadra', () => {
    const a = store.createAgent('Treni', '')
    const b = store.createAgent('Alloggio', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'Delega non fidata a Treni',
      meta: { approvalId: 'ap-1', tool: 'send_to_agent', input: {}, status: 'pending', contaminated: true, squadId: g.id }
    })
    const rows = pendingApprovalsForGroup(g.id)
    expect(rows.length).toBe(1)
    expect(rows[0]!.agentName).toBe('Alloggio')
    expect(rows[0]!.phrase).toBe('Delega non fidata a Treni')
    expect(rows[0]!.category).toBe('squadra')
    expect(rows[0]!.why).toBe('contaminato')
  })

  it('la card di un SOTTOAGENTE di un membro compare anche lei (bot = il padre)', () => {
    const a = store.createAgent('Alloggio', '')
    const b = store.createAgent('Treni', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    const figlio = store.createAgent('Alloggio · Musei', '', { parentId: a.id })
    store.appendEntry({
      agentId: figlio.id, kind: 'send-message', role: 'system', content: 'Compilare il modulo del Museo Egizio con nome ed email.',
      meta: { approvalId: 'ap-2', tool: 'fill_credential', input: {}, status: 'pending' }
    })
    const rows = pendingApprovalsForGroup(g.id)
    expect(rows.length).toBe(1)
    expect(rows[0]!.fromSubagent).toBe(true)
    expect(rows[0]!.category).toBe('dati-tuoi')
  })

  it('le card DECISE non stanno in coda, e i bot fuori dalla squadra nemmeno', () => {
    const a = store.createAgent('Capo', '')
    const b = store.createAgent('Treni', '')
    const estraneo = store.createAgent('Estraneo', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    store.appendEntry({ agentId: a.id, kind: 'approval', role: 'system', content: 'già decisa', meta: { approvalId: 'ap-3', tool: 'use-app', status: 'allowed' } })
    store.appendEntry({ agentId: estraneo.id, kind: 'approval', role: 'system', content: 'di un altro', meta: { approvalId: 'ap-4', tool: 'use-app', status: 'pending' } })
    expect(pendingApprovalsForGroup(g.id)).toEqual([])
  })

  it('l\'insieme fisso e il revisore in dubbio si vedono nel perché', () => {
    const a = store.createAgent('Capo fisso', '')
    const b = store.createAgent('Membro', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    store.appendEntry({ agentId: b.id, kind: 'approval', role: 'system', content: 'x', meta: { approvalId: 'ap-5', tool: 'delete_agent', input: {}, status: 'pending', squadAlwaysAsk: true } })
    store.appendEntry({ agentId: b.id, kind: 'approval', role: 'system', content: 'y', meta: { approvalId: 'ap-6', tool: 'browser_click', input: {}, status: 'pending', squadReviewerAsk: true } })
    const rows = pendingApprovalsForGroup(g.id)
    expect(rows.find((r) => r.approvalId === 'ap-5')!.why).toBe('fisso')
    expect(rows.find((r) => r.approvalId === 'ap-6')!.why).toBe('revisore')
    expect(rows.find((r) => r.approvalId === 'ap-6')!.category).toBe('sito-interattivo')
  })
})

describe('Q2: il grant di missione (8 ore, un grant per membro)', () => {
  it('risolvere con la missione crea un grant per OGNI membro, con scadenza 8 ore', () => {
    const a = store.createAgent('Capo missione', '')
    const b = store.createAgent('Treni missione', '')
    const c = store.createAgent('Alloggio missione', '')
    const g = createGroup('Weekend', '', a.id, [b.id, c.id], a.id)
    // la delega contaminata chiede (autonomia ask): la card porta la squadra
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'delega',
      meta: { approvalId: 'ap-m1', tool: 'send_to_agent', input: { agentId: c.id, text: 'x' }, status: 'pending', contaminated: true, squadId: g.id }
    })
    const before = Date.now()
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-m1', now: before })
    const grants = listGrants().filter((g) => g.tool === 'send_to_agent')
    expect(grants.map((g) => g.agentId).sort()).toEqual([a.id, b.id, c.id].sort())
    for (const g of grants) {
      expect(g.expiresAt! - before).toBe(8 * 60 * 60 * 1000)
    }
  })

  it('MAI per dati-tuoi, pagamento, invio o insieme fisso: nessun grant', () => {
    const a = store.createAgent('Capo fisso m', '')
    const b = store.createAgent('Membro m', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    store.appendEntry({ agentId: b.id, kind: 'approval', role: 'system', content: 'f', meta: { approvalId: 'ap-m2', tool: 'fill_credential', input: {}, status: 'pending', squadAlwaysAsk: true, squadId: g.id } })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-m2', now: Date.now() })
    expect(listGrants().filter((g) => g.tool === 'fill_credential')).toEqual([])
  })

  it('per le azioni del browser il grant è per IL SITO (site:host), non per il tool', () => {
    const a = store.createAgent('Capo sito', '')
    const b = store.createAgent('Membro sito', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'clic',
      meta: { approvalId: 'ap-m3', tool: 'browser_click', input: { ref: 'e5' }, status: 'pending', squadReviewerAsk: true, squadId: g.id, browser: { url: 'https://booking-torino.example/prenota' } }
    })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-m3', now: Date.now() })
    const grants = listGrants().filter((g) => g.tool === 'browser_click')
    expect(grants.length).toBe(2)
    expect(grants.every((g) => g.target === 'site:booking-torino.example')).toBe(true)
  })
})
