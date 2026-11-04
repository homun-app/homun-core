// Fase risposta (R4): test delle funzioni portate da Rakazo (i casi dei test
// di Rakazo che le riguardano, tradotti al nostro testo libero a stringa).
import { describe, expect, it } from 'vitest'
import {
  NO_RESPONSE, isExactNoResponse, isPlaceholderText, couldBecomeNoResponse,
  stripStrayNoResponse, peerReplyWithoutSentinel, PEER_NOTHING_NEW_REPLY
} from '../silent-reply'

describe('fase risposta (R4): isExactNoResponse — il segnale esatto', () => {
  it('il segnale da solo, ripetuto o con spazi è silenzio', () => {
    expect(isExactNoResponse(NO_RESPONSE)).toBe(true)
    expect(isExactNoResponse('NO_RESPONSE ')).toBe(true)
    expect(isExactNoResponse('  NO_RESPONSE  ')).toBe(true)
    expect(isExactNoResponse('NO_RESPONSE NO_RESPONSE')).toBe(true)
    expect(isExactNoResponse('NO_RESPONSE\nNO_RESPONSE')).toBe(true)
    // i segmenti di un turno si uniscono senza separatore (Rakazo)
    expect(isExactNoResponse('NO_RESPONSENO_RESPONSE')).toBe(true)
  })

  it('prosa attorno NON è silenzio', () => {
    expect(isExactNoResponse('Tutto ok. NO_RESPONSE')).toBe(false)
    expect(isExactNoResponse('NO_RESPONSE everything fine')).toBe(false)
    expect(isExactNoResponse('no_response')).toBe(false)
    expect(isExactNoResponse('')).toBe(false)
    // un token che continua in un identificatore è una parola (Rakazo)
    expect(isExactNoResponse('NO_RESPONSE_POLICY')).toBe(false)
  })
})

describe('fase risposta (R4.3): isPlaceholderText — i segnaposto valgono vuoto', () => {
  it('punti, puntini di sospensione, spazi e invisibili da soli', () => {
    expect(isPlaceholderText('.')).toBe(true)
    expect(isPlaceholderText('…')).toBe(true)
    expect(isPlaceholderText('...')).toBe(true)
    expect(isPlaceholderText(' . … ')).toBe(true)
    expect(isPlaceholderText('  ')).toBe(true)
    expect(isPlaceholderText('​')).toBe(true) // zero-width space
    expect(isPlaceholderText('﻿')).toBe(true) // BOM
  })

  it('qualsiasi contenuto vero è una risposta', () => {
    expect(isPlaceholderText('Tutto ok')).toBe(false)
    expect(isPlaceholderText('✓')).toBe(false)
    expect(isPlaceholderText('—')).toBe(false)
    expect(isPlaceholderText('ok.')).toBe(false)
    // il testo del tutto vuoto NON è un segnaposto (è solo vuoto)
    expect(isPlaceholderText('')).toBe(false)
  })
})

describe('fase risposta (R4.6): couldBecomeNoResponse — la diretta aspetta', () => {
  it('i prefissi del segnale possono ancora diventarlo', () => {
    for (const p of ['N', 'NO', 'NO_', 'NO_R', 'NO_RESP', 'NO_RESPONSE']) {
      expect(couldBecomeNoResponse(p)).toBe(true)
    }
    expect(couldBecomeNoResponse('NO_RESPONSE NO_RE')).toBe(true)
  })

  it('qualsiasi altra cosa no', () => {
    expect(couldBecomeNoResponse('Hello')).toBe(false)
    expect(couldBecomeNoResponse('Tutto')).toBe(false)
    // tutto bianco: il resto è '' e il segnale inizia con '' → può ancora
    // diventare tutto (si aspetta il primo carattere vero)
    expect(couldBecomeNoResponse('   ')).toBe(true)
  })
})

describe('fase risposta (R4.2): stripStrayNoResponse — i segnali spaiati ai bordi', () => {
  it('si tolgono quando c\'è prosa vera', () => {
    expect(stripStrayNoResponse('NO_RESPONSE Tutto ok')).toBe('Tutto ok')
    expect(stripStrayNoResponse('Tutto ok. NO_RESPONSE')).toBe('Tutto ok.')
    expect(stripStrayNoResponse('NO_RESPONSE\n\nTutto ok. NO_RESPONSE\n')).toBe('Tutto ok.')
    // ripetuti con spazi
    expect(stripStrayNoResponse('NO_RESPONSE NO_RESPONSE Tutto ok')).toBe('Tutto ok')
  })

  it('il segnale ripetuto confina con un identificatore: la corsa si ferma al token pulito', () => {
    // NO_RESPONSE_POLICY è una parola: il segnale prima resta, la risposta pure
    expect(stripStrayNoResponse('NO_RESPONSE_POLICY applies')).toBe('NO_RESPONSE_POLICY applies')
  })

  it('la risposta fatta solo di segnale resta com\'è (la decide isExactNoResponse)', () => {
    expect(stripStrayNoResponse('NO_RESPONSE')).toBe('NO_RESPONSE')
    expect(stripStrayNoResponse('  NO_RESPONSE ')).toBe('  NO_RESPONSE ')
  })

  it('la prosa al centro NON si tocca', () => {
    expect(stripStrayNoResponse('NO_RESPONSE prima NO_RESPONSE seconda NO_RESPONSE')).toBe('prima NO_RESPONSE seconda')
  })
})

describe('fase risposta (R4.5): peerReplyWithoutSentinel — verso un altro bot', () => {
  it('il segnale da solo diventa le parole, mai il letterale', () => {
    expect(peerReplyWithoutSentinel('NO_RESPONSE')).toBe(PEER_NOTHING_NEW_REPLY)
    expect(peerReplyWithoutSentinel(' NO_RESPONSE NO_RESPONSE ')).toBe(PEER_NOTHING_NEW_REPLY)
    expect(PEER_NOTHING_NEW_REPLY).toBe('Nothing new to add.')
  })

  it('le altre risposte si ripuliscono solo dei segnali spaiati', () => {
    expect(peerReplyWithoutSentinel('NO_RESPONSE Tutto ok')).toBe('Tutto ok')
    expect(peerReplyWithoutSentinel('Ecco i dati')).toBe('Ecco i dati')
  })
})
