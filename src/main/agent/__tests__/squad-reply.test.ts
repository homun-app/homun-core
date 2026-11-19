// Q3 (fase squadra): la risposta torna a chi ha chiesto, come in Rakazo
// (returnBotMessageOutcome). Il blocco del messaggio porta l'ID del mittente;
// ogni send_to_agent apre un filo; a fine turno di chi riceve, il testo
// finale torna da solo al mittente (<messaggio_da_agente … risposta="si">) e
// lo risveglia — a meno che chi riceve non gli abbia GIÀ scritto con
// send_to_agent. La risposta automatica non è un salto in più (il limite dei
// 3 salti resta), ma conta nel tetto orario della coppia; e una risposta non
// genera un'altra risposta (niente cicli A↔B).
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn, resolveApproval, isRunning } from '../loop'
import { makeJobRunner } from '../../../daemon/run-job'
import { listJobs } from '../../store/jobs'
import { setWebFetchForTests } from '../web-tools'
import { formatAgentMessage, AGENT_MESSAGE_RULE } from '../../../shared/agent-message'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'
let dir: string
let server: Server
let port = 0
const emit = (): void => undefined

// C1 (fase squadra-correzioni): il browser del bot — mock parziale come in
// loop.test.ts (i tool defs sono veri); disponibilità, refInfo ed esecuzione
// guidate dal test, così il click della sonda non tocca MCP veri
const browserState = vi.hoisted(() => ({
  available: false,
  calls: [] as Array<{ tool: string; input: Record<string, unknown> }>
}))
vi.mock('../browser', async (importOriginal) => {
  const real = await importOriginal<typeof import('../browser')>()
  return {
    ...real,
    browserAvailable: () => browserState.available,
    lastUrlOf: () => 'https://spa.example/prenota',
    refInfoOf: (_agentId: string, ref: string) =>
      ref === 'e8' ? { role: 'button', name: 'Conferma prenotazione', text: '' }
        : ref === 'e2' ? { role: 'link', name: 'Vedi il menu', text: '' }
        : null,
    fieldIsCredentialRef: async () => null,
    callBrowserTool: async (_agentId: string, tool: string, input: Record<string, unknown>) => {
      browserState.calls.push({ tool, input })
      return {
        output: 'Page URL: https://spa.example/prenota\n- button "Conferma prenotazione" [ref=e8]',
        meta: { browserPage: false, url: 'https://spa.example/prenota' }
      }
    }
  }
})

let queue: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = []
const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-squad-reply-'))
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
  browserState.available = false
  browserState.calls.length = 0
})

const makeAgent = (name: string): string => {
  const a = store.createAgent(name, '')
  store.updateAgent(a.id, { providerId: 'px', model: 'm-x' })
  return a.id
}
const activateBots = (agentId: string): void => {
  store.appendEntry({ agentId, kind: 'tool-result', role: 'system', content: 'groups active', meta: { callId: 'seed-groups', activatedGroups: ['bots'] } })
}
const runJob = async (job: { agent_id: string; kind: string }): Promise<void> => {
  const runner = makeJobRunner(store.db(), runTurn)
  const row = listJobs(store.db()).find((j) => j.id === (job as { id?: number }).id) ?? job
  await runner(row as never, emit)
}
const jobFor = (agentId: string, kind = 'user-message') =>
  listJobs(store.db()).find((j) => j.kind === kind && j.agent_id === agentId)

describe('Q3: il blocco del messaggio porta l\'ID del mittente (pura)', () => {
  it('formatAgentMessage con id e risposta: gli attributi nel tag, la regola dice di rispondere a quell\'id', () => {
    const ask = formatAgentMessage('Treni', 'check-in?', { id: 'agent_treni' })
    expect(ask).toContain('<messaggio_da_agente nome="Treni" id="agent_treni">')
    const reply = formatAgentMessage('Alloggio', '15:00–22:00.', { id: 'agent_alloggio', reply: true })
    expect(reply).toContain('<messaggio_da_agente nome="Alloggio" id="agent_alloggio" risposta="si">')
    expect(AGENT_MESSAGE_RULE).toContain('send_to_agent')
    expect(AGENT_MESSAGE_RULE.toLowerCase()).toContain('id')
  })

  it('senza opzioni il blocco è quello di oggi (nome e nient\'altro)', () => {
    expect(formatAgentMessage('Treni', 'ciao')).toContain('<messaggio_da_agente nome="Treni">')
  })
})

