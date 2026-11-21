// U4 (fase mcp-ui): il server stdio TROVA anche «node». Il bug vero dell'uso
// del 20/11: npx risolto nella cartella fnm (~/.local/share/fnm/aliases/
// default/bin) parte, ma è uno script «#!/usr/bin/env node» e il processo
// figlio ha il PATH ridotto dell'app aperta dal Finder → «env: node: No such
// file or directory». La cartella del comando risolto deve andare IN TESTA al
// PATH del figlio. Qui il caso INTERO dal vivo: shim npx «#!/usr/bin/env node»
// + node FINTO nella stessa cartella fnm, PATH di base SENZA quella cartella
// (e senza nessun node): senza la correzione il server NON parte; con la
// correzione parte e il PATH del figlio COMINCIA per la cartella risolta.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { setDataDir } from '../../store/db'
import { saveServers, testServer, disconnectServer, setMcpAuthResolver, listServers } from '../index'
import { resolveServerCommand, setCommandLookupForTests } from '../command-path'
import { TEST_TMP_BASE } from '../../../test-tmp'

// il server MCP finto gira come «pacchetto» lanciato dalla shim npx; espone
// come NOME di un tool la PRIMA voce del PATH che ha ricevuto (la prova che
// la cartella risolta sta in testa) — sanitize per stare in un nome tool
const FAKE_NPX = [
  '#!/usr/bin/env node',
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
  '    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "finto-npx", version: "1" } } })',
  '    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [',
  '      { name: "first_" + String(process.env.PATH ?? "").split(":")[0].replace(/[^a-zA-Z0-9]/g, "_"), description: "la prima voce del PATH del figlio", inputSchema: { type: "object" } },',
  '      { name: "second_" + String(process.env.PATH ?? "").split(":")[1].replace(/[^a-zA-Z0-9]/g, "_"), description: "la seconda voce del PATH del figlio", inputSchema: { type: "object" } }',
  '    ] } })',
  '    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })',
  '  }',
  '})'
].join('\n')

let dir: string
let fnmBin: string
const realPath = process.env.PATH

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE ?? tmpdir(), 'sandbot-u4-path-'))
  setDataDir(dir)
  // la cartella fnm di una HOME finta, come quella vera dell'utente
  const home = join(dir, 'home')
  fnmBin = join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin')
  mkdirSync(fnmBin, { recursive: true })
  // la shim npx: shebang «#!/usr/bin/env node» (il caso vero)
  writeFileSync(join(fnmBin, 'npx'), FAKE_NPX, { mode: 0o755 })
  chmodSync(join(fnmBin, 'npx'), 0o755)
  // il node FINTO accanto: niente lookup nel PATH, il percorso è assoluto
  writeFileSync(join(fnmBin, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 })
  chmodSync(join(fnmBin, 'node'), 0o755)
  // il PATH del processo (il «PATH ridotto del Finder»): né fnm, né node
  process.env.PATH = '/usr/bin:/bin'
  // il lookup VERO di connect(), con la HOME finta del fnm e il PATH ridotto
  setCommandLookupForTests((cmd) =>
    resolveServerCommand(cmd, { existsSync, readdirSync, home, envPath: '/usr/bin:/bin' }))
})

afterAll(() => {
  setMcpAuthResolver(() => ({}))
  setCommandLookupForTests(null)
  for (const s of listServers()) disconnectServer(s.id)
  process.env.PATH = realPath
  rmSync(dir, { recursive: true, force: true })
})

describe('U4: la cartella del comando risolto va IN TESTA al PATH del figlio', () => {
  it('shim npx «#!/usr/bin/env node» con node finto nella cartella fnm, PATH ridotto → il server PARTE', async () => {
    setMcpAuthResolver(async () => ({}))
    const id = 'mcp_u4_npx'
    saveServers([{
      id, name: 'mattermost finto', transport: 'stdio',
      command: 'npx', args: ['-y', '@donach/mattermost-mcp'], enabled: true
    }])
    const r = await testServer(id)
    // senza la correzione: «env: node: No such file or directory» (il figlio
    // non trova node nel PATH ridotto) e il server NON risponde
    expect(r.ok, r.ok ? '' : `error: ${r.error}`).toBe(true)
    const first = (r.tools ?? []).find((t) => t.includes('first_')) ?? ''
    expect(first.endsWith(`first_${fnmBin.replace(/[^a-zA-Z0-9]/g, '_')}`)).toBe(true)
    disconnectServer(id)
  })

  it('il PATH dell\'utente nelle variabili del server si rispetta, con la cartella risolta comunque IN TESTA', async () => {
    setMcpAuthResolver(async () => ({ stdioEnv: { MATTERMOST_URL: 'mm.example', PATH: '/Users/prova/bin:/opt/altro' } }))
    const id = 'mcp_u4_user_path'
    saveServers([{
      id, name: 'mattermost finto path utente', transport: 'stdio',
      command: 'npx', args: [], enabled: true
    }])
    const r = await testServer(id)
    expect(r.ok, r.ok ? '' : `error: ${r.error}`).toBe(true)
    // la prima voce è la cartella RISOLTA, poi il PATH dell'utente intatto
    const first = (r.tools ?? []).find((t) => t.includes('first_')) ?? ''
    const second = (r.tools ?? []).find((t) => t.includes('second_')) ?? ''
    expect(first.endsWith(`first_${fnmBin.replace(/[^a-zA-Z0-9]/g, '_')}`)).toBe(true)
    expect(second.endsWith('second__Users_prova_bin')).toBe(true)
    disconnectServer(id)
  })
})

// la parte PURA del PATH del figlio (serverCommandEnv) sta in command-path.test.ts
