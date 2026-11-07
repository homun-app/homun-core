// Fase pagine (G4): i suggerimenti del pannello Attività — funzione PURA,
// regole e niente modello. Regola 1: app del catalogo nominata negli ultimi
// 20 messaggi DIRETTI dell'utente e non collegata per questo bot. Regola 2:
// 3 o più messaggi molto simili in giorni diversi negli ultimi 14 giorni.
// Regola 3: bot senza descrizione con più di 5 turni. Tetto 3, ignorati via
// ids, mai da messaggi [sistema] o di altri bot.
import { describe, expect, it } from 'vitest'
import { botSuggestions, normalizeRequest, similarity } from '../bot-suggestions'

const DAY = 86_400_000
const now = Date.now()

/** Un messaggio utente diretto (gli initiator/fomAgentId NON sono dell'utente). */
const u = (text: string, daysAgo = 0, extra: Record<string, unknown> = {}) => ({
  text,
  at: now - daysAgo * DAY,
  ...extra
})

const APPS = [
  { id: 'slack', name: 'Slack', connectedForBot: false },
  { id: 'gmail', name: 'Gmail', connectedForBot: false },
  { id: 'notion', name: 'Notion', connectedForBot: true }
]

const BASE = { apps: APPS, agentDescription: 'Il contabile', turns: 9, dismissed: [] as string[] }

describe('fase pagine (G4): botSuggestions — regola 1, collega un\'app', () => {
  it('app nominata e non collegata → «Collega Slack» con l\'azione che apre l\'app', () => {
    const s = botSuggestions({ ...BASE, messages: [u('cerca nel canale Slack le cose su X')] })
    expect(s).toHaveLength(1)
    expect(s[0]!.label).toBe('Collega Slack')
    expect(s[0]!.action).toEqual({ kind: 'connect-app', appId: 'slack' })
  })

  it('app collegata per questo bot → NESSUN suggerimento', () => {
    expect(botSuggestions({ ...BASE, messages: [u('prendi appunti su Notion')] })).toHaveLength(0)
  })

  it('il nome conta anche in mezzo ad altro testo, mai e maiuscole', () => {
    expect(botSuggestions({ ...BASE, messages: [u('guarda nella mia GMAIL la mail di ieri')] })[0]!.label).toBe('Collega Gmail')
  })

  it('solo gli ULTIMI 20 messaggi: un nome più vecchio non conta', () => {
    const messages = [
      u('parliamo di Slack', 30),
      ...Array.from({ length: 20 }, (_v, i) => u(`messaggio normale ${i}`, 1))
    ]
    expect(botSuggestions({ ...BASE, messages })).toHaveLength(0)
  })

  it('il match è a parola intera: «slackline» non è Slack', () => {
    expect(botSuggestions({ ...BASE, messages: [u('compra una slackline')] })).toHaveLength(0)
  })

  it('una sola app per volta: vince la più recente menzione', () => {
    const s = botSuggestions({ ...BASE, messages: [u('apri Slack'), u('poi guarda Gmail')] })
    expect(s.filter((x) => x.action.kind === 'connect-app')).toHaveLength(1)
    expect(s[0]!.label).toBe('Collega Gmail')
  })
})

describe('fase pagine (G4): botSuggestions — regola 2, crea una routine', () => {
  it('3 messaggi uguali in 3 giorni diversi → «Crea una routine» con la precompilazione', () => {
    const s = botSuggestions({
      ...BASE,
      messages: [u('riassumi le email di oggi', 5), u('riassumi le email di oggi', 3), u('riassumi le email di oggi', 1)]
    })
    expect(s).toHaveLength(1)
    expect(s[0]!.label).toBe('Crea una routine')
    expect(s[0]!.action).toEqual({ kind: 'create-routine', prefill: 'Fai di questo una routine: riassumi le email di oggi' })
  })

  it('3 messaggi SIMILI (≥ 0,8) bastano, anche non identici', () => {
    const s = botSuggestions({
      ...BASE,
      messages: [u('riassumi le email di oggi', 4), u('riassumi le email di stamattina', 2), u('riassumi le email', 0)]
    })
    expect(s[0]!.label).toBe('Crea una routine')
  })

  it('2 giorni soltanto non bastano, e fuori dai 14 giorni non conta', () => {
    expect(botSuggestions({ ...BASE, messages: [u('x', 1), u('x', 0)] })).toHaveLength(0)
    expect(botSuggestions({ ...BASE, messages: [u('x', 20), u('x', 10), u('x', 0)] })).toHaveLength(0)
  })

  it('lo stesso giorno ripetuto non basta: servono giorni DIVERSI', () => {
    expect(botSuggestions({ ...BASE, messages: [u('x', 0), u('x', 0), u('x', 0)] })).toHaveLength(0)
  })

  it('normalizzazione: punteggiatura e maiuscole non contano', () => {
    expect(normalizeRequest('Riassumi, le email!')).toBe(normalizeRequest('riassumi le email'))
  })

  it('similarità: identica = 1, una domanda allungata resta ≥ 0,8, diversa = bassa, simmetrica', () => {
    expect(similarity('abc', 'abc')).toBe(1)
    expect(similarity('riassumi le email', 'riassumi le email di oggi')).toBeGreaterThanOrEqual(0.8)
    expect(similarity('riassumi le email di oggi', 'riassumi le email di stamattina')).toBeGreaterThanOrEqual(0.7)
    expect(similarity('prendi il latte', 'riassumi le email')).toBeLessThan(0.5)
    expect(similarity('a b', 'b a')).toBe(similarity('b a', 'a b'))
  })
})

