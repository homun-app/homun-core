// RV4 (fase beta.2), punto 3 — aggiornato da OA5 (fase onboarding-a).
// UN invio senza modello ora SCRIVE il messaggio utente nel transcript (non
// si perde più) e sotto c'è UNA riga notice.needModel col bottone che apre
// il passo model della guida; il turno si TRATTIENE (TurnHeldForModel: il
// job riparte da solo quando un modello arriva). La riga non si DUBLICA su
// più invii in attesa: una basta.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setDataDir, dataDir, db, createAgent, getEntries, setSetting } from '../../store/db'
import { runTurn } from '../loop'
import { TurnHeldForModel } from '../turn-held'
import { TEST_TMP_BASE } from '../../../test-tmp'
import type { SandbotEvent } from '../../../shared/types'

let dir: string
let agentId: string

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-rv4-nomodel-'))
  setDataDir(dir)
  dataDir()
  db()
  setSetting('ui.activeLanguage', 'it')
  agentId = createAgent('Trello', '').id
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('RV4+OA5: senza modello, il messaggio RESTA e la riga dell\'attesa è UNA', () => {
  it('runTurn senza provider né modello principale: messaggio utente scritto, UNA notice.needModel, turno trattenuto', async () => {
    const events: SandbotEvent[] = []
    await expect(runTurn(agentId, 'ehi, ci sei?', (e) => events.push(e))).rejects.toBeInstanceOf(TurnHeldForModel)
    const entries = getEntries(agentId)
    const messages = entries.filter((en) => en.kind === 'message')
    expect(messages, 'il messaggio utente RESTA nel transcript anche senza modello').toHaveLength(1)
    expect(messages[0]!.content).toContain('ehi, ci sei?')
    const notices = entries.filter((en) => en.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect((notices[0]!.meta as { ui?: { id?: string } })?.ui?.id).toBe('notice.needModel')
    // l'utente vede subito sia il suo messaggio sia la riga
    expect(events.filter((e) => e.type === 'entries')).toHaveLength(2)
  })

  it('un SECONDO invio in attesa: un altro messaggio utente, MA la riga dell\'attesa NON si duplica', async () => {
    await expect(runTurn(agentId, 'ancora qui?', () => undefined)).rejects.toBeInstanceOf(TurnHeldForModel)
    const entries = getEntries(agentId)
    expect(entries.filter((en) => en.kind === 'message')).toHaveLength(2)
    expect(entries.filter((en) => en.kind === 'notice')).toHaveLength(1)
  })
})
