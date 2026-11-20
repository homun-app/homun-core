// E1 (fase mcp-env): il processo stdio FINTO riceve le variabili. Un mini
// server MCP (JSON-RPC a righe su stdio) espone come NOME di un tool i valori
// di MATTERMOST_TOKEN/MATTERMOST_URL che gli arrivano nell'ambiente: se la
// variabile segreta (fornita dal resolver, come farebbe lo store cifrato) e
// quella non segreta (dalla config) arrivano, i nomi dei tool le contengono.
// E il comando semplice «npx» si risolve dal PATH con una SHIM finta.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir } from '../../store/db'
import { saveServers, testServer, disconnectServer, setMcpAuthResolver, listServers } from '../index'
import { setCommandLookupForTests } from '../command-path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const FAKE_SERVER = [
  "import { readFileSync } from 'node:fs'",
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
  '    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [',
  '      { name: "tok_" + (process.env.MATTERMOST_TOKEN ?? "MANCA"), description: "env", inputSchema: { type: "object" } },',
  '      { name: "url_" + (process.env.MATTERMOST_URL ?? "MANCA"), description: "env", inputSchema: { type: "object" } }',
  '    ] } })',
  '    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })',
  '  }',
  '})'
].join('\n')

let dir: string
let fakeServerPath: string
let shimDir: string
const realPath = process.env.PATH

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE ?? tmpdir(), 'sandbot-e1-spawn-'))
  setDataDir(dir)
  fakeServerPath = join(dir, 'finto-mcp.mjs')
  writeFileSync(fakeServerPath, FAKE_SERVER, { mode: 0o644 })
  // la shim «npx»: uno script di shell che esegue il server finto con node
  shimDir = join(dir, 'shim-bin')
  mkdirSync(shimDir)
  writeFileSync(join(shimDir, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${fakeServerPath}" "$@"\n`, { mode: 0o755 })
  chmodSync(join(shimDir, 'npx'), 0o755)
})

afterAll(() => {
  setMcpAuthResolver(() => ({}))
  setCommandLookupForTests(null)
  for (const s of listServers()) disconnectServer(s.id)
  process.env.PATH = realPath
  rmSync(dir, { recursive: true, force: true })
})

describe('E1: il processo stdio riceve le variabili del server manuale', () => {
  it('segreto (dal resolver) e non segreto (dalla config) arrivano entrambi al processo', async () => {
    // come il resolver VERO: envValues (config) + segreti (store) fusi
    setMcpAuthResolver(async () => ({ stdioEnv: { MATTERMOST_TOKEN: 'segretafinta', MATTERMOST_URL: 'mm.example' } }))
    const id = 'mcp_e1_spawn'
    saveServers([{
      id, name: 'mattermost finto', transport: 'stdio',
      command: process.execPath, args: [fakeServerPath], enabled: true,
      envSpec: [{ name: 'MATTERMOST_URL', secret: false }, { name: 'MATTERMOST_TOKEN', secret: true }],
      envValues: { MATTERMOST_URL: 'mm.example' }
    }])
    const r = await testServer(id)
    if (!r.ok) expect(r.ok, r.error).toBe(true)
    expect((r.tools ?? []).some((t) => t.includes('tok_segretafinta'))).toBe(true)
    expect((r.tools ?? []).some((t) => t.includes('url_mm.example'))).toBe(true)
    disconnectServer(id)
  })

  it('il comando semplice «npx» si risolve dal PATH (shim finta) e il server parte', async () => {
    setMcpAuthResolver(async () => ({ stdioEnv: { MATTERMOST_URL: 'via-npx.example' } }))
    // il lookup passa da qui: PATH con la sola shim (niente risoluzioni ambigue)
    setCommandLookupForTests((cmd) => (cmd === 'npx' ? { command: join(shimDir, 'npx') } : { command: cmd }))
    const id = 'mcp_e1_npx'
    saveServers([{
      id, name: 'npx finto', transport: 'stdio',
      command: 'npx', args: ['-y', '@donach/mattermost-mcp'], enabled: true,
      envSpec: [{ name: 'MATTERMOST_URL', secret: false }],
      envValues: { MATTERMOST_URL: 'via-npx.example' }
    }])
    const r = await testServer(id)
    expect(r.ok, r.error).toBe(true)
    expect((r.tools ?? []).some((t) => t.includes('url_via-npx.example'))).toBe(true)
    disconnectServer(id)
  })
})
