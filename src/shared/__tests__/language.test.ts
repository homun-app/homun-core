// Fase 17b (A1): test di detectLanguage — deterministica, senza dipendenze.
// I casi seguono le regole della fase: 2 colpi e il doppio dell'altra, con
// l'eccezione del colpo singolo IT più accento; tutto il resto è null.
import { describe, it, expect } from 'vitest'
import { detectLanguage, languageName } from '../language'

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

describe('languageName', () => {
  it('it → Italian, en → English', () => {
    expect(languageName('it')).toBe('Italian')
    expect(languageName('en')).toBe('English')
  })
})
