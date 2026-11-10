// RV4 (fase beta.2), punto 3 — la CAUSA della notice vista due volte.
// Test di CARATTERIZZAZIONE (verde per costruzione: descrive com'è il
// prodotto di oggi, il difetto non è qui): UN invio senza modello produce
// ESATTAMENTE UNA notice notice.configureProviderFirst e NON scrive il
// messaggio utente nel transcript (il turno torna prima di aprirlo) — due
// invii producono due notice CONSECUTIVE senza niente in mezzo, che
// all'utente appaiono raddoppiate. Il rimedio è il raggruppamento nel
// renderer (groupRepeatedNotices, testato a parte): qui si inchioda la causa
// perché non venga «corretto» il lato sbagliato.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setDataDir, dataDir, db, createAgent, getEntries, setSetting } from '../../store/db'
import { runTurn } from '../loop'
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

describe('RV4: senza modello, UN invio → UNA notice (e il messaggio utente non si scrive)', () => {
  it('runTurn senza provider e senza modello principale: una notice sola, zero entry messaggio', async () => {
    const events: SandbotEvent[] = []
    await runTurn(agentId, 'ehi, ci sei?', (e) => events.push(e))
    const entries = getEntries(agentId)
    const notices = entries.filter((en) => en.kind === 'notice')
    const messages = entries.filter((en) => en.kind === 'message')
    expect(notices).toHaveLength(1)
    expect((notices[0]!.meta as { ui?: { id?: string } })?.ui?.id).toBe('notice.configureProviderFirst')
    expect(messages, 'il messaggio utente NON finisce nel transcript senza modello').toHaveLength(0)
  })

  it('un SECONDO invio: un’altra notice — due di fila, identiche, con niente in mezzo', async () => {
    await runTurn(agentId, 'ehi, ci sei?', () => undefined)
    const entries = getEntries(agentId)
    const notices = entries.filter((en) => en.kind === 'notice')
    expect(notices).toHaveLength(2)
    // identiche (stesso id UI) e CONSECUTIVE: gli ultimi due elementi del
    // transcript sono le due notice, senza altro in mezzo
    const lastTwo = entries.slice(-2)
    expect(lastTwo.every((en) => en.kind === 'notice')).toBe(true)
    expect((lastTwo[0]!.meta as { ui?: { id?: string } })?.ui?.id).toBe((lastTwo[1]!.meta as { ui?: { id?: string } })?.ui?.id)
  })
})
