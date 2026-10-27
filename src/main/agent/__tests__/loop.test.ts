// Test d'integrazione del loop con LLM finto: concorrenza (§5.7), segreti (§5.6)
// e costruzione della cronologia (§5.3). Il DB è mockato in memoria, la
// sandbox e il vault sono stub: nessun Electron, nessun processo reale.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { TranscriptEntry, Agent, PermissionsConfig } from '../../../shared/types'

// ---- stato condiviso coi mock (hoisted: disponibile dentro le factory) ----
const h = vi.hoisted(() => {
  const db = {
    entries: [] as Array<import('../../../shared/types').TranscriptEntry & { id: number }>,
    agents: new Map<string, import('../../../shared/types').Agent>(),
    settings: new Map<string, unknown>(),
    grants: [] as Array<{ tool: string; target: string }>,
    routines: [] as Array<{ id: number; agent_id: string; title: string; prompt: string; schedule: string; enabled: number; provenance?: string; description?: string; timezone?: string }>,
    // fase 6: righe dell'outbox (le send-message trattenute dei turni automatici)
    outbox: [] as Array<{ entry_id: number; agent_id: string; created_at: number }>,
    // fase 7: job accodati dal loop (send_to_agent verso altri bot)
    jobs: [] as Array<{ id: number; agentId: string; kind: string; payload: Record<string, unknown>; createdAt: number; status: string }>,
    // fase 8: righe dei task (create_task / update_task); correzione B1:
    // untrusted/automatic = origine del turno che li ha creati
    tasks: [] as Array<{ id: number; agent_id: string; title: string; status: string; created_at: number; updated_at: number; summary: string | null; untrusted?: number; automatic?: number }>,
    nextId: 1,
    nextRoutineId: 1,
    nextTaskId: 1,
    dataDir: '' // riempita nel beforeAll (mkdtemp): memoria/skill scrivono lì
  }
  const llm = {
    queue: [] as unknown[],
    calls: [] as Array<Array<{ role: string; content: string; toolCallId?: string; images?: string[]; toolCalls?: unknown[] }>>,
    // fase 9 (punto 1): il modello di OGNI chiamata (per i test della riserva)
    models: [] as string[],
    gates: new Set<{ resolve: () => void }>(),
    // fase 8: risposta del revisore delle approvazioni (chiamata separata col
    // tool report_decision — non consuma la coda delle risposte del turno;
    // default senza tool call → "revisore non disponibile" → card)
    reviewer: { text: 'no' } as FakeResp
  }
  const sandboxMock = {
    exec: { command: '', env: {} as Record<string, string>, calls: 0 },
    result: { stdout: '', stderr: '', exitCode: 0, signal: null as string | null, trimmed: false }
  }
  const mcp = { calls: 0 }
  return { db, llm, sandboxMock, mcp }
})

interface FakeToolCall { id: string; name: string; arguments: string }
interface FakeResp {
  text?: string
  toolCalls?: FakeToolCall[]
  /** fase 8: lo stream non risponde mai (test delle scadenze) */
  hang?: true
  /** fase 9 (punto 1): lo stream FALLISCE con questo errore (test della riserva) */
  error?: unknown
}
/**
 * Risposta in coda: oggetto, oppure funzione che vede i messaggi e i tool
 * della chiamata (fase 4: distingue la chiamata di compaction — un solo
 * messaggio, nessun tool — dal turno vero).
 */
type FakeQueueItem = FakeResp | ((msgs: Array<{ role: string; content: string }>, tools: unknown[]) => Promise<FakeResp> | FakeResp)
const q = () => h.llm.queue as FakeQueueItem[]

vi.mock('../../store/db', () => ({
  dataDir: () => h.db.dataDir,
  getAgent: (id: string) => h.db.agents.get(id) ?? null,
  getEntries: (id: string, afterId = 0) =>
    h.db.entries.filter((e) => e.agentId === id && e.id > afterId).map((e) => ({ ...e, meta: e.meta ? { ...e.meta } : null })),
  updateAgent: (id: string, patch: Partial<Agent>) => {
    const a = h.db.agents.get(id)
    if (a) Object.assign(a, patch)
  },
  appendEntry: (e: { agentId: string; kind: TranscriptEntry['kind']; role: TranscriptEntry['role']; content: string; meta?: Record<string, unknown> }) => {
    const row = { ...e, id: h.db.nextId++, createdAt: Date.now(), meta: e.meta ?? null } as TranscriptEntry & { id: number }
    h.db.entries.push(row)
    return { ...row }
  },
  updateEntryContent: (id: number, content: string) => {
    const r = h.db.entries.find((x) => x.id === id)
    if (r) r.content = content
  },
  updateEntryMeta: (id: number, meta: Record<string, unknown>) => {
    const r = h.db.entries.find((x) => x.id === id)
    if (r) r.meta = { ...meta }
  },
  getSetting: (key: string, fallback: unknown) => (h.db.settings.has(key) ? h.db.settings.get(key) : fallback),
  // fase 7: roster degli agenti (bot principale, send_to_agent) e routine attive
  listAgents: () => [...h.db.agents.values()].sort((a, b) => a.createdAt - b.createdAt),
  listRoutines: (agentId?: string) => h.db.routines.filter((r) => !agentId || r.agent_id === agentId),
  // fase 9 (punto 1): elenco provider (richiesto dal revisore di auto-review)
  listProviders: () => [] as Array<import('../../../shared/types').ProviderConfig>,
  db: () => undefined as never,
  setSetting: (key: string, value: unknown) => { h.db.settings.set(key, value) },
  // fase 6: outbox (i messaggi non urgenti dei turni automatici restano trattenuti)
  holdOutboxEntry: (entryId: number, agentId: string, createdAt: number) => {
    h.db.outbox.push({ entry_id: entryId, agent_id: agentId, created_at: createdAt })
  },
  heldOutboxForAgent: (agentId: string) => h.db.outbox.filter((o) => o.agent_id === agentId),
  listGrants: () => h.db.grants.map((g, i) => ({ id: i + 1, tool: g.tool, target: g.target, createdAt: 0 })),
  addGrant: (tool: string, target: string) => { h.db.grants.push({ tool, target }) },
  // fase 4: CRUD routine per update_state (verdetto del gate + esecuzione)
  getRoutine: (id: number) => h.db.routines.find((r) => r.id === id) ?? null,
  createRoutine: (agentId: string, title: string, prompt: string, schedule: string, opts: { enabled?: number; provenance?: string; description?: string; timezone?: string } = {}) => {
    const r = {
      id: h.db.nextRoutineId++, agent_id: agentId, title, prompt, schedule,
      enabled: opts.enabled ?? 1, last_run: null, created_at: Date.now(),
      provenance: opts.provenance ?? 'user', description: opts.description ?? '', timezone: opts.timezone ?? ''
    }
    h.db.routines.push(r)
    return r
  },
  updateRoutine: (id: number, patch: Record<string, unknown>) => {
    const r = h.db.routines.find((x) => x.id === id)
    if (r) Object.assign(r, patch)
  },
  deleteRoutine: (id: number) => {
    const i = h.db.routines.findIndex((x) => x.id === id)
    if (i >= 0) h.db.routines.splice(i, 1)
  },
  // fase 8 (§3bis L7): tabella tasks per create_task/update_task; correzione
  // B1: l'origine del turno (untrusted/automatic) si salva sulla riga
  createTask: (agentId: string, title: string, opts: { untrusted?: boolean; automatic?: boolean } = {}) => {
    const t = {
      id: h.db.nextTaskId++, agent_id: agentId, title, status: 'working',
      created_at: Date.now(), updated_at: Date.now(), summary: null,
      untrusted: opts.untrusted ? 1 : 0, automatic: opts.automatic ? 1 : 0
    }
    h.db.tasks.push(t)
    return { ...t }
  },
  // correzione B2: task aperti (working/needs_input) e tetto per agente
  openTasksOf: (agentId: string) =>
    h.db.tasks.filter((t) => t.agent_id === agentId && (t.status === 'working' || t.status === 'needs_input')).length,
  MAX_OPEN_TASKS: 5,
  getTask: (id: number) => {
    const t = h.db.tasks.find((x) => x.id === id)
    return t ? { ...t } : null
  },
  updateTask: (id: number, patch: { status?: string; summary?: string }) => {
    const t = h.db.tasks.find((x) => x.id === id)
    if (!t) return null
    // i task chiusi non riaprono (come lo store reale)
    if (['done', 'failed', 'cancelled'].includes(t.status)) return { ...t }
    if (patch.status !== undefined) t.status = patch.status
    if (patch.summary !== undefined) t.summary = patch.summary
    t.updated_at = Date.now()
    return { ...t }
  },
  getPermissions: () =>
    (h.db.settings.get('permissions') as PermissionsConfig | undefined) ?? {
      default: 'needs_approval',
      rules: [
        { tool: 'read-file', pattern: '*', mode: 'always_allow' },
        { tool: 'list-directory', pattern: '*', mode: 'always_allow' },
        { tool: 'write-file', pattern: '*', mode: 'needs_approval' },
        { tool: 'run-command', pattern: '*', mode: 'needs_approval' },
        { tool: 'list-credentials', pattern: '*', mode: 'always_allow' },
        // fase 8: task e proposte di regola (come le regole di default dello store)
        { tool: 'create_task', pattern: '*', mode: 'always_allow' },
        { tool: 'update_task', pattern: '*', mode: 'always_allow' },
        { tool: 'propose_rule_change', pattern: '*', mode: 'always_allow' }
      ]
    }
}))

vi.mock('../../store/jobs', () => ({
  MAX_USER_MESSAGE_QUEUE: 10,
  enqueueJob: (_db: unknown, input: { agentId: string; kind: string; payload: Record<string, unknown>; runAt: number; now: number }) => {
    const job = { id: h.db.jobs.length + 1, ...input, createdAt: input.now, status: 'queued' }
    h.db.jobs.push(job)
    return job
  },
  // correzione A1: stesso tetto della coda dei messaggi utente (mock del conteggio SQL)
  pendingUserMessages: (_db: unknown, agentId: string) =>
    h.db.jobs.filter((j) => j.agentId === agentId && j.kind === 'user-message' && j.status === 'queued').length,
  // correzione A1: i job della coppia già accodati (mock di pendingAgentPairJobs)
  pendingAgentPairJobs: (_db: unknown, a: string, b: string, now: number) =>
    h.db.jobs.filter((j) =>
      j.kind === 'user-message' && (j.status === 'queued' || j.status === 'leased') &&
      j.createdAt > now - 3_600_000 && j.payload.initiator === 'AGENT' && j.payload.entryId === undefined &&
      ((j.payload.fromAgentId === a && j.payload.toAgentId === b) || (j.payload.fromAgentId === b && j.payload.toAgentId === a))
    ).length
}))

vi.mock('../providers', () => ({
  getProvider: (id: string) =>
    id === 'prov'
      ? { id: 'prov', name: 'test', kind: 'openai-compatible' as const, baseUrl: 'http://localhost', apiKey: '', enabled: true }
      : null
}))

vi.mock('../llm', () => ({
  llmStream: (
    _p: unknown,
    _model: string,
    messages: Array<{ role: string; content: string; toolCallId?: string; images?: string[]; toolCalls?: unknown[] }>,
    tools: unknown[] = []
  ) => {
    h.llm.calls.push(messages.map((m) => ({ role: m.role, content: m.content, toolCallId: m.toolCallId, images: m.images, toolCalls: m.toolCalls })))
    // fase 9 (punto 1): quale modello è stato usato per questa chiamata
    h.llm.models.push(String(_model))
    // fase 8: la chiamata del REVISORE (solo tool report_decision) risponde da
    // h.llm.reviewer senza toccare la coda del turno
    if ((tools as Array<{ name?: string }>).some((t) => t?.name === 'report_decision')) {
      const r = h.llm.reviewer
      const iter = {
        async *[Symbol.asyncIterator]() {
          if (r.text) yield { textDelta: r.text }
          if (r.toolCalls) yield { toolCalls: r.toolCalls, finishReason: 'tool_calls' }
          else yield { finishReason: 'stop' }
        }
      }
      return {
        ...iter,
        async drain() {
          let text = ''
          let toolCalls: FakeToolCall[] = []
          for await (const ch of iter[Symbol.asyncIterator]()) {
            const c = ch as { textDelta?: string; toolCalls?: FakeToolCall[] }
            if (c.textDelta) text += c.textDelta
            if (c.toolCalls) toolCalls = c.toolCalls
          }
          return { text, toolCalls, finishReason: 'stop' }
        }
      }
    }
    const resp = (q().shift() ?? { text: 'ok' }) as FakeQueueItem
    return {
      async *[Symbol.asyncIterator]() {
        const r: FakeResp = typeof resp === 'function' ? await resp(messages, tools) : resp
        // fase 8 (§3bis L11): stream appeso — nessun chunk mai (scadenze)
        if (r.hang) {
          if (r.text) yield { textDelta: r.text }
          await new Promise(() => undefined)
          return
        }
        // fase 9 (punto 1): lo stream fallisce (test della riserva)
        if (r.error) throw r.error
        if (r.text) yield { textDelta: r.text }
        if (r.toolCalls) yield { toolCalls: r.toolCalls, finishReason: 'tool_calls' }
        else yield { finishReason: 'stop' }
      },
      async drain() {
        let text = ''
        for await (const ch of this[Symbol.asyncIterator]()) if ((ch as { textDelta?: string }).textDelta) text += (ch as { textDelta: string }).textDelta
        return { text, toolCalls: [], finishReason: 'stop' }
      }
    }
  }
}))

vi.mock('../../sandbox', () => ({
  sandboxMode: () => 'host' as const,
  boxDir: (id: string) => `/tmp/sandbot-${id}`,
  execCommand: async (_agentId: string, command: string, opts: { env?: Record<string, string> } = {}) => {
    h.sandboxMock.exec.command = command
    h.sandboxMock.exec.env = opts.env ?? {}
    h.sandboxMock.exec.calls++
    return { ...h.sandboxMock.result }
  }
}))

