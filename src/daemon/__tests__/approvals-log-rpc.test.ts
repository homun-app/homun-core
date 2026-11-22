// A2 (fase approvazioni-chiare): il REGISTRO delle approvazioni — la tabella
// approvals registra CHI ha deciso, QUANDO, COME (una volta, turno, sempre,
// sito, letture, missione) e DA DOVE (chat, centro, notifica; expired per le
// scadenze). I rifiuti RESTANO nella tabella. Le chiamate passate da sole
// (grant o regola, non le letture innocue) lasciano la riga leggera
// nell'indice tool_use con allowed_by. La query è indicizzata: sotto 50 ms
// con 10.000 righe.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const TMP_ROOT = TEST_TMP_BASE + '/'

const {
  setDataDir, dataDir, db, createAgent, appendEntry, getEntries
} = await import('../../main/store/db')
const {
  recordPendingApproval, approvalLog, recordAutoAllow
} = await import('../../main/store/approvals-center')
const { setApprovalStatus } = await import('../../main/agent/loop')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent } from '../../shared/types'
import { TEST_TMP_BASE } from '../../test-tmp'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-registro-a2-'))
  setDataDir(dir)
  dataDir()
  db()
})
beforeEach(() => {
  events = []
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Una card pendente come la crea il loop, con la sua riga d'indice. */
const pendingCard = (agentId: string, approvalId: string, tool = 'run-command', content = 'run-command: esegue un comando'): number => {
  const e = appendEntry({ agentId, kind: 'approval', role: 'system', content, meta: { approvalId, tool, status: 'pending', input: { command: 'ls' } } })
  recordPendingApproval({ id: approvalId, agentId, tool, input: {}, entryId: e.id, createdAt: e.createdAt })
  return e.id
}

/** il percorso VERO di una decisione: l'RPC scrive mode e via nel meta, la
 *  chiusura della card (setApprovalStatus) li porta nella riga del registro */
const decide = (agentId: string, approvalId: string, entryId: number, decision: 'allow' | 'deny', mode: string, via: string): void => {
  api['approvals:resolve']!([agentId, approvalId, decision, mode, via])
  setApprovalStatus(agentId, entryId, decision === 'allow' ? 'allowed' : 'denied', emit)
}

describe('A2: il registro delle approvazioni (tabella approvals)', () => {
  it('la migrazione aggiunge le colonne decided_at, decision, mode, decided_via (e l\'indice)', () => {
    const cols = db().prepare("SELECT name FROM pragma_table_info('approvals')").all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    for (const c of ['decided_at', 'decision', 'mode', 'decided_via']) expect(names, c).toContain(c)
    const idx = db().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='approvals'").all() as Array<{ name: string }>
    expect(idx.some((i) => i.name === 'idx_approvals_decided')).toBe(true)
    // e l'indice dell'uso porta allowed_by (le «passate da sole»)
    const tu = db().prepare("SELECT name FROM pragma_table_info('tool_use')").all() as Array<{ name: string }>
    expect(tu.map((c) => c.name)).toContain('allowed_by')
  })

  it('ogni modo di decidere scrive la riga completa: chi, quando, come, da dove', () => {
    const a = createAgent('Turismo', '')
    const modes: Array<[string, string]> = [
      ['once', 'chat'], ['turn', 'chat'], ['always', 'center'], ['site', 'center'],
      ['server-reads', 'chat'], ['mission', 'center'], ['minutes10', 'chat']
    ]
    modes.forEach(([mode, via], i) => {
      const id = `ap-${mode}`
      const entryId = pendingCard(a.id, id)
      decide(a.id, id, entryId, 'allow', mode, via)
      const row = db().prepare('SELECT decision, mode, decided_via, decided_at FROM approvals WHERE id = ?').get(id) as
        { decision: string; mode: string; decided_via: string; decided_at: number }
      expect(row.decision, mode).toBe('allow')
      expect(row.mode, mode).toBe(mode)
      expect(row.decided_via, mode).toBe(via)
      expect(row.decided_at, mode).toBeGreaterThan(0)
    })
  })

  it('un rifiuto RESTA nella tabella (non si cancella) con decisione deny', () => {
    const a = createAgent('Archivio', '')
    const entryId = pendingCard(a.id, 'ap-rifiuto')
    decide(a.id, 'ap-rifiuto', entryId, 'deny', 'once', 'center')
    const row = db().prepare('SELECT status, decision, decided_via FROM approvals WHERE id = ?').get('ap-rifiuto') as
      { status: string; decision: string; decided_via: string }
    expect(row.status).toBe('denied')
    expect(row.decision).toBe('deny')
    // e compare nel registro tra i rifiutati
    const log = approvalLog(100)
    expect(log.some((r) => r.approvalId === 'ap-rifiuto' && r.decision === 'deny')).toBe(true)
  })

  it('una scadenza scrive decision expired, via expired', () => {
    const a = createAgent('Scaduto', '')
    const entryId = pendingCard(a.id, 'ap-scaduta')
    setApprovalStatus(a.id, entryId, 'expired', emit)
    const row = db().prepare('SELECT decision, decided_via FROM approvals WHERE id = ?').get('ap-scaduta') as
      { decision: string; decided_via: string }
    expect(row.decision).toBe('expired')
    expect(row.decided_via).toBe('expired')
  })

  it('le righe VECCHIE restano coi campi vuoti: il registro le marca «precedenti»', () => {
    const a = createAgent('Vecchio', '')
    const entryId = pendingCard(a.id, 'ap-vecchia', 'browser_click', 'Clic.')
    // come le righe del DB vero di prima della migrazione: status deciso, campi vuoti
    db().prepare('UPDATE approvals SET status = ? WHERE id = ?').run('allowed', 'ap-vecchia')
    void entryId
    const log = approvalLog(100)
    const row = log.find((r) => r.approvalId === 'ap-vecchia')
    expect(row).toBeTruthy()
    expect(row!.legacy).toBe(true)
    expect(row!.decision).toBeNull()
  })

  it('approvals:log (l\'RPC del centro): righe con frase, bot, scelta, da dove e quando', async () => {
    const a = createAgent('Solleciti', '')
    const entryId = pendingCard(a.id, 'ap-mail', 'draft_external', 'Mandare il sollecito a Rossi Srl.')
    decide(a.id, 'ap-mail', entryId, 'allow', 'always', 'chat')
    const rows = (await api['approvals:log']!([100])) as Array<Record<string, unknown>>
    const row = rows.find((r) => r.approvalId === 'ap-mail')
    expect(row).toMatchObject({ agentId: a.id, botName: 'Solleciti', phrase: 'Mandare il sollecito a Rossi Srl.', decision: 'allow', mode: 'always', via: 'chat' })
    expect(Number(row!.at)).toBeGreaterThan(0)
  })
})

describe('A2: le chiamate passate da sole (grant o regola) nel registro', () => {
  it('una chiamata passata per GRANT compare in «Passate da sole» con allowed_by grant <id>', () => {
    const a = createAgent('ConGrant', '')
    const e = appendEntry({ agentId: a.id, kind: 'tool-call', role: 'assistant', content: 'write-file', meta: { id: 'c1', name: 'write-file' } })
    recordAutoAllow(db(), { entryId: e.id, tool: 'write-file', agentId: a.id, at: Date.now(), allowedBy: 'grant 12' })
    const log = approvalLog(100)
    const row = log.find((r) => r.kind === 'auto' && r.allowedBy === 'grant 12')
    expect(row).toMatchObject({ tool: 'write-file', agentId: a.id, botName: 'ConGrant', decision: 'auto' })
  })

  it('una chiamata passata per REGOLA: allowed_by rule <tool>', () => {
    const a = createAgent('ConRegola', '')
    const e = appendEntry({ agentId: a.id, kind: 'tool-call', role: 'assistant', content: 'run-command', meta: { id: 'c2', name: 'run-command' } })
    recordAutoAllow(db(), { entryId: e.id, tool: 'run-command', agentId: a.id, at: Date.now(), allowedBy: 'rule run-command' })
    expect(approvalLog(100).some((r) => r.kind === 'auto' && r.allowedBy === 'rule run-command')).toBe(true)
  })

  it('gli usi SENZA allowed_by (le letture innocue) NON compare nel registro', () => {
    const a = createAgent('Letture', '')
    const e = appendEntry({ agentId: a.id, kind: 'tool-call', role: 'assistant', content: 'recall_memory', meta: { id: 'c3', name: 'recall_memory' } })
    void e
    expect(approvalLog(100).some((r) => r.tool === 'recall_memory')).toBe(false)
  })
})

describe('A2: prestazioni del registro', () => {
  it('10.000 righe decise: la query del registro sotto 50 ms (indice su decided_at)', () => {
    const a = createAgent('PerfRegistro', '')
    const ins = db().prepare('INSERT INTO approvals(id, agent_id, tool, input, status, created_at, entry_id, decided_at, decision, mode, decided_via) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    db().exec('BEGIN')
    for (let i = 0; i < 10_000; i++) {
      ins.run(`perf-${i}`, a.id, 'run-command', '{}', 'allowed', Date.now() - i, null, Date.now() - i, 'allow', 'once', 'chat')
    }
    db().exec('COMMIT')
    approvalLog(200) // il primo giro scalda
    const t0 = performance.now()
    const rows = approvalLog(200)
    const ms = performance.now() - t0
    console.log('[A2 prestazioni] approvalLog con 10.000 righe decise (limite 200):', ms.toFixed(1), 'ms')
    expect(rows.length).toBe(200)
    expect(ms).toBeLessThan(50)
  })
})
