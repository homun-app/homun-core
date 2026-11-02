// Test del percorso dati fisso (fase 16, U0b): con qualunque nome app la
// cartella dati resta <appData>/sandbot, quella reale dell'utente.
// Fase rilascio (A8): SANDBOT_TEST_USER_DATA sposta l'userData intero (le
// prove con la .app impacchettata non toccano i dati veri) e la cartella non
// coincide MAI con quelle di Homun 2 (confronto case-insensitive, come APFS).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { userDataDir, isSafeUserDataDir } from '../paths'

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

describe('fase rilascio (A8): override e confine con Homun 2', () => {
  it('SANDBOT_TEST_USER_DATA vince sul percorso storico', () => {
    expect(userDataDir('Homun', '/Users/fabio/Library/Application Support', { SANDBOT_TEST_USER_DATA: '/var/folders/xx/T/sb-test' }))
      .toBe('/var/folders/xx/T/sb-test')
  })
  it('senza la variabile il percorso è quello storico', () => {
    expect(userDataDir('Homun', '/Users/fabio/Library/Application Support', {})).toBe(
      join('/Users/fabio/Library/Application Support', 'sandbot')
    )
  })
  it('la cartella dati non coincide mai con …/Homun né …/Homun2, maiuscole comprese', () => {
    const appData = '/Users/fabio/Library/Application Support'
    expect(isSafeUserDataDir(join(appData, 'sandbot'), appData)).toBe(true)
    expect(isSafeUserDataDir(join(appData, 'Homun'), appData)).toBe(false)
    expect(isSafeUserDataDir(join(appData, 'Homun2'), appData)).toBe(false)
    expect(isSafeUserDataDir(join(appData, 'homun2'), appData)).toBe(false)
    expect(isSafeUserDataDir(join(appData, 'HOMUN'), appData)).toBe(false)
    expect(isSafeUserDataDir(join(appData, 'Homun2/engine'), appData)).toBe(true) // dentro ≠ uguale: il check vale per la RADICE dati
  })
})