describe('fase pagine (G4): botSuggestions — regola 3, bot senza istruzioni', () => {
  it('descrizione vuota e più di 5 turni → «Descrivi cosa fa questo bot»', () => {
    const s = botSuggestions({ ...BASE, agentDescription: '', messages: [u('ciao')] })
    expect(s).toHaveLength(1)
    expect(s[0]!.label).toBe('Descrivi cosa fa questo bot')
    expect(s[0]!.action).toEqual({ kind: 'describe-bot' })
  })

  it('5 turni o meno non bastano; la descrizione piena non suggerisce', () => {
    expect(botSuggestions({ ...BASE, agentDescription: '', turns: 5, messages: [u('ciao')] })).toHaveLength(0)
    expect(botSuggestions({ ...BASE, messages: [u('ciao')] })).toHaveLength(0)
  })
})

describe('fase pagine (G4): tetto, ignorati, fonti dei messaggi', () => {
  it('al massimo 3 suggerimenti', () => {
    const s = botSuggestions({
      apps: [...APPS, { id: 'gdrive', name: 'Google Drive', connectedForBot: false }],
      agentDescription: '',
      turns: 9,
      dismissed: [],
      messages: [
        u('apri Slack'),
        u('poi guarda Gmail'),
        u('e anche Google Drive'),
        u('riassumi le email di oggi', 4),
        u('riassumi le email di stamattina', 2),
        u('riassumi le email', 0)
      ]
    })
    expect(s.length).toBeLessThanOrEqual(3)
  })

  it('un suggerimento ignorato (dismissed) non torna', () => {
    const messages = [u('apri Slack')]
    const first = botSuggestions({ ...BASE, messages })
    const dismissed = first.map((x) => x.id)
    expect(botSuggestions({ ...BASE, messages, dismissed })).toHaveLength(0)
    // l'altro suggerimento resta
    const both = botSuggestions({ ...BASE, agentDescription: '', messages })
    const dismissedOne = [both.find((x) => x.action.kind === 'connect-app')!.id]
    expect(botSuggestions({ ...BASE, agentDescription: '', messages, dismissed: dismissedOne }).map((x) => x.label))
      .toEqual(['Descrivi cosa fa questo bot'])
  })

  it('MAI suggerimenti da messaggi [sistema] o di altri bot', () => {
    const sistema = u('Slack: connessione scaduta', 0, { initiator: 'ROUTINE' })
    const altroBot = u('ti mando la email da Gmail', 0, { fromAgentId: 'bot2', fromAgentName: 'Bot2' })
    expect(botSuggestions({ ...BASE, messages: [sistema, altroBot] })).toHaveLength(0)
    // e la routine non conta i messaggi non diretti
    expect(botSuggestions({
      ...BASE,
      messages: [u('x', 5, { initiator: 'ROUTINE' }), u('x', 3, { initiator: 'ROUTINE' }), u('x', 1, { initiator: 'ROUTINE' })]
    })).toHaveLength(0)
  })

  it('niente input → nessun suggerimento', () => {
    expect(botSuggestions({ ...BASE, messages: [] })).toHaveLength(0)
  })

  it('ogni suggerimento ha id, icona, label e azione', () => {
    for (const s of botSuggestions({ ...BASE, agentDescription: '', messages: [u('apri Slack')] })) {
      expect(typeof s.id).toBe('string')
      expect(typeof s.icon).toBe('string')
      expect(typeof s.label).toBe('string')
      expect(typeof s.action).toBe('object')
    }
  })
})
