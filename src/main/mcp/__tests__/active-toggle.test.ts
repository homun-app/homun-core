// V5 (fase stato-vivo): l'interruttore Attivo di un server MCP — spento, i
// suoi strumenti NON si offrono al bot; riacceso (e il test riesce), il bot
// li riceve AL TURNO DOPO (activeTools si carica all'inizio del turno). Con
// il server stdio FINTO che FUNZIONA, come E1.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir } from '../../store/db'
import { saveServers, listServers, testServer, disconnectServer, activeTools } from '../index'
import { TEST_TMP_BASE } from '../../../test-tmp'

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
  '    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "elenca", description: "x", inputSchema: { type: "object" } }] } })',
  '    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })',
  '  }',
  '})'
].join('\n')

let dir: string
let fakeServerPath: string

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE ?? tmpdir(), 'sandbot-v5-toggle-'))
  setDataDir(dir)
  fakeServerPath = join(dir, 'finto-mcp.mjs')
  writeFileSync(fakeServerPath, FAKE_SERVER, { mode: 0o644 })
})
afterAll(() => {
  disconnectServer('srv-v5')
  rmSync(dir, { recursive: true, force: true })
})

describe('V5: il gate del server spento — gli strumenti arrivano al turno dopo l\'accensione', () => {
  it('SPENTO: nessuno strumento; il test dell\'accensione riesce e activeTools li ha subito', async () => {
    saveServers([{
      id: 'srv-v5', name: 'finto v5', transport: 'stdio',
      command: process.execPath, args: [fakeServerPath], enabled: false, disabledReason: 'user'
    }])
    // spento: il turno NON offre i suoi strumenti (s.enabled, il gate di sempre)
    expect((await activeTools('bot-v5')).map((t) => t.name)).not.toContain('mcp__finto-v5__elenca')
    // l'interruttore ACCENDE (mcpSave enabled:true senza motivo) → il test U5 parte
    saveServers([{
      id: 'srv-v5', name: 'finto v5', transport: 'stdio',
      command: process.execPath, args: [fakeServerPath], enabled: true
    }])
    expect(listServers().find((s) => s.id === 'srv-v5')?.enabled).toBe(true)
    const test = await testServer('srv-v5')
    expect(test.ok, test.error).toBe(true)
    // e il turno DOPO riceve gli strumenti (activeTools a inizio turno)
    const tools = await activeTools('bot-v5')
    expect(tools.map((t) => t.name)).toContain('mcp__finto-v5__elenca')
  })
})
