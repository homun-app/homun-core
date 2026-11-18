// Q1 (fase squadra) a livello di LOOP, sullo stack vero: store in una
// cartella mkdtemp sotto TEST_TMP_BASE, provider finto in SSE su 127.0.0.1,
// sandbox HOST (i file della squadra finiscono comunque nella cartella box:
// writeFileInBox in host è una scrittura atomica su fs). Quello che si prova:
//   - un turno con squadId e autonomia box: write-file NEL BOX senza card;
//   - l'insieme FISSO (delete_agent) chiede anche nella squadra, e negato
//     non elimina niente;
//   - send_to_agent CONTAMINATO tra membri della stessa squadra passa e il
//     job del destinatario nasce contaminato con la squadId;
//   - un sottoagente lanciato in un turno di squadra eredita la squadId;
//   - il runner dei job riporta squadId/contaminated nelle opzioni del turno.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn, resolveApproval, isRunning } from '../loop'
import { makeJobRunner } from '../../../daemon/run-job'
import { listJobs } from '../../store/jobs'
import { createGroup, updateGroup as updateGroupRow } from '../../store/groups'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'
let dir: string
let server: Server
let port = 0
const emit = (): void => undefined

/** Le risposte in coda del provider finto: una per chiamata (tool call o testo). */
let queue: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = []
const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

/** i turni passati al runner iniettato (per le opzioni di squadId/contaminated) */
const seenOpts: Array<Record<string, unknown>> = []

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-squad-loop-'))
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
  for (const t of ['entries', 'agents', 'grants', 'jobs', 'groups', 'group_members', 'group_messages', 'group_turns', 'group_cursors', 'subagents']) {
    store.db().exec(`DELETE FROM ${t}`)
  }
  queue = []
  seenOpts.length = 0
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

const makeGroup = (a: string, b: string, autonomy: 'ask' | 'box' | 'box_review'): number => {
  const g = createGroup('Weekend', '', a, [b], a)
  if (autonomy !== 'box') updateGroupRow(g.id, { autonomy })
  return g.id
}

/** gira un turno fino in fondo, NEGANDO via via le card che compaiono. */
const runTurnDeciding = async (agentId: string, opts: Record<string, unknown>): Promise<void> => {
  let running = false
  const p = runTurn(agentId, 'lavoro', emit, undefined, opts as never)
  p.finally(() => { running = false }).catch(() => undefined)
  running = true
  // il decisore: ogni 40 ms nega le card pendenti (timeout di difetto: 30 s)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40))
    const appr = store.getEntries(agentId).find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
    if (appr) resolveApproval(agentId, String(appr.meta?.approvalId), 'deny', 'once')
    if (!running && !isRunning(agentId)) break
  }
  await p
}

describe('Q1: turno di squadra, autonomia box', () => {
  it('write-file DENTRO il box passa SENZA card e scrive il file', async () => {
    const a = makeAgent('Treni')
    const gid = makeGroup(a, makeAgent('Alloggio'), 'box')
    queue = [
      { tool: { name: 'write-file', args: { path: '/workspace/torino/01_treni.md', content: 'treni!' } } },
      { text: 'fatto' }
    ]
    await runTurnDeciding(a, { squadId: gid })
    expect(store.getEntries(a).some((e) => e.kind === 'approval')).toBe(false)
    const boxFile = join(dir, 'box', 'workspace', 'torino', '01_treni.md')
    expect(existsSync(boxFile)).toBe(true)
    expect(readFileSync(boxFile, 'utf8')).toBe('treni!')
  })

  it('write-file FUORI dal box chiede la card (negata: niente scritture sul Mac)', async () => {
    const a = makeAgent('Turismo')
    const gid = makeGroup(a, makeAgent('Treni'), 'box')
    queue = [
      { tool: { name: 'write-file', args: { path: '../../../colpo.md', content: 'x' } } },
      { text: 'ok' }
    ]
    await runTurnDeciding(a, { squadId: gid })
    const appr = store.getEntries(a).find((e) => e.kind === 'approval')
    expect(appr).toBeTruthy()
    expect(appr!.meta?.status).toBe('denied')
    expect(existsSync(join(dir, '..', 'colpo.md'))).toBe(false)
  })

  it('delete_agent (insieme FISSO) chiede anche nella squadra e negato NON elimina', async () => {
    const a = makeAgent('Capo')
    const vittima = makeAgent('Da non perdere')
    activateGroups(a, ['bots'])
    const gid = makeGroup(a, vittima, 'box')
    queue = [
      { tool: { name: 'delete_agent', args: { agentId: vittima } } },
      { text: 'ok' }
    ]
    await runTurnDeciding(a, { squadId: gid })
    const appr = store.getEntries(a).find((e) => e.kind === 'approval')
    expect(appr).toBeTruthy()
    expect(appr!.meta?.status).toBe('denied')
    expect(store.getAgent(vittima)).toBeTruthy()
  })

  it('senza squadId il write-file chiede come oggi (GUARDIA: i turni normali non cambiano)', async () => {
    const a = makeAgent('Solo')
    queue = [
      { tool: { name: 'write-file', args: { path: '/workspace/x.md', content: 'x' } } },
      { text: 'ok' }
    ]
    await runTurnDeciding(a, {})
    const appr = store.getEntries(a).find((e) => e.kind === 'approval')
    expect(appr).toBeTruthy()
    expect(appr!.meta?.status).toBe('denied')
  })
})

