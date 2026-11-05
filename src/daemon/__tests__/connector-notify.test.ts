// Test della notifica di connessione (fase 5): quando l'utente connette un
// connettore offerto dal bot, gli agenti con offerte pendenti ricevono un job
// 'user-message' con meta.initiator 'CONNECTOR_CONNECTED' e le offerte si
// marcano meta.connected (niente doppie notifiche).
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setDataDir, dataDir, createAgent, appendEntry, updateEntryMeta, getEntries, setSetting, db } = await import('../../main/store/db')
const { notifyConnectorConnected, notifyMcpServerConnected, notifyComposioAppConnected } = await import('../api')

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-connnotify-test-'))
  setDataDir(root)
  dataDir()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Un'offerta di connessione nel transcript di un agente. */
function offerEntry(agentId: string, connectorId: string, name: string): number {
  return appendEntry({
    agentId, kind: 'send-message', role: 'assistant', content: name,
    meta: { message: { type: 'connector', connectorId, name }, call: { id: 'c', name: 'offer_connector', arguments: '{}' }, status: 'pending' }
  }).id
}

describe('notifyConnectorConnected (CONNECTOR_CONNECTED)', () => {
  it('agenti con offerta pendente ricevono il job initiator; offerte già connesse o altre app no', async () => {
    const a1 = createAgent('Con offerta')
    const a2 = createAgent('Offerta già soddisfatta')
    const a3 = createAgent('Senza offerte')
    offerEntry(a1.id, 'gmail', 'Gmail')
    const done = offerEntry(a2.id, 'gmail', 'Gmail')
    // quell'offerta è già stata soddisfatta in passato
    const e = getEntries(a2.id).find((x) => x.id === done)!
    updateEntryMeta(done, { ...e.meta, connected: true })

    let pokes = 0
    await notifyConnectorConnected('gmail', 'Gmail', () => undefined, { poke: () => pokes++ } as never)
    // fase 17c (C2, MU): il TESTO per il modello resta inglese (prefisso [sistema])
    // e il payload porta extraMeta.ui per la vista nella lingua dell'interfaccia

    // un solo job user-message, per l'agente con l'offerta pendente
    const rows = db().prepare("SELECT agent_id, payload_json FROM jobs WHERE kind = 'user-message'").all() as Array<{ agent_id: string; payload_json: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agent_id).toBe(a1.id)
    const payload = JSON.parse(rows[0]!.payload_json) as { initiator?: string; text: string }
    expect(payload.initiator).toBe('CONNECTOR_CONNECTED')
    expect(payload.text).toContain('Gmail')
    expect(payload.text).toMatch(/^\[sistema\] The user connected Gmail/)
    const extra = (payload as { extraMeta?: { ui?: { id: string; values?: Record<string, string> } } }).extraMeta
    expect(extra?.ui?.id).toBe('sistema.connectorConnected')
    expect(extra?.ui?.values).toEqual({ name: 'Gmail', connectorId: 'gmail' })
    // l'offerta pendente è marcata connessa (non ri-notificare alla prossima)
    expect(getEntries(a1.id).find((x) => x.kind === 'send-message')?.meta?.connected).toBe(true)
    // il worker è stato svegliato (il job parte al prossimo tick)
    expect(pokes).toBe(1)
  })
})


/** Una card "Aggiungi server MCP" nel transcript di un agente (fase mcp-setup). */
function mcpCardEntry(agentId: string, cardId: string, name: string): number {
  return appendEntry({
    agentId, kind: 'send-message', role: 'assistant', content: name,
    meta: { message: { type: 'mcp-server', id: cardId, name, trust: 'unverified', trustKind: 'github-account', runtime: { kind: 'remote', host: '{mattermost_host}' }, needs: { kind: 'oauth' }, setup: { urlVariables: [], auth: 'oauth' } }, call: { id: 'c', name: 'add_mcp_server', arguments: '{}' }, status: 'installed' }
  }).id
}

