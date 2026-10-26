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
  const mcp = { calls: 0 }
  return { db, llm, sandboxMock, mcp }
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

// fase 3: il client MCP è finto — conta le chiamate per provare che gli invii
// esterni NON partono finché l'utente non clicca Invia
vi.mock('../../mcp', () => ({
  activeTools: async () => [{
    name: 'mcp__gmail__send_message', description: 'invia email', parameters: { type: 'object', properties: {} }
  }],
  callTool: async () => {
    h.mcp.calls++
    return 'email inviata'
  }
}))

const { runTurn, isRunning, resolveApproval, supersedeIfPaused, RECOVERY_NUDGE } = await import('../loop')

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

    resolveApproval(AGENT, String(appr.meta?.approvalId), 'allow', true)
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