describe('Q3: la risposta collegata — la sequenza del treno', () => {
  it('A chiede a B; a fine turno di B il testo finale torna da solo ad A e lo risveglia', async () => {
    const treni = makeAgent('Treni')
    const alloggio = makeAgent('Alloggio')
    activateBots(treni)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: alloggio, text: 'A che ora è il check-in dell\'Hotel Chelsea?' } } },
      { text: 'inviato' }
    ]
    await runTurn(treni, 'organizza', emit)
    const toB = jobFor(alloggio)
    expect(toB).toBeTruthy()
    const payloadB = toB!.payload as Record<string, unknown>
    expect(typeof payloadB.threadId).toBe('string')
    expect(String(payloadB.text)).toContain(`id="${treni}"`)
    // il turno di B risponde col testo finale: la risposta torna AD A
    queue = [{ text: '15:00–22:00. Prendete il treno delle 13:05.' }]
    await runJob(toB!)
    const back = jobFor(treni)
    expect(back).toBeTruthy()
    const p = back!.payload as Record<string, unknown>
    expect(p.fromAgentId).toBe(alloggio)
    expect(p.toAgentId).toBe(treni)
    expect(p.threadId).toBe(payloadB.threadId)
    expect(p.autoReply).toBe(true)
    // la risposta NON è un salto in più: lo stesso hop della domanda
    expect(p.hop).toBe(payloadB.hop)
    // il blocco è una RISPOSTA con l'id di B, e contiene il testo finale
    expect(String(p.text)).toContain(`id="${alloggio}"`)
    expect(String(p.text)).toContain('risposta="si"')
    expect(String(p.text)).toContain('15:00–22:00')
  })

  it('se B ha GIÀ scritto ad A con send_to_agent nel turno, la risposta automatica NON parte', async () => {
    const treni = makeAgent('Treni 2')
    const alloggio = makeAgent('Alloggio 2')
    activateBots(alloggio)
    // il turno di B nasce dalla domanda di A (filo), ma B risponde con un suo send_to_agent
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: treni, text: 'ecco l\'orario' } } },
      { text: 'detto' }
    ]
    await runTurn(alloggio, 'domanda', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: treni, fromAgentName: 'Treni 2', hop: 1, threadId: 'thr-1' }
    })
    // il send esplicito c'è; la risposta automatica NO
    const jobs = listJobs(store.db()).filter((j) => j.kind === 'user-message' && j.agent_id === treni)
    expect(jobs.length).toBe(1) // solo il send esplicito
    expect((jobs[0]!.payload as Record<string, unknown>).autoReply).toBeUndefined()
  })

  it('B risponde per sbaglio al COORDINATORE: la risposta collegata arriva COMUNQUE ad A', async () => {
    const treni = makeAgent('Treni 3')
    const alloggio = makeAgent('Alloggio 3')
    const capo = makeAgent('Capo 3')
    activateBots(alloggio)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: capo, text: 'risposta sbagliata' } } },
      { text: 'comunque' }
    ]
    await runTurn(alloggio, 'domanda', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: treni, fromAgentName: 'Treni 3', hop: 1, threadId: 'thr-2' }
    })
    // al capo va il send sbagliato…
    expect(jobFor(capo)).toBeTruthy()
    // …e a Treni arriva comunque la risposta collegata col testo finale
    const back = jobFor(treni)
    expect(back).toBeTruthy()
    const p = back!.payload as Record<string, unknown>
    expect(p.autoReply).toBe(true)
    expect(String(p.text)).toContain('risposta="si"')
  })

  it('nessun ciclo A↔B: la risposta automatica non genera un\'altra risposta automatica', async () => {
    const treni = makeAgent('Treni 4')
    const alloggio = makeAgent('Alloggio 4')
    // A viene risvegliato dalla RISPOSTA automatica di B e chiude col testo
    queue = [{ text: 'perfetto, aggiorno il treno' }]
    await runTurn(treni, 'risposta', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: alloggio, fromAgentName: 'Alloggio 4', hop: 1, threadId: 'thr-3', autoReply: true }
    })
    expect(jobFor(alloggio)).toBeUndefined()
  })

  it('il limite dei salti resta: risvegliato dalla risposta (hop 1), A può ancora delegare (hop 2)', async () => {
    const treni = makeAgent('Treni 5')
    const turismo = makeAgent('Turismo 5')
    activateBots(treni)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: turismo, text: 'itinerario?' } } },
      { text: 'chiesto' }
    ]
    await runTurn(treni, 'risposta', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: makeAgent('Alloggio 5'), fromAgentName: 'Alloggio 5', hop: 1, threadId: 'thr-4', autoReply: true }
    })
    const toTurismo = jobFor(turismo)
    expect(toTurismo).toBeTruthy()
    expect((toTurismo!.payload as Record<string, unknown>).hop).toBe(2)
  })
})