vi.mock('../../vault', () => ({
  revealSecret: async (name: string) => {
    if (name === 'API_KEY') return 'SK-1234-SEGRETO'
    throw new Error(`credenziale "${name}" non presente nel vault`)
  },
  listSecretNames: () => ['API_KEY']
}))

// fase 3: il client MCP è finto — conta le chiamate per provare che gli invii
// esterni NON partono finché l'utente non clicca Invia
vi.mock('../../mcp', () => ({
  activeTools: async () => [{
    name: 'mcp__gmail__send_message', description: 'invia email', parameters: { type: 'object', properties: {} }
  }],
  listServers: () => [],
  McpNeedsReconnectError: class extends Error {},
  callTool: async () => {
    h.mcp.calls++
    return 'email inviata'
  }
}))

const { runTurn, isRunning, resolveApproval, supersedeIfPaused, interrupt, RECOVERY_NUDGE } = await import('../loop')
// il modulo mcp mockato (per patcharne callTool nel test della card Riconnetti)
const mcpMock = await import('../../mcp')

const emit = () => undefined
const AGENT = 'agent_t'

// fase 4: memoria/skill del loop scrivono su file — directory temporanea
// (la dataDir del mock db la legge da qui)
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const TMP = mkdtempSync(join(tmpdir(), 'sandbot-loop-test-'))
h.db.dataDir = TMP

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Risposta LLM che blocca lo stream finché il gate non si apre (agente "occupato"). */
function gated(text: string) {
  const gate = deferred()
  h.llm.gates.add(gate)
  return {
    response: async (): Promise<FakeResp> => { await gate.promise; return { text } },
    resolve: () => { gate.resolve(); h.llm.gates.delete(gate) }
  }
}

beforeEach(() => {
  h.db.entries.length = 0
  h.db.agents.clear()
  h.db.settings.clear()
  h.db.grants.length = 0
  h.db.routines.length = 0
  h.db.outbox.length = 0
  h.db.jobs.length = 0
  h.db.tasks.length = 0
  h.db.nextId = 1
  h.db.nextRoutineId = 1
  h.db.nextTaskId = 1
  // fase 4: memoria e skill scritte dai test non devono inquinare il dopo
  rmSync(join(TMP, 'agents'), { recursive: true, force: true })
  h.llm.queue.length = 0
  h.llm.calls.length = 0
  h.llm.models.length = 0
  h.llm.reviewer = { text: 'no' }
  h.sandboxMock.exec = { command: '', env: {}, calls: 0 }
  h.sandboxMock.result = { stdout: '', stderr: '', exitCode: 0, signal: null, trimmed: false }
  h.mcp.calls = 0
  h.db.agents.set(AGENT, {
    id: AGENT, name: 'TestBot', description: '', providerId: 'prov', model: 'm1',
    status: 'idle', unread: 0, createdAt: 1
  })
})

// un test fallito può lasciare turni bloccati sui gate: si rilasciano tutti e
// si aspetta che il loop si svuoti, altrimenti `running` inquina il test dopo
afterEach(async () => {
  for (const g of h.llm.gates) g.resolve()
  h.llm.gates.clear()
  await vi.waitFor(() => {
    expect(isRunning(AGENT)).toBe(false)
  }, { timeout: 3000 })
})

describe('§5.7 concorrenza: un turno per agente (fase 2: la coda vive nella tabella jobs del daemon)', () => {
  it('una routine su agente occupato viene scartata con notice, non accodata', async () => {
    const g = gated('occupato')
    h.llm.queue = [g.response]

    const first = runTurn(AGENT, 'lavoro', emit, undefined, { source: 'routine', title: 'Lavoro' })
    await vi.waitFor(() => expect(h.llm.calls).toHaveLength(1))

    await runTurn(AGENT, '[routine] backup', emit, undefined, { source: 'routine', title: 'Backup' })
    const notice = h.db.entries.find((e) => e.kind === 'notice' && e.content.includes('Backup') && e.content.includes('saltata'))
    expect(notice).toBeTruthy()

    g.resolve()
    await first
    await vi.waitFor(() => expect(isRunning(AGENT)).toBe(false))
    // la routine non ha mai girato; il turno di routine senza send_to_user non
    // fa nemmeno la chiamata di recupero (solo i turni utente la fanno)
    expect(h.llm.calls).toHaveLength(1)
  })

  it('un secondo messaggio utente su agente occupato viene scartato con notice (nessuna coda qui)', async () => {
    const g = gated('primo fatto')
    h.llm.queue = [g.response]
    // seconda risposta per la chiamata di recupero (il turno finisce senza send_to_user)
    h.llm.queue.push({ text: 'recupero' })

    const first = runTurn(AGENT, 'primo', emit)
    await vi.waitFor(() => expect(h.llm.calls).toHaveLength(1))
    expect(isRunning(AGENT)).toBe(true)

    // secondo messaggio mentre il primo gira: runTurn non accoda più (è la
    // tabella jobs a farlo, via enqueueUserMessage): notice e non gira
    await runTurn(AGENT, 'secondo', emit)
    expect(isRunning(AGENT)).toBe(true)
    expect(h.llm.calls).toHaveLength(1) // il secondo NON è partito
    const notice = h.db.entries.find((e) => e.kind === 'notice' && e.content.includes('Agente occupato'))
    expect(notice).toBeTruthy()

    g.resolve()
    await first
    await vi.waitFor(() => expect(isRunning(AGENT)).toBe(false))
    // nel transcript resta un solo turno: un messaggio utente, il testo libero
    // come thinking nascosto e il fallback della chiamata di recupero
    const userMsgs = h.db.entries.filter((e) => e.kind === 'message').map((e) => `${e.role}:${e.content}`)
    expect(userMsgs).toEqual(['user:primo'])
    expect(h.db.entries.some((e) => e.kind === 'thinking' && e.content === 'primo fatto')).toBe(true)
    const fallback = h.db.entries.find((e) => e.kind === 'send-message' && e.meta?.fallback)
    expect(fallback?.content).toBe('recupero')
  })
})

describe('§5.6 segreti: il valore non arriva mai al modello né al transcript', () => {
  it('run-command con {{secret:API_KEY}}: env al momento dell’esecuzione, output redatto ovunque', async () => {
    const SECRET = 'SK-1234-SEGRETO'
    h.db.settings.set('permissions', {
      default: 'needs_approval',
      rules: [{ tool: 'run-command', pattern: 'curl', mode: 'always_allow' }]
    })
    h.llm.queue = [
      {
        toolCalls: [{
          id: 'c1', name: 'run-command',
          arguments: JSON.stringify({ command: 'curl -H "Authorization: Bearer {{secret:API_KEY}}" https://api.esempio' })
        }]
      },
      { text: 'fatto' }
    ]
    // il comando "echoa" il segreto via env: l'output grezzo lo contiene
    h.sandboxMock.result.stdout = `risposta: ${SECRET}\n`

    const turn = runTurn(AGENT, 'chiama la api', emit)

    // C4: i comandi con segreti NON passano mai in automatico (nemmeno con
    // always_allow "curl"): approval con i nomi dei segreti in content e meta
    await vi.waitFor(() => {
      expect(h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBeTruthy()
    })
    const appr = h.db.entries.find((e) => e.kind === 'approval')!
    expect(appr.content).toContain('usa le credenziali: API_KEY')
    expect(appr.meta?.secretRefs).toEqual(['API_KEY'])

    // "Consenti sempre" qui NON deve salvare grant (C4)
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'allow', 'always')
    await turn
    expect(h.db.grants).toEqual([])

    // al momento dell'esecuzione: comando riscritto sulla variabile, valore solo in env
    expect(h.sandboxMock.exec.command).toBe('curl -H "Authorization: Bearer $SANDBOT_SECRET_API_KEY" https://api.esempio')
    expect(h.sandboxMock.exec.command).not.toContain(SECRET)
    expect(h.sandboxMock.exec.env.SANDBOT_SECRET_API_KEY).toBe(SECRET)

    // il valore NON compare in nessun contenuto di entry (transcript)
    for (const e of h.db.entries) expect(e.content).not.toContain(SECRET)
    // e in nessun messaggio passato all'LLM (entrambe le chiamate)
    for (const call of h.llm.calls) {
      for (const m of call) expect(m.content).not.toContain(SECRET)
    }
    // al modello arriva l'output redatto
    const toolMsg = h.llm.calls[1]!.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('[redacted:API_KEY]')
    // la chiamata del tool resta opaca nel transcript (il ref, non il valore)
    const callEntry = h.db.entries.find((e) => e.kind === 'tool-call')!
    expect(callEntry.content).toBe('run-command')
    expect(String(callEntry.meta?.arguments)).toContain('{{secret:API_KEY}}')
  })

  it('run-command con segreto inesistente: errore coi nomi disponibili, niente esecuzione', async () => {
    h.db.settings.set('permissions', {
      default: 'needs_approval',
      rules: [{ tool: 'run-command', pattern: 'curl', mode: 'always_allow' }]
    })
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'curl -H "{{secret:NON_C_E}}" x' }) }] },
      { text: 'ok' }
    ]
    const turn = runTurn(AGENT, 'chiama', emit)
    // anche qui serve l'approvazione: il comando contiene un {{secret:...}} (C4)
    await vi.waitFor(() => {
      expect(h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBeTruthy()
    })
    const appr = h.db.entries.find((e) => e.kind === 'approval')!
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'allow', 'once')
    await turn
    expect(h.sandboxMock.exec.calls).toBe(0)
    const res = h.db.entries.find((e) => e.kind === 'tool-result')!
    expect(res.content).toContain('non presenti nel vault')
    expect(res.content).toContain('API_KEY')
  })
})

describe('§5.1+approval: gate asincrono e standing grant esatta', () => {
  it('comando non coperto → approval; allow+always → grant su "curl" esatta e il turno prosegue', async () => {
    const SECRET_TIMEOUT = 60_000
    h.db.settings.set('permissions.timeoutMs', SECRET_TIMEOUT)
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'curl https://esempio' }) }] },
      // fase 3: la risposta finale all'utente passa da send_to_user
      { toolCalls: [{ id: 'c2', name: 'send_to_user', arguments: JSON.stringify({ text: 'completato' }) }] },
      { text: 'ok' } // fine turno: thinking non visibile
    ]

    const turn = runTurn(AGENT, 'scarica', emit)
    await vi.waitFor(() => {
      const appr = h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
      expect(appr).toBeTruthy()
    })
    const appr = h.db.entries.find((e) => e.kind === 'approval')!
    expect(appr.content).toContain('curl')

    resolveApproval(AGENT, String(appr.meta?.approvalId), 'allow', 'always')
    await turn
    await vi.waitFor(() => expect(h.db.grants).toContainEqual({ tool: 'run-command', target: 'curl' }))

    // eseguito davvero e il turno si è chiuso con il messaggio visibile
    expect(h.sandboxMock.exec.command).toBe('curl https://esempio')
    expect(h.db.entries.findLast((e) => e.kind === 'send-message')?.content).toBe('completato')
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('FINISHED')
  })

  it('approval scaduta → result "Rifiutato dall’utente" al transcript e notice di scadenza', async () => {
    h.db.settings.set('permissions.timeoutMs', 30)
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'curl https://esempio' }) }] },
      { text: 'annullato' }
    ]
    await runTurn(AGENT, 'scarica', emit)
    expect(h.sandboxMock.exec.calls).toBe(0)
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('Approvazione scaduta'))).toBe(true)
    const res = h.db.entries.find((e) => e.kind === 'tool-result')!
    expect(res.content).toContain("Rifiutato dall'utente")
  })

  it('`ls; rm -rf /` con grant solo su "ls" → approval che mostra ENTRAMBE le chiavi', async () => {
    h.db.grants.push({ tool: 'run-command', target: 'ls' })
    h.db.settings.set('permissions.timeoutMs', 30)
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'ls; rm -rf /' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'pulisci', emit)
    const appr = h.db.entries.find((e) => e.kind === 'approval')!
    expect(String(appr.meta?.keys)).toContain('rm')
    expect(h.sandboxMock.exec.calls).toBe(0) // scaduta → mai eseguita
  })
})

