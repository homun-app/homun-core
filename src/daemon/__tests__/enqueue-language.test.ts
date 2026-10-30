// Fase 17b (A2): dove noteHumanText scatta — e dove NON deve scattare. Test
// d'integrazione di enqueueUserMessage/enqueueWidgetResponse sullo store reale
// in una directory temporanea: il messaggio umano aggiorna 'agent.userLanguage',
// il messaggio di sistema con initiator (LOOK_AROUND) e i clic sulle opzioni
// dei widget no, il testo libero sì.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

const { setDataDir, getSetting, deleteSetting, createAgent, appendEntry, db } = await import('../../main/store/db')
const { enqueueUserMessage, enqueueWidgetResponse } = await import('../enqueue')
const { secondaryPrompts } = await import('../../main/agent/prompts')
const { detectLanguage } = await import('../../shared/language')

let root: string
let agentId: string
const noop = (): void => {}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-enqueue-lang-test-'))
  setDataDir(root)
  agentId = createAgent('Bot', 'assistente').id
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('fase 17b (A2): enqueueUserMessage', () => {
  it('il messaggio utente senza initiator aggiorna la lingua', () => {
    deleteSetting('agent.userLanguage')
    enqueueUserMessage(db() as DatabaseSync, agentId, 'ciao, che cosa puoi fare per me?', undefined, noop)
    expect(getSetting('agent.userLanguage', null)).toBe('it')
  })

  it('un messaggio inglese cambia la lingua', () => {
    enqueueUserMessage(db() as DatabaseSync, agentId, 'hello, what can you do for me?', undefined, noop)
    expect(getSetting('agent.userLanguage', null)).toBe('en')
  })

  it('il messaggio di sistema LOOK_AROUND (initiator) NON tocca il setting', () => {
    deleteSetting('agent.userLanguage')
    // il testo del lookAround è rilevabile (inglese, fase 17b A4): se finisse
    // in noteHumanText scriverebbe una lingua — deve restare null
    const text = secondaryPrompts.lookAround()
    expect(detectLanguage(text)).not.toBeNull()
    enqueueUserMessage(db() as DatabaseSync, agentId, text, undefined, noop, undefined, 'LOOK_AROUND')
    expect(getSetting('agent.userLanguage', null)).toBeNull()
  })

  it('anche gli initiator CONNECTOR_CONNECTED non toccano il setting', () => {
    enqueueUserMessage(
      db() as DatabaseSync, agentId,
      "[sistema] L'utente ha connesso Gmail: i suoi tool sono ora disponibili.",
      undefined, noop, undefined, 'CONNECTOR_CONNECTED'
    )
    expect(getSetting('agent.userLanguage', null)).toBeNull()
  })
})

describe('fase 17b (A2): enqueueWidgetResponse', () => {
  function askWidget(options: Array<{ label: string; value: string }>): number {
    const e = appendEntry({
      agentId, kind: 'send-message', role: 'assistant', content: 'domanda',
      meta: {
        call: { id: 'c1', name: 'ask_user', arguments: '{}' },
        message: { type: 'widget', prompt: 'Vuoi proseguire?', options, allowCustom: true }
      }
    })
    return e.id
  }

  it('il clic su un\'opzione NON tocca il setting (le etichette sono del bot)', () => {
    deleteSetting('agent.userLanguage')
    const id = askWidget([{ label: 'Sì, grazie', value: 'yes' }])
    enqueueWidgetResponse(db() as DatabaseSync, agentId, id, 'yes', noop)
    expect(getSetting('agent.userLanguage', null)).toBeNull()
  })

  it('la risposta libera aggiorna la lingua', () => {
    const id = askWidget([{ label: 'Sì, grazie', value: 'yes' }])
    enqueueWidgetResponse(db() as DatabaseSync, agentId, id, 'no grazie, preferisco farlo da solo domani', noop)
    expect(getSetting('agent.userLanguage', null)).toBe('it')
  })
})