describe('fase mcp-setup (M5.2): notifyMcpServerConnected', () => {
  it('le card del server collegato si marcano connected e il bot riceve CONNECTOR_CONNECTED col prefisso mcp__ (R1: dal toolSlug della config, non dal nome)', async () => {
    const a1 = createAgent('Con card Mattermost')
    const a2 = createAgent('Card già soddisfatta')
    mcpCardEntry(a1.id, 'registry:io.github.mattermost/mattermost-plugin-agents', 'Mattermost')
    const done = mcpCardEntry(a2.id, 'registry:io.github.mattermost/mattermost-plugin-agents', 'Mattermost')
    const e = getEntries(a2.id).find((x) => x.id === done)!
    updateEntryMeta(done, { ...e.meta, connected: true })
    // una card di ALTRO server non c'entra
    mcpCardEntry(a1.id, 'registry:altro/server', 'Altro')

    let pokes = 0
    await notifyMcpServerConnected(['registry:io.github.mattermost/mattermost-plugin-agents'], { name: 'Mattermost', toolSlug: 'mattermost' }, () => undefined, { poke: () => pokes++ } as never)

    // il db dei job è condiviso col test di prima: si filtrano per agente
    const rows = db().prepare("SELECT agent_id, payload_json FROM jobs WHERE kind = 'user-message' AND agent_id = ?").all(a1.id) as Array<{ agent_id: string; payload_json: string }>
    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0]!.payload_json) as { initiator?: string; text: string; extraMeta?: { ui?: { id: string; values?: Record<string, string> } } }
    expect(payload.initiator).toBe('CONNECTOR_CONNECTED')
    expect(payload.text).toBe('[sistema] The user connected Mattermost: its mcp__mattermost__* tools are now available.')
    expect(payload.extraMeta?.ui?.id).toBe('sistema.serverConnected')
    expect(payload.extraMeta?.ui?.values).toEqual({ name: 'Mattermost', prefix: 'mcp__mattermost' })
    // la card pendente è connessa, le altre no
    const entries = getEntries(a1.id).filter((x) => x.kind === 'send-message')
    expect(entries.find((x) => (x.meta?.message as { id?: string }).id === 'registry:io.github.mattermost/mattermost-plugin-agents')?.meta?.connected).toBe(true)
    expect(entries.find((x) => (x.meta?.message as { id?: string }).id === 'registry:altro/server')?.meta?.connected).toBeUndefined()
    expect(pokes).toBe(1)
  })

  it('R1: il prefisso è toolSlugOf(cfg) — un titolo che cambia non lo trascina più (slug congelato anche «-2»)', async () => {
    const a1 = createAgent('Con card Notion dal registro')
    mcpCardEntry(a1.id, 'registry:com.notion/mcp', 'Notion')
    await notifyMcpServerConnected(['registry:com.notion/mcp'], { name: 'Notion', toolSlug: 'notion-2' }, () => undefined, { poke: () => undefined } as never)
    const rows = db().prepare("SELECT payload_json FROM jobs WHERE kind = 'user-message' AND agent_id = ?").all(a1.id) as Array<{ payload_json: string }>
    const payload = JSON.parse(rows.at(-1)!.payload_json) as { text: string; extraMeta?: { ui?: { values?: Record<string, string> } } }
    expect(payload.text).toBe('[sistema] The user connected Notion: its mcp__notion-2__* tools are now available.')
    expect(payload.extraMeta?.ui?.values).toEqual({ name: 'Notion', prefix: 'mcp__notion-2' })
  })
})

