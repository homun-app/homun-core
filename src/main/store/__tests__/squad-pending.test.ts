// Q2 (fase squadra): la raccolta delle card pendenti della squadra dallo
// store VERO (mkdtemp): membri + sottoagenti, frasi, perché, e la RPC di
// risoluzione con la missione (grant di 8 ore per OGNI membro, solo per le
// categorie sito-interattivo e squadra, mai per l'insieme fisso).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as store from '../db'
import { createGroup, pendingApprovalsForGroup, applyMissionGrant } from '../groups'
import { listGrants, revokeLegacyMissionGrants } from '../db'
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
    const grants = listGrants().filter((gr) => gr.tool === 'send_to_agent')
    expect(grants.map((gr) => gr.agentId).sort()).toEqual([a.id, b.id, c.id].sort())
    for (const gr of grants) {
      expect(gr.expiresAt! - before).toBe(8 * 60 * 60 * 1000)
      // S1: il target porta la SQUADRA e il DESTINATARIO della card, mai «*»
      expect(gr.target).toBe(`squad:${g.id}|agent:${c.id}`)
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

  it('per le azioni del browser il grant è per LA SQUADRA e IL SITO (squad:<gid>|site:host), non per il tool', () => {
    const a = store.createAgent('Capo sito', '')
    const b = store.createAgent('Membro sito', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'clic',
      meta: { approvalId: 'ap-m3', tool: 'browser_click', input: { ref: 'e5' }, status: 'pending', squadReviewerAsk: true, squadId: g.id, browser: { url: 'https://booking-torino.example/prenota' } }
    })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-m3', now: Date.now() })
    const grants = listGrants().filter((gr) => gr.tool === 'browser_click')
    expect(grants.length).toBe(2)
    expect(grants.every((gr) => gr.target === `squad:${g.id}|site:booking-torino.example`)).toBe(true)
  })

  it('S1: card su about:blank o data: → NESSUN grant (la decisione vale «una volta», la coda non offre la missione come concessione)', () => {
    const a = store.createAgent('Capo vuoto', '')
    const b = store.createAgent('Membro vuoto', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    for (const url of ['about:blank', 'data:text/html,<h1>ciao</h1>']) {
      store.appendEntry({
        agentId: b.id, kind: 'approval', role: 'system', content: 'clic senza host',
        meta: { approvalId: `ap-m4-${url.slice(0, 5)}`, tool: 'browser_click', input: { ref: 'e5' }, status: 'pending', squadReviewerAsk: true, squadId: g.id, browser: { url } }
      })
    }
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-m4-about', now: Date.now() })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-m4-data:', now: Date.now() })
    expect(listGrants().filter((gr) => gr.tool === 'browser_click')).toEqual([])
  })

  it('S1: la delega SENZA destinatario non crea grant', () => {
    const a = store.createAgent('Capo senza', '')
    const b = store.createAgent('Membro senza', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'delega senza id',
      meta: { approvalId: 'ap-m5', tool: 'send_to_agent', input: {}, status: 'pending', contaminated: true, squadId: g.id }
    })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-m5', now: Date.now() })
    expect(listGrants().filter((gr) => gr.tool === 'send_to_agent')).toEqual([])
  })
})

describe('S1 (fase squadra-sicurezza): revoca alla migrazione dei grant di missione col formato vecchio', () => {
  it('i grant browser «site:» (anche a host vuoto) e i «*» dei tool di squadra con scadenza 8 ore ESATTA vengono revocati; le concessioni dell\'utente restano', () => {
    const now = Date.now()
    const ins = store.db().prepare('INSERT INTO grants(tool, target, created_at, expires_at, agent_id) VALUES(?,?,?,?,?)')
    const mission = (tool: string, target: string, agentId: string): void => {
      ins.run(tool, target, now - 5_000, now - 5_000 + 8 * 60 * 60 * 1000, agentId)
    }
    // formato vecchio di applyMissionGrant: site:<host> (anche vuoto) e «*» a 8 ore
    mission('browser_click', 'site:booking.example', 'a1')
    mission('browser_click', 'site:', 'a1')
    mission('send_to_agent', '*', 'a1')
    mission('create_group', '*', 'a2')
    // concessioni dell'utente: «Consenti sempre» (senza scadenza), «10 minuti»
    // (solo use-app, durata 10 minuti), grant di comando a chiave esatta
    ins.run('send_to_agent', '*', now - 5_000, null, 'a4')
    ins.run('send_to_agent', '*', now - 5_000, now + 600_000, 'a3')
    ins.run('use-app', 'app:Safari', now - 5_000, now + 600_000, 'a1')
    ins.run('run-command', 'ls', now - 5_000, null, 'a1')
    const { removed } = revokeLegacyMissionGrants()
    expect(removed).toBe(4)
    const left = listGrants().map((gr) => `${gr.tool}|${gr.target}|${gr.agentId}`).sort()
    expect(left).toEqual([
      'run-command|ls|a1',
      'send_to_agent|*|a3',
      'send_to_agent|*|a4',
      'use-app|app:Safari|a1'
    ].sort())
  })
})

