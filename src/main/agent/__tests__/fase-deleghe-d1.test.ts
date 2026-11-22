// D1 (fase deleghe): il limite orario «10 messaggi per coppia» serve contro
// le CATENE tra bot, non contro le deleghe chieste dall'utente. Nel turno
// dell'utente NON conta (il caso vero del 22/11: 4 richieste → 11 messaggi
// in 18 minuti e la quarta rifiutata); al suo posto un tetto CHIARO: al
// massimo 5 send_to_agent per turno utente. I messaggi nati in turni non
// dell'utente (routine, eventi, risposte a risposte) restano soggetti al
// limite della coppia, e AGENT_HOP_MAX resta 3.
// Harness come squad-reply.test.ts: store reale su directory temporanea
// (TEST_TMP_BASE), modello FINTO openai-compatible su 127.0.0.1.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn } from '../loop'
import { listJobs } from '../../store/jobs'
import { AGENT_PAIR_HOURLY_MAX, AGENT_USER_TURN_SEND_MAX } from '../../../shared/agent-message'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'
let dir: string
let server: Server
let port = 0
const emit = (): void => undefined

// il browser del bot non serve qui: mock parziale come in squad-reply.test.ts
vi.mock('../browser', async (importOriginal) => {
  const real = await importOriginal<typeof import('../browser')>()
  return { ...real, browserAvailable: () => false }
})

let queue: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = []
// i CORPI delle richieste arrivate al modello finto (per leggere i tool result)
const bodies: string[] = []
const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-deleghe-d1-'))
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
/** attiva il gruppo 'bots' per il bot (la prima chiamata send_to_agent altrimenti attiva il gruppo e non esegue) */
const activateBots = (agentId: string): void => {
  store.appendEntry({ agentId, kind: 'tool-result', role: 'system', content: 'groups active', meta: { callId: 'seed-groups', activatedGroups: ['bots'] } })
}
const userJobsFor = (agentId: string) =>
  listJobs(store.db()).filter((j) => j.kind === 'user-message' && j.agent_id === agentId && j.status === 'queued')
const seedPair = (from: string, to: string, n: number, userRequested = false): void => {
  const now = Date.now()
  for (let i = 0; i < n; i++) {
    store.appendEntry({
      agentId: to, kind: 'message', role: 'user', content: 'msg',
      meta: { initiator: 'AGENT', fromAgentId: from, fromAgentName: from, toAgentId: to, hop: 1, ...(userRequested ? { userRequested: true } : {}) },
      createdAt: now - 60_000
    } as never)
  }
}

