// D2 (fase deleghe): quando send_to_agent è fermato da un limite
// TEMPORANEOO (il limite orario della coppia di D1 o la coda piena del
// destinatario) il messaggio SI ACCODA davvero: un job user-message con
// runAt = il momento in cui il limite si libera (per la coppia: il più
// vecchio messaggio della finestra + 1 ora; per la coda piena: un tentativo
// ogni 2 minuti, al massimo 30, poi il messaggio torna al mittente come
// «non consegnato»). Al bot torna un risultato VERO («Queued: it will be
// delivered to <nome> at HH:MM (limit reached)...»), e la regola nel prompt
// gli vieta di dire «in coda» quando non lo è. I rifiuti definitivi (hop,
// destinatario rimosso, testo vuoto) restano rifiuti.
// Harness come fase-deleghe-d1: store reale su TEST_TMP_BASE, modello FINTO
// su 127.0.0.1, orologio esplicito per claimDueJobs.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn } from '../loop'
import { makeJobRunner } from '../../../daemon/run-job'
import { listJobs, claimDueJobs, getJobById, MAX_USER_MESSAGE_QUEUE } from '../../store/jobs'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'
let dir: string
let server: Server
let port = 0
const emit = (): void => undefined

vi.mock('../browser', async (importOriginal) => {
  const real = await importOriginal<typeof import('../browser')>()
  return { ...real, browserAvailable: () => false }
})

