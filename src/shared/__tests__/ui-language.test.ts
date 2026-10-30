// Fase 17a (L7.1): resolveUiLanguage — setting esplicito, lingue di sistema,
// salto delle lingue sconosciute, default internazionale, setting ignoto.
import { describe, expect, it } from 'vitest'
import { resolveUiLanguage } from '../ui-language'

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
