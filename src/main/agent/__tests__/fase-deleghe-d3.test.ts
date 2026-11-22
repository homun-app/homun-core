// D3 (fase deleghe): NESSUNA ECO — i messaggi tra bot hanno un TIPO:
// 'request' (una delega, una domanda — ogni send_to_agent esplicito) e
// 'result' (la risposta collegata a una delega). Il testo finale di un turno
// nato da un RESULT non torna al mittente (va all'utente o resta nel
// transcript), e OGNI messaggio tra bot incrementa l'hop, le risposte
// automatiche comprese (verificato dal vivo il 22/11: la catena
// 2273→2279→2285→2290 si è fermata al terzo salto).
// Harness come fase-deleghe-d1: store reale su TEST_TMP_BASE, modello FINTO
// su 127.0.0.1, job runner vero.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn } from '../loop'
import { makeJobRunner } from '../../../daemon/run-job'
import { listJobs } from '../../store/jobs'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'
let dir: string
let server: Server
const emit = (): void => undefined

vi.mock('../browser', async (importOriginal) => {
  const real = await importOriginal<typeof import('../browser')>()
  return { ...real, browserAvailable: () => false }
})

let queue: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = []
const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-deleghe-d3-'))
  store.setDataDir(dir)
  store.db()
  let n = 0
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm-x', display_name: 'X' }] }))
      return
    }
    let body = ''
    req.on('data', (c: string) => { body += c })
    req.on('end', () => {
      const next = queue.shift() ?? { text: 'ok' }
      n++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = next.tool
        ? [
            { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${n}`, function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }, finish_reason: null }] },
            { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
          ]
        : [
            { id: 'x', choices: [{ index: 0, delta: { content: next.text ?? 'ok' }, finish_reason: null }] },
            { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
          ]
      res.end(sse(chunks))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const p: ProviderConfig = { id: 'px', name: 'X (finto)', kind: 'mistral', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test-x', enabled: true }
  store.saveProviders([p])
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  return new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  for (const t of ['entries', 'agents', 'grants', 'jobs', 'groups', 'group_members', 'group_messages', 'group_turns', 'group_cursors', 'subagents']) {
    store.db().exec(`DELETE FROM ${t}`)
  }
  queue = []
})

const makeAgent = (name: string): string => {
  const a = store.createAgent(name, '')
  store.updateAgent(a.id, { providerId: 'px', model: 'm-x' })
  return a.id
}
const activateBots = (agentId: string): void => {
  store.appendEntry({ agentId, kind: 'tool-result', role: 'system', content: 'groups active', meta: { callId: 'seed-groups', activatedGroups: ['bots'] } })
}
const agentJobs = (agentId: string) =>
  listJobs(store.db()).filter((j) => j.kind === 'user-message' && j.agent_id === agentId && j.status === 'queued')
const runJobOf = async (job: { id: number; agent_id: string }): Promise<void> => {
  const runner = makeJobRunner(store.db(), runTurn)
  const row = listJobs(store.db()).find((j) => j.id === job.id) ?? job
  await runner(row as never, emit)
  // come fa il worker: il job girato è DONE (altrimenti resterebbe «in coda»
  // e i conteggi della sonda conterebbero i fantasmi)
  const { completeJob } = await import('../../store/jobs')
  completeJob(store.db(), job.id)
}

describe('D3: richiesta → risultato, e il risultato NON genera eco', () => {
  it('il caso vero: principale → Chef request → result → il testo del principale va all\'UTENTE e NESSUN job per Chef', async () => {
    const capo = makeAgent('Capo D3a')
    const chef = makeAgent('Chef Ricette D3a')
    activateBots(capo)
    // l'utente chiede; il principale delega (request)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: chef, text: 'ricetta della pastiera' } } },
      { text: 'chiesto a Chef' }
    ]
    await runTurn(capo, 'chef, la pastiera?', emit)
    const toChef = agentJobs(chef)
    expect(toChef).toHaveLength(1)
    const req = toChef[0]!.payload as Record<string, unknown>
    expect(req.messageType).toBe('request')
    expect(String(req.text)).toContain('tipo="richiesta"')
    // il turno di Chef risponde col testo finale → result, hop +1, tipo risultato
    queue = [{ text: 'La pastiera ti è già arrivata: cottura 90 minuti a 160°.' }]
    await runJobOf(toChef[0]!)
    const back = agentJobs(capo)
    expect(back).toHaveLength(1)
    const res = back[0]!.payload as Record<string, unknown>
    expect(res.messageType).toBe('result')
    expect(String(res.text)).toContain('tipo="risultato"')
    expect(res.hop).toBe(2) // (req.hop 1) + 1: le risposte automatiche incrementano l'hop
    // il principale riporta all'utente: il testo finale NON torna a Chef
    queue = [{ text: 'La pastiera è pronta: 90 minuti a 160 gradi.' }]
    await runJobOf(back[0]!)
    expect(agentJobs(chef)).toHaveLength(0) // NESSUNA eco
    const toUser = store.getEntries(capo).findLast((e) => e.kind === 'send-message' && !e.meta?.agentSend)
    expect(toUser?.content).toContain('La pastiera è pronta')
  })

  it('un send_to_agent ESPLICITO dopo un result è una richiesta NUOVA e viene consegnato', async () => {
    const capo = makeAgent('Capo D3b')
    const chef = makeAgent('Chef Ricette D3b')
    activateBots(capo)
    // il principale è stato svegliato da un result (hop 2) e chiede ancora
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: chef, text: 'e il grano deve stare in ammollo?' } } },
      { text: 'chiesto il dettaglio' }
    ]
    await runTurn(capo, 'risposta del chef', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: chef, fromAgentName: 'Chef Ricette D3b', hop: 2, threadId: 't-d3b', messageType: 'result' }
    })
    const toChef = agentJobs(chef)
    expect(toChef).toHaveLength(1)
    const req = toChef[0]!.payload as Record<string, unknown>
    expect(req.messageType).toBe('request')
    expect(String(req.text)).toContain('tipo="richiesta"')
    expect(req.hop).toBe(3)
  })

  it('la sequenza vera 2101–2155 rigiocata: 0 messaggi a Chef dopo il suo result, i testi del principale solo all\'utente', async () => {
    const capo = makeAgent('Capo D3c')
    const chef = makeAgent('Chef Ricette D3c')
    activateBots(capo)
    // 2101: l'utente chiede la ricerca; il principale DELEGA (request)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: chef, text: 'delega-pastiera' } } },
      { text: 'chiesto' }
    ]
    await runTurn(capo, 'la pastiera per favore', emit)
    const first = agentJobs(chef)
    expect(first).toHaveLength(1)
    // il risultato di Chef (2100-like)
    queue = [{ text: 'Ricevuto, la pastiera ti è già arrivata.' }]
    await runJobOf(first[0]!)
    // 2106: il principale, svegliato dal result, ringrazia l'UTENTE — oggi il
    // testo tornava anche a Chef: dopo D3 NON torna
    queue = [{ text: 'Tutto ricevuto, la pastiera arriva alle 18.' }]
    const wake = agentJobs(capo)
    expect(wake).toHaveLength(1)
    await runJobOf(wake[0]!)
    expect(agentJobs(chef)).toHaveLength(0) // l'eco è chiusa
    // il testo del principale è in chat per l'utente
    const toUser = store.getEntries(capo).filter((e) => e.kind === 'send-message' && !e.meta?.agentSend)
    expect(toUser.some((e) => e.content.includes('Tutto ricevuto'))).toBe(true)
    // i contenuti della RICERCA (che non riguardano Chef) non sono mai
    // arrivati al cuoco: nessuna entry AGENT per Chef oltre la delega
    const chefIncoming = store.getEntries(chef).filter((e) => e.kind === 'message' && e.meta?.initiator === 'AGENT')
    expect(chefIncoming).toHaveLength(1) // solo la richiesta vera
  })

  it('ogni messaggio incrementa l\'hop, i result compresi: la catena di 4 si ferma al limite (hop 3)', async () => {
    const capo = makeAgent('Capo D3d')
    const chef = makeAgent('Chef Ricette D3d')
    activateBots(capo)
    // request hop 1
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: chef, text: 'prima' } } },
      { text: 'chiesto' }
    ]
    await runTurn(capo, 'vai', emit)
    const r1 = agentJobs(chef)[0]!.payload as Record<string, unknown>
    expect(r1.hop).toBe(1)
    // result hop 2
    queue = [{ text: 'pronta' }]
    await runJobOf(agentJobs(chef)[0]!)
    const r2 = agentJobs(capo)[0]!.payload as Record<string, unknown>
    expect(r2.hop).toBe(2)
    // il principale, svegliato dal result, chiede ANCORA (request hop 3)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: chef, text: 'terza (esplicita)' } } },
      { text: 'chiesto ancora' }
    ]
    await runJobOf(agentJobs(capo)[0]!)
    const r3 = agentJobs(chef)[0]!.payload as Record<string, unknown>
    expect(r3.hop).toBe(3)
    // Chef risponde col testo finale: la risposta sarebbe hop 4 — OLTRE il
    // limite: non parte, il testo resta nel transcript di Chef
    queue = [{ text: 'quarta risposta che non deve partire' }]
    const chefJobs = agentJobs(chef)
    expect(chefJobs).toHaveLength(1)
    await runJobOf(chefJobs[0]!)
    // NESSUN quarto messaggio: né verso capo né altrove
    expect(agentJobs(capo)).toHaveLength(0)
    expect(listJobs(store.db()).filter((j) => j.kind === 'user-message' && j.status === 'queued')).toHaveLength(0)
  })
})
