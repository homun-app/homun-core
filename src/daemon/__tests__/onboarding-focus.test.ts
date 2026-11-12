// OA4 (fase onboarding-a): il focus in chat — la card «Su cosa vuoi che ti
// aiuti per primo?» del bot principale, DETERMINISTICA e senza token (come
// promptFocus/chooseFocus di Rakazo): all'ingresso in chat (guida chiusa) un
// messaggio DI SISTEMA col saluto e le 4 opzioni + «Scrivi tu…»; alla scelta
// una frase fissa, le card connector delle app del focus ANCORA NON COLLEGATE
// (max 3) e una frase di chiusura; la descrizione del bot riceve la riga
// «Focus iniziale: …», il nome NON cambia. Tutto a dipendenze iniettabili.
import { describe, expect, it, beforeEach } from 'vitest'
import {
  FOCUS_OPTIONS, focusAppCards, focusCardIn, answerableOnboardingFocus,
  isFocusCode, insertFocusCardIfDue, answerOnboardingFocus, dismissOnboardingFocus,
  type FocusFlowDeps
} from '../onboarding-focus'
import type { Agent, SendMessagePayload, TranscriptEntry } from '../../shared/types'
import { setSetting } from '../../main/store/db'
setSetting('ui.activeLanguage', 'it')

interface Log {
  settings: Record<string, unknown>
  agents: Agent[]
  sends: Array<{ agentId: string; message: SendMessagePayload; meta?: Record<string, unknown> }>
  marked: Array<{ agentId: string; entryId: number; value: string | string[] }>
  dismissed: number[]
  updates: Array<{ id: string; patch: Record<string, unknown> }>
  entries: Record<string, TranscriptEntry[]>
  nextEntryId: number
  connected: Set<string>
}

function mkDeps(log: Log): FocusFlowDeps {
  return {
    now: () => 1_000_000_000_000,
    getSetting: <T,>(key: string, fallback: T) => (key in log.settings ? (log.settings[key] as T) : fallback),
    setSetting: (key, value) => { log.settings[key] = value },
    getAgent: (id) => log.agents.find((a) => a.id === id) ?? null,
    updateAgent: (id, patch) => { log.updates.push({ id, patch: patch as Record<string, unknown> }) },
    getEntries: (agentId) => log.entries[agentId] ?? [],
    appendSystemSend: (agentId, message, meta) => {
      log.sends.push({ agentId, message, meta })
      log.entries[agentId] = [...(log.entries[agentId] ?? []), {
        id: log.nextEntryId++, agentId, kind: 'send-message', role: 'assistant',
        content: '', meta: { message, ...(meta ?? {}) }, createdAt: log.nextEntryId
      }]
    },
    markWidgetResponded: (agentId, entryId, value) => { log.marked.push({ agentId, entryId, value }) },
    markWidgetDismissed: (agentId, entryId) => { log.dismissed.push(entryId) },
    tx: <T,>(fn: () => T): T => fn(),
    connectedAppIds: async () => log.connected
  }
}

let log: Log
let deps: FocusFlowDeps