describe('R1: ripresa del turno dopo crash/retry (payload.entryId)', () => {
  /** Entry del transcript costruita a mano (stato "post-crash"). */
  const mkEntry = (
    id: number, kind: TranscriptEntry['kind'], role: TranscriptEntry['role'],
    content: string, meta: Record<string, unknown> | null = null
  ): TranscriptEntry & { id: number } => ({ id, agentId: AGENT, kind, role, content, meta, createdAt: 1 })

  it('primo tentativo: l\'id dell\'entry utente viene salvato PRIMA di chiamare il modello', async () => {
    h.llm.queue = [{ text: 'ok' }]
    let savedAtLlmCalls = -1
    let savedId = -1
    await runTurn(AGENT, 'ciao', emit, undefined, {
      onTurnEntry: (id) => { savedAtLlmCalls = h.llm.calls.length; savedId = id }
    })
    expect(savedId).toBe(h.db.entries.find((e) => e.kind === 'message' && e.role === 'user')!.id)
    expect(savedAtLlmCalls).toBe(0) // salvato prima della prima chiamata al modello
    // fase 3: turno utente senza send_to_user → UNA chiamata di recupero in più
    expect(h.llm.calls).toHaveLength(2)
    // il messaggio utente compare UNA volta sola nella storia del modello
    expect(h.llm.calls[0]!.filter((m) => m.role === 'user' && m.content === 'ciao')).toHaveLength(1)
  })

  it('ripresa dopo crash: un solo messaggio utente, tool-result "interrotto da un riavvio", approval expired, tool non rieseguito', async () => {
    // transcript post-crash: messaggio utente, tool-call il cui esito è andato
    // perso (nessun tool-result) e approval rimasta pending
    h.db.entries.push(
      mkEntry(1, 'message', 'user', 'fai il deploy'),
      mkEntry(2, 'message', 'assistant', ''),
      mkEntry(3, 'tool-call', 'assistant', 'run-command', { id: 'c1', name: 'run-command', arguments: '{"command":"deploy"}' }),
      mkEntry(4, 'approval', 'system', 'run-command: comando fuori box', { approvalId: 'ap1', tool: 'run-command', input: { command: 'deploy' }, status: 'pending' })
    )
    h.db.nextId = 5
    h.llm.queue = [{ text: 'verifico lo stato e proseguo' }]

    await runTurn(AGENT, 'fai il deploy', emit, undefined, { resume: { entryId: 1 } })

    // il messaggio utente NON è stato riscritto
    expect(h.db.entries.filter((e) => e.kind === 'message' && e.role === 'user')).toHaveLength(1)
    // la tool-call orfana ha ricevuto un tool-result PERSISTITO
    const res = h.db.entries.find((e) => e.kind === 'tool-result')!
    expect(res.content).toContain('interrotto da un riavvio')
    expect(res.content).toContain('esito è sconosciuto')
    expect(res.meta?.callId).toBe('c1')
    // l'approval pending è scaduta e c'è la notice di ripresa
    expect(h.db.entries.find((e) => e.kind === 'approval')!.meta?.status).toBe('expired')
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('Turno ripreso dopo un'))).toBe(true)
    // il tool NON è stato rieseguito (il modello non l'ha richiamato)
    expect(h.sandboxMock.exec.calls).toBe(0)
    // al modello è arrivato il result sintetico e un solo messaggio utente
    const first = h.llm.calls[0]!
    expect(first.filter((m) => m.role === 'user' && m.content === 'fai il deploy')).toHaveLength(1)
    expect(first.find((m) => m.role === 'tool')?.content).toContain('interrotto da un riavvio')
  })

  it('turno già concluso: la ripresa NON chiama il modello', async () => {
    h.db.entries.push(
      mkEntry(1, 'message', 'user', 'stato?'),
      mkEntry(2, 'message', 'assistant', 'tutto a posto')
    )
    h.db.nextId = 3

    await runTurn(AGENT, 'stato?', emit, undefined, { resume: { entryId: 1 } })

    expect(h.llm.calls).toHaveLength(0)
    expect(h.db.entries.filter((e) => e.kind === 'message' && e.role === 'user')).toHaveLength(1)
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('Turno ripreso'))).toBe(false)
  })
})

describe('fase 3: l\'agente comunica SOLO tramite tool (§3bis L2)', () => {
  it('send_to_user crea una send-message visibile; il testo libero resta thinking nascosto', async () => {
    h.llm.queue = [
      { text: 'sto verificando…', toolCalls: [{ id: 'c1', name: 'send_to_user', arguments: JSON.stringify({ text: 'Ecco il **risultato**' }) }] },
      { text: 'finito' }
    ]
    await runTurn(AGENT, 'dimmi', emit)

    // il testo libero è thinking (non visibile), il messaggio è send-message
    expect(h.db.entries.find((e) => e.kind === 'thinking')?.content).toBe('sto verificando…')
    const sent = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(sent.content).toBe('Ecco il **risultato**')
    expect(sent.meta?.message).toMatchObject({ type: 'text', text: 'Ecco il **risultato**' })
    // meta.call ricostruisce la chiamata originale per la storia del modello
    expect(sent.meta?.call).toMatchObject({ id: 'c1', name: 'send_to_user' })
    // urgent finisce in meta (servirà alla fase 6)
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('FINISHED')
    // nessuna tool-call entry nel transcript per i tool di comunicazione
    expect(h.db.entries.some((e) => e.kind === 'tool-call' && e.content === 'send_to_user')).toBe(false)
  })

  it('turno ROUTINE senza send_to_user: silenzio (nessuna send-message) e nessuna chiamata di recupero', async () => {
    h.llm.queue = [{ text: 'analisi interna, niente da segnalare' }]
    await runTurn(AGENT, 'routine check', emit, undefined, { source: 'routine', title: 'Check' })

    expect(h.llm.calls).toHaveLength(1) // NESSUN recupero per le routine
    expect(h.db.entries.filter((e) => e.kind === 'send-message')).toHaveLength(0)
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('FINISHED')
    // il testo libero resta interno
    expect(h.db.entries.some((e) => e.kind === 'thinking')).toBe(true)
  })

  it('turno UTENTE senza send_to_user: UNA chiamata di recupero; se usa send_to_user viene mostrata', async () => {
    h.llm.queue = [
      { text: 'penso tra me' },
      { toolCalls: [{ id: 'r1', name: 'send_to_user', arguments: JSON.stringify({ text: 'ecco la risposta' }) }] }
    ]
    await runTurn(AGENT, 'domanda', emit)

    expect(h.llm.calls).toHaveLength(2)
    // la seconda chiamata porta il sollecito di recupero come messaggio utente
    const second = h.llm.calls[1]!
    expect(second[second.length - 1]).toMatchObject({ role: 'user', content: RECOVERY_NUDGE })
    const sent = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(sent.content).toBe('ecco la risposta')
    expect(sent.meta?.fallback).toBeUndefined() // NON è un fallback
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('FINISHED')
  })

  it('recupero senza send_to_user nemmeno alla seconda: fallback col testo libero, meta.fallback=true', async () => {
    h.llm.queue = [
      { text: 'prima risposta' },
      { text: 'testo dell\'ultima risposta' }
    ]
    await runTurn(AGENT, 'ciao', emit)

    expect(h.llm.calls).toHaveLength(2)
    const fallback = h.db.entries.findLast((e) => e.kind === 'send-message')!
    expect(fallback.content).toBe('testo dell\'ultima risposta')
    expect(fallback.meta?.fallback).toBe(true)
    expect(fallback.meta?.message).toMatchObject({ type: 'text' })
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('FINISHED')
  })

  it('ask_user → entry widget, esito AWAITING_USER, nessun recupero; la risposta arriva con respondedTo', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'w1', name: 'ask_user', arguments: JSON.stringify({
        prompt: 'Sì o no?', helpText: 'serve per procedere',
        options: [
          { label: 'Sì', style: 'primary' },
          { label: 'No', value: 'no' }
        ],
        dismissOnMoveOn: true
      }) }] }
    ]
    await runTurn(AGENT, 'procedi', emit)

    // una sola chiamata: il turno TERMINA con ask_user (nessun recupero)
    expect(h.llm.calls).toHaveLength(1)
    const widget = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(widget.meta?.message).toMatchObject({ type: 'widget', prompt: 'Sì o no?' })
    // le opzioni sono normalizzate: value di ripiego = label
    expect(widget.meta?.message).toMatchObject({ options: [
      { label: 'Sì', value: 'Sì', style: 'primary' }, { label: 'No', value: 'no' }
    ] })
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('AWAITING_USER')

    // la risposta dell'utente: nuovo turno con meta.respondedTo = entry del widget
    h.llm.queue = [{ toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'ok ricevuto' }) }] }, { text: '.' }]
    await runTurn(AGENT, 'Sì', emit, undefined, { respondedTo: widget.id })
    const answer = h.db.entries.findLast((e) => e.kind === 'message' && e.role === 'user')!
    expect(answer.content).toBe('Sì')
    expect(answer.meta?.respondedTo).toBe(widget.id)
    // e la storia del modello contiene la risposta dopo il widget
    expect(h.llm.calls[1]!.filter((m) => m.role === 'user' && m.content === 'Sì')).toHaveLength(1)
  })

  it('SUPERSEDED: nuovo messaggio durante un\'approval pendente → approval superseded, turno SUPERSEDED, il nuovo parte', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'curl https://esempio' }) }] },
      { text: 'mai' }
    ]
    const first = runTurn(AGENT, 'prima richiesta', emit)
    await vi.waitFor(() => {
      expect(h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBeTruthy()
    })

    // l'utente scrive altro mentre l'agente è fermo sull'approval
    expect(supersedeIfPaused(AGENT)).toBe(true)
    await first
    await vi.waitFor(() => expect(isRunning(AGENT)).toBe(false))

    const appr = h.db.entries.find((e) => e.kind === 'approval')!
    expect(appr.meta?.status).toBe('superseded')
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('SUPERSEDED')
    // il tool non è MAI stato eseguito e il modello non è stato richiamato
    expect(h.sandboxMock.exec.calls).toBe(0)
    expect(h.llm.calls).toHaveLength(1)

    // il nuovo messaggio parte subito in un turno pulito
    h.llm.queue = [{ toolCalls: [{ id: 'n1', name: 'send_to_user', arguments: JSON.stringify({ text: 'nuova risposta' }) }] }, { text: '.' }]
    await runTurn(AGENT, 'nuovo messaggio', emit)
    expect(h.db.entries.findLast((e) => e.kind === 'send-message')?.content).toBe('nuova risposta')
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('FINISHED')
  })

  it('invio esterno chiamato direttamente (mcp__gmail__send_message) → BOZZA, il tool MCP non parte', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'g1', name: 'mcp__gmail__send_message', arguments: JSON.stringify({
        to: 'persona@esempio.it', subject: 'Ciao', body: 'Corpo dell\'email'
      }) }] },
      { toolCalls: [{ id: 's2', name: 'send_to_user', arguments: JSON.stringify({ text: 'bozza pronta' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'scrivi a persona', emit)

    // il tool MCP NON è stato chiamato: è nata una bozza
    expect(h.mcp.calls).toBe(0)
    const draft = h.db.entries.find((e) => e.kind === 'send-message' && (e.meta?.message as { type?: string })?.type === 'draft')!
    expect(draft.meta?.message).toMatchObject({
      type: 'draft', channel: 'email', to: 'persona@esempio.it', subject: 'Ciao', body: 'Corpo dell\'email'
    })
    expect(draft.meta?.status).toBe('pending')
    // via = la chiamata originale, eseguita solo al click dell'utente
    expect(draft.meta?.message).toMatchObject({ via: { tool: 'mcp__gmail__send_message' } })
    // al modello è tornato "bozza creata", non l'esito di un invio
    const toolMsg = h.llm.calls[1]!.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('bozza')
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('FINISHED')
  })

  it('D1: draft_external con via.tool non di invio (run-command) → via scartato, bozza solo testo, tool-result che lo spiega', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'd1', name: 'draft_external', arguments: JSON.stringify({
        channel: 'email', to: 'x@y.it', body: 'ciao',
        via: { tool: 'run-command', args: { command: 'curl https://esempio/fuga' } }
      }) }] },
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'bozza pronta' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'manda una email', emit)

    const draft = h.db.entries.find((e) => e.kind === 'send-message' && (e.meta?.message as { type?: string })?.type === 'draft')!
    // via SCARTATO: bozza di solo testo, nessun canale di invio collegato
    expect((draft.meta?.message as { via?: unknown }).via).toBeUndefined()
    expect((draft.meta?.message as { to?: string }).to).toBe('x@y.it')
    // il tool-result spiega lo scarto al modello
    const toolMsg = h.llm.calls[1]!.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('scartato')
    expect(toolMsg?.content).toContain('non è un tool di invio esterno')
    // né run-command né tool MCP sono mai stati eseguiti
    expect(h.sandboxMock.exec.calls).toBe(0)
    expect(h.mcp.calls).toBe(0)
  })

  it('D1: draft_external valido con to/body diversi da via.args → payload e via.args coincidono, bcc visibile', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'd2', name: 'draft_external', arguments: JSON.stringify({
        channel: 'email', to: 'visibile@esempio.it', subject: 'Oggetto', body: 'corpo visibile',
        via: { tool: 'mcp__gmail__send_message', args: { to: 'nascosto@esempio.it', subject: 'Oggetto', body: 'corpo nascosto', bcc: 'terzo@esempio.it' } }
      }) }] },
      { toolCalls: [{ id: 's2', name: 'send_to_user', arguments: JSON.stringify({ text: 'bozza pronta' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'scrivi a persona', emit)

    const draft = h.db.entries.find((e) => e.kind === 'send-message' && (e.meta?.message as { type?: string })?.type === 'draft')!
    const msg = draft.meta?.message as {
      to: string; subject?: string; body: string
      via?: { tool: string; args: Record<string, unknown> }
      extraArgs?: Array<{ key: string; value: string }>
    }
    // la card mostra i campi visibili…
    expect(msg.to).toBe('visibile@esempio.it')
    expect(msg.subject).toBe('Oggetto')
    expect(msg.body).toBe('corpo visibile')
    // …e gli argomenti che verranno eseguiti sono quelli aggiornati dai campi visibili
    expect(msg.via).toEqual({
      tool: 'mcp__gmail__send_message',
      args: { to: 'visibile@esempio.it', subject: 'Oggetto', body: 'corpo visibile', bcc: 'terzo@esempio.it' }
    })
    // il campo extra bcc non è nascosto: finisce in "Altri parametri"
    expect(msg.extraArgs).toEqual([{ key: 'bcc', value: 'terzo@esempio.it' }])
    // il tool MCP NON è mai partito in questo turno (solo al click su Invia)
    expect(h.mcp.calls).toBe(0)
  })
})

describe('residuo fase 4 (0c): interrupt durante un’approval', () => {
  it('interrupt → approval risolta SUBITO con cancelled (entry marcata) e turno STOPPED', async () => {
    // timeout lungo: se l'interrupt non risolvesse la promise, il test
    // resterebbe appeso fino alla scadenza vera
    h.db.settings.set('permissions.timeoutMs', 300_000)
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'curl https://esempio' }) }] }
    ]

    const turn = runTurn(AGENT, 'scarica', emit)
    await vi.waitFor(() => {
      expect(h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBeTruthy()
    })
    const appr = h.db.entries.find((e) => e.kind === 'approval')!

    interrupt(AGENT)
    // il turno si chiude SUBITO, senza aspettare il timeout da 5 minuti
    await vi.waitFor(() => expect(isRunning(AGENT)).toBe(false), { timeout: 2000 })
    await turn

    // l'entry approval è marcata cancelled, il tool non è mai partito
    const marked = h.db.entries.find((e) => e.id === appr.id)!
    expect(marked.meta?.status).toBe('cancelled')
    expect(h.sandboxMock.exec.calls).toBe(0)
    // il modello vede l'esito dell'interrupt e il turno chiude STOPPED
    const cancelledResult = h.db.entries.find((e) => e.kind === 'tool-result' && e.content === 'Interrotto dall’utente')
    expect(cancelledResult).toBeTruthy()
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('STOPPED')
    // nessuna seconda chiamata al modello dopo l'interrupt
    expect(h.llm.calls).toHaveLength(1)
  })
})

