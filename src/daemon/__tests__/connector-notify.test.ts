// Test della notifica di connessione (fase 5): quando l'utente connette un
// connettore offerto dal bot, gli agenti con offerte pendenti ricevono un job
// 'user-message' con meta.initiator 'CONNECTOR_CONNECTED' e le offerte si
// marcano meta.connected (niente doppie notifiche).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setDataDir, dataDir, createAgent, appendEntry, updateEntryMeta, getEntries, db } = await import('../../main/store/db')
const { notifyConnectorConnected } = await import('../api')

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

    // un solo job user-message, per l'agente con l'offerta pendente
    const rows = db().prepare("SELECT agent_id, payload_json FROM jobs WHERE kind = 'user-message'").all() as Array<{ agent_id: string; payload_json: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agent_id).toBe(a1.id)
    const payload = JSON.parse(rows[0]!.payload_json) as { initiator?: string; text: string }
    expect(payload.initiator).toBe('CONNECTOR_CONNECTED')
    expect(payload.text).toContain('Gmail')
    // l'offerta pendente è marcata connessa (non ri-notificare alla prossima)
    expect(getEntries(a1.id).find((x) => x.kind === 'send-message')?.meta?.connected).toBe(true)
    // il worker è stato svegliato (il job parte al prossimo tick)
    expect(pokes).toBe(1)
  })
})