describe('S3 (fase squadra-sicurezza-2): bersaglio preciso e niente missione per create_*', () => {
  it('create_agent/create_group NON creano grant di missione (la card vale «una volta»)', () => {
    const a = store.createAgent('Capo crea', '')
    const b = store.createAgent('Membro crea', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    for (const [apid, tool] of [['ap-s3a', 'create_agent'], ['ap-s3b', 'create_group']] as const) {
      store.appendEntry({
        agentId: b.id, kind: 'approval', role: 'system', content: 'crea',
        meta: { approvalId: apid, tool, input: { name: 'Nuovo' }, status: 'pending', squadId: g.id }
      })
      applyMissionGrant({ agentId: b.id, approvalId: apid, now: Date.now() })
    }
    expect(listGrants().filter((gr) => gr.tool === 'create_agent' || gr.tool === 'create_group')).toEqual([])
  })

  it('update_group di UN\'ALTRA squadra non crea grant (il grant copre solo la PROPRIA squadra)', () => {
    const a = store.createAgent('Capo proprio', '')
    const b = store.createAgent('Membro proprio', '')
    const g1 = createGroup('Weekend', '', a.id, [b.id], a.id)
    const g2 = createGroup('Altra', '', a.id, [], a.id)
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'aggiorna l\'altra',
      meta: { approvalId: 'ap-s3c', tool: 'update_group', input: { groupId: g2.id, description: 'x' }, status: 'pending', squadId: g1.id }
    })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-s3c', now: Date.now() })
    expect(listGrants().filter((gr) => gr.tool === 'update_group')).toEqual([])
  })

  it('update_group della PROPRIA squadra crea il grant squad:<gid>|group:<gid> (per ogni membro)', () => {
    const a = store.createAgent('Capo gruppo', '')
    const b = store.createAgent('Membro gruppo', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'aggiorna la propria',
      meta: { approvalId: 'ap-s3d', tool: 'update_group', input: { groupId: g.id, description: 'x' }, status: 'pending', squadId: g.id }
    })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-s3d', now: Date.now() })
    const grants = listGrants().filter((gr) => gr.tool === 'update_group')
    expect(grants.map((gr) => gr.agentId).sort()).toEqual([a.id, b.id].sort())
    expect(grants.every((gr) => gr.target === `squad:${g.id}|group:${g.id}`)).toBe(true)
  })

  it('update_agent di un bot NON membro non crea grant; di un MEMBRO crea squad:<gid>|agent:<id>', () => {
    const a = store.createAgent('Capo bot', '')
    const b = store.createAgent('Membro bot', '')
    const membro = store.createAgent('Bot membro', '')
    const estraneo = store.createAgent('Bot fuori', '')
    const g = createGroup('Weekend', '', a.id, [b.id, membro.id], a.id)
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'aggiorna lo straniero',
      meta: { approvalId: 'ap-s3e', tool: 'update_agent', input: { agentId: estraneo.id, role: 'x' }, status: 'pending', squadId: g.id }
    })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-s3e', now: Date.now() })
    expect(listGrants().filter((gr) => gr.tool === 'update_agent' && gr.target === `squad:${g.id}|agent:${estraneo.id}`)).toEqual([])
    store.appendEntry({
      agentId: b.id, kind: 'approval', role: 'system', content: 'aggiorna il membro',
      meta: { approvalId: 'ap-s3f', tool: 'update_agent', input: { agentId: membro.id, role: 'x' }, status: 'pending', squadId: g.id }
    })
    applyMissionGrant({ agentId: b.id, approvalId: 'ap-s3f', now: Date.now() })
    const grants = listGrants().filter((gr) => gr.tool === 'update_agent')
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.every((gr) => gr.target === `squad:${g.id}|agent:${membro.id}`)).toBe(true)
  })
})

