// Fase use-app (U1/U4) a livello di LOOP, sullo stack vero: store in una
// cartella mkdtemp, provider finto in SSE su 127.0.0.1, desktop FINTO di
// computer use (nessun tasto arriva al Mac dove girano i test).
//
// U4: due errori di Accessibilità nello stesso turno → la terza azione di
//     tastiera/mouse è rifiutata SENZA eseguire, con lo stesso testo; in chat
//     compare UNA notice «Apri Accessibilità»; screenshot non è toccato.
// U1: app = Homun → rifiutata nel loop PRIMA della card (nessuna approval).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn } from '../loop'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { setComputerUseIO, setHomunPidProvider, ACCESSIBILITY_RESULT, HOMUN_SELF_RESULT } from '../../computeruse'
import { createFakeComputerUseIO, type FakeDesktop } from '../../computeruse/fake'

const TMP_ROOT = TEST_TMP_BASE + '/'
let dir: string
let server: Server
let port = 0
const emit = (): void => undefined
let desk: FakeDesktop

/** Le risposte in coda del provider finto: una per chiamata (tool call o testo). */
let queue: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = []
const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-use-app-loop-'))
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
  setComputerUseIO(null)
  setHomunPidProvider(() => null)
  rmSync(dir, { recursive: true, force: true })
  return new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  store.db().exec('DELETE FROM entries')
  store.db().exec('DELETE FROM agents')
  store.db().exec('DELETE FROM grants')
  queue = []
  desk = createFakeComputerUseIO({ frontmost: 'Safari', homunPid: 4242 })
  setComputerUseIO(desk.io)
  setHomunPidProvider(() => 4242)
})

/** un bot col provider finto; use-app senza card (regola always_allow) salvo dove il test dice altro */
const makeAgent = (useAppMode: 'always_allow' | 'needs_approval' = 'always_allow'): string => {
  const agent = store.createAgent('UseAppBot')
  store.updateAgent(agent.id, { providerId: 'px', model: 'm-x' })
  store.setSetting('permissions', {
    default: 'needs_approval',
    rules: [
      { tool: 'send_to_user', pattern: '*', mode: 'always_allow' },
      { tool: 'use-app', pattern: 'screenshot', mode: 'always_allow' },
      { tool: 'use-app', pattern: '*', mode: useAppMode }
    ]
  })
  // fase token (T2): i test chiamano use-app per nome — il gruppo apps dev'essere
  // già attivo, come farebbe una find_tools({group}) precedente nella conversazione
  store.appendEntry({ agentId: agent.id, kind: 'tool-result', role: 'system', content: 'groups active', meta: { callId: 'seed-groups', activatedGroups: ['apps'] } })
  return agent.id
}

const results = (agentId: string) => store.getEntries(agentId).filter((e) => e.kind === 'tool-result')
const useApp = (args: Record<string, unknown>) => ({ tool: { name: 'use-app', args } })

describe('U4 — dopo due errori di Accessibilità nel turno, le altre azioni di tastiera e mouse non partono', () => {
  it('terzo tentativo rifiutato senza eseguire, stesso testo; UNA notice «Apri Accessibilità»; screenshot libero', async () => {
    const agentId = makeAgent()
    desk.state.denyAccessibility = true
    queue = [
      useApp({ action: 'click', x: 10, y: 10, app: 'Safari' }),
      useApp({ action: 'click', x: 20, y: 20, app: 'Safari' }),
      useApp({ action: 'type', text: 'https://sora.chatgpt.com', app: 'Safari' }),
      useApp({ action: 'screenshot' }),
      { text: 'mi fermo' }
    ]
    await runTurn(agentId, 'apri sora', emit)

    const rs = results(agentId)
    const useAppResults = rs.filter((e) => e.content === ACCESSIBILITY_RESULT)
    expect(useAppResults.length).toBe(3)
    // i primi due sono errori VERI del desktop (osascript chiamato due volte)
    expect(desk.records.filter((r) => r.op === 'osascript').length).toBe(2)
    // il terzo non ha toccato il desktop: nessun type registrato, nemmeno un osascript in più
    expect(desk.records.some((r) => r.op === 'type')).toBe(false)
    expect(useAppResults[2]!.meta?.accessibilityCap).toBe(true)
    // UNA notice con la via d'uscita (il bottone lo mette la UI dall'id)
    const notices = store.getEntries(agentId).filter((e) => e.kind === 'notice' && (e.meta?.ui as { id?: string } | undefined)?.id === 'notice.computerAccessibility')
    expect(notices.length).toBe(1)
    // screenshot non è un'azione di tastiera/mouse: eseguito (screencapture chiamato)
    expect(desk.records.some((r) => r.op === 'screencapture')).toBe(true)
  }, 20_000)

  it('un solo errore non chiude nulla: la seconda azione parte ancora', async () => {
    const agentId = makeAgent()
    desk.state.denyAccessibility = true
    queue = [
      useApp({ action: 'click', x: 10, y: 10, app: 'Safari' }),
      useApp({ action: 'type', text: 'x', app: 'Safari' }),
      { text: 'ok' }
    ]
    await runTurn(agentId, 'prova', emit)
    expect(desk.records.filter((r) => r.op === 'osascript').length).toBe(2)
    expect(results(agentId).filter((e) => e.content === ACCESSIBILITY_RESULT).every((e) => !e.meta?.accessibilityCap)).toBe(true)
  }, 20_000)
})

describe('U1 — app = Homun si rifiuta nel loop, prima della card', () => {
  it('nessuna approval, risultato «Homun never types…», desktop intatto', async () => {
    const agentId = makeAgent('needs_approval')
    queue = [
      useApp({ action: 'type', text: 'https://sora.chatgpt.com', app: 'Homun' }),
      { text: 'ok' }
    ]
    await runTurn(agentId, 'scrivi', emit)
    expect(store.getEntries(agentId).some((e) => e.kind === 'approval')).toBe(false)
    expect(results(agentId).some((e) => e.content === HOMUN_SELF_RESULT)).toBe(true)
    expect(desk.records).toEqual([])
  }, 20_000)
})
