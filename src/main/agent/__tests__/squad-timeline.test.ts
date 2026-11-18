// Q4 (fase squadra): la timeline della squadra si riempie da sola — ogni
// send_to_agent tra membri (e la sua risposta collegata) entra come riga
// relay di SOLA VISUALIZZAZIONE (authorKind 'relay': non sveglia nessuno, non
// conta nei turni o nei tetti), i documenti e i file della cartella condivisa
// entrano come card che si aprono ('artifact'), e le card di approvazione dei
// turni della squadra tornano con la timeline (dalle entry con meta.squadId).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn } from '../loop'
import { listJobs } from '../../store/jobs'
import { groupMessages, squadApprovalCardsForGroup } from '../../store/groups'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'
let dir: string
let server: Server
let port = 0
const emit = (): void => undefined

let queue: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = []
const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-squad-timeline-'))
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
  for (const t of ['entries', 'agents', 'grants', 'jobs', 'groups', 'group_members', 'group_messages', 'group_turns', 'group_cursors', 'subagents', 'library_items']) {
    store.db().exec(`DELETE FROM ${t}`)
  }
  queue = []
})

const makeAgent = (name: string): string => {
  const a = store.createAgent(name, '')
  store.updateAgent(a.id, { providerId: 'px', model: 'm-x' })
  return a.id
}
const activate = (agentId: string, groups: string[]): void => {
  store.appendEntry({ agentId, kind: 'tool-result', role: 'system', content: 'groups active', meta: { callId: 'seed-groups', activatedGroups: groups } })
}

describe('Q4: la delega 1-a-1 tra membri entra nella timeline come RELAY', () => {
  it('una riga relay compatta (da → a, testo), e NESSUN turno di gruppo parte', async () => {
    const treni = makeAgent('Treni')
    const alloggio = makeAgent('Alloggio')
    activate(treni, ['bots'])
    const { createGroup } = await import('../../store/groups')
    const g = createGroup('Weekend', '', treni, [alloggio], treni)
    queue = [
      { tool: { name: 'send_to_agent', args: { agentId: alloggio, text: 'A che ora è il check-in?' } } },
      { text: 'inviato' }
    ]
    await runTurn(treni, 'lavora', emit, undefined, { squadId: g.id })
    const msgs = groupMessages(g.id)
    const relay = msgs.find((m) => m.author_kind === 'relay')
    expect(relay).toBeTruthy()
    expect(relay!.author_id).toBe(treni)
    expect(relay!.author_name).toBe('Treni')
    const payload = JSON.parse(relay!.text) as { to: string; toName: string; text: string }
    expect(payload.to).toBe(alloggio)
    expect(payload.toName).toBe('Alloggio')
    expect(payload.text).toContain('check-in')
    // il relay NON sveglia nessuno: nessun job group-turn, nessun turno pianificato
    expect(listJobs(store.db()).some((j) => j.kind === 'group-turn')).toBe(false)
    expect(msgs.every((m) => m.author_kind !== 'agent' || m.id !== relay!.id)).toBe(true)
  })
})

describe('Q4: i documenti e i file della squadra entrano come CARD che si aprono', () => {
  it('write_document in un turno di squadra → card documento con id e titolo', async () => {
    const capo = makeAgent('Capo doc')
    const { createGroup } = await import('../../store/groups')
    const g = createGroup('Weekend', '', capo, [makeAgent('Membro doc')], capo)
    queue = [
      { tool: { name: 'write_document', args: { title: 'Torino weekend — guida definitiva', content: '# Guida\nTorino!' } } },
      { text: 'fatto' }
    ]
    await runTurn(capo, 'scrivi', emit, undefined, { squadId: g.id })
    const artifact = groupMessages(g.id).find((m) => m.author_kind === 'artifact')
    expect(artifact).toBeTruthy()
    const payload = JSON.parse(artifact!.text) as { kind: string; id: string; title: string }
    expect(payload.kind).toBe('document')
    expect(payload.title).toContain('Torino weekend')
    expect(payload.id).toBeTruthy()
  })

  it('write-file nella cartella CONDIVISA (/workspace) → card file col percorso', async () => {
    const treni = makeAgent('Treni file')
    const { createGroup } = await import('../../store/groups')
    const g = createGroup('Weekend', '', treni, [makeAgent('Alloggio file')], treni)
    queue = [
      { tool: { name: 'write-file', args: { path: '/workspace/torino/01_treni.md', content: 'treni' } } },
      { text: 'fatto' }
    ]
    await runTurn(treni, 'scrivi', emit, undefined, { squadId: g.id })
    const artifact = groupMessages(g.id).find((m) => m.author_kind === 'artifact')
    expect(artifact).toBeTruthy()
    const payload = JSON.parse(artifact!.text) as { kind: string; title: string; path: string }
    expect(payload.kind).toBe('file')
    expect(payload.title).toBe('01_treni.md')
    expect(payload.path).toContain('workspace/torino/01_treni.md')
  })

  it('write-file nella HOME PRIVATA del bot NON entra nella timeline della squadra', async () => {
    const treni = makeAgent('Treni privato')
    const { createGroup } = await import('../../store/groups')
    const g = createGroup('Weekend', '', treni, [makeAgent('Alloggio privato')], treni)
    queue = [
      { tool: { name: 'write-file', args: { path: 'appunti-privati.md', content: 'x' } } },
      { text: 'fatto' }
    ]
    await runTurn(treni, 'scrivi', emit, undefined, { squadId: g.id })
    expect(groupMessages(g.id).some((m) => m.author_kind === 'artifact')).toBe(false)
  })
})

describe('Q4: le card di approvazione dei turni della squadra tornano con la timeline', () => {
  it('squadApprovalCardsForGroup: le approval dei turni con meta.squadId, non le altre', async () => {
    const capo = makeAgent('Capo card')
    const { createGroup } = await import('../../store/groups')
    const g = createGroup('Weekend', '', capo, [makeAgent('Membro card')], capo)
    store.appendEntry({
      agentId: capo, kind: 'approval', role: 'system', content: 'Turismo chiede: compilare il modulo',
      meta: { approvalId: 'c1', tool: 'fill_credential', input: {}, status: 'pending', squadId: g.id, squadAlwaysAsk: true }
    })
    store.appendEntry({
      agentId: capo, kind: 'approval', role: 'system', content: 'fuori squadra',
      meta: { approvalId: 'c2', tool: 'use-app', input: {}, status: 'pending' }
    })
    const cards = squadApprovalCardsForGroup(g.id)
    expect(cards.length).toBe(1)
    expect(cards[0]!.approvalId).toBe('c1')
    expect(cards[0]!.agentName).toBe('Capo card')
    expect(cards[0]!.phrase).toContain('compilare il modulo')
    expect(cards[0]!.pending).toBe(true)
    expect(cards[0]!.fixed).toBe(true)
  })
})
