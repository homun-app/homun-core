// Fase 19b (T4/T6/T7): il feed ATTIVITÀ — la tabella computer_actions (tetto
// 300 per proprietario), l'unione e l'ordinamento delle due fonti (shell_jobs
// + computer_actions, PURO), i comandi dei FIGLI col nome, l'accesso
// activity:output di un ALTRO proprietario rifiutato, e la verifica T4.1 che
// il comando salvato in shell_jobs porta i RIFERIMENTI ai segreti
// ({{secret:NOME}}), mai i valori.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { COMPUTER_ACTIONS_DDL, createComputerAction, computerActionCountOf, getComputerAction, COMPUTER_ACTIONS_PER_OWNER_MAX } from '../../store/computer-actions'
import { SHELL_JOBS_DDL, createShellJob, type ShellJob } from '../../store/shell-jobs'
import type { ComputerAction } from '../../store/computer-actions'

// il db del daemon è FINTO: :memory: con le due tabelle del feed; la
// famiglia del padre `papà` comprende il figlio `figlio`
const mem = new DatabaseSync(':memory:')
mem.exec(SHELL_JOBS_DDL)
mem.exec(COMPUTER_ACTIONS_DDL)

vi.mock('../../store/db', () => ({
  db: () => mem,
  getAgent: (id: string) => (id === 'papà' ? { id, name: 'Papà', parentId: null } : id === 'figlio' ? { id, name: 'Figlio', parentId: 'papà' } : id === 'altro' ? { id, name: 'Altro', parentId: null } : null),
  familyAgents: (owner: string) => (owner === 'papà' ? [{ id: 'papà', name: 'Papà' }, { id: 'figlio', name: 'Figlio' }] : [{ id: owner, name: owner }])
}))
vi.mock('../../sandbox', () => ({
  // come il vero boxOwnerOf: il figlio appartiene al padre
  boxOwnerOf: (id: string) => (id === 'figlio' ? 'papà' : id)
}))

const { recordComputerAction, mergeActivity, shellItem, actionItem, listComputerActivity, computerActivityOutput, setComputerActivityEmitter, truncateText } = await import('../computer-activity')

describe('fase 19b (T4.1): la tabella computer_actions', () => {
  it('il tetto: al massimo 300 righe per owner, le più vecchie si cancellano all\'inserimento', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(COMPUTER_ACTIONS_DDL)
    for (let i = 0; i < COMPUTER_ACTIONS_PER_OWNER_MAX + 10; i++) {
      createComputerAction(db, {
        id: `act-${i}`, agent_id: 'papà', owner_id: 'papà', actor: 'bot',
        kind: 'write_file', target: `file-${i}`, bytes: i, error: null, created_at: 1_000 + i
      })
    }
    expect(computerActionCountOf(db, 'papà')).toBe(COMPUTER_ACTIONS_PER_OWNER_MAX)
    // le più VECCHIE sono andate: resta da file-10 in poi
    const first = getComputerAction(db, 'act-9')
    expect(first).toBeNull()
    expect(getComputerAction(db, 'act-10')).not.toBeNull()
    // il tetto è PER PROPRIETARIO: un altro owner non si tocca
    createComputerAction(db, { id: 'act-altro', agent_id: 'altro', owner_id: 'altro', actor: 'bot', kind: 'write_file', target: 'x', bytes: 1, error: null, created_at: 2_000 })
    expect(computerActionCountOf(db, 'altro')).toBe(1)
  })

  it('recordComputerAction inserisce, EMETTE l\'evento e non lancia MAI', () => {
    const events: Array<{ ownerId: string }> = []
    setComputerActivityEmitter((e) => {
      if (e.type === 'computer-activity') events.push({ ownerId: e.ownerId })
    })
    recordComputerAction({ agentId: 'figlio', kind: 'copy_in', target: 'home/papà/dato.bin', bytes: 12, db: mem, now: () => 5_000 })
    expect(events).toEqual([{ ownerId: 'papà' }]) // l'evento porta il PROPRIETARIO
    const rows = listComputerActivity('papà', 10, { db: mem }).items
    expect(rows[0]).toMatchObject({ source: 'action', kind: 'copy_in', actor: 'bot', bytes: 12, status: 'ok', agentName: 'Figlio' })
  })
})