describe('D1: le deleghe dell\'utente non consumano il limite della coppia', () => {
  it('il caso vero: 4 deleghe dell\'utente di fila allo stesso bot, con risposte, in 20 minuti → TUTTE consegnate (11 messaggi nella coppia)', async () => {
    const capo = makeAgent('Capo D1a')
    const novita = makeAgent('Novità AI D1a')
    activateBots(capo)
    // la storia di stamattina: 7 richieste (turni dell'utente) + 4 risposte
    // collegate, TUTTE nate da richieste dell'utente — la coppia è «piena»
    // solo se qualcuno le conta
    seedPair(capo, novita, 7, true)
    seedPair(novita, capo, 4, true)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'quarta richiesta: migliori sistemi di memoria' } } },
      { text: 'delegato' }
    ]
    await runTurn(capo, 'migliori sistemi di memoria, chiedi a Novità AI', emit)
    const toNovita = userJobsFor(novita)
    expect(toNovita).toHaveLength(1)
    // il job nasce marcato: la risposta collegata non conterà nemmeno lei
    expect((toNovita[0]!.payload as Record<string, unknown>).userRequested).toBe(true)
  })

  it('11 messaggi tra due bot nati da una ROUTINE: l\'undicesimo non parte adesso — ma la stessa storia nata dall\'utente passa', async () => {
    const capo = makeAgent('Capo D1b')
    const novita = makeAgent('Novità AI D1b')
    activateBots(capo)
    seedPair(capo, novita, AGENT_PAIR_HOURLY_MAX)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'undicesimo' } } },
      { text: 'in coda' }
    ]
    // il turno NON è dell'utente: routine → il limite della coppia scatta.
    // D2 (fase deleghe): il limite è TEMPORANEO — il messaggio non parte
    // adesso ma si ACCODA con runAt futuro, e il tool result lo dice
    const t0 = Date.now()
    await runTurn(capo, '[recurring routine: Ronda] controlla', emit, undefined, { source: 'routine', title: 'Ronda', initiator: 'ROUTINE' })
    const queued = userJobsFor(novita)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.run_at).toBeGreaterThan(t0 + 30 * 60_000) // tra un'ora circa, non adesso
    expect(bodies.some((b) => b.includes('Queued: it will be delivered to'))).toBe(true)
    // la STESSA storia, ma nata da richieste dell'utente: la delega passa SUBITO
    store.db().exec('DELETE FROM entries')
    store.db().exec('DELETE FROM jobs')
    activateBots(capo)
    seedPair(capo, novita, 7, true)
    seedPair(novita, capo, 4, true)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'quinta richiesta' } } },
      { text: 'delegato' }
    ]
    const t1 = Date.now()
    await runTurn(capo, 'chiedi ancora a Novità AI', emit)
    const now2 = userJobsFor(novita)
    expect(now2).toHaveLength(1)
    expect(now2[0]!.run_at).toBeLessThan(t1 + 5_000) // subito, non in coda
  })

  it('una catena a hop 3 è rifiutata come oggi (AGENT_HOP_MAX resta 3)', async () => {
    const capo = makeAgent('Capo D1c')
    const novita = makeAgent('Novità AI D1c')
    activateBots(capo)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'ancora un giro' } } },
      { text: 'ok' }
    ]
    await runTurn(capo, 'messaggio da altro bot', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: novita, fromAgentName: 'Novità AI D1c', hop: 3 }
    })
    expect(userJobsFor(novita)).toHaveLength(0)
    expect(bodies.some((b) => b.includes('maximum hop 3'))).toBe(true)
  })

  it('il sesto send_to_agent nello STESSO turno dell\'utente è rifiutato (tetto 5 per turno, in inglese)', async () => {
    const capo = makeAgent('Capo D1d')
    const novita = makeAgent('Novità AI D1d')
    const altra = makeAgent('Altra D1d')
    activateBots(capo)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'msg 1' } } },
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'msg 2' } } },
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'msg 3' } } },
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'msg 4' } } },
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'msg 5' } } },
      { tool: { name: 'send_to_agent', args: { agentId: altra, text: 'msg 6' } } },
      { text: 'delegato a raffica' }
    ]
    await runTurn(capo, 'delega a raffica', emit)
    // le prime 5 passano (tetto per turno), la sesta no — a chiunque sia
    expect(userJobsFor(novita)).toHaveLength(5)
    expect(userJobsFor(altra)).toHaveLength(0)
    // il rifiuto in inglese con il tetto
    expect(bodies.some((b) => b.includes(`limit ${AGENT_USER_TURN_SEND_MAX}`))).toBe(true)
  })

  it('la delega di un turno UTENTE non conta nemmeno da ACCODATA (pendingAgentPairJobs la salta)', async () => {
    const capo = makeAgent('Capo D1e')
    const novita = makeAgent('Novità AI D1e')
    activateBots(capo)
    // 8 messaggi di CATENA nella coppia + il messaggio che apre QUESTO turno
    // (novita→capo) = 9: la decima posizione oggi se la prende anche il job
    // utente in coda — con D1 no
    seedPair(capo, novita, AGENT_PAIR_HOURLY_MAX - 2)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'prima (dell\'utente)' } } },
      { text: 'una' }
    ]
    await runTurn(capo, 'prima delega', emit)
    expect(userJobsFor(novita)).toHaveLength(1)
    // il turno successivo di capo NON è dell'utente (risvegliato da novita):
    // il suo messaggio di catena verso la STESSA coppia non vede il job
    // utente in coda → resta alla decima posizione e parte
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: novita, text: 'seconda (catena)' } } },
      { text: 'due' }
    ]
    await runTurn(capo, 'risposta', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: novita, fromAgentName: 'Novità AI D1e', hop: 1 }
    })
    expect(userJobsFor(novita).length).toBe(2)
  })
})