describe('C1 (fase squadra-correzioni): la risposta collegata porta il contagio', () => {
  /** gira il job del risveglio NEGANDO via via le card pendenti (come runTurnDeciding di squad-loop) */
  const runJobDeciding = async (job: { id: number; agent_id: string; kind: string }): Promise<void> => {
    const runner = makeJobRunner(store.db(), runTurn)
    const row = listJobs(store.db()).find((j) => j.id === job.id) ?? job
    let settled = false
    const p = runner(row as never, emit)
    p.finally(() => { settled = true }).catch(() => undefined)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !settled) {
      await new Promise((r) => setTimeout(r, 40))
      const appr = store.getEntries(row.agent_id).find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
      if (appr) resolveApproval(row.agent_id, String(appr.meta?.approvalId), 'deny', 'once')
    }
    await p
  }

  it('B riceve una delega, LEGGE una pagina e chiude col testo: il job della risposta per A nasce contaminato', async () => {
    const treni = makeAgent('Treni C1')
    const alloggio = makeAgent('Alloggio C1')
    // il fetch FINTO che contamina (come privacy.test.ts / loop.test.ts C1 memoria)
    setWebFetchForTests(async () => ({ ok: true, text: 'Il check-in apre alle 15:00', contentType: 'text/html', finalUrl: 'https://hotel.example/checkin', downloadedBytes: 100, status: 200, elapsedMs: 40 }))
    try {
      queue = [
        { tool: { name: 'web_fetch', args: { url: 'https://hotel.example/checkin' } } },
        { text: 'Il check-in è dalle 15:00 alle 22:00.' }
      ]
      await runTurn(alloggio, 'domanda', emit, undefined, {
        initiator: 'AGENT',
        agentMessage: { fromAgentId: treni, fromAgentName: 'Treni C1', hop: 1, threadId: 'thr-c1' }
      })
      const back = jobFor(treni)
      expect(back).toBeTruthy()
      const p = back!.payload as Record<string, unknown>
      expect(p.autoReply).toBe(true)
      // il contagio di fine turno di B attraversa la risposta collegata
      expect(p.contaminated).toBe(true)
    } finally {
      setWebFetchForTests(null)
    }
  })

  it('caso pulito: B non legge niente, il payload della risposta NON ha contaminated (GUARDIA)', async () => {
    const treni = makeAgent('Treni C1 pulito')
    const alloggio = makeAgent('Alloggio C1 pulito')
    queue = [{ text: 'Nessuna lettura, solo la risposta.' }]
    await runTurn(alloggio, 'domanda', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: treni, fromAgentName: 'Treni C1 pulito', hop: 1, threadId: 'thr-c1-pulito' }
    })
    const back = jobFor(treni)
    expect(back).toBeTruthy()
    expect((back!.payload as Record<string, unknown>).contaminated).toBeUndefined()
  })

  it('nel turno risvegliato di A il contagio della risposta fa scattare il lift F8: run-command coperto da always_allow torna a chiedere', async () => {
    const treni = makeAgent('Treni C1 lift')
    const alloggio = makeAgent('Alloggio C1 lift')
    setWebFetchForTests(async () => ({ ok: true, text: 'Il check-in apre alle 15:00', contentType: 'text/html', finalUrl: 'https://hotel.example/checkin', downloadedBytes: 100, status: 200, elapsedMs: 40 }))
    // la regola always_allow dell'utente sul comando
    store.setSetting('permissions', { default: 'needs_approval', rules: [{ tool: 'run-command', pattern: 'ls', mode: 'always_allow' }] })
    try {
      // B legge e risponde: la risposta collegata per A è contaminata
      queue = [
        { tool: { name: 'web_fetch', args: { url: 'https://hotel.example/checkin' } } },
        { text: 'Il check-in è dalle 15:00.' }
      ]
      await runTurn(alloggio, 'domanda', emit, undefined, {
        initiator: 'AGENT',
        agentMessage: { fromAgentId: treni, fromAgentName: 'Treni C1 lift', hop: 1, threadId: 'thr-c1-lift' }
      })
      const back = jobFor(treni)
      expect(back).toBeTruthy()
      expect((back!.payload as Record<string, unknown>).contaminated).toBe(true)
      // A si sveglia e prova il comando coperto dalla regola: il lift F8 lo
      // riporta all'utente (il turno è contaminato dalla risposta)
      queue = [
        { tool: { name: 'run-command', args: { command: 'ls' } } },
        { text: 'ok' }
      ]
      await runJobDeciding(back!)
      const appr = store.getEntries(treni).find((e) => e.kind === 'approval')
      expect(appr).toBeTruthy()
      expect(appr!.meta?.status).toBe('denied')
    } finally {
      setWebFetchForTests(null)
      store.deleteSetting('permissions')
    }
  })

  it('nel turno risvegliato di A un browser_click che il modo «Non chiedere» coprirebbe torna a chiedere (contagio dalla risposta)', async () => {
    const treni = makeAgent('Treni C1 click')
    const alloggio = makeAgent('Alloggio C1 click')
    browserState.available = true
    setWebFetchForTests(async () => ({ ok: true, text: 'Il check-in apre alle 15:00', contentType: 'text/html', finalUrl: 'https://hotel.example/checkin', downloadedBytes: 100, status: 200, elapsedMs: 40 }))
    // il modo «Non chiedere»: senza contagio il click di conferma passerebbe
    // da solo (neverAllow); col contagio della risposta la card va all'utente
    store.setSetting('approvals.mode', 'never')
    // il gruppo browser attivo nel transcript di A (come farebbe find_tools)
    store.appendEntry({ agentId: treni, kind: 'tool-result', role: 'system', content: 'groups active', meta: { callId: 'seed-c1', activatedGroups: ['browser'] } })
    try {
      queue = [
        { tool: { name: 'web_fetch', args: { url: 'https://hotel.example/checkin' } } },
        { text: 'Il check-in è dalle 15:00.' }
      ]
      await runTurn(alloggio, 'domanda', emit, undefined, {
        initiator: 'AGENT',
        agentMessage: { fromAgentId: treni, fromAgentName: 'Treni C1 click', hop: 1, threadId: 'thr-c1-click' }
      })
      const back = jobFor(treni)
      expect(back).toBeTruthy()
      expect((back!.payload as Record<string, unknown>).contaminated).toBe(true)
      queue = [
        { tool: { name: 'browser_click', args: { ref: 'e8' } } },
        { text: 'ok' }
      ]
      await runJobDeciding(back!)
      // il click NON è passato da solo: card all'utente, negata, nulla eseguito
      const appr = store.getEntries(treni).find((e) => e.kind === 'approval')
      expect(appr).toBeTruthy()
      expect(String(appr!.meta?.tool)).toBe('browser_click')
      expect(appr!.meta?.status).toBe('denied')
      expect(browserState.calls).toHaveLength(0)
    } finally {
      setWebFetchForTests(null)
      store.deleteSetting('approvals.mode')
    }
  })
})