describe('fase prefisso-offerta (P2): il ripiego di notifyConnectorConnected non indovina più l\'id', () => {
  it('server NON registrato → prefisso dal NOME come farebbe la registrazione (gcalendar «Google Calendar» → mcp__google-calendar__*) e UN warn col solo id', async () => {
    const a1 = createAgent('Offerta gcalendar senza server')
    offerEntry(a1.id, 'gcalendar', 'Google Calendar')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // le chiamate si catturano PRIMA del mockRestore (il restore le azzera)
    let lines: string[] = []
    try {
      await notifyConnectorConnected('gcalendar', 'Google Calendar', () => undefined, { poke: () => undefined } as never)
      lines = warn.mock.calls.map((c) => String(c[0]))
    } finally {
      warn.mockRestore()
    }
    // caso che non dovrebbe succedere: UNA riga di warn, col SOLO id (niente dati dell'utente)
    const mine = lines.filter((l) => l.includes('gcalendar'))
    expect(mine).toHaveLength(1)
    expect(mine[0]).not.toContain('Google Calendar')
    const rows = db().prepare("SELECT payload_json FROM jobs WHERE kind = 'user-message' AND agent_id = ?").all(a1.id) as Array<{ payload_json: string }>
    const payload = JSON.parse(rows.at(-1)!.payload_json) as { text: string; extraMeta?: { ui?: { values?: Record<string, string> } } }
    expect(payload.text).toBe('[sistema] The user connected Google Calendar: its mcp__google-calendar__* tools are now available (find the exact names with your tools or by asking the user).')
    expect(payload.extraMeta?.ui?.values).toEqual({ name: 'Google Calendar', connectorId: 'google-calendar' })
  })

  it('server registrato con toolSlug rinumerato → il messaggio dice il prefisso VERO (mcp__google-calendar-2__*)', async () => {
    const a1 = createAgent('Offerta gcalendar con server -2')
    offerEntry(a1.id, 'gcalendar', 'Google Calendar')
    setSetting('mcp.servers', [{
      id: 'srv-cal', name: 'Google Calendar', transport: 'http' as const, url: 'https://calendarmcp.googleapis.com/mcp/v1',
      enabled: true, catalogId: 'gcalendar', toolSlug: 'google-calendar-2'
    }])
    try {
      await notifyConnectorConnected('gcalendar', 'Google Calendar', () => undefined, { poke: () => undefined } as never)
    } finally {
      setSetting('mcp.servers', [])
    }
    const rows = db().prepare("SELECT payload_json FROM jobs WHERE kind = 'user-message' AND agent_id = ?").all(a1.id) as Array<{ payload_json: string }>
    const payload = JSON.parse(rows.at(-1)!.payload_json) as { text: string }
    expect(payload.text).toBe('[sistema] The user connected Google Calendar: its mcp__google-calendar-2__* tools are now available (find the exact names with your tools or by asking the user).')
  })
})

describe('fase mcp-setup (M5.3): notifyComposioAppConnected (via Composio dalla card di una curata diretta)', () => {
  it('un\'app ACTIVE con offerta pendente per la DIRETTA dello stesso marchio: notifica UNA volta sola, con i nomi composio__', async () => {
    const a1 = createAgent('Con offerta Gmail diretta')
    offerEntry(a1.id, 'gmail', 'Gmail')
    const worker = { poke: () => undefined } as never
    await notifyComposioAppConnected('gmail', 'Gmail', () => undefined, worker)
    let rows = db().prepare("SELECT payload_json FROM jobs WHERE kind = 'user-message'").all() as Array<{ payload_json: string }>
    const mine = rows.map((r) => JSON.parse(r.payload_json) as { text: string; initiator?: string; extraMeta?: { ui?: { id: string } } })
      .filter((p) => p.initiator === 'CONNECTOR_CONNECTED' && p.text.includes('via Composio'))
    expect(mine).toHaveLength(1)
    expect(mine[0]!.text).toBe('[sistema] The user connected Gmail (via Composio): its composio__gmail__* tools are now available (find the exact names with find_tools).')
    expect(mine[0]!.extraMeta?.ui?.id).toBe('sistema.composioAppConnected')
    // la seconda volta NESSUNA nuova notifica (l'offerta è già connessa)
    await notifyComposioAppConnected('gmail', 'Gmail', () => undefined, worker)
    rows = db().prepare("SELECT payload_json FROM jobs WHERE kind = 'user-message'").all() as Array<{ payload_json: string }>
    expect(rows.map((r) => JSON.parse(r.payload_json) as { text: string }).filter((p) => p.text.includes('via Composio'))).toHaveLength(1)
    // uno slug SENZA curata diretta dello stesso marchio non notifica nessuno
    await notifyComposioAppConnected('slug-senza-diretta', 'X', () => undefined, worker)
    rows = db().prepare("SELECT payload_json FROM jobs WHERE kind = 'user-message'").all() as Array<{ payload_json: string }>
    expect(rows.map((r) => JSON.parse(r.payload_json) as { text: string }).filter((p) => p.text.includes('via Composio'))).toHaveLength(1)
  })
})