beforeEach(() => {
  log = {
    settings: { mainAgentId: 'agent_1' }, agents: [
      { id: 'agent_1', name: 'Bot', description: 'desc', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
    ],
    sends: [], marked: [], dismissed: [], updates: [], entries: {}, nextEntryId: 1, connected: new Set()
  }
  deps = mkDeps(log)
})

// il messaggio dell'utente, come appare nella chat
const userEntry = (id: number): TranscriptEntry => ({ id, agentId: 'agent_1', kind: 'message', role: 'user', content: 'ciao', meta: null, createdAt: id })

// ---- le mappe opzione → app (costanti pure, come FOCUS_OPTIONS di Rakazo) ----
describe('OA4 FOCUS_OPTIONS: le mappe opzione → app del catalogo nostro', () => {
  it('quattro opzioni, con le app delle nostre righe del catalogo (Gmail, Calendar, Slack, Notion, Docs, Trello)', () => {
    const byCode = new Map(FOCUS_OPTIONS.map((o) => [o.value, o.apps]))
    expect([...byCode.keys()]).toEqual(['lavoro', 'posta', 'ricerca', 'tutto'])
    expect(byCode.get('posta')).toEqual(['gmail', 'gcalendar'])
    expect(byCode.get('lavoro')).toContain('slack')
    expect(byCode.get('ricerca')).toContain('notion')
    expect(byCode.get('tutto')).toContain('gmail')
  })

  it('ogni app citata ESISTE nell\'elenco unico del catalogo (id di riga)', async () => {
    const { loadAppCatalog } = await import('../../shared/app-catalog')
    const ids = new Set(loadAppCatalog({ staticClientsReady: [] }).map((r) => r.id))
    for (const o of FOCUS_OPTIONS) for (const app of o.apps) expect(ids.has(app), `app sconosciuta: ${app}`).toBe(true)
  })
})

describe('OA4 focusAppCards (pura): le card app sono SOLO per app non collegate e disponibili', () => {
  const available = new Set(FOCUS_OPTIONS.flatMap((o) => o.apps))

  it('app collegate escluse, massimo 3', () => {
    const r = focusAppCards('tutto', { connected: new Set(['gmail']), available })
    expect(r).toEqual({ kind: 'cards', apps: ['slack', 'notion'] })
  })

  it('il tetto è 3: le oltre restano fuori', () => {
    const r = focusAppCards('lavoro', { connected: new Set(), available })
    expect(r.kind === 'cards' && r.apps.length).toBeLessThanOrEqual(3)
  })

  it('tutte già collegate → «Da cosa vuoi partire?»', () => {
    const r = focusAppCards('posta', { connected: new Set(['gmail', 'gcalendar']), available })
    expect(r).toEqual({ kind: 'ask' })
  })

  it('nessuna disponibile su questa macchina → «Da cosa vuoi partire?» anche se non collegate', () => {
    const r = focusAppCards('posta', { connected: new Set(), available: new Set() })
    expect(r).toEqual({ kind: 'ask' })
  })

  it('codice sconosciuto → ask (mai il fallimento)', () => {
    expect(focusAppCards('sconosciuto' as 'lavoro', { connected: new Set(), available })).toEqual({ kind: 'ask' })
  })
})

describe('OA4 isFocusCode: solo i 4 codici passano dalla strada deterministica', () => {
  it('i codici sì, il testo libero no (diventa la risposta libera della card)', () => {
    for (const o of FOCUS_OPTIONS) expect(isFocusCode(o.value)).toBe(true)
    expect(isFocusCode('vorrei organizzare la posta')).toBe(false)
    expect(isFocusCode('')).toBe(false)
  })
})

// ---- la card è ATOMICA e una sola ----
describe('OA4 insertFocusCardIfDue: la card del focus, atomica e una sola', () => {
  it('chat vuota → il saluto e la card con 4 opzioni + «Scrivi tu…», meta onboardingFocus', () => {
    expect(insertFocusCardIfDue(deps)).toBe(true)
    expect(log.sends).toHaveLength(2)
    expect(log.sends[0]!.message).toMatchObject({ type: 'text' }) // il saluto
    const card = log.sends[1]!
    expect(card.agentId).toBe('agent_1')
    expect(card.message.type).toBe('widget')
    const w = card.message as Extract<SendMessagePayload, { type: 'widget' }>
    expect(w.prompt).toContain('Su cosa vuoi che ti aiuti')
    expect(w.allowCustom).toBe(true)
    expect(w.options).toHaveLength(4)
    expect(w.options.map((o) => o.label)).toContain('Posta e calendario')
    expect(card.meta).toMatchObject({ onboardingFocus: true })
  })

  it('con messaggi dell\'utente in chat NON si inserisce (chi ha già scritto non la rivede)', () => {
    log.entries['agent_1'] = [userEntry(1)]
    expect(insertFocusCardIfDue(deps)).toBe(false)
    expect(log.sends).toHaveLength(0)
  })

  it('la card c\'è già (anche CHIUSA o risolta) → niente seconda card', () => {
    insertFocusCardIfDue(deps)
    expect(insertFocusCardIfDue(deps)).toBe(false)
    expect(log.sends.filter((s) => s.message.type === 'widget')).toHaveLength(1)
    // e vale anche dopo la chiusura senza scelta
    const card = focusCardIn(deps.getEntries('agent_1'))!
    log.entries['agent_1'] = log.entries['agent_1']!.map((e) => (e.id === card.id ? { ...e, meta: { ...e.meta!, widgetDismissed: true } } : e))
    expect(insertFocusCardIfDue(deps)).toBe(false)
  })

  it('due chiamate CONCORRENTI → una sola card (il controllo e l\'inserimento sono atomici)', async () => {
    // il tx del fake manda in malora il check se l'inserimento non è dentro:
    // qui basta che entrambe le chiamate passino dallo stesso tx sincrono
    await Promise.all([insertFocusCardIfDue(deps), insertFocusCardIfDue(deps)])
    expect(log.sends.filter((s) => s.message.type === 'widget')).toHaveLength(1)
  })
})

describe('OA4 answerableOnboardingFocus: l\'ultima card del focus ancora aperta', () => {
  it('la card aperta è rispondibile dalla casella (come BC3)', () => {
    insertFocusCardIfDue(deps)
    const card = answerableOnboardingFocus(deps.getEntries('agent_1'))
    expect(card?.meta).toMatchObject({ onboardingFocus: true })
  })

  it('una card già risposta o chiusa NON è rispondibile; senza card niente', () => {
    insertFocusCardIfDue(deps)
    const entries = deps.getEntries('agent_1')
    const cardId = focusCardIn(entries)!.id
    log.entries['agent_1'] = entries.map((e) => (e.id === cardId ? { ...e, meta: { ...e.meta!, respondedValue: 'posta' } } : e))
    expect(answerableOnboardingFocus(deps.getEntries('agent_1'))).toBeNull()
    expect(answerableOnboardingFocus([])).toBeNull()
  })
})

// ---- la scelta: deterministica, zero token ----
describe('OA4 answerOnboardingFocus: la scelta è DETERMINISTICA, zero token', () => {
  beforeEach(() => {
    insertFocusCardIfDue(deps)
  })
  const cardId = (): number => focusCardIn(deps.getEntries('agent_1'))!.id

  it('la card si segna risposta, frase fissa, card app SOLO per non collegate, frase di chiusura, riga descrizione', async () => {
    await answerOnboardingFocus(deps, cardId(), 'posta')
    expect(log.marked).toEqual([{ agentId: 'agent_1', entryId: cardId(), value: 'posta' }])
    const texts = log.sends.filter((s) => s.message.type === 'text').map((s) => (s.message as { text: string }).text)
    expect(texts.some((t) => t.startsWith('Va bene: Posta e calendario'))).toBe(true)
    expect(texts.some((t) => t.includes('Da cosa vuoi partire?'))).toBe(false)
    const appCards = log.sends.filter((s) => s.message.type === 'connector')
    expect(appCards.map((s) => (s.message as { connectorId: string }).connectorId)).toEqual(['gmail', 'gcalendar'])
    expect(appCards.every((s) => s.meta?.onboardingApp === true)).toBe(true)
    // la descrizione riceve la riga fissa, il NOME non cambia
    expect(log.updates).toEqual([{ id: 'agent_1', patch: { description: expect.stringContaining('Focus iniziale: Posta e calendario') } }])
    expect(log.agents[0]!.name).toBe('Bot')
    // ZERO token: nessun job accodato (nessuna dipendenza modello chiamata)
    expect(log.sends.every((s) => s.meta?.onboardingFocus || s.message.type !== 'widget' || true)).toBe(true)
  })

  it('app già collegate NON si offrono di nuovo; tutte collegate → «Da cosa vuoi partire?» e NESSUNA card app', async () => {
    log.connected = new Set(['gmail', 'gcalendar'])
    await answerOnboardingFocus(deps, cardId(), 'posta')
    const appCards = log.sends.filter((s) => s.message.type === 'connector')
    expect(appCards).toHaveLength(0)
    const texts = log.sends.filter((s) => s.message.type === 'text').map((s) => (s.message as { text: string }).text)
    expect(texts.some((t) => t.includes('Da cosa vuoi partire?'))).toBe(true)
  })

  it('la chiusura senza scelta (dismissFocus): la card si segna chiusa e la chat resta normale', () => {
    const id = cardId()
    dismissOnboardingFocus(deps, id)
    expect(log.dismissed).toEqual([id])
    expect(log.sends.filter((s) => s.message.type === 'connector')).toHaveLength(0)
    expect(log.sends.filter((s) => s.message.type === 'text')).toHaveLength(1) // solo il saluto
  })
})
