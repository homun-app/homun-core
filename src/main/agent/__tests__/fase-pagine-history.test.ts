// Fase pagine (G2/G6): la riga di contesto della pagina aperta — un
// messaggio utente scritto mentre l'utente legge una pagina arriva al modello
// prefissato da UNA riga sola `[The user is reading the page …]`, presa dal
// meta.readingPage dell'entry (mai nel testo salvato in chat). Il prefisso è
// deterministico: la STESSA entry dà sempre la stessa riga.
import { describe, expect, it } from 'vitest'
import { buildMessages, readingPageLine } from '../history'
import type { TranscriptEntry } from '../../../shared/types'

let nextId = 1
function mk(kind: TranscriptEntry['kind'], role: TranscriptEntry['role'], content: string, meta?: Record<string, unknown>): TranscriptEntry {
  return { id: nextId++, agentId: 'a', kind, role, content, meta: meta ?? null, createdAt: nextId * 1000 }
}

const sys = 'SEI IL SISTEMA'
const PAGE = { id: 'lib_abc', title: 'Brief operativo', version: 3 }
const LINE = '[The user is reading the page "Brief operativo" (id lib_abc, version 3).]'
const unstamped = (content: string): string => content.replace(/^\[Sent: [^\]\n]*\]\n\n/, '')

describe('fase pagine (G2/G6): la riga di contesto della pagina', () => {
  it('readingPageLine: il testo esatto della riga, dal meta', () => {
    expect(readingPageLine(PAGE)).toBe(LINE)
    expect(readingPageLine({ id: 'lib_x', title: 'Piano', version: 1 })).toBe('[The user is reading the page "Piano" (id lib_x, version 1).]')
  })

  it('il messaggio scritto dalla pagina aperta arriva al modello con la riga in testa', () => {
    const entries = [
      mk('message', 'user', 'ciao'),
      mk('message', 'assistant', 'ecco il brief'),
      mk('message', 'user', 'allunga la sezione numeri', { readingPage: PAGE })
    ]
    const msgs = buildMessages(sys, entries)
    const last = msgs[msgs.length - 1]!
    expect(last.role).toBe('user')
    expect(last.content.startsWith(LINE + '\n')).toBe(true)
    // dopo la riga resta il timbro di U4 e il testo originale
    const stamp = last.content.match(/\[Sent: ([^\]\n]*)\]/)![1]
    expect(last.content).toBe(`${LINE}\n[Sent: ${stamp}]\n\nallunga la sezione numeri`)
  })

  it('i messaggi SENZA readingPage restano com\'erano (nessuna riga)', () => {
    const entries = [mk('message', 'user', 'normale')]
    const msgs = buildMessages(sys, entries)
    expect(unstamped(msgs[1]!.content)).toBe('normale')
  })

  it('la riga si ricostruisce uguale nei turni SUCCESSIVI (stessa entry, stesso testo)', () => {
    const entries = [
      mk('message', 'user', 'allunga la sezione numeri', { readingPage: PAGE }),
      mk('message', 'assistant', 'fatto'),
      mk('message', 'user', 'grazie')
    ]
    const once = buildMessages(sys, entries)[1]!.content
    const again = buildMessages(sys, entries)[1]!.content
    expect(once).toBe(again)
    expect(once.startsWith(LINE + '\n')).toBe(true)
  })

  it('un meta.readingPage malformato non rompe la storia (riga assente)', () => {
    const entries = [mk('message', 'user', 'x', { readingPage: { id: 'lib_a' } })]
    const msgs = buildMessages(sys, entries)
    expect(unstamped(msgs[1]!.content)).toBe('x')
  })
})