describe('fase 4: memoria e skill nel system prompt', () => {
  it('una memoria core finisce nella sezione # Memoria del system del turno', async () => {
    const { writeMemory } = await import('../memory')
    writeMemory(AGENT, { content: "l'utente vuole puntualità", tier: 'core' })
    h.llm.queue = [
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'ok' }) }] },
      { text: 'fine' }
    ]
    await runTurn(AGENT, 'ciao', emit)
    const system = h.llm.calls[0]![0]!.content
    expect(system).toContain('# Memoria')
    expect(system).toContain("l'utente vuole puntualità")
  })

  it('nel system solo nome e descrizione delle skill; il corpo arriva col tool skill()', async () => {
    const { writeSkill } = await import('../skills')
    writeSkill(AGENT, { name: 'triage', description: 'smista la posta', content: 'CORPO SEGRETO della skill' })
    h.llm.queue = [
      { toolCalls: [{ id: 'k1', name: 'skill', arguments: JSON.stringify({ name: 'triage' }) }] },
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'fatto' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'usa la skill', emit)
    const system = h.llm.calls[0]![0]!.content
    expect(system).toContain('# Skill disponibili')
    expect(system).toContain('triage: smista la posta')
    expect(system).not.toContain('CORPO SEGRETO')
    // il tool skill ha consegnato il corpo al modello come tool result
    expect(h.db.entries.some((e) => e.kind === 'tool-result' && e.content.includes('CORPO SEGRETO'))).toBe(true)
  })
})

describe('fase 4: update_state nel loop', () => {
  it('create: routine in pausa provenance agent + evento automation in chat, NESSUNA approval', async () => {
    h.llm.queue = [
      {
        toolCalls: [{
          id: 'u1', name: 'update_state',
          arguments: JSON.stringify({ target: 'routine', action: 'create', name: 'Monitor', prompt: 'guarda', schedule: '0 9 * * *' })
        }]
      },
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'creata' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'crea una routine', emit)
    expect(h.db.routines).toHaveLength(1)
    expect(h.db.routines[0]).toMatchObject({ title: 'Monitor', enabled: 0, provenance: 'agent' })
    expect(h.db.entries.some((e) => e.kind === 'approval')).toBe(false)
    const ev = h.db.entries.find((e) => e.kind === 'event' && e.meta?.automation)
    expect(ev?.content).toBe('Routine creata (in pausa): Monitor')
    expect(ev?.meta?.automation).toMatchObject({ action: 'create', name: 'Monitor' })
  })

  it('resume: approval con nome e schedule in linguaggio naturale; allow → attivata con evento', async () => {
    h.db.routines.push({ id: 3, agent_id: AGENT, title: 'Backup', prompt: 'backuppa tutto', schedule: '30 8 * * 1-5', enabled: 0 })
    h.llm.queue = [
      { toolCalls: [{ id: 'u1', name: 'update_state', arguments: JSON.stringify({ target: 'routine', action: 'resume', id: 3 }) }] },
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'attivata' }) }] },
      { text: '.' }
    ]
    const turn = runTurn(AGENT, 'attivala', emit)
    await vi.waitFor(() => expect(h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBeTruthy())
    const appr = h.db.entries.find((e) => e.kind === 'approval')!
    expect(appr.content).toContain('Backup')
    expect(appr.content).toContain('giorni feriali')
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'allow', 'once')
    await turn
    expect(h.db.routines[0]!.enabled).toBe(1)
    const ev = h.db.entries.find((e) => e.kind === 'event' && (e.meta?.automation as { action?: string } | undefined)?.action === 'resume')
    expect(ev?.content).toBe('Routine attivata: Backup')
  })

  it('cron non valido: errore leggibile al modello, routine non creata, turno prosegue', async () => {
    h.llm.queue = [
      {
        toolCalls: [{
          id: 'u1', name: 'update_state',
          arguments: JSON.stringify({ target: 'routine', action: 'create', name: 'Sbagliata', prompt: 'x', schedule: 'mai' })
        }]
      },
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'schedule errata' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'crea routine sbagliata', emit)
    expect(h.db.routines).toHaveLength(0)
    expect(h.db.entries.some((e) => e.kind === 'tool-result' && e.content.includes('Schedule non valida'))).toBe(true)
    // il modello vede l'errore come tool result nella chiamata successiva
    const secondCall = h.llm.calls[1]!
    expect(secondCall.some((m) => m.role === 'tool' && m.content.includes('Schedule non valida'))).toBe(true)
  })
})

