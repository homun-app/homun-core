// Fase 17c correzioni (D3): la funzione di mappatura del renderer per i campi
// del login nella card del fill — codice → testo del catalogo, codice
// sconosciuto (le parole italiane delle entry vecchie) → invariato.
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { fillFieldLabel } from '../fill-fields'
import { itCatalogEntries } from '../../__tests__/po-helper'

// come sidebar-utils.test: l'italiano si risolve dal catalogo it
i18n.load('it', itCatalogEntries())
i18n.activate('it')

const text = (code: string): string => {
  const label = fillFieldLabel(code)
  return typeof label === 'string' ? label : i18n.t(label)
}

describe('fase 17c correzioni (D3): i campi della card del fill', () => {
  it('codice → testo tradotto (username/password/totp)', () => {
    expect(text('username')).toBe('nome utente')
    expect(text('password')).toBe('password')
    expect(text('totp')).toBe('codice TOTP')
  })

  it('codice sconosciuto → invariato (le entry vecchie con le parole italiane)', () => {
    expect(fillFieldLabel('utente')).toBe('utente')
    expect(fillFieldLabel('codice TOTP')).toBe('codice TOTP')
    expect(text('utente')).toBe('utente')
    expect(text('password extra')).toBe('password extra')
  })
})
