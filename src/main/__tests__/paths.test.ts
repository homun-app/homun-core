// Test del percorso dati fisso (fase 16, U0b): con qualunque nome app la
// cartella dati resta <appData>/sandbot, quella reale dell'utente.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { userDataDir } from '../paths'

describe('fase 16 (U0b): userDataDir', () => {
  it('con nome app "Homun" (impacchettata) restituisce <appData>/sandbot', () => {
    expect(userDataDir('Homun', '/Users/fabio/Library/Application Support')).toBe(
      join('/Users/fabio/Library/Application Support', 'sandbot')
    )
  })
  it('con nome app "sandbot" (sviluppo) è la stessa cartella', () => {
    expect(userDataDir('sandbot', '/Users/fabio/Library/Application Support')).toBe(
      userDataDir('Homun', '/Users/fabio/Library/Application Support')
    )
  })
  it('è in minuscolo (il nome esatto della cartella esistente)', () => {
    expect(userDataDir('Homun', '/tmp')).toBe(join('/tmp', 'sandbot'))
  })
})