describe('fase 4: compaction della history nel loop', () => {
  it('sopra soglia: prima chiamata = riassunto (senza tool), il summary entra nella history', async () => {
    h.db.settings.set('contextBudgetTokens', { 'prov/m1': 400 })
    h.llm.queue = [
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'primo' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'primo messaggio', emit)
    h.db.entries.push({ id: h.db.nextId++, agentId: AGENT, kind: 'thinking', role: 'assistant', content: 'z'.repeat(4000), meta: null, createdAt: 1 })

    h.llm.queue = [
      async (msgs: Array<{ role: string; content: string }>, tools: unknown[]) => {
        expect(tools).toHaveLength(0) // la chiamata di compaction non ha tool
        expect(msgs).toHaveLength(1) // un solo messaggio utente: il digest
        expect(msgs[0]!.content).toContain('primo messaggio')
        return { text: "RIEPILOGO: l'utente ha chiesto il primo messaggio." }
      },
      { toolCalls: [{ id: 's2', name: 'send_to_user', arguments: JSON.stringify({ text: 'secondo' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'secondo messaggio', emit)

    const summary = h.db.entries.find((e) => e.kind === 'summary')
    expect(summary?.content).toContain('RIEPILOGO')
    expect(typeof summary?.meta?.coversUpTo).toBe('number')
    // alla chiamata del turno (l'ultima meno una: system + summary + user):
    // c'è il riepilogo, non c'è più il thinking enorme
    const turnCall = h.llm.calls.at(-2)!
    expect(turnCall.some((m) => m.content.includes('RIEPILOGO'))).toBe(true)
    expect(turnCall.some((m) => m.content.includes('z'.repeat(50)))).toBe(false)
  })

  it('riassunto che fallisce: nessun summary e il turno gira lo stesso (fallback)', async () => {
    h.db.settings.set('contextBudgetTokens', { 'prov/m1': 400 })
    h.llm.queue = [
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'primo' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'primo messaggio', emit)
    h.db.entries.push({ id: h.db.nextId++, agentId: AGENT, kind: 'thinking', role: 'assistant', content: 'z'.repeat(4000), meta: null, createdAt: 1 })

    h.llm.queue = [
      async () => { throw new Error('riassunto giù') },
      { toolCalls: [{ id: 's2', name: 'send_to_user', arguments: JSON.stringify({ text: 'secondo' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'secondo messaggio', emit)
    expect(h.db.entries.some((e) => e.kind === 'summary')).toBe(false)
    // entrambi i turni sono girati lo stesso (2 chiamate ciascuno)
    expect(h.llm.calls.filter((c) => c.length > 1)).toHaveLength(4)
  })
})

describe('fase 5: funnel dei connettori (offer_connector) e card Riconnetti', () => {
  it('offer_connector → entry send-message type connector, NESSUNA connessione automatica', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'oc1', name: 'offer_connector', arguments: JSON.stringify({ id: 'gmail', reason: 'per riassumerti le email in arrivo' }) }] },
      { text: 'fatto' }
    ]
    await runTurn(AGENT, 'ricordami le email', emit)

    const offer = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(offer.meta?.message).toMatchObject({
      type: 'connector', connectorId: 'gmail', name: 'Gmail', reason: 'per riassumerti le email in arrivo'
    })
    expect(offer.meta?.status).toBe('pending')
    // nessuna chiamata ai connettori: la connessione parte SOLO dal click utente
    expect(h.mcp.calls).toBe(0)
    // al modello torna la spiegazione del funnel (nella chiamata SUCCESSIVA)
    const second = h.llm.calls[1]!
    expect(second.some((m) => m.role === 'tool' && String(m.content).includes("offerta mostrata"))).toBe(true)
    expect(h.db.entries.findLast((e) => e.kind === 'event')?.meta?.turnEnd).toBe('FINISHED')
  })

  it('offer_connector con id inesistente → tool-result di errore, nessuna entry', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'oc2', name: 'offer_connector', arguments: JSON.stringify({ id: 'inesistente', reason: 'x' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'collega', emit)
    // nessuna CARD connector (il fallback di recupero può creare una send-message di testo)
    expect(h.db.entries.some((e) => (e.meta?.message as { type?: string } | undefined)?.type === 'connector')).toBe(false)
    const second = h.llm.calls[1]!
    expect(second.some((m) => m.role === 'tool' && String(m.content).includes('search_connectors'))).toBe(true)
  })

  it('search_connectors è SEMPRE consentito (lettura del catalogo, nessuna approval)', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'sc1', name: 'search_connectors', arguments: JSON.stringify({ query: 'gmail' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'cosa puoi collegare', emit)
    // eseguito come tool normale SENZA approval entry
    expect(h.db.entries.some((e) => e.kind === 'approval')).toBe(false)
    expect(h.db.entries.some((e) => e.kind === 'tool-call' && e.content === 'search_connectors')).toBe(true)
    const result = h.db.entries.find((e) => e.kind === 'tool-result' && e.meta?.callId === 'sc1')
    expect(result?.content).toContain('Gmail')
  })

  it('tool MCP con token scaduto → tool-result con meta.needsReconnect e card connector (needsAuth)', async () => {
    class FakeReconnectError extends Error {
      constructor(
        public serverName: string,
        public serverId: string
      ) {
        super('Il connettore "FakeApp" richiede la riconnessione')
      }
    }
    // il mock mcp espone la classe e fallisce con l'errore di riconnessione
    ;(mcpMock as unknown as Record<string, unknown>).McpNeedsReconnectError = FakeReconnectError
    const prevCallTool = (mcpMock as unknown as { callTool: unknown }).callTool
    ;(mcpMock as unknown as { callTool: unknown }).callTool = async () => {
      throw new FakeReconnectError('FakeApp', 'fake')
    }
    // i tool mcp__ passano il gate senza approval (regola del mock db)
    h.db.settings.set('permissions', { default: 'needs_approval', rules: [{ tool: 'mcp__*', pattern: '*', mode: 'always_allow' }] })
    h.llm.queue = [
      { toolCalls: [{ id: 'mc1', name: 'mcp__fake__search', arguments: '{}' }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'cerca', emit)

    const result = h.db.entries.find((e) => e.kind === 'tool-result' && e.meta?.callId === 'mc1')
    expect(result?.meta?.needsReconnect).toEqual({ serverName: 'FakeApp', connectorId: 'fake' })
    const card = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(card.meta?.message).toMatchObject({ type: 'connector', connectorId: 'fake', name: 'FakeApp' })
    expect(card.meta?.needsAuth).toBe(true)
    // ripristino del mock
    ;(mcpMock as unknown as { callTool: unknown }).callTool = prevCallTool
  })
})

// ---- fase 6: outbox — i send_to_user non urgenti dei turni AUTOMATICI ----

describe('fase 6: outbox dei turni automatici', () => {
  const mkSend = (id: string, args: string): FakeToolCall => ({ id, name: 'send_to_user', arguments: args })

  it('turno routine con send_to_user non urgente: entry trattenuta (meta.held) e in outbox', async () => {
    h.llm.queue = [
      { toolCalls: [mkSend('s1', '{"text":"riepilogo notturno"}')] },
      { text: 'fatto' }
    ]
    await runTurn(AGENT, '[routine] notturna', emit, undefined, { source: 'routine', title: 'Notturna' })
    const send = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(send.meta?.held).toBe(true)
    expect(h.db.outbox).toEqual([{ entry_id: send.id, agent_id: AGENT, created_at: send.createdAt }])
    // al modello è stato detto che la consegna è rinviata
    const lastCall = h.llm.calls[h.llm.calls.length - 1]!
    const toolResults = lastCall.filter((m) => m.role === 'tool')
    expect(toolResults.some((m) => String(m.content).includes('finestra di consegna'))).toBe(true)
    // nessun evento di notifica done: l'utente non ha visto nulla
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'FINISHED')).toBe(true)
  })

  it('urgent bypassa l\'outbox: entry visibile subito e notifica agent-done', async () => {
    h.llm.queue = [
      { toolCalls: [mkSend('s2', '{"text":"servono le credenziali SCADUTE","urgent":true}')] },
      { text: 'ok' }
    ]
    const events: import('../../../shared/types').SandbotEvent[] = []
    await runTurn(AGENT, '[routine] urgente', emit, undefined, { source: 'routine', title: 'Urgente' })
    void events
    const send = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(send.meta?.held).toBeUndefined()
    expect(h.db.outbox).toHaveLength(0)
  })

  it('fase 7 (residuo 0b): nei turni automatici solo il PRIMO urgent passa, i successivi sono trattenuti', async () => {
    // fase 9 (0d): più send di FILA senza lavoro in mezzo non si consegnano,
    // quindi il secondo urgent arriva dopo un tool di lavoro
    h.llm.queue = [
      { toolCalls: [mkSend('u1', '{"text":"primo: agisci entro stasera","urgent":true}')] },
      { toolCalls: [{ id: 'lc1', name: 'list-credentials', arguments: '{}' }, mkSend('u2', '{"text":"secondo: altro avviso","urgent":true}')] },
      { text: 'fatto' }
    ]
    await runTurn(AGENT, '[routine] due urgent', emit, undefined, { source: 'routine', title: 'Urgentissime' })
    const sends = h.db.entries.filter((e) => e.kind === 'send-message')
    expect(sends).toHaveLength(2)
    expect(sends[0]!.meta?.held).toBeUndefined() // il primo urgent passa subito
    expect((sends[0]!.meta?.message as { urgent?: boolean }).urgent).toBe(true)
    // il secondo urgent diventa NON urgente e finisce in outbox
    expect(sends[1]!.meta?.held).toBe(true)
    expect((sends[1]!.meta?.message as { urgent?: boolean }).urgent).toBeUndefined()
    expect(h.db.outbox).toEqual([
      { entry_id: sends[1]!.id, agent_id: AGENT, created_at: sends[1]!.createdAt }
    ])
  })

  it('fase 7 (residuo 0b): nei turni UTENTE più urgent restano urgent (l\'outbox non c\'entra)', async () => {
    // fase 9 (0d): le due send sono separate da un tool di lavoro (senza, la
    // seconda non verrebbe consegnata: vedi il blocco fase 9 qui sotto)
    h.llm.queue = [
      { toolCalls: [mkSend('v1', '{"text":"uno","urgent":true}')] },
      { toolCalls: [{ id: 'lc2', name: 'list-credentials', arguments: '{}' }, mkSend('v2', '{"text":"due","urgent":true}')] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'domanda con urgenze', emit)
    const sends = h.db.entries.filter((e) => e.kind === 'send-message')
    expect(sends).toHaveLength(2)
    expect(sends.every((s) => s.meta?.held === undefined)).toBe(true)
    expect((sends[1]!.meta?.message as { urgent?: boolean }).urgent).toBe(true)
  })

  it('i turni avviati dall\'utente NON passano mai dall\'outbox', async () => {
    h.llm.queue = [
      { toolCalls: [mkSend('s3', '{"text":"ecco la risposta"}')] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'domanda normale', emit)
    const send = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(send.meta?.held).toBeUndefined()
    expect(h.db.outbox).toHaveLength(0)
  })

  it('i widget ask_user dei turni routine non vengono trattenuti (interattivi)', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'w1', name: 'ask_user', arguments: '{"prompt":"procedo?","options":[{"label":"Sì"}]}' }] }
    ]
    await runTurn(AGENT, '[routine] con domanda', emit, undefined, { source: 'routine', title: 'Domanda' })
    const widget = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(widget.meta?.message).toMatchObject({ type: 'widget' })
    expect(widget.meta?.held).toBeUndefined()
    expect(h.db.outbox).toHaveLength(0)
  })
})

// ---- fase 7 (§3bis L8): messaggi tra agenti ----

describe('fase 7: send_to_agent', () => {
  const OTHER = 'agent_other'

  beforeEach(() => {
    h.db.agents.set(OTHER, {
      id: OTHER, name: 'Specialista', description: 'smista la posta', providerId: 'prov', model: 'm1',
      status: 'idle', unread: 0, createdAt: 2
    })
  })

  it('accoda un job user-message sul destinatario con initiator AGENT, from e hop', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'a1', name: 'send_to_agent', arguments: JSON.stringify({ agentId: OTHER, text: 'controlla la posta di stamattina' }) }] },
      { text: 'delegato' }
    ]
    await runTurn(AGENT, 'occupatene tu', emit)
    expect(h.db.jobs).toHaveLength(1)
    const job = h.db.jobs[0]!
    expect(job.agentId).toBe(OTHER)
    expect(job.kind).toBe('user-message')
    expect(job.payload.initiator).toBe('AGENT')
    expect(job.payload.fromAgentId).toBe(AGENT)
    expect(job.payload.fromAgentName).toBe('TestBot')
    expect(job.payload.toAgentId).toBe(OTHER)
    expect(job.payload.hop).toBe(1)
    // il testo entra nel blocco evidenza col nome del mittente
    expect(String(job.payload.text)).toContain('<messaggio_da_agente nome="TestBot">')
    expect(String(job.payload.text)).toContain('controlla la posta di stamattina')
    // al modello: conferma leggibile
    const lastCall = h.llm.calls[h.llm.calls.length - 1]!
    const toolResults = lastCall.filter((m) => m.role === 'tool')
    expect(toolResults.some((m) => String(m.content).includes('in coda per Specialista'))).toBe(true)
  })

  it('destinatario inesistente o se stesso: errore leggibile, NESSUN job', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'a2', name: 'send_to_agent', arguments: JSON.stringify({ agentId: 'agent_manca', text: 'ciao' }) }] },
      { toolCalls: [{ id: 'a3', name: 'send_to_agent', arguments: JSON.stringify({ agentId: AGENT, text: 'a me stesso' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'prova destinazioni', emit)
    expect(h.db.jobs).toHaveLength(0)
    const lastCall = h.llm.calls[h.llm.calls.length - 1]!
    const toolResults = lastCall.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(toolResults.some((c) => c.includes('list_agents'))).toBe(true)
    expect(toolResults.some((c) => c.includes('te stesso'))).toBe(true)
  })

  it('hop massimo: il destinatario di un messaggio a hop 3 non genera altri messaggi', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'h3', name: 'send_to_agent', arguments: JSON.stringify({ agentId: OTHER, text: 'ancora un giro' }) }] },
      { text: 'ok' }
    ]
    // questo turno è stato aperto da un messaggio a hop 3: niente più rimbalzi
    await runTurn(AGENT, 'messaggio da altro bot', emit, undefined, {
      agentMessage: { fromAgentId: OTHER, fromAgentName: 'Specialista', hop: 3 }
    })
    expect(h.db.jobs).toHaveLength(0)
    const lastCall = h.llm.calls[h.llm.calls.length - 1]!
    const toolResults = lastCall.filter((m) => m.role === 'tool')
    expect(toolResults.some((m) => String(m.content).includes('hop massimo 3'))).toBe(true)
  })

  it('limite per ora: oltre 10 messaggi tra la stessa coppia, rifiuto senza accodare', async () => {
    // 10 messaggi tra la coppia nell'ultima ora nel transcript del destinatario
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      h.db.entries.push({
        id: h.db.nextId++, agentId: OTHER, kind: 'message', role: 'user',
        content: 'msg', createdAt: now - 60_000,
        meta: { initiator: 'AGENT', fromAgentId: AGENT, fromAgentName: 'TestBot', toAgentId: OTHER, hop: 1 }
      })
    }
    h.llm.queue = [
      { toolCalls: [{ id: 'a4', name: 'send_to_agent', arguments: JSON.stringify({ agentId: OTHER, text: 'uno in più' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'ancora', emit)
    expect(h.db.jobs).toHaveLength(0)
    const lastCall = h.llm.calls[h.llm.calls.length - 1]!
    const toolResults = lastCall.filter((m) => m.role === 'tool')
    expect(toolResults.some((m) => String(m.content).includes('ultima ora'))).toBe(true)
  })

  it('il messaggio di un altro bot apre il turno con meta fromAgentId/hop (entry non scritta dall\'utente)', async () => {
    h.llm.queue = [{ text: 'ricevuto' }]
    await runTurn(AGENT, 'blocco evidenza', emit, undefined, {
      initiator: 'AGENT',
      agentMessage: { fromAgentId: OTHER, fromAgentName: 'Specialista', hop: 2 }
    })
    const msg = h.db.entries.find((e) => e.kind === 'message' && e.role === 'user')!
    expect(msg.meta).toMatchObject({ initiator: 'AGENT', fromAgentId: OTHER, fromAgentName: 'Specialista', toAgentId: AGENT, hop: 2 })
  })

  it('il kickstart TEMPLATE_IMPORT apre il turno con initiator e templateName (per la riga espandibile della UI)', async () => {
    h.llm.queue = [{ text: 'ok' }]
    await runTurn(AGENT, 'configurati', emit, undefined, {
      initiator: 'TEMPLATE_IMPORT', extraMeta: { templateName: 'Monitor delle menzioni' }
    })
    const msg = h.db.entries.find((e) => e.kind === 'message' && e.role === 'user')!
    expect(msg.meta).toMatchObject({ initiator: 'TEMPLATE_IMPORT', templateName: 'Monitor delle menzioni' })
  })

  it('il bot principale ha la sezione di coordinamento con gli altri bot (nome, ruolo, routine attive)', async () => {
    h.db.settings.set('mainAgentId', AGENT)
    h.db.routines.push({ id: 9, agent_id: OTHER, title: 'Sgocciolaggio posta', prompt: 'p', schedule: '0 9 * * *', enabled: 1 })
    h.llm.queue = [
      (msgs: Array<{ role: string; content: string }>) => {
        const system = String(msgs[0]!.content)
        // il system del bot principale elenca gli altri bot con le routine attive
        expect(system).toContain('punto di contatto principale')
        expect(system).toContain('Specialista')
        expect(system).toContain('smista la posta')
        expect(system).toContain('Sgocciolaggio posta')
        return { text: 'ok' }
      }
    ]
    await runTurn(AGENT, 'chi c\'è?', emit)
  })

  it('un bot NON principale non ha la sezione di coordinamento', async () => {
    h.db.settings.set('mainAgentId', OTHER)
    h.llm.queue = [
      (msgs: Array<{ role: string; content: string }>) => {
        expect(String(msgs[0]!.content)).not.toContain('punto di contatto principale')
        return { text: 'ok' }
      }
    ]
    await runTurn(AGENT, 'normale', emit)
  })

  // ---- correzioni review fase 7 (A1/A2/A3/A5) ----

  it('correzione A1: 11 send_to_agent nella stessa risposta → 10 accodati, l\'11° errore e nessun accodamento', async () => {
    const calls = Array.from({ length: 11 }, (_, i) => ({
      id: `m${i + 1}`, name: 'send_to_agent',
      arguments: JSON.stringify({ agentId: OTHER, text: `msg ${i + 1}` })
    }))
    h.llm.queue = [{ toolCalls: calls }, { text: 'ok' }, { toolCalls: [{ id: 'r1', name: 'send_to_user', arguments: JSON.stringify({ text: 'ho delegato a Specialista' }) }] }]
    await runTurn(AGENT, 'delega a raffica', emit)
    expect(h.db.jobs).toHaveLength(10)
    // fase 8 (residuo 0a): le deleghe non sono messaggi all'utente → la
    // chiamata di recupero PARTE anche in un turno che ha solo delegato
    // (terza chiamata); i tool result delle 11 call stanno nella seconda
    expect(h.llm.calls).toHaveLength(3)
    const toolResults = h.llm.calls[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(toolResults.filter((c) => c.includes('in coda per Specialista'))).toHaveLength(10)
    expect(toolResults.some((c) => c.includes('ultima ora'))).toBe(true)
  })

  it('correzione A1: la coda del destinatario ha lo stesso tetto dei messaggi utente (10 in attesa → rifiuto, niente entry)', async () => {
    // 10 messaggi utente normali già in coda per il destinatario
    for (let i = 0; i < 10; i++) {
      h.db.jobs.push({ id: i + 1, agentId: OTHER, kind: 'user-message', payload: { text: `coda ${i}` }, createdAt: Date.now(), status: 'queued' })
    }
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'send_to_agent', arguments: JSON.stringify({ agentId: OTHER, text: 'un altro' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'delega', emit)
    expect(h.db.jobs).toHaveLength(10) // nessun job nuovo
    expect(h.db.entries.some((e) => e.meta?.agentSend)).toBe(false) // nemmeno la traccia A2
    const toolResults = h.llm.calls[h.llm.calls.length - 1]!.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(toolResults.some((c) => c.includes('Coda piena per Specialista'))).toBe(true)
  })

  it('correzione A2: la delega lascia una entry "A <nome>" dal mittente, e il turno dopo vede chiamata+esito', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 't1', name: 'send_to_agent', arguments: JSON.stringify({ agentId: OTHER, text: 'controlla la posta di stamattina' }) }] },
      { text: 'delegato' }
    ]
    await runTurn(AGENT, 'occupatene tu', emit)
    const sent = h.db.entries.find((e) => e.kind === 'send-message' && e.meta?.agentSend)!
    expect(sent.content).toBe('controlla la posta di stamattina')
    expect(sent.meta).toMatchObject({
      toAgentId: OTHER, toAgentName: 'Specialista', hop: 1,
      call: { id: 't1', name: 'send_to_agent' }
    })

    // il turno successivo del mittente: buildMessages riporta la coppia
    // chiamata/risultato (sa di aver delegato, non riceve risposte "dal nulla")
    h.llm.queue = [
      { toolCalls: [{ id: 't2', name: 'send_to_user', arguments: JSON.stringify({ text: 'in attesa del gestore' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'e adesso?', emit)
    // la prima chiamata del SECONDO turno: quella che contiene il nuovo messaggio utente
    const second = h.llm.calls.find((c) => c.some((m) => m.role === 'user' && m.content === 'e adesso?'))!
    const call = second.flatMap((m) => (m.toolCalls as FakeToolCall[] | undefined) ?? []).find((tc) => tc?.name === 'send_to_agent')
    expect(call).toBeTruthy()
    const result = second.find((m) => m.role === 'tool' && m.toolCallId === call!.id)
    expect(String(result?.content)).toContain('in coda per Specialista')
    expect(String(result?.content)).toContain('non vede questa conversazione')
  })

  it('correzione A3: la catena partita da una routine è automatica — payload automatic, outbox e un solo urgent per il destinatario', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'r1', name: 'send_to_agent', arguments: JSON.stringify({ agentId: OTHER, text: 'controlla la posta' }) }] },
      { text: 'delegato' }
    ]
    await runTurn(AGENT, '[routine] notturna', emit, undefined, { source: 'routine', title: 'Notturna' })
    expect(h.db.jobs[0]!.payload.automatic).toBe(true)

    // il turno del destinatario, aperto dal job automatico: send_to_user come
    // nei turni di routine (outbox + al massimo un urgent); fase 9 (0d): più
    // send di fila senza lavoro non si consegnano, quindi un lavoro le separa
    h.llm.queue = [
      { toolCalls: [
        { id: 'b0', name: 'list-credentials', arguments: '{}' },
        { id: 'b1', name: 'send_to_user', arguments: JSON.stringify({ text: 'riepilogo notturno' }) }
      ] },
      { toolCalls: [
        { id: 'b0b', name: 'list-credentials', arguments: '{}' },
        { id: 'b2', name: 'send_to_user', arguments: JSON.stringify({ text: 'primo urgent', urgent: true }) }
      ] },
      { toolCalls: [
        { id: 'b0c', name: 'list-credentials', arguments: '{}' },
        { id: 'b3', name: 'send_to_user', arguments: JSON.stringify({ text: 'secondo urgent', urgent: true }) }
      ] },
      { text: 'fatto' }
    ]
    await runTurn(OTHER, '<messaggio_da_agente nome="TestBot">controlla la posta</messaggio_da_agente>', emit, undefined, {
      agentMessage: { fromAgentId: AGENT, fromAgentName: 'TestBot', hop: 1 }, automatic: true
    })
    const sends = h.db.entries.filter((e) => e.agentId === OTHER && e.kind === 'send-message')
    expect(sends).toHaveLength(3)
    expect(sends[0]!.meta?.held).toBe(true) // non urgent → outbox
    expect(sends[1]!.meta?.held).toBeUndefined() // il primo urgent passa subito
    expect(sends[2]!.meta?.held).toBe(true) // il secondo urgent viene trattenuto
    expect(h.db.outbox.filter((o) => o.agent_id === OTHER)).toHaveLength(2)
  })

  it('correzione A3: la catena partita da un messaggio dell\'utente resta immediata', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'u1', name: 'send_to_agent', arguments: JSON.stringify({ agentId: OTHER, text: 'controlla' }) }] },
      { text: 'delegato' }
    ]
    await runTurn(AGENT, 'occupatene tu', emit) // turno utente: catena NON automatica
    expect(h.db.jobs[0]!.payload.automatic).toBeUndefined()

    h.llm.queue = [
      { toolCalls: [{ id: 'b1', name: 'send_to_user', arguments: JSON.stringify({ text: 'risposta immediata' }) }] },
      { text: '.' }
    ]
    await runTurn(OTHER, '<messaggio_da_agente nome="TestBot">controlla</messaggio_da_agente>', emit, undefined, {
      agentMessage: { fromAgentId: AGENT, fromAgentName: 'TestBot', hop: 1 }
    })
    const send = h.db.entries.find((e) => e.agentId === OTHER && e.kind === 'send-message')!
    expect(send.meta?.held).toBeUndefined()
    expect(h.db.outbox).toHaveLength(0)
  })

  it('correzione A5: provenance template accettata SOLO nel turno di kickstart (TEMPLATE_IMPORT)', async () => {
    const create = (id: string): FakeToolCall => ({
      id, name: 'update_state',
      arguments: JSON.stringify({ target: 'routine', action: 'create', name: 'Da template', prompt: 'p', schedule: '0 9 * * *', provenance: 'template' })
    })
    h.llm.queue = [{ toolCalls: [create('k1')] }, { text: '.' }]
    await runTurn(AGENT, 'configurati', emit, undefined, { initiator: 'TEMPLATE_IMPORT' })
    h.llm.queue = [{ toolCalls: [create('k2')] }, { text: '.' }]
    await runTurn(AGENT, 'creami una routine', emit) // turno utente normale
    expect(h.db.routines).toHaveLength(2)
    expect(h.db.routines[0]).toMatchObject({ title: 'Da template', provenance: 'template', enabled: 0 })
    // stessa chiamata fuori dal kickstart: la routine è dell'agente
    expect(h.db.routines[1]).toMatchObject({ provenance: 'agent' })
  })
})