describe('S3 (fase squadra-sicurezza-2): revoca alla migrazione dei grant squad:<gid>|* del formato della fase scorsa', () => {
  it('i squad:%|* di update_group/update_agent/create_* vengono revocati; i nuovi (group:/agent:), le deleghe e i siti restano', () => {
    const ins = store.db().prepare('INSERT INTO grants(tool, target, created_at, expires_at, agent_id) VALUES(?,?,?,?,?)')
    const now = Date.now()
    // formato della fase scorsa: riconoscibili dal prefisso squad: e dal tool
    ins.run('update_group', 'squad:1|*', now, now + 8 * 60 * 60 * 1000, 'a1')
    ins.run('update_agent', 'squad:1|*', now, now + 8 * 60 * 60 * 1000, 'a1')
    ins.run('create_agent', 'squad:1|*', now, now + 8 * 60 * 60 * 1000, 'a2')
    ins.run('create_group', 'squad:2|*', now, now + 8 * 60 * 60 * 1000, 'a3')
    // formato NUOVO di questa fase e grant degli altri tool: restano
    ins.run('update_group', 'squad:1|group:1', now, now + 8 * 60 * 60 * 1000, 'a1')
    ins.run('update_agent', 'squad:1|agent:b7', now, now + 8 * 60 * 60 * 1000, 'a1')
    ins.run('send_to_agent', 'squad:1|agent:b2', now, now + 8 * 60 * 60 * 1000, 'a1')
    ins.run('browser_click', 'squad:1|site:booking.example', now, now + 8 * 60 * 60 * 1000, 'a1')
    ins.run('run-command', 'ls', now, null, 'a1')
    const { removed } = revokeLegacyMissionGrants()
    expect(removed).toBe(4)
    const left = listGrants().map((gr) => `${gr.tool}|${gr.target}`).sort()
    expect(left).toEqual([
      'browser_click|squad:1|site:booking.example',
      'run-command|ls',
      'send_to_agent|squad:1|agent:b2',
      'update_agent|squad:1|agent:b7',
      'update_group|squad:1|group:1'
    ].sort())
  })
})

describe('S4 (fase squadra-sicurezza-2): un bot tolto dalla squadra perde i permessi di quella squadra', () => {
  it('removeGroupMember revoca i grant squad:<gid>|… di quel bot (e SOLO i suoi)', async () => {
    const { removeGroupMember } = await import('../groups')
    const a = store.createAgent('Capo revoca', '')
    const b = store.createAgent('Membro revoca', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    const now = Date.now()
    const ins = store.db().prepare('INSERT INTO grants(tool, target, created_at, expires_at, agent_id) VALUES(?,?,?,?,?)')
    ins.run('browser_click', `squad:${g.id}|site:booking.example`, now, now + 8 * 60 * 60 * 1000, a.id)
    ins.run('browser_click', `squad:${g.id}|site:booking.example`, now, now + 8 * 60 * 60 * 1000, b.id)
    // una concessione NON di missione dello stesso bot: resta
    ins.run('run-command', 'ls', now, null, b.id)
    removeGroupMember(g.id, b.id)
    const left = listGrants().map((gr) => `${gr.tool}|${gr.target}|${gr.agentId}`).sort()
    expect(left).toEqual([
      'browser_click|squad:' + g.id + '|site:booking.example|' + a.id,
      'run-command|ls|' + b.id
    ].sort())
  })

  it('la cancellazione della squadra revoca TUTTI i grant squad:<gid>|…', async () => {
    const { deleteGroup } = await import('../groups')
    const a = store.createAgent('Capo canc', '')
    const b = store.createAgent('Membro canc', '')
    const g = createGroup('Weekend', '', a.id, [b.id], a.id)
    const g2 = createGroup('Altra resta', '', a.id, [], a.id)
    const now = Date.now()
    const ins = store.db().prepare('INSERT INTO grants(tool, target, created_at, expires_at, agent_id) VALUES(?,?,?,?,?)')
    ins.run('browser_click', `squad:${g.id}|site:booking.example`, now, now + 8 * 60 * 60 * 1000, a.id)
    ins.run('update_group', `squad:${g.id}|group:${g.id}`, now, now + 8 * 60 * 60 * 1000, b.id)
    ins.run('send_to_agent', `squad:${g.id}|agent:${b.id}`, now, now + 8 * 60 * 60 * 1000, a.id)
    // un grant dell'ALTRA squadra: resta
    ins.run('browser_click', `squad:${g2.id}|site:altro.example`, now, now + 8 * 60 * 60 * 1000, a.id)
    deleteGroup(store.db(), g.id)
    const left = listGrants().map((gr) => `${gr.tool}|${gr.target}`).sort()
    expect(left).toEqual([`browser_click|squad:${g2.id}|site:altro.example`])
  })
})
