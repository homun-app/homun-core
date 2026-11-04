// Fase risposta (R3): la riga di lavoro — test puri della narrationStatusLine
// (spazi compattati, taglio a 60 caratteri con «…», ultima riga del testo).
import { describe, expect, it } from 'vitest'
import { narrationStatusLine, NARRATION_STATUS_MAX_LENGTH } from '../narration'

describe('fase risposta (R3): narrationStatusLine', () => {
  it('gli spazi si compattano e la riga si ripulisce', () => {
    expect(narrationStatusLine('  cerco   nel   catalogo  ')).toBe('cerco nel catalogo')
    expect(narrationStatusLine('钙')).toBe('钙')
  })

  it('si prende l\'ULTIMA riga non vuota del testo della chiamata', () => {
    expect(narrationStatusLine('prima riga di pensiero\nseconda riga\n\nterza riga quella buona')).toBe('terza riga quella buona')
    expect(narrationStatusLine('unico\n')).toBe('unico')
  })

  it('oltre 60 caratteri si taglia con «…»', () => {
    const corta = 'a'.repeat(NARRATION_STATUS_MAX_LENGTH)
    expect(narrationStatusLine(corta)).toBe(corta)
    const lunga = 'a'.repeat(NARRATION_STATUS_MAX_LENGTH + 10)
    const taglio = narrationStatusLine(lunga)
    expect(taglio.length).toBe(NARRATION_STATUS_MAX_LENGTH + 1)
    expect(taglio.endsWith('…')).toBe(true)
    // il taglio finisce con trimEnd: niente spazio prima dei puntini
    expect(narrationStatusLine('b'.repeat(59) + ' ' + 'c'.repeat(10))).toBe('b'.repeat(59) + '…')
  })

  it('testo vuoto o solo spazi: riga vuota (il «pensa…» resta)', () => {
    expect(narrationStatusLine('')).toBe('')
    expect(narrationStatusLine('  \n  ')).toBe('')
  })
})
