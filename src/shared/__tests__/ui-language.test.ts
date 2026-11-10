// Fase 17a (L7.1): resolveUiLanguage — setting esplicito, lingue di sistema,
// salto delle lingue sconosciute, default internazionale, setting ignoto.
// Fase 17a correzioni (K1): startupMainLanguage — la scelta all'avvio del
// main, col setting letto dal daemon più le lingue di sistema.
import { describe, expect, it } from 'vitest'
import { resolveUiLanguage, startupMainLanguage, SUPPORTED_UI_LANGUAGES, isUiLanguageSetting } from '../ui-language'

describe('RV3 (fase beta.2): l’elenco delle lingue è UN solo posto', () => {
  it('SUPPORTED_UI_LANGUAGES: it + en, ciascuna col suo endonimo (che NON si traduce)', () => {
    expect(SUPPORTED_UI_LANGUAGES).toEqual([
      { code: 'it', endonym: 'Italiano' },
      { code: 'en', endonym: 'English' }
    ])
  })

  it('il setting valido è system o un codice dell’elenco — niente altro', () => {
    expect(isUiLanguageSetting('system')).toBe(true)
    for (const l of SUPPORTED_UI_LANGUAGES) expect(isUiLanguageSetting(l.code)).toBe(true)
    expect(isUiLanguageSetting('fr')).toBe(false)
    expect(isUiLanguageSetting('it ')).toBe(false)
    expect(isUiLanguageSetting(42)).toBe(false)
  })

  it('la risoluzione segue l’elenco: un codice dell’elenco si riconosce, gli altri no', () => {
    // il setting esplicito di OGNI lingua dell’elenco vince sul sistema
    for (const l of SUPPORTED_UI_LANGUAGES) expect(resolveUiLanguage(l.code, ['xx-XX'])).toBe(l.code)
    expect(resolveUiLanguage('xx', ['it-IT'])).toBe('it')
  })
})

describe('fase 17a (L2): resolveUiLanguage', () => {
  it('un setting esplicito vince sulle lingue di sistema', () => {
    expect(resolveUiLanguage('it', ['en-US', 'de-DE'])).toBe('it')
    expect(resolveUiLanguage('en', ['it-IT'])).toBe('en')
  })
  it('con system: la prima lingua di sistema che inizia con it/en decide', () => {
    expect(resolveUiLanguage('system', ['it-IT'])).toBe('it')
    expect(resolveUiLanguage('system', ['en-US'])).toBe('en')
    expect(resolveUiLanguage('system', ['en-GB', 'it-IT'])).toBe('en')
    expect(resolveUiLanguage('system', ['it-IT', 'en-US'])).toBe('it')
  })
  it('le lingue che non sono it/en si saltano (es. de-DE)', () => {
    expect(resolveUiLanguage('system', ['de-DE'])).toBe('en')
    expect(resolveUiLanguage('system', ['de-DE', 'it-IT'])).toBe('it')
    expect(resolveUiLanguage('system', ['fr-FR', 'de-DE', 'en-US'])).toBe('en')
  })
  it('nessuna lingua nota (o lista vuota) → en, la lingua internazionale', () => {
    expect(resolveUiLanguage('system', [])).toBe('en')
    expect(resolveUiLanguage('system', ['ja-JP', 'zh-CN'])).toBe('en')
  })
  it('un setting sconosciuto si tratta come system', () => {
    expect(resolveUiLanguage('francese', ['it-IT'])).toBe('it')
    expect(resolveUiLanguage('francese', ['de-DE'])).toBe('en')
    expect(resolveUiLanguage('', ['en-US'])).toBe('en')
  })
})

describe('fase 17a (K1): startupMainLanguage — la lingua del main all\'avvio', () => {
  it('il setting salvato vince sul sistema: en salvato su Mac in italiano dà en', () => {
    expect(startupMainLanguage('en', ['it-IT'])).toBe('en')
    expect(startupMainLanguage('it', ['en-US'])).toBe('it')
  })
  it("'system' segue le lingue di sistema", () => {
    expect(startupMainLanguage('system', ['it-IT'])).toBe('it')
    expect(startupMainLanguage('system', ['en-US'])).toBe('en')
  })
  it('lettura fallita (setting nullo/non stringa): resta la lingua di sistema', () => {
    expect(startupMainLanguage(null, ['it-IT'])).toBe('it')
    expect(startupMainLanguage(null, ['en-US'])).toBe('en')
    expect(startupMainLanguage(undefined, ['de-DE'])).toBe('en')
    expect(startupMainLanguage(42 as unknown as string, ['it-IT'])).toBe('it')
  })
})