describe('Q1: send_to_agent contaminato tra membri della stessa squadra', () => {
  it('passa SENZA card e il job del destinatario nasce contaminato con la squadId', async () => {
    const treni = makeAgent('Treni')
    const alloggio = makeAgent('Alloggio')
    activateGroups(treni, ['bots'])
    const gid = makeGroup(treni, alloggio, 'box')
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: alloggio, text: 'check-in?' } } },
      { text: 'inviato' }
    ]
    await runTurnDeciding(treni, { squadId: gid, contaminated: true })
    // nessuna card di delega non fidata
    expect(store.getEntries(treni).some((e) => e.kind === 'approval')).toBe(false)
    // il job user-message per il destinatario
    const job = listJobs(store.db()).find((j) => j.kind === 'user-message' && j.agent_id === alloggio)
    expect(job).toBeTruthy()
    const payload = job!.payload as Record<string, unknown>
    expect(payload.squadId).toBe(gid)
    expect(payload.contaminated).toBe(true)
    expect(payload.fromAgentId).toBe(treni)
  })

  it('con autonomia ask la delega contaminata chiede la card come oggi', async () => {
    const treni = makeAgent('Treni ask')
    const alloggio = makeAgent('Alloggio ask')
    activateGroups(treni, ['bots'])
    const gid = makeGroup(treni, alloggio, 'ask')
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: alloggio, text: 'check-in?' } } },
      { text: 'inviato' }
    ]
    await runTurnDeciding(treni, { squadId: gid, contaminated: true })
    const appr = store.getEntries(treni).find((e) => e.kind === 'approval')
    expect(appr).toBeTruthy()
    expect(appr!.meta?.status).toBe('denied')
    expect(listJobs(store.db()).some((j) => j.kind === 'user-message' && j.agent_id === alloggio)).toBe(false)
  })

  it('verso un bot FUORI dalla squadra la delega contaminata chiede come oggi', async () => {
    const treni = makeAgent('Treni fuori')
    const estraneo = makeAgent('Estraneo')
    activateGroups(treni, ['bots'])
    const gid = makeGroup(treni, makeAgent('Alloggio fuori'), 'box')
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: estraneo, text: 'ehi' } } },
      { text: 'inviato' }
    ]
    await runTurnDeciding(treni, { squadId: gid, contaminated: true })
    const appr = store.getEntries(treni).find((e) => e.kind === 'approval')
    expect(appr).toBeTruthy()
    expect(appr!.meta?.status).toBe('denied')
  })
})

describe('Q1: il sottoagente di un turno di squadra', () => {
  it('il job subagent-run porta la squadId del turno che lo ha lanciato', async () => {
    const alloggio = makeAgent('Alloggio')
    const gid = makeGroup(alloggio, makeAgent('Treni sub'), 'box')
    const brief = 'Controlla gli orari di apertura dei musei di Torino per il weekend del 19-20 dicembre 2026, riporta i prezzi dei biglietti interi e ridotti, le chiusure straordinarie note e l\'ultima ora utile di ingresso, e indica quali richiedono la prenotazione obbligatoria online. Non prenotare e non comprare niente: solo lettura.'
    queue = [
      { tool: { name: 'spawn_subagent', args: { title: 'Musei', brief } } },
      { text: 'lanciato' }
    ]
    await runTurnDeciding(alloggio, { squadId: gid })
    const job = listJobs(store.db()).find((j) => j.kind === 'subagent-run')
    expect(job).toBeTruthy()
    expect((job!.payload as Record<string, unknown>).squadId).toBe(gid)
  })
})

describe('Q1: il runner dei job riporta la squadra alle opzioni del turno', () => {
  it('user-message con squadId e contaminated → opts.squadId e opts.contaminated', async () => {
    const { enqueueJob } = await import('../../store/jobs')
    const b = makeAgent('Ricevente')
    const gid = 1
    enqueueJob(store.db(), {
      agentId: b, kind: 'user-message',
      payload: { text: 'ciao', initiator: 'AGENT', fromAgentId: 'x', fromAgentName: 'X', toAgentId: b, hop: 1, squadId: gid, contaminated: true },
      runAt: Date.now(), now: Date.now()
    })
    const runner = makeJobRunner(store.db(), (async (_id: string, _text: string, _emit: unknown, _imgs: unknown, opts: Record<string, unknown>) => {
      seenOpts.push(opts)
    }) as never)
    const job = listJobs(store.db()).find((j) => j.kind === 'user-message')!
    await runner(job, emit)
    expect(seenOpts[0]!.squadId).toBe(gid)
    expect(seenOpts[0]!.contaminated).toBe(true)
  })

  it('subagent-run con squadId → opts.squadId', async () => {
    const { insertSubagent } = await import('../../store/subagents')
    const padre = makeAgent('Padre runner')
    insertSubagent(store.db(), { id: 'sub_probe', parentId: padre, parentTaskId: null, batchId: 'b1', title: 'T', brief: 'B', deadlineAt: Date.now() + 60_000, createdAt: Date.now() })
    const { enqueueJob } = await import('../../store/jobs')
    enqueueJob(store.db(), {
      agentId: 'sub_probe', kind: 'subagent-run',
      payload: { subagentId: 'sub_probe', first: true, squadId: 3 },
      runAt: Date.now(), now: Date.now()
    })
    const runner = makeJobRunner(store.db(), (async (_id: string, _text: string, _emit: unknown, _imgs: unknown, opts: Record<string, unknown>) => {
      seenOpts.push(opts)
    }) as never)
    const job = listJobs(store.db()).find((j) => j.kind === 'subagent-run')!
    await runner(job, emit)
    expect(seenOpts[0]!.squadId).toBe(3)
  })
})
