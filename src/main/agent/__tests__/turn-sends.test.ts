// Fase 9 (punto 0) — test puri delle regole dei send_to_user nel turno:
// result con l'inizio del testo consegnato, dedup, tetto degli avanzamenti.
// Fase 10 (residuo 0c): tetto dei send consegnati per turno.
import { describe, expect, it } from 'vitest'
import {
  deliveredResultText, alreadyDeliveredResult, isDuplicateSend,
  isWorkTool, messageCapResult, previewOf, DELIVERED_PREVIEW_CHARS,
  turnCapResult, MAX_DELIVERED_PER_TURN, finalHeldAfterSpawn
} from '../turn-sends'

describe('previewOf / deliveredResultText (punto 0b)', () => {
  it('il result riporta l\'inizio del testo e dice di non ripeterlo', () => {
    expect(deliveredResultText('Routine "Riepilogo mattina" creata in pausa.'))
      .toBe('delivered to the user: "Routine "Riepilogo mattina" creata in pausa.". Do not repeat it.')
  })

  it('testi oltre 120 caratteri: preview troncata con ellissi', () => {
    const lungo = 'A'.repeat(300)
    const r = deliveredResultText(lungo)
    expect(r).toContain('"' + 'A'.repeat(DELIVERED_PREVIEW_CHARS) + '…"')
    expect(r.endsWith('. Do not repeat it.')).toBe(true)
  })

  it('preview esattamente 120 caratteri: nessuna ellissi', () => {
    expect(previewOf('B'.repeat(120))).toBe('B'.repeat(120))
    expect(previewOf('B'.repeat(121))).toBe('B'.repeat(120) + '…')
  })

  it('i ritorni a capo e le virgolette restano nel testo consegnato (il modello verifica che è arrivato intero)', () => {
    const testo = 'Riga uno\nriga due con "virgolette"'
    expect(deliveredResultText(testo)).toContain('Riga uno\nriga due con "virgolette"')
  })

  it('held: il result spiega la consegna rinviata dell\'outbox', () => {
    expect(deliveredResultText('notturno', { held: true }))
      .toBe('delivered to the user: "notturno" — delivery is deferred to the next delivery window or when the chat opens, unless urgent. Do not repeat it.')
  })
})

describe('isDuplicateSend (punto 0c)', () => {
  it('testo uguale a uno già consegnato è duplicato', () => {
    expect(isDuplicateSend(['Fatto, Fabio!'], 'Fatto, Fabio!')).toBe(true)
  })

  it('testo contenuto in uno già consegnato è duplicato (il caso del DB: ripetizione troncata)', () => {
    expect(isDuplicateSend(
      ['Routine "Riepilogo mattina" creata in pausa. Attivalo quando vuoi.'],
      'creata in pausa'
    )).toBe(true)
    expect(isDuplicateSend(
      ['Routine "Riepilogo mattina" creata in pausa. Attivalo quando vuoi.'],
      'Riepilogo mattina'
    )).toBe(true)
  })

  it('un testo che CONTIENE uno consegnato non è duplicato: aggiunge informazioni', () => {
    // il nuovo messaggio estende il precedente ("Riepilogo mattina" → il riepilogo
    // vero e proprio): la spec vieta solo l'uguale e il contenuto
    expect(isDuplicateSend(['Riepilogo mattina'], 'Riepilogo mattina pronto: 3 email, nulla di urgente.')).toBe(false)
  })

  it('testo nuovo non è duplicato; il confronto è trimmato e case-sensitive', () => {
    expect(isDuplicateSend(['Riepilogo mattina pronto.'], 'Ecco il riepilogo di oggi: tutto ok.')).toBe(false)
    expect(isDuplicateSend(['  Fatto.  '], 'Fatto.')).toBe(true)
    expect(isDuplicateSend(['Fatto.'], 'fatto.')).toBe(false)
  })

  it('testo vuoto mai duplicato', () => {
    expect(isDuplicateSend(['Fatto.'], '')).toBe(false)
    expect(isDuplicateSend(['Fatto.'], '   ')).toBe(false)
  })

  it('alreadyDeliveredResult cita l\'inizio del testo', () => {
    expect(alreadyDeliveredResult('Riepilogo mattina'))
      .toBe('already delivered to the user in this turn: "Riepilogo mattina". Do not repeat the same content.')
  })
})

describe('isWorkTool / messageCapResult (punto 0d)', () => {
  it('solo send_to_user e ask_user non sono lavoro', () => {
    expect(isWorkTool('send_to_user')).toBe(false)
    expect(isWorkTool('ask_user')).toBe(false)
    expect(isWorkTool('update_state')).toBe(true)
    expect(isWorkTool('run-command')).toBe(true)
    expect(isWorkTool('mcp__gmail__search')).toBe(true)
    expect(isWorkTool('send_to_agent')).toBe(true)
    expect(isWorkTool('draft_external')).toBe(true)
    expect(isWorkTool('create_task')).toBe(true)
  })

  it('il result del tetto spiega cosa fare (chiudere o fondere, non ripetere)', () => {
    const r = messageCapResult()
    expect(r).toContain('Not delivered')
    expect(r).toContain('Do not repeat')
    expect(r).toContain('merge it into a single message')
  })
})

describe('turnCapResult / MAX_DELIVERED_PER_TURN (fase 10, residuo 0c)', () => {
  it('il tetto del turno è 3 send consegnati', () => {
    expect(MAX_DELIVERED_PER_TURN).toBe(3)
  })

  it('il result del tetto dice che il testo è ragionamento e come procedere', () => {
    const r = turnCapResult()
    expect(r).toContain('Not delivered')
    expect(r).toContain('reasoning')
    expect(r).toContain('3 messages')
    expect(r).not.toContain('Do not repeat the same content')
  })
})

// ---- fase eval-deboli (D3): un turno che lancia subagenti consegna al massimo UN messaggio ----

describe('fase eval-deboli (D3): finalHeldAfterSpawn — il finale dopo una spawn e una consegna si trattiene', () => {
  it('spawn RIUSCITA + un messaggio già consegnato → il finale si trattiene', () => {
    expect(finalHeldAfterSpawn({ spawnedThisTurn: true, deliveredThisTurn: true })).toBe(true)
  })

  it('spawn senza messaggi consegnati → il finale si consegna (il turno non sarebbe muto)', () => {
    expect(finalHeldAfterSpawn({ spawnedThisTurn: true, deliveredThisTurn: false })).toBe(false)
  })

  it('nessuna spawn → invariato: il testo finale si consegna come sempre', () => {
    expect(finalHeldAfterSpawn({ spawnedThisTurn: false, deliveredThisTurn: true })).toBe(false)
    expect(finalHeldAfterSpawn({ spawnedThisTurn: false, deliveredThisTurn: false })).toBe(false)
  })
})
