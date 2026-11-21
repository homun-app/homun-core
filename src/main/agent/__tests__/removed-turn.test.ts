// X1 (fase sicurezza-beta16) a livello di LOOP, sullo stack vero (come
// squad-loop.test.ts): store in mkdtemp sotto TEST_TMP_BASE, provider finto in
// SSE su 127.0.0.1. Quello che si prova:
//   - send_to_agent verso un bot ARCHIVIATO o ELIMINATO → rifiutato, NESSUN
//     job per lui (il destinatario non è più nella lista);
//   - send_to_agent verso un FIGLIO di padre archiviato → nessun job;
//   - runTurn non PARTE per un bot rimosso (né per un figlio il cui padre lo
//     è): nessuna entry, nessuna chiamata al modello;
//   - dopo il RIPRISTINO la delega torna a passare.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn } from '../loop'
import { listJobs } from '../../store/jobs'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'
let dir: string
let server: Server
let port = 0
const emit = (): void => undefined

/** Le risposte in coda del provider finto: una per chiamata (tool call o testo). */
let queue: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = []
const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-removed-turn-'))
  store.setDataDir(dir)
  store.db()
  let n = 0
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm-x', display_name: 'X' }] }))
      return
    }
    const next = queue.shift() ?? { text: 'fine' }
    n++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = next.tool
      ? [
          { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${n}`, function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }, finish_reason: null }] },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
        ]
      : [
          { id: 'x', choices: [{ index: 0, delta: { content: next.text ?? 'fine' }, finish_reason: null }] },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ]
    res.end(sse(chunks))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  const p: ProviderConfig = { id: 'px', name: 'X (finto)', kind: 'mistral', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test-x', enabled: true }
  store.saveProviders([p])
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  return new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  for (const t of ['entries', 'agents', 'jobs', 'subagents']) {
    store.db().exec(`DELETE FROM ${t}`)
  }
  queue = []
})

const makeAgent = (name: string): string => {
  const a = store.createAgent(name, '')
  store.updateAgent(a.id, { providerId: 'px', model: 'm-x' })
  return a.id
}

/** attiva i gruppi di tool nel transcript del bot (come farebbe find_tools) */
const activateGroups = (agentId: string, groups: string[]): void => {
  store.appendEntry({ agentId, kind: 'tool-result', role: 'system', content: 'groups active', meta: { callId: 'seed-groups', activatedGroups: groups } })
}

/** gira un turno fino in fondo (niente card attese qui: solo tool permessi). */
const runTurnDone = async (agentId: string): Promise<void> => {
  await runTurn(agentId, 'lavoro', emit)
}

describe('X1: send_to_agent non vede i bot rimossi', () => {
  it('verso un bot ARCHIVIATO: nessun job per lui, il turno del mittente finisce', async () => {
    const mittente = makeAgent('Mittente')
    const archiviato = makeAgent('Archiviato')
    store.setAgentArchived(archiviato, Date.now())
    activateGroups(mittente, ['bots'])
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: archiviato, text: 'ehi' } } },
      { text: 'inviato' }
    ]
    await runTurnDone(mittente)
    expect(listJobs(store.db()).some((j) => j.kind === 'user-message' && j.agent_id === archiviato)).toBe(false)
  })

  it('verso un bot ELIMINATO: nessun job', async () => {
    const mittente = makeAgent('Mittente due')
    const eliminato = makeAgent('Eliminato')
    store.setAgentDeleted(eliminato, Date.now())
    activateGroups(mittente, ['bots'])
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: eliminato, text: 'ehi' } } },
      { text: 'inviato' }
    ]
    await runTurnDone(mittente)
    expect(listJobs(store.db()).some((j) => j.kind === 'user-message' && j.agent_id === eliminato)).toBe(false)
  })

  it('verso un FIGLIO di padre archiviato: nessun job (il figlio segue il padre)', async () => {
    const mittente = makeAgent('Mittente tre')
    const padre = makeAgent('Padre dormiente')
    const child = store.createAgent('Figlio', '', { parentId: padre, id: 'sub_rm1' }).id
    store.setAgentArchived(padre, Date.now())
    activateGroups(mittente, ['bots'])
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: child, text: 'ehi' } } },
      { text: 'inviato' }
    ]
    await runTurnDone(mittente)
    expect(listJobs(store.db()).some((j) => j.agent_id === child)).toBe(false)
  })

  it('dopo il RIPRISTINO la delega torna a passare (il job nasce)', async () => {
    const mittente = makeAgent('Mittente quattro')
    const dest = makeAgent('Ripristinato')
    store.setAgentArchived(dest, Date.now())
    store.setAgentArchived(dest, null)
    activateGroups(mittente, ['bots'])
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: dest, text: 'bentornato' } } },
      { text: 'inviato' }
    ]
    await runTurnDone(mittente)
    expect(listJobs(store.db()).some((j) => j.kind === 'user-message' && j.agent_id === dest)).toBe(true)
  })
})

describe('X1: runTurn non parte per i rimossi', () => {
  it('bot archiviato: nessuna entry, nessuna chiamata al modello', async () => {
    const a = makeAgent('Dormiente')
    store.setAgentArchived(a, Date.now())
    queue = [{ text: 'non dovresti leggermi' }]
    await runTurn(a, 'svegliati', emit).catch(() => undefined)
    expect(store.getEntries(a)).toHaveLength(0)
    expect(queue).toHaveLength(1) // il provider finto non è stato chiamato
  })

  it('figlio di un padre eliminato: il turno del figlio non parte', async () => {
    const padre = makeAgent('Padre eliminato')
    const child = store.createAgent('Figlio due', '', { parentId: padre, id: 'sub_rm2' }).id
    store.setAgentDeleted(padre, Date.now())
    queue = [{ text: 'non dovresti leggermi' }]
    await runTurn(child, 'brief', emit).catch(() => undefined)
    expect(store.getEntries(child)).toHaveLength(0)
    expect(queue).toHaveLength(1)
  })
})