let queue: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = []
const bodies: string[] = []
const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-deleghe-d2-'))
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
      bodies.push(body)
      const next = queue.shift() ?? { text: 'ok ricevuto' }
      n++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = next.tool
        ? [
            { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${n}`, function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }, finish_reason: null }] },
            { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
          ]
        : [
            { id: 'x', choices: [{ index: 0, delta: { content: next.text ?? 'ok ricevuto' }, finish_reason: null }] },
            { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
          ]
      res.end(sse(chunks))
    })
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
  bodies.length = 0
})

const makeAgent = (name: string): string => {
  const a = store.createAgent(name, '')
  store.updateAgent(a.id, { providerId: 'px', model: 'm-x' })
  return a.id
}
const activateBots = (agentId: string): void => {
  store.appendEntry({ agentId, kind: 'tool-result', role: 'system', content: 'groups active', meta: { callId: 'seed-groups', activatedGroups: ['bots'] } })
}
/** n messaggi di catena nella coppia; il più vecchio è oldestAgo ms fa, gli altri a 1 s di distanza */
const seedChain = (from: string, to: string, n: number, oldestAgo: number): number => {
  const now = Date.now()
  for (let i = 0; i < n; i++) {
    const e = store.appendEntry({
      agentId: to, kind: 'message', role: 'user', content: 'msg',
      meta: { initiator: 'AGENT', fromAgentId: from, fromAgentName: from, toAgentId: to, hop: 2 }
    } as never)
    // appendEntry scrive created_at = adesso: il tempo della finestra lo si
    // imposta dopo, direttamente sulla riga
    store.db().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(now - oldestAgo + i * 1_000, e.id)
  }
  return now - oldestAgo
}
const agentJobs = (agentId: string) =>
  listJobs(store.db()).filter((j) => j.kind === 'user-message' && j.agent_id === agentId)

describe('D2: il limite della coppia pieno → il messaggio si accoda DAVVERO e parte all\'ora giusta', () => {
  it('il caso vero: rifiutato oggi, il job nasce con runAt = più vecchio + 1 ora, risultato «Queued … at HH:MM», e parte allora (orologio finto)', async () => {
    const capo = makeAgent('Capo D2a')
    const novita = makeAgent('Novità AI D2a')
    activateBots(capo)
    // 10 messaggi di catena, il più vecchio 50 minuti fa → libera tra 10 minuti
    const oldest = seedChain(capo, novita, 10, 50 * 60_000)
    const t0 = Date.now()
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'migliori sistemi di memoria' } } },
      { text: 'in coda' }
    ]
    await runTurn(capo, 'risposta', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: novita, fromAgentName: 'Novità AI D2a', hop: 1 }
    })
    // il job c'è, con il runAt giusto (più vecchio + 1 ora, non «mai»)
    const job = agentJobs(novita).find((j) => j.status === 'queued' && j.run_at > t0)
    expect(job).toBeTruthy()
    expect(job!.run_at).toBeGreaterThanOrEqual(oldest + 3_600_000)
    expect(job!.run_at).toBeLessThan(t0 + 11 * 60_000)
    // il risultato al bot dice la VERITÀ: in coda, a che ora, e di non promettere lui
    expect(bodies.some((b) => b.includes('Queued: it will be delivered to Novità AI D2a at ') && b.includes('(limit reached)') && b.includes('do not promise to retry yourself'))).toBe(true)
    // la riga di stato della chat ha job e ora (meta.delegationQueued)
    const send = store.getEntries(capo).findLast((e) => e.kind === 'send-message' && e.meta?.agentSend)
    expect(send?.meta?.delegationQueued).toMatchObject({ jobId: job!.id, runAt: job!.run_at })
    // orologio finto: PRIMA del runAt non parte, ALLORA sì
    expect(claimDueJobs(store.db(), job!.run_at - 1_000, 120_000)).toHaveLength(0)
    const claimed = claimDueJobs(store.db(), job!.run_at + 1_000, 120_000)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.id).toBe(job!.id)
    // e consegna davvero: il turno del destinatario apre col messaggio
    queue = [{ text: 'fatto: i sistemi migliori sono…' }]
    await makeJobRunner(store.db(), runTurn)(claimed[0]!, emit)
    const opened = store.getEntries(novita).find((e) => e.kind === 'message' && e.meta?.initiator === 'AGENT')
    expect(opened?.meta?.fromAgentId).toBe(capo)
  })

  it('hop massimo: rifiuto definitivo, NESSUN job (nemmeno in ritardo)', async () => {
    const capo = makeAgent('Capo D2b')
    const novita = makeAgent('Novità AI D2b')
    activateBots(capo)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'ancora' } } },
      { text: 'ok' }
    ]
    await runTurn(capo, 'messaggio a hop 3', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: novita, fromAgentName: 'Novità AI D2b', hop: 3 }
    })
    expect(agentJobs(novita)).toHaveLength(0)
    expect(bodies.some((b) => b.includes('maximum hop 3'))).toBe(true)
  })
})

describe('D2: la coda del destinatario piena → retry ogni 2 minuti, al massimo 30', () => {
  it('coda piena → job con runAt +2 minuti e delegationRetry; ancora piena → rimandato di 2 minuti; si libera → consegna', async () => {
    const capo = makeAgent('Capo D2c')
    const novita = makeAgent('Novità AI D2c')
    activateBots(capo)
    const t0 = Date.now()
    // la coda del destinatario è PIENA (10 messaggi utente in attesa, non
    // ancora dovuti: run_at in futuro, così il claim prende solo il retry)
    for (let i = 0; i < MAX_USER_MESSAGE_QUEUE; i++) {
      store.db().prepare('INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?,?,0,?)')
        .run(novita, 'user-message', JSON.stringify({ text: `coda ${i}` }), t0 + 3_600_000, 'queued', t0)
    }
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'quando ti liberi' } } },
      { text: 'ok' }
    ]
    await runTurn(capo, 'delega', emit)
    // il job di retry: user-message, +2 minuti, marcato delegationRetry
    const retry = agentJobs(novita).find((j) => (j.payload as Record<string, unknown>).delegationRetry === true)
    expect(retry).toBeTruthy()
    expect(retry!.run_at).toBeGreaterThanOrEqual(t0 + 110_000)
    expect(retry!.run_at).toBeLessThanOrEqual(t0 + 130_000)
    // anche qui il risultato dice la verità
    expect(bodies.some((b) => b.includes('Queued:') && b.includes('queue'))).toBe(true)
    // all'ora giusta il worker lo prende, la coda è ANCORA piena → rimandato di 2 minuti
    const claimed = claimDueJobs(store.db(), retry!.run_at + 1_000, 120_000)
    expect(claimed).toHaveLength(1)
    const r1 = Date.now()
    await makeJobRunner(store.db(), runTurn)(claimed[0]!, emit)
    const after = getJobById(store.db(), retry!.id)!
    expect(after.status).toBe('queued')
    expect(after.run_at).toBeGreaterThanOrEqual(r1 + 110_000) // +2 minuti dal tentativo, non da prima
    expect(store.getEntries(novita).filter((e) => e.meta?.initiator === 'AGENT')).toHaveLength(0)
    // la coda si libera (un messaggio via) → al prossimo tentativo CONSEGNA
    store.db().prepare('DELETE FROM jobs WHERE kind = ? AND agent_id = ? AND payload_json LIKE ?')
      .run('user-message', novita, '%coda 0%')
    const claimed2 = claimDueJobs(store.db(), after.run_at + 1_000, 120_000)
    expect(claimed2).toHaveLength(1)
    queue = [{ text: 'libero: ecco la risposta' }]
    await makeJobRunner(store.db(), runTurn)(claimed2[0]!, emit)
    const opened = store.getEntries(novita).find((e) => e.kind === 'message' && e.meta?.initiator === 'AGENT')
    expect(opened?.meta?.fromAgentId).toBe(capo)
  })

  it('coda SEMPRE piena → dopo 30 minuti il messaggio torna al mittente come «non consegnato»', async () => {
    const capo = makeAgent('Capo D2d')
    const novita = makeAgent('Novità AI D2d')
    activateBots(capo)
    const t0 = Date.now()
    // il job di retry è nato 31 minuti fa (oltre i 30): created_at nel passato
    store.db().prepare('INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?,?,0,?)')
      .run(novita, 'user-message', JSON.stringify({
        text: '<messaggio_da_agente nome="Capo D2d" id="capo">il mio messaggio</messaggio_da_agente>',
        initiator: 'AGENT', fromAgentId: capo, fromAgentName: 'Capo D2d', toAgentId: novita, hop: 1,
        threadId: 't-scaduto', delegationRetry: true
      }), t0, 'queued', t0 - 31 * 60_000)
    for (let i = 0; i < MAX_USER_MESSAGE_QUEUE; i++) {
      store.db().prepare('INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?,?,0,?)')
        .run(novita, 'user-message', JSON.stringify({ text: `coda ${i}` }), t0 + 3_600_000, 'queued', t0)
    }
    const claimed = claimDueJobs(store.db(), t0 + 1_000, 120_000)
    expect(claimed).toHaveLength(1)
    queue = [{ text: '(il mittente non dovrebbe girare per questo)' }]
    await makeJobRunner(store.db(), runTurn)(claimed[0]!, emit)
    // NESSUNA consegna al destinatario…
    expect(store.getEntries(novita).filter((e) => e.meta?.initiator === 'AGENT')).toHaveLength(0)
    // …e il messaggio torna al MITTENTE come non consegnato
    const back = agentJobs(capo).find((j) => (j.payload as Record<string, unknown>).initiator === 'DELEGATION_UNDELIVERED')
    expect(back).toBeTruthy()
    expect(String((back!.payload as Record<string, unknown>).text)).toContain('NOT delivered')
  })

  it('Annulla: il job in coda si toglie e non parte più', async () => {
    const { cancelJob } = await import('../../store/jobs')
    const capo = makeAgent('Capo D2e')
    const novita = makeAgent('Novità AI D2e')
    activateBots(capo)
    const t0 = Date.now()
    store.db().prepare('INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?,?,0,?)')
      .run(novita, 'user-message', JSON.stringify({
        text: 'in attesa', initiator: 'AGENT', fromAgentId: capo, fromAgentName: 'Capo D2e',
        toAgentId: novita, hop: 1, threadId: 't-x', delegationRetry: true
      }), t0 + 120_000, 'queued', t0)
    const job = listJobs(store.db())[0]!
    cancelJob(store.db(), job.id)
    expect(getJobById(store.db(), job.id)).toBeNull()
    expect(claimDueJobs(store.db(), t0 + 200_000, 120_000)).toHaveLength(0)
  })
})
