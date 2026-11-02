// Fase rilascio (A8): il primo avvio della 0.3 e gli aggiornamenti. Test PURI:
// quando il controllo automatico è ammesso (mai in sviluppo, mai con variabili
// SANDBOT_TEST_*), il confronto delle versioni, e il riconoscimento della
// cartella di Homun 2 (solo existsSync: non si legge niente là dentro).
// FASE RILASCIO — CORREZIONI (K6): mai nemmeno quando manca app-update.yml
// (le build --dir): niente controllo, niente ENOENT nel log.
import { describe, expect, it } from 'vitest'
import { shouldAutoCheckUpdates, isNewerVersion, hasUpdateConfig } from '../updater'
import { findLegacyHomun2Dir, isLegacyHomun2DataDir, legacyNoticeMarkerPath } from '../legacy-homun2'

const APP_DATA = '/Users/fabio/Library/Application Support'

describe('fase rilascio (A8): quando si controlla il feed (puro)', () => {
  it('mai in sviluppo (non impacchettata)', () => {
    expect(shouldAutoCheckUpdates(false, {})).toBe(false)
  })

  it('sì nell\'app impacchettata, senza variabili di test', () => {
    expect(shouldAutoCheckUpdates(true, { HOME: '/Users/fabio' })).toBe(true)
  })

  it('MAI quando c\'è una variabile SANDBOT_TEST_* (le prove non toccano la rete)', () => {
    expect(shouldAutoCheckUpdates(true, { SANDBOT_TEST_USER_DATA: '/tmp/x' })).toBe(false)
    expect(shouldAutoCheckUpdates(true, { SANDBOT_TEST_FAKE_KEYCHAIN: '/tmp/kc' })).toBe(false)
    expect(shouldAutoCheckUpdates(true, { SANDBOT_TEST_FAKE_SAFESTORAGE: '/tmp/ss' })).toBe(false)
  })

  it('K6: MAI quando manca Resources/app-update.yml (build --dir), senza errore', () => {
    expect(shouldAutoCheckUpdates(true, { HOME: '/Users/fabio' }, false)).toBe(false)
    // anche l'ordine non conta: sviluppo o prove restano comunque fuori
    expect(shouldAutoCheckUpdates(false, {}, false)).toBe(false)
    expect(shouldAutoCheckUpdates(true, { SANDBOT_TEST_USER_DATA: '/tmp/x' }, false)).toBe(false)
    // col file presente, il giudizio di prima resta
    expect(shouldAutoCheckUpdates(true, { HOME: '/Users/fabio' }, true)).toBe(true)
  })

  it('K6: hasUpdateConfig guarda Resources/app-update.yml (puro, esistenza iniettata)', () => {
    const yes = (p: string) => p === '/Applications/Homun.app/Contents/Resources/app-update.yml'
    expect(hasUpdateConfig('/Applications/Homun.app/Contents/Resources', yes)).toBe(true)
    expect(hasUpdateConfig('/Applications/Homun.app/Contents/Resources', () => false)).toBe(false)
    // senza percorso (test/Node puro): non c'è niente da controllare
    expect(hasUpdateConfig('', yes)).toBe(false)
  })
})

describe('fase rilascio (A8): confronto delle versioni (puro)', () => {
  it('una versione è nuova solo se MAGGIORE (non diversa)', () => {
    expect(isNewerVersion('0.3.0', '0.3.1')).toBe(true)
    expect(isNewerVersion('0.2.1004', '0.3.0')).toBe(true)
    expect(isNewerVersion('0.3.0', '0.3.0')).toBe(false)
    expect(isNewerVersion('0.3.1', '0.3.0')).toBe(false)
  })

  it('versioni malformate non sono novità', () => {
    expect(isNewerVersion('0.3.0', 'viva')).toBe(false)
    expect(isNewerVersion('boh', '0.3.1')).toBe(false)
  })

  it('un pre-release conta la sua x.y.z', () => {
    expect(isNewerVersion('0.3.0', '0.3.1-beta.1')).toBe(true)
  })
})

describe('fase rilascio (A8): la cartella di Homun 2 (solo existsSync)', () => {
  it('riconosciuta da Homun2/engine (il percorso storico) e da Homun/engine', () => {
    expect(isLegacyHomun2DataDir(APP_DATA, 'Homun2', (p) => p === `${APP_DATA}/Homun2/engine`)).toBe(true)
    expect(isLegacyHomun2DataDir(APP_DATA, 'Homun', (p) => p === `${APP_DATA}/Homun/engine`)).toBe(true)
    expect(isLegacyHomun2DataDir(APP_DATA, 'Homun2', () => false)).toBe(false)
    // Homun2 senza engine NON è la sede dati di Homun 2: non si segnala
    expect(isLegacyHomun2DataDir(APP_DATA, 'Homun2', (p) => p === `${APP_DATA}/Homun2/qualcosa`)).toBe(false)
  })

  it('Homun2 vince su Homun quando ci sono entrambe', () => {
    const both = (p: string) => p === `${APP_DATA}/Homun2/engine` || p === `${APP_DATA}/Homun/engine`
    expect(findLegacyHomun2Dir(APP_DATA, both)).toBe(`${APP_DATA}/Homun2`)
    expect(findLegacyHomun2Dir(APP_DATA, (p) => p === `${APP_DATA}/Homun/engine`)).toBe(`${APP_DATA}/Homun`)
    expect(findLegacyHomun2Dir(APP_DATA, () => false)).toBeNull()
  })

  it('il marker della «riga già mostrata» sta nell\'userData', () => {
    expect(legacyNoticeMarkerPath('/Users/fabio/Library/Application Support/sandbot')).toBe(
      '/Users/fabio/Library/Application Support/sandbot/legacy-homun2-noticed'
    )
  })
})
