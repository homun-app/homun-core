// Test dei widget ask_user (§3bis L10): quali widget vanno marcati widgetDismissed
// quando l'utente scrive altro, e come si legge la risposta.
import { describe, expect, it } from 'vitest'
import { findDismissibleWidgets, responseDisplayText, normalizeOptions, widgetPayload } from '../widgets'
import type { TranscriptEntry } from '../../../shared/types'

let nextId = 1
function mk(kind: TranscriptEntry['kind'], meta?: Record<string, unknown>): TranscriptEntry {
  return { id: nextId++, agentId: 'a', kind, role: 'assistant', content: '', meta: meta ?? null, createdAt: 0 }
}

describe('findDismissibleWidgets (§3bis L10)', () => {
  it('widget con dismissOnMoveOn e senza risposta viene segnalato', () => {
    const withFlag = mk('send-message', {
      message: { type: 'widget', prompt: 'procedo?', dismissOnMoveOn: true, options: [] }
    })
    const dismissible = findDismissibleWidgets([withFlag])
    expect(dismissible.map((e) => e.id)).toEqual([withFlag.id])
  })

  it('già risposto, già scartato o senza dismissOnMoveOn NON vengono segnalati', () => {
    const answered = mk('send-message', {
      message: { type: 'widget', prompt: 'p', dismissOnMoveOn: true, options: [] }, respondedValue: 'si'
    })
    const dismissed = mk('send-message', {
      message: { type: 'widget', prompt: 'p', dismissOnMoveOn: true, options: [] }, widgetDismissed: true
    })
    const persistent = mk('send-message', {
      message: { type: 'widget', prompt: 'p', options: [] } // niente dismissOnMoveOn
    })
    const text = mk('send-message', { message: { type: 'text', text: 'ciao' } })
    expect(findDismissibleWidgets([answered, dismissed, persistent, text])).toHaveLength(0)
  })
})

describe('responseDisplayText', () => {
  const w = {
    type: 'widget' as const, prompt: 'quale?',
    options: [
      { label: 'La prima', value: 'a' }, { label: 'La seconda', value: 'b' }
    ]
  }
  it('valore singolo → etichetta leggibile; multipli → etichette separate da virgola', () => {
    expect(responseDisplayText(w, 'a')).toBe('La prima')
    expect(responseDisplayText(w, ['a', 'b'])).toBe('La prima, La seconda')
  })
  it('testo libero (allowCustom) passa com\'è', () => {
    expect(responseDisplayText(w, 'fammi una cosa diversa')).toBe('fammi una cosa diversa')
  })
})

describe('normalizeOptions', () => {
  it('scarta le opzioni malformi e dà value di ripiego = label', () => {
    const out = normalizeOptions([
      { label: 'Ok', style: 'primary' },
      { label: 'No', value: 'no', description: 'non fare' },
      'spazzatura',
      { description: 'senza label' }
    ])
    expect(out).toEqual([
      { label: 'Ok', value: 'Ok', style: 'primary' },
      { label: 'No', value: 'no', description: 'non fare' }
    ])
  })
  it('widgetPayload estrae il payload solo dalle send-message widget', () => {
    const e = mk('send-message', {
      message: { type: 'widget', prompt: 'procedo?', options: [{ label: 'Sì', value: 'si' }] }
    })
    expect(widgetPayload(e)?.prompt).toBe('procedo?')
    expect(widgetPayload(mk('send-message', { message: { type: 'text', text: 'x' } }))).toBeNull()
    expect(widgetPayload(mk('thinking'))).toBeNull()
  })
})
