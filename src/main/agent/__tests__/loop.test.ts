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
    nextId: 1
  }
  const llm = {
    queue: [] as unknown[],
    calls: [] as Array<Array<{ role: string; content: string; toolCallId?: string; images?: string[]; toolCalls?: unknown[] }>>,
    gates: new Set<{ resolve: () => void }>()
  }
  const sandboxMock = {
    exec: { command: '', env: {} as Record<string, string>, calls: 0 },
    result: { stdout: '', stderr: '', exitCode: 0, signal: null as string | null, trimmed: false }
  }
  return { db, llm, sandboxMock }
})

interface FakeToolCall { id: string; name: string; arguments: string }
interface FakeResp { text?: string; toolCalls?: FakeToolCall[] }
type FakeQueueItem = FakeResp | (() => Promise<FakeResp>)
const q = () => h.llm.queue as FakeQueueItem[]

vi.mock('../../store/db', () => ({
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
  setSetting: (key: string, value: unknown) => { h.db.settings.set(key, value) },
  listGrants: () => h.db.grants.map((g, i) => ({ id: i + 1, tool: g.tool, target: g.target, createdAt: 0 })),
  addGrant: (tool: string, target: string) => { h.db.grants.push({ tool, target }) },
  getPermissions: () =>
    (h.db.settings.get('permissions') as PermissionsConfig | undefined) ?? {
      default: 'needs_approval',
      rules: [
        { tool: 'read-file', pattern: '*', mode: 'always_allow' },
        { tool: 'list-directory', pattern: '*', mode: 'always_allow' },
        { tool: 'write-file', pattern: '*', mode: 'needs_approval' },
        { tool: 'run-command', pattern: '*', mode: 'needs_approval' },
        { tool: 'list-credentials', pattern: '*', mode: 'always_allow' }
      ]
    }
}))

vi.mock('../providers', () => ({
  getProvider: (id: string) =>
    id === 'prov'
      ? { id: 'prov', name: 'test', kind: 'openai-compatible' as const, baseUrl: 'http://localhost', apiKey: '', enabled: true }
      : null
}))

vi.mock('../llm', () => ({
  llmStream: (_p: unknown, _model: string, messages: Array<{ role: string; content: string; toolCallId?: string; images?: string[]; toolCalls?: unknown[] }>) => {
    h.llm.calls.push(messages.map((m) => ({ role: m.role, content: m.content, toolCallId: m.toolCallId, images: m.images, toolCalls: m.toolCalls })))
    const resp = (q().shift() ?? { text: 'ok' }) as FakeQueueItem
    return {
      async *[Symbol.asyncIterator]() {
        const r: FakeResp = typeof resp === 'function' ? await resp() : resp
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

const { runTurn, isRunning, resolveApproval } = await import('../loop')

const emit = () => undefined
const AGENT = 'agent_t'

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
  h.db.nextId = 1
  h.llm.queue.length = 0
  h.llm.calls.length = 0
  h.sandboxMock.exec = { command: '', env: {}, calls: 0 }
  h.sandboxMock.result = { stdout: '', stderr: '', exitCode: 0, signal: null, trimmed: false }
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

    const first = runTurn(AGENT, 'lavoro', emit)
    await vi.waitFor(() => expect(h.llm.calls).toHaveLength(1))

    await runTurn(AGENT, '[routine] backup', emit, undefined, { source: 'routine', title: 'Backup' })
    const notice = h.db.entries.find((e) => e.kind === 'notice' && e.content.includes('Backup') && e.content.includes('saltata'))
    expect(notice).toBeTruthy()

    g.resolve()
    await first
    await vi.waitFor(() => expect(isRunning(AGENT)).toBe(false))
    expect(h.llm.calls).toHaveLength(1) // la routine non ha mai girato
  })

  it('un secondo messaggio utente su agente occupato viene scartato con notice (nessuna coda qui)', async () => {
    const g = gated('primo fatto')
    h.llm.queue = [g.response]

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
    // nel transcript resta un solo turno
    const kinds = h.db.entries.filter((e) => e.kind === 'message').map((e) => `${e.role}:${e.content}`)
    expect(kinds).toEqual(['user:primo', 'assistant:primo fatto'])
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
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'allow', true)
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
    resolveApproval(AGENT, String(appr.meta?.approvalId), 'allow', false)
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
      { text: 'completato' }
    ]

    const turn = runTurn(AGENT, 'scarica', emit)
    await vi.waitFor(() => {
      const appr = h.db.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
      expect(appr).toBeTruthy()
    })
    const appr = h.db.entries.find((e) => e.kind === 'approval')!
    expect(appr.content).toContain('curl')

    resolveApproval(AGENT, String(appr.meta?.approvalId), 'allow', true)
    await turn
    await vi.waitFor(() => expect(h.db.grants).toContainEqual({ tool: 'run-command', target: 'curl' }))

    // eseguito davvero e il turno si è chiuso
    expect(h.sandboxMock.exec.command).toBe('curl https://esempio')
    expect(h.db.entries.findLast((e) => e.kind === 'message')?.content).toBe('completato')
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
