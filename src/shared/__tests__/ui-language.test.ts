// Fase 17a (L7.1): resolveUiLanguage — setting esplicito, lingue di sistema,
// salto delle lingue sconosciute, default internazionale, setting ignoto.
// Fase 17a correzioni (K1): startupMainLanguage — la scelta all'avvio del
// main, col setting letto dal daemon più le lingue di sistema.
import { describe, expect, it } from 'vitest'
import { resolveUiLanguage, startupMainLanguage } from '../ui-language'

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
