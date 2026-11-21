// U5 (fase mcp-ui): dopo import/aggiunta/modifica il test di connessione
// parte da solo e i BOT ABILITATI ricevono la nota di sistema (initiator
// CONNECTOR_INSTALLED, come le card dei connettori): «Server MCP collegato:
// orion-moon (12 strumenti)» oppure «mattermost non parte: <errore>».
// Il testo per il modello resta inglese; meta.ui porta la lingua dell'interfaccia.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../test-tmp'

const { setDataDir, dataDir, createAgent, db } = await import('../../main/store/db')
const { notifyMcpServerState } = await import('../api')

let root: string
beforeAll(() => {
  root = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mcpnote-test-'))
  setDataDir(root)
  dataDir()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** i job user-message accodati (le note di sistema). */
const userMessageJobs = (): Array<{ agent_id: string; payload_json: string }> =>
  db().prepare("SELECT agent_id, payload_json FROM jobs WHERE kind = 'user-message'").all() as Array<{ agent_id: string; payload_json: string }>

describe('U5: notifyMcpServerState — la nota ai bot abilitati', () => {
  it('server collegato: i bot con enabledFor ["*"] ricevono «Server MCP collegato» con il NUMERO di strumenti', async () => {
    const a = createAgent('Competitoor')
    let pokes = 0
    await notifyMcpServerState(
      { name: 'orion-moon', toolSlug: 'orion_moon', enabledFor: ['*'] },
      { ok: true, tools: ['mcp__orion_moon__a', 'mcp__orion_moon__b', 'mcp__orion_moon__c', 'mcp__orion_moon__d', 'mcp__orion_moon__e', 'mcp__orion_moon__f', 'mcp__orion_moon__g', 'mcp__orion_moon__h', 'mcp__orion_moon__i', 'mcp__orion_moon__j', 'mcp__orion_moon__k', 'mcp__orion_moon__l'] },
      () => undefined,
      { poke: () => pokes++ } as never
    )
    const rows = userMessageJobs().filter((r) => r.agent_id === a.id)
    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0]!.payload_json) as { initiator?: string; text: string; extraMeta?: { ui?: { id: string; values?: Record<string, string> } } }
    expect(payload.initiator).toBe('CONNECTOR_INSTALLED')
    expect(payload.text).toMatch(/^\[sistema\] Server MCP "orion-moon" connected/)
    expect(payload.text).toContain('12 tools')
    expect(payload.text).toContain('mcp__orion_moon__')
    expect(payload.text).toContain('find_tools')
    expect(payload.extraMeta?.ui?.id).toBe('sistema.mcpServerOk')
    expect(payload.extraMeta?.ui?.values).toMatchObject({ name: 'orion-moon', count: 12 })
    expect(pokes).toBe(1)
  })

  it('server che NON parte: la nota dice «non parte» con l\'errore leggibile', async () => {
    const a = createAgent('Bot della posta')
    await notifyMcpServerState(
      { name: 'mattermost', enabledFor: [a.id] },
      // X2 (fase sicurezza-beta16): come lo produce testServer da oggi — la
      // category arriva dal codice/tipo d'errore, non dal testo
      { ok: false, error: 'comando "npx" non trovato: usa il percorso completo', category: 'command-not-found' },
      () => undefined,
      { poke: () => undefined } as never
    )
    const rows = userMessageJobs().filter((r) => r.agent_id === a.id)
    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0]!.payload_json) as { text: string; extraMeta?: { ui?: { id: string; values?: Record<string, string> } } }
    expect(payload.text).toBe('[sistema] Server MCP "mattermost" does not start: command not found.')
    // il testo libero dell'errore NON entra nel messaggio al modello
    expect(payload.text).not.toContain('usa il percorso completo')
    expect(payload.extraMeta?.ui?.id).toBe('sistema.mcpServerFail')
    expect(payload.extraMeta?.ui?.values).toMatchObject({ name: 'mattermost', error: 'comando "npx" non trovato: usa il percorso completo' })
  })

  it('SOLO i bot per cui il server è abilitato (enabledFor), non tutti', async () => {
    const a1 = createAgent('Abilitato')
    const a2 = createAgent('Non abilitato')
    await notifyMcpServerState(
      { name: 'privato', enabledFor: [a1.id] },
      { ok: true, tools: ['mcp__privato__x'] },
      () => undefined,
      { poke: () => undefined } as never
    )
    const rows = userMessageJobs()
    expect(rows.some((r) => r.agent_id === a1.id)).toBe(true)
    expect(rows.some((r) => r.agent_id === a2.id)).toBe(false)
  })

  it('la nota NON apre un turno quando il bot ha il server ma la chat è sua (nessun initiator doppio per lo stesso salvataggio)', async () => {
    // la funzione accoda UNA nota per bot: due chiamate = due note (un
    // salvataggio chiama UNA volta); qui si verifica che non ci siano
    // duplicati DENTRO una sola chiamata
    const a = createAgent('Bot unico')
    db().prepare('DELETE FROM jobs').run()
    await notifyMcpServerState({ name: 'uno', enabledFor: ['*'] }, { ok: true, tools: ['t1'] }, () => undefined, { poke: () => undefined } as never)
    expect(userMessageJobs().filter((r) => r.agent_id === a.id)).toHaveLength(1)
  })
})
