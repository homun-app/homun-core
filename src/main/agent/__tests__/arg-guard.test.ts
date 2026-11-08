// Fase token (T8) + fase token ritocchi (R1–R3): i controlli FISSI di
// sicurezza, PURI — non dipendono dal modello. (a) un blocco <evento> esterno
// nel messaggio che apre il turno contamina il turno; (b) un argomento che va
// verso l'esterno o verso un sito con dentro un NUMERO DI CARTA (R2: solo nei
// campi dove si digita, con IIN plausibile + Luhn + forma 4-4-4-4 o attaccata),
// una CHIAVE col prefisso noto (R1: token intero, lunghezza da chiave vera,
// almeno una cifra) o un SEGRETO che l'utente ha scritto in chat (R3: parola
// intera, assegnazione esplicita con : = è e' is vale sarebbe, valore che
// sembra un segreto) viene RIFIUTATO senza esecuzione, e il valore non compare
// mai nel messaggio verso il modello.
import { describe, expect, it } from 'vitest'
import {
  hasExternalEvento, luhnCardNumbers, knownKeyPrefixHits, chatSecretValues,
  argGuardVerdict, GUARDED_ARG_TOOLS, KEY_SHAPES
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

describe('fase token ritocchi (R1): le chiavi solo come token intero e con lunghezza da chiave vera', () => {
  it('KEY_SHAPES è la tabella esportata delle soglie (caratteri minimi dopo il prefisso)', () => {
    expect(Object.fromEntries(KEY_SHAPES.map((s) => [s.prefix, s.minAfter]))).toEqual({
      'sk-': 20, ak_: 16, secret_: 16, ghp_: 30,
      'xoxa-': 10, 'xoxb-': 10, 'xoxp-': 10, 'xoxr-': 10
    })
  })
  it('NESSUN falso positivo: le parole comuni non contengono chiavi (niente lettera/cifra/_/- prima del prefisso)', () => {
    for (const t of [
      'npm install task-runner', 'brew install disk-utility', 'python peak_hours.py',
      'ask_user', 'risk-free', 'break_point', 'tokens xoxtrash-can'
    ]) {
      expect(knownKeyPrefixHits(t), t).toEqual([])
    }
  })
  it('le chiavi vere restano prese: sk- (20+), ak_ (16+), secret_ (16+), ghp_ (30+), xox[abpr]- (10+), tutte con almeno una cifra', () => {
    const sk = 'sk-proj-' + 'a1'.repeat(20)      // 40 caratteri dopo sk-, con cifre
    const ghp = 'ghp_' + 'Ab1'.repeat(12)        // 36 caratteri
    const secret = 'secret_abc123def456ghi7'     // 17 caratteri, con cifre
    const ak = 'ak_' + 'x9'.repeat(8)            // 16 caratteri
    const xoxb = 'xoxb-' + '1a2b3c4d5e6f7g'
    const xoxp = 'xoxp-' + 'Z9y8x7w6v5u4'
    expect(knownKeyPrefixHits(`export K=${sk} e ${ghp}`)).toEqual([sk, ghp])
    expect(knownKeyPrefixHits(`usa ${secret}`)).toEqual([secret])
    expect(knownKeyPrefixHits(`tmp ${ak}`)).toEqual([ak])
    expect(knownKeyPrefixHits(`slack ${xoxb} e ${xoxp}`)).toEqual([xoxb, xoxp])
  })
  it('sotto la soglia, o senza cifre, non è una chiave', () => {
    expect(knownKeyPrefixHits('usa sk-abc123DEF per la chiamata')).toEqual([])   // 9 < 20
    expect(knownKeyPrefixHits('ghp_AAAABBBB1234')).toEqual([])                   // 12 < 30
    expect(knownKeyPrefixHits('xoxT-12345678')).toEqual([])                      // xoxT non è xox[abpr]-
    expect(knownKeyPrefixHits('xoxb-12345')).toEqual([])                         // 5 < 10
    expect(knownKeyPrefixHits('sk-' + 'a'.repeat(24))).toEqual([])               // 24 lettere, nessuna cifra
  })
})

describe('fase token ritocchi (R2): le carte, solo dove si digita e con l\'aspetto di una carta', () => {
  it('i numeri che sembrano carte: 13–19 cifre, IIN plausibile E Luhn valido', () => {
    for (const c of [
      '4242424242424242',      // Visa
      '4539148803436467',      // Visa
      '5555555555554444',      // Mastercard 51–55
      '2221000000000009',      // Mastercard 2221–2720
      '378282246310005',       // Amex 37 (15 cifre)
      '6011111111111117',      // Discover 6011
      '6500000000000002',      // Discover 65
      '6440000000000005',      // Discover 644–649
      '3566002020360505',      // JCB 35
      '30569309025904',        // Diners 30 (14 cifre)
      '4222222222222'          // Visa a 13 cifre
    ]) {
      expect(luhnCardNumbers(`paga con ${c} ok`), c).toEqual([c])
    }
    // a gruppi di 4, separati da spazi o trattini
    expect(luhnCardNumbers('carta 4539 1488 0343 6467 ok')).toEqual(['4539148803436467'])
    expect(luhnCardNumbers('carta 4242-4242-4242-4242 ok')).toEqual(['4242424242424242'])
  })
  it('NESSUN falso positivo: id, timestamp, CAP, date, IBAN, telefoni — anche quando Luhn passa', () => {
    expect(luhnCardNumbers('id 1926010112345678904')).toEqual([]) // 19 cifre, Luhn valido, IIN no
    expect(luhnCardNumbers('seq 123456789012345671')).toEqual([]) // 18 cifre, Luhn valido, IIN no
    expect(luhnCardNumbers('https://x.com/u/status/1926010112345678904?t=1762600000000')).toEqual([])
    expect(luhnCardNumbers('ordine 12345678 del 2026-11-08, CAP 40121')).toEqual([])
    expect(luhnCardNumbers('IBAN IT60X0542811101000000123456')).toEqual([])
    expect(luhnCardNumbers('tel +39 333 123 4567')).toEqual([])
    expect(luhnCardNumbers('amex 3782 822463 10005')).toEqual([]) // 4-6-5: non è 4-4-4-4
    expect(luhnCardNumbers('seq 123456789012')).toEqual([])       // 12 cifre
    expect(luhnCardNumbers('carta 4111 1111 111X 1111')).toEqual([]) // non è Luhn
  })
})

describe('fase token ritocchi (R2): argGuardVerdict cerca la carta SOLO nei campi dove si digita', () => {
  const card = '4242 4242 4242 4242'
  it('i tool che scrivono in un campo o in un messaggio: rifiutati', () => {
    expect(argGuardVerdict('browser_type', { ref: 'e6', text: card }, []).ok).toBe(false)
    expect(argGuardVerdict('browser_select', { ref: 'e7', values: [card] }, []).ok).toBe(false)
    expect(argGuardVerdict('draft_external', { channel: 'email', to: 'a@b.it', subject: 'x', body: `paga con ${card}` }, []).ok).toBe(false)
    expect(argGuardVerdict('send_to_agent', { agentId: 'b1', text: `usa la carta ${card}` }, []).ok).toBe(false)
    expect(argGuardVerdict('computer_act', { actions: [{ kind: 'click', x: 1, y: 2 }, { kind: 'type', text: card }] }, []).ok).toBe(false)
  })
  it('MAI su URL, comandi o id: web_fetch, browser_open e run-command passano anche con la carta dentro', () => {
    expect(argGuardVerdict('web_fetch', { url: 'https://shop.example/pay?c=4242424242424242' }, []).ok).toBe(true)
    expect(argGuardVerdict('browser_open', { url: 'https://shop.example/pay?c=4242424242424242' }, []).ok).toBe(true)
    expect(argGuardVerdict('run-command', { command: 'echo 4242424242424242' }, []).ok).toBe(true)
    // e la carta nell'id (ref) del tool che digita, non nel testo: non è un campo digitato
    expect(argGuardVerdict('browser_type', { ref: 'e6', text: 'ciao, come va?' }, []).ok).toBe(true)
  })
})

describe('fase token ritocchi (R3): i segreti scritti in chat, solo se assegnati in modo esplicito', () => {
  it('presi: parola di segreto + separatore esplicito (: = è e' + "' is vale sarebbe) + valore che sembra un segreto", () => {
    const casi: Array<[string, string]> = [
      ['la mia password è Tigre!2026', 'Tigre!2026'],
      ['password: hunter2x', 'hunter2x'],
      ['il token è ab12cd34ef', 'ab12cd34ef'],
      ['my password is S3cret!!', 'S3cret!!'],
      ['la password del wifi è Casa2026', 'Casa2026'],
      ["l'apikey = ne11tt22kk33", 'ne11tt22kk33'],
      ['la chiave segreta: Topolino1', 'Topolino1'],
      ['il segreto vale ippogrifo9', 'ippogrifo9'],
      ['il pin è 987654', '987654'],
      ["la passphrase e' Quattro4Quattro", 'Quattro4Quattro'],
      ['la chiave api sarebbe gh7519xkfm2z', 'gh7519xkfm2z']
    ]
    for (const [text, value] of casi) {
      expect(chatSecretValues([text]), text).toContain(value)
    }
  })
  it('NON presi: niente assegnazione esplicita, o valore che non sembra un segreto', () => {
    const nonPresi = [
      'la password di Netflix non funziona più',   // «di Netflix»: nessun separatore
      'usa come parola chiave marketing',          // «chiave» da sola non conta
      'ho dimenticato la password dell\'account',  // nessun valore dopo la parola
      'la password è sbagliata',                   // parola comune: niente cifre/simboli/maiuscole
      'spingere il pinguino',                      // «pin» dentro un\'altra parola non conta
      'il token di GitHub scade domani',           // nessun separatore prima di un valore
      'la chiave del garage è quella verde',       // «chiave» da sola, e il valore ha spazi
      'il token è scaduto da giorni',              // parola comune
      'chiave inglese, chiave di lettura',         // «chiave» da sola non conta
      'marketing: la parola chiave del piano'      // la parola di segreto non c'è
    ]
    for (const text of nonPresi) {
      expect(chatSecretValues([text]), text).toEqual([])
    }
  })
})

describe('fase token (T8b) + ritocchi: argGuardVerdict rifiuta senza esecuzione e senza il valore', () => {
  const chat = ['la mia password è Tr4pp0la!92', 'la chiave api è sk-proj-abc123def456ghi789jklmnop']

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
    const v = argGuardVerdict('offer_connector', { id: 'gcal', reason: 'uso la chiave sk-proj-abc123def456ghi789jklmnop' }, chat)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).not.toContain('sk-proj-abc123def456ghi789jklmnop')
  })
  it('web_fetch: SOLO l\'url viene guardato (e la chiave vera nell\'url resta rifiutata)', () => {
    expect(argGuardVerdict('web_fetch', { url: 'https://proxy.example/v1?key=sk-proj-abc123def456ghi789jklmnop' }, chat).ok).toBe(false)
    // la carta nell'url NON si rifiuta (R2: mai sugli URL) — semmai la blocca il web-guard
    expect(argGuardVerdict('web_fetch', { url: 'https://x.com/u/status/1926010112345678904' }, chat).ok).toBe(true)
  })
  it('i tool guardati sono quelli che vanno verso l\'esterno o verso un sito (computer_act compreso, R2)', () => {
    for (const t of ['browser_type', 'browser_select', 'draft_external', 'send_to_agent', 'offer_connector', 'add_mcp_server', 'web_fetch', 'run-command', 'fill_credential', 'computer_act']) {
      expect(GUARDED_ARG_TOOLS.has(t), t).toBe(true)
    }
    expect(GUARDED_ARG_TOOLS.has('read-file')).toBe(false)
  })
  it('nessun falso positivo: testi normali passano', () => {
    expect(argGuardVerdict('browser_type', { ref: 'e4', text: 'ciao, come va?' }, chat).ok).toBe(true)
    expect(argGuardVerdict('run-command', { command: 'ls -la' }, chat).ok).toBe(true)
    expect(argGuardVerdict('send_to_agent', { agentId: 'b1', text: 'ricorda l\'ordine 12345678' }, chat).ok).toBe(true)
    expect(argGuardVerdict('run-command', { command: 'npm install task-runner && python peak_hours.py' }, chat).ok).toBe(true)
  })
})