describe('fase 19b (T7, puro): l\'unione e l\'ordinamento delle due fonti', () => {
  it('shellItem e actionItem mappano le righe (status, exitCode, bytes, testo troncato a 500)', () => {
    const sh = shellItem(
      { id: 'sh-1', agent_id: 'papà', command: 'x'.repeat(600), secret_names: [], mode: 'docker', pid: null, log_path: '.sandbot/shells/sh-1.log', started_at: 1, status: 'done', exit_code: 3, finished_at: 2, awaited: true, notified: true },
      'Papà'
    )
    expect(sh).toMatchObject({ source: 'shell', kind: 'shell', status: 'done', exitCode: 3, bytes: null, text: 'x'.repeat(500) })
    const ac = actionItem(
      { id: 'act-1', agent_id: 'figlio', owner_id: 'papà', actor: 'user', kind: 'upload', target: 'f', bytes: 7, error: 'nope', created_at: 3 },
      'Figlio'
    )
    expect(ac).toMatchObject({ source: 'action', actor: 'user', kind: 'upload', status: 'error', bytes: 7 })
    expect(truncateText('y'.repeat(501))).toHaveLength(500)
  })

  it('mergeActivity ordina dalla più recente e ferma al limite', () => {
    const shell = (id: string, at: number): ShellJob => ({ id, agent_id: 'papà', command: `cmd ${id}`, secret_names: [], mode: 'docker', pid: null, log_path: 'l', started_at: at, status: 'running', exit_code: null, finished_at: null, awaited: false, notified: false })
    const action = (id: string, at: number): ComputerAction => ({ id, agent_id: 'papà', owner_id: 'papà', actor: 'bot', kind: 'write_file', target: 't', bytes: 1, error: null, created_at: at })
    const merged = mergeActivity(
      [shell('sh-a', 100), shell('sh-b', 300)],
      [action('act-1', 200), action('act-2', 50)],
      () => 'Papà',
      10
    )
    expect(merged.map((i) => [i.id, i.startedAt])).toEqual([['sh-b', 300], ['act-1', 200], ['sh-a', 100], ['act-2', 50]])
    expect(mergeActivity([shell('sh-a', 100)], [], () => '', 1)).toHaveLength(1)
  })

  it('listComputerActivity: la famiglia del pannello (i comandi dei FIGLI col nome), ordine e limite', () => {
    createShellJob(mem, { id: 'sh-padre', agent_id: 'papà', command: 'echo padre', secret_names: [], mode: 'docker', pid: null, log_path: '.sandbot/shells/sh-padre.log', started_at: 100 })
    createShellJob(mem, { id: 'sh-figlio', agent_id: 'figlio', command: 'echo figlio', secret_names: [], mode: 'docker', pid: null, log_path: '.sandbot/shells/sh-figlio.log', started_at: 200 })
    // un comando dell'ALTRO proprietario NON compare
    createShellJob(mem, { id: 'sh-altro', agent_id: 'altro', command: 'echo altro', secret_names: [], mode: 'docker', pid: null, log_path: '.sandbot/shells/sh-altro.log', started_at: 300 })
    const { owner, items } = listComputerActivity('papà', 100, { db: mem })
    expect(owner).toBe('papà')
    const ids = items.map((i) => i.id)
    expect(ids).toContain('sh-padre')
    expect(ids).toContain('sh-figlio')
    expect(ids).not.toContain('sh-altro')
    // il nome del figlio accompagna il suo comando
    const ofChild = items.find((i) => i.id === 'sh-figlio')!
    expect(ofChild.agentName).toBe('Figlio')
    expect(ofChild.text).toBe('echo figlio')
  })
})

describe('fase 19b (T6): activity:output', () => {
  it('una shell di un ALTRO proprietario → errore (il log non si legge)', async () => {
    await expect(computerActivityOutput('papà', 'sh-altro')).rejects.toThrow(/another bot/i)
  })

  it('un id che non esiste → errore; un\'azione PROPRIA torna il suo errore', async () => {
    await expect(computerActivityOutput('papà', 'sh-inesistente')).rejects.toThrow(/no activity/i)
    createComputerAction(mem, { id: 'act-err', agent_id: 'papà', owner_id: 'papà', actor: 'bot', kind: 'write_file', target: 'x', bytes: null, error: 'permission denied', created_at: 900 })
    await expect(computerActivityOutput('papà', 'act-err')).resolves.toBe('permission denied')
    // un'azione dell'ALTRO proprietario non si legge
    createComputerAction(mem, { id: 'act-altro2', agent_id: 'altro', owner_id: 'altro', actor: 'bot', kind: 'write_file', target: 'y', bytes: null, error: 'x', created_at: 901 })
    await expect(computerActivityOutput('papà', 'act-altro2')).rejects.toThrow(/another bot/i)
  })
})

describe('fase 19b (T4.1): il comando in shell_jobs NON porta MAI i valori dei segreti', () => {
  it('i riferimenti {{secret:NOME}} restano, i valori non ci sono; secret_names registra i NOMI', () => {
    // come run-command oggi: il comando salvato è quello REDATTO (i valori
    // sostituiti da {{secret:NOME}} dal gate dei segreti PRIMA della riga)
    const command = 'curl -H "Authorization: Bearer {{secret:API_TOKEN}}" https://api.example.com'
    createShellJob(mem, { id: 'sh-secret', agent_id: 'papà', command, secret_names: ['API_TOKEN'], mode: 'docker', pid: null, log_path: '.sandbot/shells/sh-secret.log', started_at: 400 })
    const row = mem.prepare('SELECT command, secret_names FROM shell_jobs WHERE id = ?').get('sh-secret') as { command: string; secret_names: string }
    expect(row.command).toBe(command)
    expect(row.command).toContain('{{secret:API_TOKEN}}')
    expect(row.command).not.toContain('valore-del-token')
    expect(JSON.parse(row.secret_names)).toEqual(['API_TOKEN'])
    // e il feed mostra QUEL comando (il riferimento, mai il valore)
    const inFeed = listComputerActivity('papà', 100, { db: mem }).items.find((i) => i.id === 'sh-secret')
    expect(inFeed?.text).toContain('{{secret:API_TOKEN}}')
  })
})
