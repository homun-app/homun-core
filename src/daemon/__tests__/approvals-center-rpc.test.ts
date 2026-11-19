// A1 (fase centro-autorizzazioni): l'RPC approvals:pending-all — la tabella
// approvals come INDICE delle richieste pendenti (status = 'pending', con
// indice), unita alla entry della card per frase, categoria, perché, ora e
// marcatori di squadra. Il costo dipende dal numero delle RICHIESTE, non
// dalla lunghezza delle chat: mai getEntries per agente.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

// fase 16b: le cartelle temporanee dei test di questa fase nascono con
// mkdtemp nella directory fissata per il lavoro (mai $TMPDIR/os.tmpdir)
const TMP_ROOT = TEST_TMP_BASE + '/'

const {
  setDataDir, dataDir, db, createAgent, appendEntry, getEntries, updateEntryMeta
} = await import('../../main/store/db')
const { createGroup } = await import('../../main/store/groups')
const {
  recordPendingApproval, setApprovalRowStatus, pendingApprovalsAll
} = await import('../../main/store/approvals-center')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent } from '../../shared/types'
import { TEST_TMP_BASE } from '../../test-tmp'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-centro-a1-'))
  setDataDir(dir)
  dataDir()
  db()
})
beforeEach(() => {
  events = []
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Una card pendente come la crea il loop: entry kind approval (o send-message
 * per le bozze) con meta.approvalId, e la riga dell'indice approvals. */
const pendingCard = (agentId: string, approvalId: string, meta: Record<string, unknown>, kind: 'approval' | 'send-message' = 'approval', content = ''): number => {
  const e = appendEntry({ agentId, kind, role: kind === 'send-message' ? 'assistant' : 'system', content, meta: { approvalId, status: 'pending', ...meta } })
  recordPendingApproval({ id: approvalId, agentId, tool: String(meta.tool ?? ''), input: (meta.input ?? {}) as Record<string, unknown>, entryId: e.id, createdAt: e.createdAt })
  return e.id
}

describe('A1: approvals:pending-all — righe, gruppi e ordinamento', () => {
  it('2 squadre + 1 bot singolo + 1 sottoagente: 4 righe nei gruppi giusti', async () => {
    const a1 = createAgent('Alfa', '')
    const b1 = createAgent('Beta', '')
    const c1 = createAgent('Gamma', '')
    const solo = createAgent('Ricerche', '')
    const figlio = createAgent('Aiutante', '', { parentId: solo.id })
    const g1 = createGroup('Weekend Torino', '', 'user', [a1.id, b1.id], a1.id)
    const g2 = createGroup('Fatture marzo', '', 'user', [c1.id], c1.id)

    pendingCard(a1.id, 'ap-museo', { tool: 'fill_credential', squadId: g1.id, squadAlwaysAsk: true, input: { origin: 'https://museo.example' } }, 'approval', 'Compilare il modulo del Museo Egizio con nome ed email.')
    pendingCard(b1.id, 'ap-click', { tool: 'browser_click', squadId: g1.id, browser: { url: 'https://booking.example/verifica' } }, 'approval', 'Cliccare «Verifica disponibilità».')
    pendingCard(c1.id, 'ap-mail', { tool: 'draft_external', squadId: g2.id, message: { type: 'draft', to: 'amministrazione@rossi.example', subject: 'Fattura 214' } }, 'send-message', 'Sollecito di pagamento.')
    pendingCard(figlio.id, 'ap-login', { tool: 'browser_click' }, 'approval', 'Accedere a LinkedIn.')

    const rows = (await api['approvals:pending-all']!([])) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(4)
    const byId = Object.fromEntries(rows.map((r) => [r.approvalId, r]))
    // la card del sottoagente mostra il PADRE, «tramite un sottoagente»
    expect(byId['ap-login']).toMatchObject({ agentId: figlio.id, botId: solo.id, botName: 'Ricerche', fromSubagent: true, squad: null })
    expect(byId['ap-museo']).toMatchObject({ agentId: a1.id, botId: a1.id, fromSubagent: false, squad: { id: g1.id, name: 'Weekend Torino' } })
    expect(byId['ap-museo']).toMatchObject({ category: 'dati-tuoi', why: 'fisso', phrase: 'Compilare il modulo del Museo Egizio con nome ed email.' })
    expect(byId['ap-click']).toMatchObject({ squad: { id: g1.id }, category: 'sito-interattivo', why: null })
    // la bozza: categoria invio, con destinatario e oggetto già nella card
    expect(byId['ap-mail']).toMatchObject({ squad: { id: g2.id }, category: 'invio', isDraft: true })
    expect(JSON.stringify(byId['ap-mail'])).toContain('amministrazione@rossi.example')
    // l'anteprima del sito c'è solo perché è già nel meta della card
    expect(JSON.stringify(byId['ap-click'])).toContain('booking.example')
    // l'ordinamento: prima l'insieme fisso, poi le altre; a parità la più vecchia
    const order = rows.map((r) => r.approvalId)
    expect(order.indexOf('ap-museo')).toBeLessThan(order.indexOf('ap-click'))
  })

  it('una richiesta decisa sparisce', async () => {
    const a = createAgent('Deciso', '')
    const entryId = pendingCard(a.id, 'ap-decisa', { tool: 'run-command', input: { command: 'ls' } }, 'approval', 'Comando.')
    const fresh = getEntries(a.id).find((e) => e.id === entryId)?.meta ?? {}
    updateEntryMeta(entryId, { ...fresh, status: 'denied' })
    setApprovalRowStatus('ap-decisa', 'denied')
    const rows = (await api['approvals:pending-all']!([])) as Array<Record<string, unknown>>
    expect(rows.some((r) => r.approvalId === 'ap-decisa')).toBe(false)
  })

  it('self-heal: la riga resta pending nell\'indice ma la entry è già decisa → non compare e l\'indice si riallinea', async () => {
    const a = createAgent('Sfasato', '')
    const entryId = pendingCard(a.id, 'ap-sfasata', { tool: 'browser_click' }, 'approval', 'Clic.')
    const fresh = getEntries(a.id).find((e) => e.id === entryId)?.meta ?? {}
    updateEntryMeta(entryId, { ...fresh, status: 'allowed' })
    // (nessun setApprovalRowStatus: l'indice resta com'era)
    const rows = (await api['approvals:pending-all']!([])) as Array<Record<string, unknown>>
    expect(rows.some((r) => r.approvalId === 'ap-sfasata')).toBe(false)
    const raw = db().prepare('SELECT status FROM approvals WHERE id = ?').get('ap-sfasata') as { status: string }
    expect(raw.status).toBe('allowed')
  })

  it('una richiesta di un bot eliminato non compare', async () => {
    const a = createAgent('Morto', '')
    pendingCard(a.id, 'ap-morto', { tool: 'browser_click' }, 'approval', 'Clic.')
    const { deleteAgent } = await import('../../main/store/db')
    deleteAgent(a.id)
    const rows = (await api['approvals:pending-all']!([])) as Array<Record<string, unknown>>
    expect(rows.some((r) => r.approvalId === 'ap-morto')).toBe(false)
  })

  it('la squadra senza marcatore viene dal padre se è unica', async () => {
    const a = createAgent('SoloUnico', '')
    const g = createGroup('Lavoro', '', 'user', [a.id], a.id)
    pendingCard(a.id, 'ap-senza-marcatore', { tool: 'browser_click' }, 'approval', 'Clic.')
    const rows = (await api['approvals:pending-all']!([])) as Array<Record<string, unknown>>
    const row = rows.find((r) => r.approvalId === 'ap-senza-marcatore')
    expect(row?.squad).toMatchObject({ id: g.id, name: 'Lavoro' })
  })

  it('PRESTAZIONI: 100 bot × 2.000 entry, 10 pendenti → RPC sotto 50 ms', async () => {
    const insert = db().prepare('INSERT INTO entries(agent_id, kind, role, content, meta, created_at) VALUES(?,?,?,?,?,?)')
    for (let b = 0; b < 100; b++) {
      const id = 'perf-bot-' + b
      createAgent('Perf' + b, '', { id })
      db().exec('BEGIN')
      for (let i = 0; i < 2_000; i++) {
        insert.run(id, 'send-message', 'assistant', 'messaggio numero ' + i, JSON.stringify({ note: i }), Date.now() - i)
      }
      db().exec('COMMIT')
    }
    for (let i = 0; i < 10; i++) {
      const owner = 'perf-bot-' + i
      const e = appendEntry({ agentId: owner, kind: 'approval', role: 'system', content: 'richiesta perf ' + i, meta: { approvalId: 'perf-ap-' + i, status: 'pending', tool: 'browser_click' } })
      recordPendingApproval({ id: 'perf-ap-' + i, agentId: owner, tool: 'browser_click', input: {}, entryId: e.id, createdAt: e.createdAt })
    }
    // due giri: il primo scalda, il numero del REPORT è il secondo
    await api['approvals:pending-all']!([])
    const t0 = performance.now()
    const rows = (await api['approvals:pending-all']!([])) as Array<Record<string, unknown>>
    const ms = performance.now() - t0
    console.log('[A1 prestazioni] approvals:pending-all con 100 bot × 2.000 entry e 10 pendenti:', ms.toFixed(1), 'ms')
    expect(rows.filter((r) => String(r.approvalId).startsWith('perf-ap-'))).toHaveLength(10)
    expect(ms).toBeLessThan(50)
  })
})
