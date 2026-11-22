// V6 (fase stato-vivo): il click su Attiva/Non ora della scheda
// offer_enable_plugin. Attiva fa quello che fa l'interruttore V5 (accende,
// toglie il motivo, lancia il test U5) e — SOLO se il test riesce — il daemon
// accoda un TURNO NUOVO dello stesso bot (initiator PLUGIN_ENABLED_RESUME)
// con la nota fissa inglese «The user turned on <nome ripulito> (N tools).
// Resume the user's last request.»: gli strumenti si caricano a inizio
// turno. Se il test fallisce: nessuna ripresa, la scheda mostra la
// categoria X2. Un click solo: due click non accodano due job.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir, db, createAgent, appendEntry, getEntries } from '../../main/store/db'
import { saveServers, disconnectServer } from '../../main/mcp'
import { resolveEnablePluginCard } from '../api'
import { TEST_TMP_BASE } from '../../test-tmp'

// il server stdio FINTO che FUNZIONA (come E1); quello ROTTO è un comando che non esiste
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
  '    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "uno", description: "x", inputSchema: { type: "object" } }, { name: "due", description: "x", inputSchema: { type: "object" } }] } })',
  '    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })',
  '  }',
  '})'
].join('\n')

let root: string
let fakeServerPath: string
let agentId: string

/** i job user-message accodati (le note di sistema, la ripresa V6). */
const userMessageJobs = (): Array<{ agent_id: string; payload_json: string }> =>
  db().prepare("SELECT agent_id, payload_json FROM jobs WHERE kind = 'user-message'").all() as Array<{ agent_id: string; payload_json: string }>

beforeAll(() => {
  root = mkdtempSync(join(TEST_TMP_BASE ?? tmpdir(), 'sandbot-v6-enable-'))
  setDataDir(root)
  fakeServerPath = join(root, 'finto-mcp.mjs')
  writeFileSync(fakeServerPath, FAKE_SERVER, { mode: 0o644 })
  agentId = createAgent('Competitoor').id
})
afterAll(() => {
  for (const id of ['srv-v6-ok', 'srv-v6-ko', 'srv-v6-nome']) disconnectServer(id)
  rmSync(root, { recursive: true, force: true })
})

/** La scheda pendente nel transcript, come la crea il tool offer_enable_plugin. */
const mkCard = (pluginId: string, name: string): number =>
  appendEntry({
    agentId, kind: 'send-message', role: 'assistant', content: name,
    meta: { message: { type: 'enable-plugin', pluginId, name, reason: 'mi serve' }, status: 'pending' }
  }).id

const worker = { poke: () => undefined } as never

describe('V6: resolveEnablePluginCard — Attiva / Non ora', () => {
  it('«Attiva» col server finto che RISPONDE: enabled true, un job PLUGIN_ENABLED_RESUME con la nota fissa e il nome RIPULITO', async () => {
    saveServers([{ id: 'srv-v6-ok', name: 'orion\nmoon<b>', transport: 'stdio', command: process.execPath, args: [fakeServerPath], enabled: false, disabledReason: 'never-connected' }])
    const entryId = mkCard('srv-v6-ok', 'orion\nmoon<b>')
    const r = await resolveEnablePluginCard(agentId, entryId, 'enable', () => undefined, worker)
    expect(r).toEqual({ ok: true, status: 'activated' })
    const { listServers } = await import('../../main/mcp')
    const cfg = listServers().find((s) => s.id === 'srv-v6-ok')!
    expect(cfg.enabled).toBe(true)
    expect(cfg.disabledReason).toBeUndefined()
    const jobs = userMessageJobs().filter((j) => j.agent_id === agentId)
    expect(jobs).toHaveLength(1)
    const payload = JSON.parse(jobs[0]!.payload_json) as { initiator?: string; text: string }
    expect(payload.initiator).toBe('PLUGIN_ENABLED_RESUME')
    // la nota è FISSA (inglese, nessun testo del server) e il nome è ripulito
    // X2: niente a capo né < > (il resto del «tag» resta: è il comportamento di sanitizeServerNoteName)
    expect(payload.text).toBe('The user turned on orion moonb (2 tools). Resume the user\'s last request.')
    // la scheda è chiusa col conteggio
    const entry = getEntries(agentId).find((e) => e.id === entryId)!
    expect(entry.meta?.status).toBe('activated')
    expect(entry.meta?.toolsCount).toBe(2)
  })

  it('«Attiva» col server che NON risponde: NESSUN job, la scheda dice «non parte» con la categoria', async () => {
    saveServers([{ id: 'srv-v6-ko', name: 'rotto', transport: 'stdio', command: '/non/esiste/prog', enabled: false }])
    const entryId = mkCard('srv-v6-ko', 'rotto')
    const before = userMessageJobs().length
    const r = await resolveEnablePluginCard(agentId, entryId, 'enable', () => undefined, worker)
    expect(r).toEqual({ ok: true, status: 'failed' })
    expect(userMessageJobs().length).toBe(before)
    const entry = getEntries(agentId).find((e) => e.id === entryId)!
    expect(entry.meta?.status).toBe('failed')
    expect(entry.meta?.category).toBe('command-not-found')
    // il server resta acceso (non si rispegne da solo: l'utente vede «non parte · Vedi perché»)
    const { listServers } = await import('../../main/mcp')
    expect(listServers().find((s) => s.id === 'srv-v6-ko')!.enabled).toBe(true)
  })

  it('doppio click → UN SOLO job (la scheda chiusa blocca il secondo)', async () => {
    saveServers([{ id: 'srv-v6-nome', name: 'lento', transport: 'stdio', command: process.execPath, args: [fakeServerPath], enabled: false }])
    const entryId = mkCard('srv-v6-nome', 'lento')
    const resumeJobs = (): number => userMessageJobs().filter((j) => j.agent_id === agentId && JSON.parse(j.payload_json).initiator === 'PLUGIN_ENABLED_RESUME').length
    const before = resumeJobs()
    const first = await resolveEnablePluginCard(agentId, entryId, 'enable', () => undefined, worker)
    expect(first).toEqual({ ok: true, status: 'activated' })
    await expect(resolveEnablePluginCard(agentId, entryId, 'enable', () => undefined, worker)).rejects.toThrow()
    expect(resumeJobs()).toBe(before + 1)
  })

  it('«Non ora»: la scheda si chiude, NESSUN job e il server resta spento', async () => {
    saveServers([{ id: 'srv-v6-ko', name: 'rotto', transport: 'stdio', command: '/non/esiste/prog', enabled: false }])
    const entryId = mkCard('srv-v6-ko', 'rotto')
    const before = userMessageJobs().length
    const r = await resolveEnablePluginCard(agentId, entryId, 'not-now', () => undefined, worker)
    expect(r).toEqual({ ok: true, status: 'declined' })
    expect(userMessageJobs().length).toBe(before)
    const entry = getEntries(agentId).find((e) => e.id === entryId)!
    expect(entry.meta?.status).toBe('declined')
    const { listServers } = await import('../../main/mcp')
    expect(listServers().find((s) => s.id === 'srv-v6-ko')!.enabled).toBe(false)
  })
})
