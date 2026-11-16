// Fase chat-limiti (CL5): l'esito VERO dell'assistente. Un figlio fermato
// dal controllo anti-loop arriva al padre come esito="stopped-loop" (non
// «done»: il risultato è parziale e va detto all'utente), con la riga di
// spiegazione dentro il <sottoagente>. La riga del padre insegna a
// presentare un esito diverso da done come PARZIALE.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { formatSubagentsDone } from '../agent-message'
import { TERMINAL_SUBAGENT_STATUSES } from '../../main/store/subagents'

describe('CL5: l\'esito del figlio fermato dal controllo anti-loop', () => {
  it('status stopped-loop → esito="stopped-loop" nel blocco e LA RIGA di spiegazione', () => {
    const text = formatSubagentsDone([
      { id: 'sub_x', title: 'Ricerca V7', status: 'stopped-loop', summary: 'ho letto 12 annunci su 40' }
    ])
    expect(text).toContain('<sottoagente id="sub_x" titolo="Ricerca V7" esito="stopped-loop">')
    expect(text).toContain('ho letto 12 annunci su 40')
    // la riga che spiega COM'E' FINITO il figlio (parziale, interrotto)
    expect(text).toContain('interrupted by the loop guard: the result is partial')
  })

  it('GUARDIA: figlio finito → esito="done" e NESSUNA riga di interruzione', () => {
    const text = formatSubagentsDone([
      { id: 'sub_ok', title: 'Ricerca ok', status: 'done', summary: 'tutti e 40 gli annunci' }
    ])
    expect(text).toContain('esito="done"')
    expect(text).not.toContain('esito="stopped-loop"')
    expect(text).not.toContain('interrupted by the loop guard')
  })

  it('la riga del PADRE dice che un esito diverso da done va presentato come PARZIALE', () => {
    const text = formatSubagentsDone([{ id: 's', title: 't', status: 'done', summary: 'ok' }])
    expect(text).toContain('PARTIAL')
    expect(text.toLowerCase()).toContain('tell the user')
  })

  it('stopped-loop è uno stato TERMINALE del figlio (il lotto si sveglia)', () => {
    expect(TERMINAL_SUBAGENT_STATUSES).toContain('stopped-loop')
  })
})

describe('CL5: la card dell\'Aiutante mostra «interrotto» (cataloghi it/en veri)', () => {
  const readPo = (lang: 'it' | 'en'): string =>
    readFileSync(new URL(`../../renderer/src/locales/${lang}/messages.po`, import.meta.url), 'utf8')

  it('l\'etichetta «interrotto» c\'è in it con riferimento SubagentCard, e in en è «interrupted»', () => {
    const it = readPo('it')
    expect(it).toContain('SubagentCard.tsx')
    const itBlock = /#: src\/renderer\/src\/components\/SubagentCard\.tsx\nmsgid "interrotto"\nmsgstr "([^"]*)"/.exec(it)
    expect(itBlock).not.toBeNull()
    expect(itBlock?.[1]).toBe('interrotto')
    const en = readPo('en')
    const enBlock = /#: src\/renderer\/src\/components\/SubagentCard\.tsx\nmsgid "interrotto"\nmsgstr "([^"]*)"/.exec(en)
    expect(enBlock).not.toBeNull()
    expect(enBlock?.[1]).toBe('interrupted')
  })
})
