// Fase 17b (A1): test di detectLanguage — deterministica, senza dipendenze.
// I casi seguono le regole della fase: 2 colpi e il doppio dell'altra, con
// l'eccezione del colpo singolo IT più accento; tutto il resto è null.
import { describe, it, expect } from 'vitest'
import { detectLanguage, languageName, IT_WORDS, EN_WORDS } from '../language'

describe('detectLanguage', () => {
  it('riconosce una frase italiana normale', () => {
    expect(detectLanguage('puoi riassumermi questa email per favore?')).toBe('it')
  })

  it('riconosce una frase inglese normale', () => {
    expect(detectLanguage('can you summarize this email for me?')).toBe('en')
  })

  it('riconosce un italiano più lungo', () => {
    expect(detectLanguage('domani devo partire presto, puoi prepararmi il viaggio?')).toBe('it')
  })

  it('riconosce un inglese più lungo', () => {
    expect(detectLanguage('what time is the meeting, and where should we go?')).toBe('en')
  })

  it('un URL dentro la frase non cambia la lingua (it)', () => {
    expect(detectLanguage('che ne pensi di https://example.com/articolo?')).toBe('it')
  })

  it('un URL dentro la frase non cambia la lingua (en)', () => {
    expect(detectLanguage('what do you think of https://example.com/article?')).toBe('en')
  })

  it('il codice dentro la frase non cambia la lingua', () => {
    expect(detectLanguage('sistemami il bug in src/main.ts del progetto')).toBe('it')
  })

  it('«ok» non decide nulla', () => {
    expect(detectLanguage('ok')).toBeNull()
  })

  it('«grazie!» ha un solo colpo: null', () => {
    expect(detectLanguage('grazie!')).toBeNull()
  })

  it('«thanks» ha un solo colpo: null', () => {
    expect(detectLanguage('thanks')).toBeNull()
  })

  it('un italiano con un termine inglese resta italiano', () => {
    expect(detectLanguage('fammi il deploy della build')).toBe('it')
  })

  it('un inglese con un nome italiano non diventa italiano', () => {
    // «Da» vale un colpo IT, ma senza altri indizi la frase non decide;
    // con le parole funzionali inglesi attorno vince l'inglese
    expect(detectLanguage('book a table at Trattoria Da Mario')).toBeNull()
    expect(detectLanguage('can you book a table at Trattoria Da Mario?')).toBe('en')
  })

  it('un colpo IT con accento italiano basta', () => {
    expect(detectLanguage('perché?')).toBe('it')
    expect(detectLanguage('vado a casa, però poi ti scrivo')).not.toBeNull()
  })

  it('la stringa vuota non decide nulla', () => {
    expect(detectLanguage('')).toBeNull()
  })

  it('un comando da solo non decide nulla', () => {
    expect(detectLanguage('npm run build')).toBeNull()
  })

  it('le hit a pari merito non decidono', () => {
    // «che when» dà 1+1: nessuna delle due ha il doppio dell'altra
    expect(detectLanguage('che when')).toBeNull()
  })
})

// Fase 17b correzioni (B1): l'articolo «i» e «me»/«do» italiani non devono più
// contare come inglese; le frasi italiane comuni restano italiane e le frasi
// ambigue restano null, mai «en» per sbaglio.
describe('fase 17b correzioni (B1): articolo «i» e falsi inglesi', () => {
  it("l'articolo «i» non sposta la lingua", () => {
    expect(detectLanguage('Dammi i file di ieri e i risultati')).toBe('it')
    expect(detectLanguage('Controlla i log e dimmi se ci sono errori')).toBe('it')
  })

  it('«ti do una mano» non conta «do» come inglese', () => {
    expect(detectLanguage('Ti do una mano con la presentazione')).toBe('it')
  })

  it('frasi italiane senza accenti', () => {
    expect(detectLanguage('Il deploy è fallito, controlla la pipeline')).toBe('it')
    expect(detectLanguage('Fai il backup')).toBe('it')
    expect(detectLanguage('Sì, fallo pure')).toBe('it')
  })

  it('frasi ambigue restano null, mai «en»', () => {
    expect(detectLanguage('Cerca i voli per Roma')).toBeNull()
    expect(detectLanguage('Leggi i documenti e riassumi')).toBeNull()
    expect(detectLanguage('Per me va bene')).toBeNull()
  })

  it("l'inglese si riconosce anche senza «i»/«me»/«do»", () => {
    expect(detectLanguage('Can you come with me?')).toBe('en')
    expect(detectLanguage('Come here and tell me what you need')).toBe('en')
    expect(detectLanguage('Can you check the logs from yesterday?')).toBe('en')
    expect(detectLanguage('I need the report by Friday')).toBe('en')
    expect(detectLanguage('Please send me the file')).toBe('en')
  })

  it('nessuna parola in comune fra IT_WORDS ed EN_WORDS', () => {
    const common = [...IT_WORDS].filter((w) => EN_WORDS.has(w))
    expect(common).toEqual([])
  })
})

describe('languageName', () => {
  it('it → Italian, en → English', () => {
    expect(languageName('it')).toBe('Italian')
    expect(languageName('en')).toBe('English')
  })
})
