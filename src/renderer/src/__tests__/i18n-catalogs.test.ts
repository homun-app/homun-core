// Fase 17a (L7.2): i cataloghi en e it — stesso insieme di msgid, nessun
// msgstr vuoto in en, ogni segnaposto {…} del msgid presente nel msgstr.
import { describe, expect, it } from 'vitest'
import { parsePo, icuArgs } from './po-helper'

describe('fase 17a (L4): cataloghi completi', () => {
  const catIt = parsePo('it')
  const catEn = parsePo('en')

  it('i due cataloghi hanno lo stesso insieme di msgid', () => {
    const onlyIt = [...catIt.keys()].filter((k) => !catEn.has(k))
    const onlyEn = [...catEn.keys()].filter((k) => !catIt.has(k))
    expect(onlyIt).toEqual([])
    expect(onlyEn).toEqual([])
  })

  it('nessun msgstr vuoto nel catalogo en', () => {
    const empty = [...catEn.entries()].filter(([, v]) => v === '').map(([k]) => k)
    expect(empty).toEqual([])
  })

  it('il catalogo it (sorgente): msgstr sempre pieno (id a hash = testo; id esplicito = traduzione italiana, fase 17c)', () => {
    // con gli id espliciti della 17c (notice.*, card.*, …) il msgid è il codice
    // e il msgstr della sorgente è il testo italiano: NON deve essere vuoto
    const empty = [...catIt.entries()].filter(([, v]) => v === '').map(([k]) => k)
    expect(empty).toEqual([])
    // gli id a hash (testi del renderer) restano msgstr == msgid
    const hashed = [...catIt.entries()].filter(([k, v]) => !k.includes('.') && v !== '' && v !== k).map(([k]) => k)
    expect(hashed).toEqual([])
  })

  it('ogni segnaposto {…} del msgid è presente nel msgstr inglese', () => {
    const missing: string[] = []
    for (const [id, str] of catEn) {
      const wanted = icuArgs(id)
      const got = icuArgs(str)
      for (const a of wanted) {
        if (!got.has(a)) missing.push(`${id!} → manca {${a}}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('il catalogo non è vuoto (sanity: la UI è davvero avvolta)', () => {
    expect(catIt.size).toBeGreaterThan(400)
    expect(catEn.size).toBe(catIt.size)
  })
})
