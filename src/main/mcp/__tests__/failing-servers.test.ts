// V1 (fase stato-vivo): i server ACCESI che NON partono, per il blocco
// «Collegamenti ora» del prompt. La CATEGORIA X2 dell'ultima prova si ricorda
// in connectors.state (la scrive testServer alla fonte, com'era per il testo
// libero di PL3); failingServersForAgent la rilegge per il bot (enabledFor,
// un figlio eredita dal padre) — così il prompt dice «orion-moon: does not
// start (…)» invece di far credere al bot che lo strumento non esista.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir, getSetting, setSetting } from '../../store/db'
import { saveServers, testServer, disconnectServer, failingServersForAgent } from '../index'
import { TEST_TMP_BASE } from '../../../test-tmp'

// un mini server MCP stdio (JSON-RPC a righe) che FUNZiona, come E1
const FAKE_SERVER = [
  'let buf = ""',
  'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")',
  'process.stdin.setEncoding("utf8")',
  'process.stdin.on("data", (d) => {',
  '  buf += d',
  '  let i',
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, i); buf = buf.slice(i + 1)',
  '    if (!line.trim()) continue',
  '    const m = JSON.parse(line)',
  '    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "finto", version: "1" } } })',
  '    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ciao", description: "x", inputSchema: { type: "object" } }] } })',
  '    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })',
  '  }',
  '})'
].join('\n')

let dir: string
let fakeServerPath: string

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE ?? tmpdir(), 'sandbot-v1-failing-'))
  setDataDir(dir)
  fakeServerPath = join(dir, 'finto-mcp.mjs')
  writeFileSync(fakeServerPath, FAKE_SERVER, { mode: 0o644 })
})

afterAll(() => {
  for (const s of [{ id: 'srv-v1-finto' }, { id: 'srv-v1-rotto' }]) disconnectServer(s.id)
  rmSync(dir, { recursive: true, force: true })
})

describe('V1: failingServersForAgent — i server accesi che non partono (categoria X2)', () => {
  it('solo gli ACCESI con stato error; spenti, sani e needsAuth fuori', () => {
    saveServers([
      { id: 'srv-v1-sano', name: 'sano', transport: 'stdio', command: 'x', enabled: true },
      { id: 'srv-v1-rotto', name: 'rotto', transport: 'stdio', command: 'x', enabled: true },
      { id: 'srv-v1-spento', name: 'spento', transport: 'stdio', command: 'x', enabled: false },
      { id: 'srv-v1-auth', name: 'auth', transport: 'http', url: 'http://127.0.0.1:1', enabled: true, needsAuth: { kind: 'key', keys: ['K'] } },
      { id: 'srv-v1-altrabot', name: 'altrabot', transport: 'stdio', command: 'x', enabled: true, enabledFor: ['bot-2'] }
    ])
    setSetting('connectors.state', {
      'srv-v1-rotto': { status: 'error', error: 'boom', category: 'unreachable' },
      'srv-v1-spento': { status: 'error', error: 'boom', category: 'startup-error' }
    })
    expect(failingServersForAgent('bot-1')).toEqual([
      { id: 'srv-v1-rotto', name: 'rotto', category: 'unreachable' }
    ])
  })

  it('testServer FALLITO scrive la categoria in connectors.state; RIUSCITO pulisce l\'error', async () => {
    saveServers([
      { id: 'srv-v1-rotto', name: 'rotto', transport: 'stdio', command: '/non/esiste/prog', enabled: true },
      { id: 'srv-v1-finto', name: 'finto', transport: 'stdio', command: process.execPath, args: [fakeServerPath], enabled: true }
    ])
    const ko = await testServer('srv-v1-rotto')
    expect(ko.ok).toBe(false)
    expect(ko.category).toBe('command-not-found')
    expect(getSetting<Record<string, { status?: string; category?: string }>>('connectors.state', {})['srv-v1-rotto']).toMatchObject({
      status: 'error',
      category: 'command-not-found'
    })
    // il finto FUNZIONA: uno stato error precedente si pulisce (il server torna
    // nei tool del turno, e il blocco «Collegamenti ora» non lo dice rotto)
    setSetting('connectors.state', {
      'srv-v1-rotto': { status: 'error', error: 'boom', category: 'command-not-found' },
      'srv-v1-finto': { status: 'error', error: 'vecchio', category: 'unreachable' }
    })
    const ok = await testServer('srv-v1-finto')
    expect(ok.ok, ok.error).toBe(true)
    const st = getSetting<Record<string, { status?: string; category?: string }>>('connectors.state', {})['srv-v1-finto']
    expect(st?.status).not.toBe('error')
    expect(st?.category).toBeUndefined()
    expect(failingServersForAgent('bot-1').map((s) => s.id)).toEqual(['srv-v1-rotto'])
  })
})