// ---- fase 8 (punto 1): auto-review delle approvazioni ----

const AR_RULE = 'comandi ls e cat dentro la home del bot'
const AR_DRAFT_RULE = 'email in uscita verso team@example.com'

function enableAutoReview(over: Partial<{ enabled: boolean; allowRules: string[]; blockRules: string[]; providerId: string; model: string }> = {}): void {
  h.db.settings.set('autoReview', {
    enabled: true, allowRules: [AR_RULE], blockRules: [],
    providerId: 'prov', model: 'm1', ...over
  })
}

/** Risposta del revisore che approva citando la regola. */
function reviewerAllow(rule: string): void {
  h.llm.reviewer = {
    toolCalls: [{ id: 'rd1', name: 'report_decision', arguments: JSON.stringify({ decision: 'allow', ruleMatched: rule, reason: 'regola rispettata' }) }]
  }
}

describe('fase 8 (punto 1): auto-review delle approvazioni', () => {
  it('regola allow → il comando passa SENZA card, entry approval compressa con autoApproved e regola', async () => {
    enableAutoReview()
    reviewerAllow(AR_RULE)
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'ls -la' }) }] },
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'fatto' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'elenca i file', emit)
    expect(h.sandboxMock.exec.calls).toBe(1)
    const approvals = h.db.entries.filter((e) => e.kind === 'approval')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!.meta).toMatchObject({ autoApproved: true, ruleMatched: AR_RULE, status: 'allowed' })
    // entry chiusa: niente approvalId da cliccare
    expect(approvals[0]!.meta?.approvalId).toBeUndefined()
    // il revisore ha visto SOLO regole e azione (nessun messaggio del transcript)
    const reviewerCall = h.llm.calls.find((c) => c.length === 1 && c[0]!.role === 'user' && c[0]!.content.includes('<azione>'))!
    expect(reviewerCall[0]!.content).toContain(AR_RULE)
    expect(reviewerCall[0]!.content).toContain('elenca i file'.length > 0 ? 'tool: run-command' : '')
    expect(reviewerCall[0]!.content).not.toContain('elenca i file')
  })

  it('revisore che chiede conferma (ask) → la card resta come senza auto-review', async () => {
    enableAutoReview()
    h.llm.reviewer = { toolCalls: [{ id: 'rd1', name: 'report_decision', arguments: JSON.stringify({ decision: 'ask', reason: 'nessuna regola corrisponde' }) }] }
    h.llm.queue = [{ toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'ls' }) }] }]
    const turn = runTurn(AGENT, 'vai', emit)
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBe(true)
    })
    const appr = h.db.entries.findLast((e) => e.kind === 'approval')!
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'deny', 'once')
    await turn
    expect(h.sandboxMock.exec.calls).toBe(0)
    expect(appr.meta?.autoApproved).toBeUndefined()
  })

  it('esclusione: turno aperto da un ALTRO BOT — anche col revisore favorevole resta card', async () => {
    enableAutoReview()
    reviewerAllow(AR_RULE)
    h.llm.queue = [{ toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'ls' }) }] }, { text: 'ok' }]
    const turn = runTurn(AGENT, '<messaggio_da_agente nome="Altro">controlla</messaggio_da_agente>', emit, undefined, {
      agentMessage: { fromAgentId: 'agent_o', fromAgentName: 'Altro', hop: 1 }, initiator: 'AGENT'
    })
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBe(true)
    })
    const appr = h.db.entries.findLast((e) => e.kind === 'approval')!
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'deny', 'once')
    await turn
    expect(h.sandboxMock.exec.calls).toBe(0)
    expect(appr.meta?.autoApproved).toBeUndefined()
  })

  it('esclusione: comando never-auto (bash -c) resta card anche col revisore favorevole', async () => {
    enableAutoReview()
    reviewerAllow(AR_RULE)
    h.llm.queue = [{ toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'bash -c ls' }) }] }, { text: 'ok' }]
    const turn = runTurn(AGENT, 'vai', emit)
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBe(true)
    })
    const appr = h.db.entries.findLast((e) => e.kind === 'approval')!
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'deny', 'once')
    await turn
    expect(h.sandboxMock.exec.calls).toBe(0)
  })

  it('esclusione: update_state su routine attiva resta card anche col revisore favorevole', async () => {
    enableAutoReview()
    reviewerAllow(AR_RULE)
    h.db.routines.push({ id: 1, agent_id: AGENT, title: 'Riepilogo', prompt: 'p', schedule: '0 9 * * *', enabled: 1 })
    h.llm.queue = [{ toolCalls: [{ id: 'c1', name: 'update_state', arguments: JSON.stringify({ target: 'routine', action: 'resume', id: 1 }) }] }, { text: 'ok' }]
    const turn = runTurn(AGENT, 'attiva la routine', emit)
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBe(true)
    })
    const appr = h.db.entries.findLast((e) => e.kind === 'approval')!
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'deny', 'once')
    await turn
    expect(h.db.routines[0]!.enabled).toBe(1)
  })

  it('bozza: regola allow → inviata automaticamente (via il gate, tracciata con la regola)', async () => {
    enableAutoReview({ allowRules: [AR_DRAFT_RULE] })
    reviewerAllow(AR_DRAFT_RULE)
    h.llm.queue = [
      {
        toolCalls: [{
          id: 'd1', name: 'draft_external',
          arguments: JSON.stringify({
            channel: 'email', to: 'team@example.com', subject: 'report', body: 'ecco il report',
            via: { tool: 'mcp__gmail__send_message', args: { to: 'team@example.com', body: 'ecco il report' } }
          })
        }]
      },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'manda il report', emit)
    expect(h.mcp.calls).toBe(1)
    const draft = h.db.entries.find((e) => e.kind === 'send-message' && (e.meta?.message as { type?: string } | undefined)?.type === 'draft')!
    expect(draft.meta?.status).toBe('sent')
    expect(draft.meta).toMatchObject({ autoApproved: true, ruleMatched: AR_DRAFT_RULE })
    // il modello sa che l'invio è avvenuto per la regola (l'ultima chiamata è
    // il proseguimento: in mezzo c'è anche la chiamata del revisore)
    const last = h.llm.calls[h.llm.calls.length - 1]!
    const results = last.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results.some((c) => c.includes('INVIATA automaticamente'))).toBe(true)
  })

  it('bozza che non rispetta le regole → resta card (nessun invio)', async () => {
    enableAutoReview({ allowRules: [AR_DRAFT_RULE] })
    h.llm.reviewer = { toolCalls: [{ id: 'rd1', name: 'report_decision', arguments: JSON.stringify({ decision: 'ask' }) }] }
    h.llm.queue = [
      {
        toolCalls: [{
          id: 'd1', name: 'draft_external',
          arguments: JSON.stringify({
            channel: 'email', to: 'estraneo@example.com', body: 'ciao',
            via: { tool: 'mcp__gmail__send_message', args: { to: 'estraneo@example.com', body: 'ciao' } }
          })
        }]
      },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'manda', emit)
    expect(h.mcp.calls).toBe(0)
    const draft = h.db.entries.find((e) => e.kind === 'send-message' && (e.meta?.message as { type?: string } | undefined)?.type === 'draft')!
    expect(draft.meta?.status).toBe('pending')
    expect(draft.meta?.autoApproved).toBeUndefined()
  })

  it('propose_rule_change: card con la regola proposta, NIENTE salvato nei settings', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'pr1', name: 'propose_rule_change', arguments: JSON.stringify({ kind: 'allow', text: 'leggere le email di lavoro', why: 'le approvi sempre di persona' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'proponi una regola', emit)
    const proposal = h.db.entries.find((e) => e.kind === 'send-message' && (e.meta?.message as { type?: string } | undefined)?.type === 'rule')!
    expect(proposal.meta?.message).toMatchObject({ type: 'rule', kind: 'allow', text: 'leggere le email di lavoro', why: 'le approvi sempre di persona' })
    // la regola si salva SOLO al click: nessun setting è stato toccato
    expect(h.db.settings.has('autoReview')).toBe(false)
    const results = h.llm.calls[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results.some((c) => c.includes('solo se lui la accetta'))).toBe(true)
  })
})

// ---- fase 8 (punto 2): "Consenti per questo turno" ----

describe('fase 8 (punto 2): Consenti per questo turno', () => {
  it('la stessa chiave del gate non chiede più fino a fine turno; una chiave diversa chiede di nuovo', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'a1', name: 'run-command', arguments: JSON.stringify({ command: 'ls' }) }] },
      { toolCalls: [{ id: 'a2', name: 'run-command', arguments: JSON.stringify({ command: 'ls' }) }] },
      { toolCalls: [{ id: 'a3', name: 'run-command', arguments: JSON.stringify({ command: 'cat pippo.txt' }) }] },
      { text: 'fatto' }
    ]
    const turn = runTurn(AGENT, 'vai', emit)
    // prima card (ls): consenti PER QUESTO TURNO
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBe(true)
    })
    const first = h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')!
    resolveApproval(AGENT, String(first.meta?.approvalId), 'allow', 'turn')
    // il secondo ls NON chiede (stessa chiave 'ls'); il cat sì (chiave diversa)
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending' &&
        String((e.meta?.input as { command?: string } | undefined)?.command ?? '').startsWith('cat'))).toBe(true)
    })
    const second = h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending' && String((e.meta?.input as { command?: string })?.command ?? '').startsWith('cat'))!
    resolveApproval(AGENT, String(second.meta?.approvalId), 'allow', 'once')
    await turn
    // una card sola per 'ls' (la seconda identica è passata), due in totale
    const approvals = h.db.entries.filter((e) => e.kind === 'approval')
    expect(approvals).toHaveLength(2)
    // tutti e tre i comandi eseguiti
    expect(h.sandboxMock.exec.calls).toBe(3)
  })

  it('la grant di turno NON si persiste: il turno dopo chiede di nuovo', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'a1', name: 'run-command', arguments: JSON.stringify({ command: 'ls' }) }] },
      { text: 'ok' }
    ]
    const turn = runTurn(AGENT, 'vai', emit)
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending')).toBe(true)
    })
    resolveApproval(AGENT, String(h.db.entries.findLast((e) => e.kind === 'approval')!.meta?.approvalId), 'allow', 'turn')
    await turn
    expect(h.db.grants).toEqual([]) // niente standing grant nel DB
    // secondo turno, stesso comando: la card torna (la grant era solo di turno)
    h.llm.queue = [{ toolCalls: [{ id: 'b1', name: 'run-command', arguments: JSON.stringify({ command: 'ls' }) }] }]
    const turn2 = runTurn(AGENT, 'ancora', emit)
    await vi.waitFor(() => {
      // due approval in totale (una per turno): quella del secondo turno pendente
      expect(h.db.entries.filter((e) => e.kind === 'approval')).toHaveLength(2)
      expect(h.db.entries.findLast((e) => e.kind === 'approval')!.meta?.status).toBe('pending')
    })
    resolveApproval(AGENT, String(h.db.entries.findLast((e) => e.kind === 'approval')!.meta?.approvalId), 'deny', 'once')
    await turn2
  })
})

// ---- fase 8 (§3bis L7): task thread ----

describe('fase 8 (§3bis L7): ciclo di vita del task', () => {
  it('create_task: task + card in chat principale + job task-run; il task non vede la chat principale', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 't1', name: 'create_task', arguments: JSON.stringify({ title: 'Ricerca prezzi', brief: 'Confronta i prezzi di X su 3 siti e prepara una tabella.' }) }] },
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'Ho aperto un task per la ricerca.' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'confronta i prezzi di X', emit)
    expect(h.db.tasks).toHaveLength(1)
    expect(h.db.tasks[0]).toMatchObject({ title: 'Ricerca prezzi', status: 'working' })
    // card del task in chat PRINCIPALE: send-message type task, SENZA meta.taskId
    const card = h.db.entries.find((e) => e.kind === 'send-message' && (e.meta?.message as { type?: string } | undefined)?.type === 'task')!
    expect(card.meta?.message).toMatchObject({ taskId: 1, title: 'Ricerca prezzi' })
    expect(card.meta?.taskId).toBeUndefined()
    // job della stessa coda (in serie con gli altri turni dell'agente)
    const job = h.db.jobs.find((j) => j.kind === 'task-run')!
    expect(job.payload).toMatchObject({ taskId: 1, brief: 'Confronta i prezzi di X su 3 siti e prepara una tabella.' })
    expect(job.agentId).toBe(AGENT)
  })

  it('working → needs_input (ask_user nel task) → done (update_task) con summary → TASK_DONE per la chat principale', async () => {
    // il task esiste già (lo crea il primo test col suo create_task)
    h.db.tasks.push({ id: 1, agent_id: AGENT, title: 'Ricerca prezzi', status: 'working', created_at: 1, updated_at: 1, summary: null })
    // il turno del task: apre col brief, chiede all'utente → needs_input
    h.llm.queue = [
      { toolCalls: [{ id: 'q1', name: 'ask_user', arguments: JSON.stringify({ prompt: 'Quanti siti confronto?', options: [{ label: '3' }, { label: '5' }] }) }] }
    ]
    await runTurn(AGENT, 'Confronta i prezzi di X su 3 siti.', emit, undefined, { taskId: 1 })
    expect(h.db.tasks[0]!.status).toBe('needs_input')
    // TUTTE le entry del turno di task hanno meta.taskId
    const widget = h.db.entries.find((e) => e.kind === 'send-message' && (e.meta?.message as { type?: string } | undefined)?.type === 'widget' && e.meta?.taskId === 1)!
    expect(widget).toBeTruthy()
    const taskEntries = h.db.entries.filter((e) => e.meta?.taskId === 1)
    expect(taskEntries.length).toBeGreaterThan(1) // brief + thinking + widget…
    // il contesto del task conteneva SOLO il brief (nessun messaggio della chat principale)
    const taskCall = h.llm.calls.find((c) => c.some((m) => m.role === 'user' && m.content === 'Confronta i prezzi di X su 3 siti.'))!
    expect(taskCall.some((m) => m.content === 'confronta i prezzi di X')).toBe(false)

    // la risposta dell'utente continua il task (come fa enqueueWidgetResponse)
    h.llm.queue = [
      { toolCalls: [{ id: 'u1', name: 'update_task', arguments: JSON.stringify({ id: 1, status: 'done', summary: 'Confrontati 3 siti: migliore Y a 10€.' }) }] }
    ]
    await runTurn(AGENT, '3', emit, undefined, { taskId: 1, respondedTo: widget.id })
    expect(h.db.tasks[0]).toMatchObject({ status: 'done', summary: 'Confrontati 3 siti: migliore Y a 10€.' })
    // il summary torna alla chat principale come job TASK_DONE
    const done = h.db.jobs.find((j) => j.payload.initiator === 'TASK_DONE')!
    expect(done.kind).toBe('user-message')
    expect(done.agentId).toBe(AGENT)
    expect(String(done.payload.text)).toContain('<task_done')
    expect(String(done.payload.text)).toContain('Confrontati 3 siti: migliore Y a 10€.')

    // la chat principale NON vede le entry del task: il turno dopo non riceve
    // né il brief né la domanda del task
    h.llm.queue = [{ text: 'ok' }]
    await runTurn(AGENT, 'e adesso?', emit)
    const mainCall = h.llm.calls.find((c) => c.some((m) => m.role === 'user' && m.content === 'e adesso?'))!
    expect(JSON.stringify(mainCall)).not.toContain('Quanti siti')
    expect(JSON.stringify(mainCall)).not.toContain('Confronta i prezzi di X su 3 siti.')
  })

  it('approval dentro un task → needs_input, la decisione dell\'utente lo riporta working', async () => {
    h.db.tasks.push({ id: 1, agent_id: AGENT, title: 'Ricerca prezzi', status: 'working', created_at: 1, updated_at: 1, summary: null })
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'ls' }) }] }
    ]
    const turn = runTurn(AGENT, 'brief del task', emit, undefined, { taskId: 1 })
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending' && e.meta?.taskId === 1)).toBe(true)
    })
    expect(h.db.tasks[0]!.status).toBe('needs_input')
    resolveApproval(AGENT, String(h.db.entries.findLast((e) => e.kind === 'approval')!.meta?.approvalId), 'allow', 'once')
    await turn
    expect(h.db.tasks[0]!.status).toBe('working')
    expect(h.sandboxMock.exec.calls).toBe(1)
  })

  it('interrupt del task annulla e il job successivo non parte', async () => {
    h.db.tasks.push({ id: 1, agent_id: AGENT, title: 'Ricerca prezzi', status: 'working', created_at: 1, updated_at: 1, summary: null })
    h.llm.queue = [
      { toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'sleep 1' }) }] },
      { text: 'ok' }
    ]
    const turn = runTurn(AGENT, 'brief', emit, undefined, { taskId: 1 })
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'tool-call' && e.meta?.taskId === 1)).toBe(true)
    })
    const { interruptTask } = await import('../loop')
    expect(interruptTask(AGENT, 1)).toBe(true)
    await turn
    // dopo l'interrupt il task è annullabile dal suo stato (la RPC lo farebbe);
    // un nuovo job dello stesso task non parte
    h.db.tasks[0]!.status = 'cancelled'
    h.llm.queue = [{ text: 'non dovrei girare' }]
    await runTurn(AGENT, 'brief', emit, undefined, { taskId: 1 })
    expect(h.llm.calls[h.llm.calls.length - 1]!.some((m) => m.content === 'non dovrei girare')).toBe(false)
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('annullato'))).toBe(true)
  })
})

// ---- fase 8 (§3bis L11): protezioni di runtime ----

describe('fase 8 (§3bis L11): loop detection', () => {
  it('la stessa identica chiamata per la TERZA volta di fila ferma il turno con notice leggibile', async () => {
    // fase 9 (0c): le send identiche vengono intercettate dalla dedup prima
    // della loop detection, quindi il veicolo qui è un tool di lavoro
    const resp = { toolCalls: [{ id: 'x', name: 'list-credentials', arguments: '{}' }] }
    h.llm.queue = [resp, resp, resp, resp]
    await runTurn(AGENT, 'vai', emit)
    // la terza identica NON è stata eseguita: due esecuzioni e una notice di loop
    const calls = h.db.entries.filter((e) => e.kind === 'tool-call' && e.meta?.name === 'list-credentials')
    expect(calls).toHaveLength(2)
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('loop'))).toBe(true)
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'STOPPED')).toBe(true)
  })

  it('due chiamate uguali e una diversa NON sono un loop', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 'a', name: 'list-credentials', arguments: '{}' }] },
      { toolCalls: [{ id: 'b', name: 'list-credentials', arguments: '{}' }] },
      { toolCalls: [{ id: 'c', name: 'list-credentials', arguments: '{"x":1}' }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'vai', emit)
    expect(h.db.entries.filter((e) => e.kind === 'tool-call' && e.meta?.name === 'list-credentials')).toHaveLength(3)
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('loop'))).toBe(false)
  })
})

describe('fase 8 (§3bis L11): scadenze dello stream', () => {
  it('nessun token entro la scadenza → notice "il modello non risponde", turno STOPPED, ripresa normale dopo', async () => {
    h.db.settings.set('llm.firstTokenMs', 30)
    h.llm.queue = [{ hang: true }]
    await runTurn(AGENT, 'rispondi', emit)
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('Il modello non risponde'))).toBe(true)
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'STOPPED')).toBe(true)
    // la ripresa è normale: il messaggio successivo gira senza tracce della scadenza
    h.llm.queue = [
      { toolCalls: [{ id: 's1', name: 'send_to_user', arguments: JSON.stringify({ text: 'ora va' }) }] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'e ora?', emit)
    expect(h.db.entries.filter((e) => e.kind === 'send-message' && (e.meta?.call as { name?: string } | undefined)?.name === 'send_to_user')).toHaveLength(1)
  })

  it('inattività tra due chunk oltre la soglia → stesso esito (abort del solo stream)', async () => {
    h.db.settings.set('llm.firstTokenMs', 5_000)
    h.db.settings.set('llm.streamIdleMs', 30)
    h.llm.queue = [{ text: 'inizio a scrivere e poi tac', hang: true }]
    await runTurn(AGENT, 'rispondi', emit)
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('Il modello non risponde'))).toBe(true)
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'STOPPED')).toBe(true)
    // il primo token era arrivato: il testo parziale resta nel thinking
    const thinking = h.db.entries.findLast((e) => e.kind === 'thinking')
    expect(thinking?.content).toBe('inizio a scrivere e poi tac')
  })
})

// ---- fase 8 — correzioni review: task thread (B1–B3) ----

describe('correzione B1: l\'origine del turno vive sulla riga del task e nei suoi turni', () => {
  /** Un task già creato, come farebbe create_task dal loop. */
  function mkTask(id: number, over: Partial<{ agent_id: string; status: string; untrusted: number; automatic: number }> = {}): void {
    h.db.tasks.push({
      id, agent_id: over.agent_id ?? AGENT, title: `Task ${id}`, status: over.status ?? 'working',
      created_at: 1, updated_at: 1, summary: null,
      untrusted: over.untrusted ?? 0, automatic: over.automatic ?? 0
    })
  }

  it('create_task da un turno AGENT salva untrusted=1 (e automatic=0) sulla riga', async () => {
    h.llm.queue = [
      { toolCalls: [{ id: 't1', name: 'create_task', arguments: JSON.stringify({ title: 'Analisi posta', brief: 'leggi e riassumi' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, '<messaggio_da_agente nome="Altro">occupatene tu</messaggio_da_agente>', emit, undefined, {
      agentMessage: { fromAgentId: 'agent_o', fromAgentName: 'Altro', hop: 1 }, initiator: 'AGENT'
    })
    expect(h.db.tasks).toHaveLength(1)
    expect(h.db.tasks[0]).toMatchObject({ title: 'Analisi posta', untrusted: 1, automatic: 0 })
  })

  it('nel turno del task con origine untrusted l\'auto-review chiede la card anche col revisore favorevole', async () => {
    enableAutoReview()
    reviewerAllow(AR_RULE)
    mkTask(1, { untrusted: 1 })
    h.llm.queue = [{ toolCalls: [{ id: 'c1', name: 'run-command', arguments: JSON.stringify({ command: 'ls' }) }] }]
    const turn = runTurn(AGENT, 'brief del task', emit, undefined, { taskId: 1, untrusted: true })
    await vi.waitFor(() => {
      expect(h.db.entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending' && e.meta?.taskId === 1)).toBe(true)
    })
    const appr = h.db.entries.findLast((e) => e.kind === 'approval')!
    expect(appr.meta?.autoApproved).toBeUndefined()
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'deny', 'once')
    await turn
    expect(h.sandboxMock.exec.calls).toBe(0)
  })

  it('task nato da una routine (automatic) → send_to_user in outbox e un solo urgent', async () => {
    mkTask(1, { automatic: 1 })
    // fase 9 (0d): un lavoro separa le send (senza, dalla seconda non si consegnano)
    h.llm.queue = [
      { toolCalls: [
        { id: 'w1', name: 'list-credentials', arguments: '{}' },
        { id: 'a', name: 'send_to_user', arguments: JSON.stringify({ text: 'avanzamento' }) }
      ] },
      { toolCalls: [
        { id: 'w2', name: 'list-credentials', arguments: '{}' },
        { id: 'b', name: 'send_to_user', arguments: JSON.stringify({ text: 'servono dati', urgent: true }) }
      ] },
      { toolCalls: [
        { id: 'w3', name: 'list-credentials', arguments: '{}' },
        { id: 'c', name: 'send_to_user', arguments: JSON.stringify({ text: 'altro urgent', urgent: true }) }
      ] },
      { text: '.' }
    ]
    await runTurn(AGENT, 'brief', emit, undefined, { taskId: 1, automatic: true })
    const sends = h.db.entries.filter((e) => e.kind === 'send-message' && e.meta?.taskId === 1)
    expect(sends).toHaveLength(3)
    expect(sends[0]!.meta?.held).toBe(true)   // non urgent → outbox
    expect(sends[1]!.meta?.held).toBeUndefined() // il primo urgent passa
    expect(sends[2]!.meta?.held).toBe(true)   // il secondo urgent è trattenuto
    expect(h.db.outbox.filter((o) => o.agent_id === AGENT)).toHaveLength(2)
  })
})

describe('correzione B2: niente task annidati e tetto di task aperti', () => {
  it('create_task DENTRO un task → errore leggibile, nessun task nuovo', async () => {
    h.db.tasks.push({ id: 1, agent_id: AGENT, title: 'Task 1', status: 'working', created_at: 1, updated_at: 1, summary: null, untrusted: 0, automatic: 0 })
    h.llm.queue = [
      { toolCalls: [{ id: 't2', name: 'create_task', arguments: JSON.stringify({ title: 'Sub-task', brief: 'b' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'brief', emit, undefined, { taskId: 1 })
    expect(h.db.tasks).toHaveLength(1)
    expect(h.db.jobs.filter((j) => j.kind === 'task-run')).toHaveLength(0)
    const results = h.llm.calls[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results.some((c) => c.includes('sei già in un task'))).toBe(true)
  })

  it('oltre 5 task aperti → errore leggibile e nessuna creazione (i chiusi non contano)', async () => {
    for (let i = 1; i <= 5; i++) {
      h.db.tasks.push({ id: i, agent_id: AGENT, title: `T${i}`, status: i === 5 ? 'needs_input' : 'working', created_at: 1, updated_at: 1, summary: null, untrusted: 0, automatic: 0 })
    }
    h.db.tasks.push({ id: 6, agent_id: AGENT, title: 'Chiuso', status: 'done', created_at: 1, updated_at: 1, summary: null, untrusted: 0, automatic: 0 })
    h.llm.queue = [
      { toolCalls: [{ id: 't3', name: 'create_task', arguments: JSON.stringify({ title: 'Sesto aperto', brief: 'b' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'aprilo', emit)
    expect(h.db.tasks).toHaveLength(6) // nessuno nuovo
    const results = h.llm.calls[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results.some((c) => c.includes('5 task aperti'))).toBe(true)
  })
})

describe('correzione B3: update_task chiude solo task propri (e, in un task, solo il corrente)', () => {
  it('il task di un ALTRO agente non si chiude: errore, task intatto, nessun TASK_DONE', async () => {
    h.db.tasks.push({ id: 9, agent_id: 'agent_other', title: 'Non mio', status: 'working', created_at: 1, updated_at: 1, summary: null, untrusted: 0, automatic: 0 })
    h.llm.queue = [
      { toolCalls: [{ id: 'u1', name: 'update_task', arguments: JSON.stringify({ id: 9, status: 'done', summary: 'fatto' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'chiudi quel task', emit)
    expect(h.db.tasks[0]!.status).toBe('working')
    expect(h.db.jobs.filter((j) => j.payload.initiator === 'TASK_DONE')).toHaveLength(0)
    const results = h.llm.calls[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results.some((c) => c.includes('non è tuo'))).toBe(true)
  })

  it('dentro un task si chiude SOLO il task corrente (niente chiusure di altri task propri)', async () => {
    h.db.tasks.push({ id: 1, agent_id: AGENT, title: 'Corrente', status: 'working', created_at: 1, updated_at: 1, summary: null, untrusted: 0, automatic: 0 })
    h.db.tasks.push({ id: 2, agent_id: AGENT, title: 'Altro task', status: 'working', created_at: 1, updated_at: 1, summary: null, untrusted: 0, automatic: 0 })
    h.llm.queue = [
      { toolCalls: [{ id: 'u2', name: 'update_task', arguments: JSON.stringify({ id: 2, status: 'done', summary: 'x' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'brief', emit, undefined, { taskId: 1 })
    expect(h.db.tasks.find((t) => t.id === 1)!.status).toBe('working')
    expect(h.db.tasks.find((t) => t.id === 2)!.status).toBe('working')
    expect(h.db.jobs.filter((j) => j.payload.initiator === 'TASK_DONE')).toHaveLength(0)
    const results = h.llm.calls[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results.some((c) => c.includes('SOLO quello'))).toBe(true)
  })

  it('la chiusura del task corrente continua a funzionare (B3 non blocca il percorso giusto)', async () => {
    h.db.tasks.push({ id: 1, agent_id: AGENT, title: 'Corrente', status: 'working', created_at: 1, updated_at: 1, summary: null, untrusted: 0, automatic: 0 })
    h.llm.queue = [
      { toolCalls: [{ id: 'u3', name: 'update_task', arguments: JSON.stringify({ id: 1, status: 'done', summary: 'pronto' }) }] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'brief', emit, undefined, { taskId: 1 })
    expect(h.db.tasks[0]).toMatchObject({ status: 'done', summary: 'pronto' })
    const done = h.db.jobs.find((j) => j.payload.initiator === 'TASK_DONE')!
    // correzione B1: summary in blocco evidenza con la regola, niente origine da propagare
    expect(String(done.payload.text)).toContain('<task_done')
    expect(String(done.payload.text)).toContain('DATO')
    expect(done.payload.automatic).toBeUndefined()
    expect(done.payload.untrusted).toBeUndefined()
  })
})

// ---- fase 9 (punto 0): un messaggio per risultato — riproduzione del bug ----

describe('fase 9 (punto 0): più messaggi per una sola azione', () => {
  const mkSend = (id: string, args: string): FakeToolCall => ({ id, name: 'send_to_user', arguments: args })
  // il messaggio del DB di sviluppo: virgolette E a capo negli argomenti
  const TESTO = 'Routine "Riepilogo mattina" creata in pausa.\nAttivala quando vuoi.'
  const ARGS = JSON.stringify({ text: TESTO })

  it('la sequenza del DB: send integra, congettura nel ragionamento, ripetizione e riempitivi', async () => {
    h.llm.queue = [
      // passo 1: la send buona (nel DB reale è arrivata integra, arguments validi)
      { toolCalls: [mkSend('s1', ARGS)] },
      // passo 2: il modello si convince che sia stata troncata e ripete lo stesso testo
      { text: 'Routine\n\nThe final message got cut again: "Routine ". Maybe the quotes cause issue.', toolCalls: [mkSend('s2', ARGS)] },
      // passi 3-4: i riempitivi del DB ("Attivata." / "OK.")
      { toolCalls: [mkSend('s3', '{"text":"Attivata."}')] },
      { toolCalls: [mkSend('s4', '{"text":"OK."}')] },
      { text: 'fine' }
    ]
    await runTurn(AGENT, 'Per favore crea una routine chiamata "Riepilogo mattina"', emit)
    // UNA sola send visibile: quella buona, col testo integro (virgolette e a capo)
    const sends = h.db.entries.filter((e) => e.kind === 'send-message')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.content).toBe(TESTO)
    // la ripetizione non ha creato entry; i riempitivi sono diventati ragionamento
    expect(h.db.entries.some((e) => e.kind === 'thinking' && e.content === 'Attivata.')).toBe(true)
    expect(h.db.entries.some((e) => e.kind === 'thinking' && e.content === 'OK.')).toBe(true)
    // i result che il modello ha ricevuto (l'ultima chiamata li vede tutti):
    // consegna con riscontro, già consegnato, non consegnato ×2
    const lastCall = h.llm.calls[h.llm.calls.length - 1]!
    const results = lastCall.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results.some((c) => c.includes("consegnato all'utente: «Routine \"Riepilogo mattina\" creata in pausa."))).toBe(true)
    expect(results.some((c) => c.includes('già consegnato'))).toBe(true)
    expect(results.filter((c) => c.includes('Non consegnato'))).toHaveLength(2)
  })

  it('il turno successivo rivede la chiamata INTATTA: arguments identici con virgolette e a capo', async () => {
    h.llm.queue = [
      { toolCalls: [mkSend('s1', ARGS)] },
      { text: 'fatto' }
    ]
    await runTurn(AGENT, 'crea la routine', emit)
    h.llm.queue.length = 0
    h.llm.calls.length = 0
    h.llm.queue = [{ text: 'grazie' }]
    await runTurn(AGENT, 'e adesso?', emit)
    // la chiamata ricostruita dal transcript ha gli ARGOMENTI identici…
    const call2 = h.llm.calls[0]!
    const calls = call2.flatMap(
      (m) => ((m.toolCalls as Array<{ id: string; name: string; arguments: string }> | undefined) ?? [])
    )
    const sendCall = calls.find((tc) => tc.name === 'send_to_user')
    expect(sendCall?.arguments).toBe(ARGS)
    // …e il result della ricostruzione riporta l'inizio del testo consegnato
    expect(call2.some((m) => m.role === 'tool' && String(m.content).includes("consegnato all'utente: «Routine"))).toBe(true)
  })

  it('avanzamento legittimo: annuncio, lavoro, risultato — entrambi i messaggi consegnati', async () => {
    h.llm.queue = [
      { toolCalls: [mkSend('a1', '{"text":"Sto controllando la posta, un attimo."}')] },
      { toolCalls: [{ id: 'lc3', name: 'list-credentials', arguments: '{}' }] },
      { toolCalls: [mkSend('a2', '{"text":"Fatto: nessuna email in sospeso."}')] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'controlla la posta', emit)
    const sends = h.db.entries.filter((e) => e.kind === 'send-message')
    expect(sends.map((s) => s.content)).toEqual(['Sto controllando la posta, un attimo.', 'Fatto: nessuna email in sospeso.'])
    expect(h.db.entries.some((e) => e.kind === 'thinking' && e.content.includes('Fatto:'))).toBe(false)
  })

  it('la chiamata di recupero segue le stesse regole: due send dal recupero → solo la prima è in chat', async () => {
    h.llm.queue = [
      // il turno risponde senza send: scatta il recupero
      { text: 'ho pensato molto' },
      // il recupero prova a mandare DUE messaggi (il caso "esattamente UN send")
      { toolCalls: [mkSend('r1', '{"text":"Routine attivata."}'), mkSend('r2', '{"text":"Fatto."}')] }
    ]
    await runTurn(AGENT, 'attiva la routine', emit)
    const sends = h.db.entries.filter((e) => e.kind === 'send-message')
    expect(sends.map((s) => s.content)).toEqual(['Routine attivata.'])
    // il secondo è diventato ragionamento, non chat
    expect(h.db.entries.some((e) => e.kind === 'thinking' && e.content === 'Fatto.')).toBe(true)
  })
})

// ---- fase 9 (punto 1): il modello di riserva quando il principale non risponde ----

describe('fase 9 (punto 1): riserva del modello', () => {
  const mkSend = (id: string, args: string): FakeToolCall => ({ id, name: 'send_to_user', arguments: args })
  const httpError = (status: number): Error => {
    const e = new Error(`HTTP ${status}`)
    ;(e as Error & { status?: number }).status = status
    return e
  }
  const setRiserva = (model: string): void => {
    h.db.settings.set('providers.modelDefaults', { prov: { fallbackModel: model } })
  }

  it('5xx → UNA riprova col modello di riserva, notice di sistema, consegna normale', async () => {
    setRiserva('m-riserva')
    h.llm.queue = [
      { error: httpError(502) },
      { toolCalls: [mkSend('f1', '{"text":"eccomi"}')] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'ciao', emit)
    // il principale ha fallito, le chiamate successive girano sulla riserva
    expect(h.llm.models).toEqual(['m1', 'm-riserva', 'm-riserva'])
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('uso la riserva m-riserva'))).toBe(true)
    const send = h.db.entries.find((e) => e.kind === 'send-message')!
    expect(send.content).toBe('eccomi')
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'FINISHED')).toBe(true)
  })

  it('la scadenza dello stream (fase 8) ammette la riserva come un timeout', async () => {
    h.db.settings.set('llm.firstTokenMs', 30)
    setRiserva('m-riserva')
    h.llm.queue = [
      { hang: true },
      { toolCalls: [mkSend('f2', '{"text":"risposta dalla riserva"}')] },
      { text: 'ok' }
    ]
    await runTurn(AGENT, 'ciao', emit)
    expect(h.llm.models).toEqual(['m1', 'm-riserva', 'm-riserva'])
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('uso la riserva'))).toBe(true)
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'FINISHED')).toBe(true)
  })

  it('la riserva si usa UNA volta sola: se fallisce anche lei il turno chiude STOPPED', async () => {
    setRiserva('m-riserva')
    h.llm.queue = [
      { error: httpError(503) },
      { error: httpError(503) },
      { text: 'mai raggiunta' }
    ]
    await runTurn(AGENT, 'ciao', emit)
    expect(h.llm.models).toEqual(['m1', 'm-riserva'])
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'STOPPED')).toBe(true)
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.startsWith('Errore dal modello'))).toBe(true)
  })

  it('4xx: MAI riserva (richiesta sbagliata), turno STOPPED subito', async () => {
    setRiserva('m-riserva')
    h.llm.queue = [{ error: httpError(400) }, { text: 'mai' }]
    await runTurn(AGENT, 'ciao', emit)
    expect(h.llm.models).toEqual(['m1'])
    expect(h.db.entries.some((e) => e.kind === 'notice' && e.content.includes('riserva'))).toBe(false)
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'STOPPED')).toBe(true)
  })

  it('senza riserva configurata il comportamento resta quello di prima', async () => {
    h.llm.queue = [{ error: httpError(500) }, { text: 'mai' }]
    await runTurn(AGENT, 'ciao', emit)
    expect(h.llm.models).toEqual(['m1'])
    expect(h.db.entries.some((e) => e.kind === 'event' && e.meta?.turnEnd === 'STOPPED')).toBe(true)
  })
})
