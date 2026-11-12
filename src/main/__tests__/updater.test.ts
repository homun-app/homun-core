// Fase rilascio (A8): il primo avvio della 0.3 e gli aggiornamenti. Test PURI:
// quando il controllo automatico è ammesso (mai in sviluppo, mai con variabili
// SANDBOT_TEST_*), il confronto delle versioni, e il riconoscimento della
// cartella di Homun 2 (solo existsSync: non si legge niente là dentro).
// FASE RILASCIO — CORREZIONI (K6): mai nemmeno quando manca app-update.yml
// (le build --dir): niente controllo, niente ENOENT nel log.
import { describe, expect, it } from 'vitest'
import {
  shouldAutoCheckUpdates, isNewerVersion, hasUpdateConfig, notesOf,
  UPDATE_OFFER_WINDOW_SIZE, updateOfferWindowOptions, buildUpdateOfferPage,
  updateOfferNotesScript, testUpdateOfferFromEnv, TEST_UPDATE_VERSION,
  offerWindowAction, offerWindowPlan, escapeHtml
} from '../updater'
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

// ---- RW5: le note dell'aggiornamento come testo semplice ----

describe('RW5: notesOf converte l\'HTML delle release in testo leggibile', () => {
  it('releaseNotes stringa HTML → testo piano (niente <p>, <br>, <li>)', () => {
    const info = { version: '0.3.1001-beta.2', releaseNotes: '<p>Aggiornamenti</p><ul><li>una cosa</li><li>un\'altra &amp; compagnia</li></ul>' } as Parameters<typeof notesOf>[0]
    const t = notesOf(info)
    expect(t).toContain('Aggiornamenti')
    expect(t).toContain('• una cosa')
    expect(t).toContain('un\'altra & compagnia')
    expect(t).not.toMatch(/<\/?(p|ul|li)\b/i)
  })

  it('la forma ReleaseNoteInfo (note) passa dallo stesso convertitore', () => {
    const t = notesOf({ version: '1.0.0', releaseNotes: { note: '<p>prima riga<br>seconda riga</p>' } as never } as unknown as Parameters<typeof notesOf>[0])
    expect(t).toBe('prima riga\nseconda riga')
  })
})

// ---- B1 (fase beta.4): il dialogo diventa una finestra di Homun ----

describe('B1: la finestra dell\'offerta — opzioni e pagina (puro)', () => {
  it('piccola, NON ridimensionabile, centrata: al massimo 460×520 pt', () => {
    const o = updateOfferWindowOptions()
    expect(o.width).toBeLessThanOrEqual(460)
    expect(o.height).toBeLessThanOrEqual(520)
    expect(o.resizable).toBe(false)
    expect(o.center).toBe(true)
    // mai Node nel renderer: sandbox, isolation, niente nodeIntegration
    expect(o.webPreferences.nodeIntegration).toBe(false)
    expect(o.webPreferences.contextIsolation).toBe(true)
    expect(o.webPreferences.sandbox).toBe(true)
    expect(UPDATE_OFFER_WINDOW_SIZE).toEqual({ width: 460, height: 520 })
  })

  it('la pagina: titolo con la versione, TRE bottoni, area note che SCORRE, CSP stretta', () => {
    const s = {
      availableTitle: 'È disponibile Homun {version}',
      download: 'Scarica e installa', openNotes: 'Apri le note', later: 'Più tardi'
    } as never as Parameters<typeof buildUpdateOfferPage>[0]
    const page = buildUpdateOfferPage(s, '0.3.1001-beta.4', false)
    expect(page).toContain('È disponibile Homun 0.3.1001-beta.4')
    // i tre bottoni FISSI IN FONDO, ciascico col suo id
    expect(page).toMatch(/id="upd-download"[^>]*>Scarica e installa</)
    expect(page).toMatch(/id="upd-open-notes"[^>]*>Apri le note</)
    expect(page).toMatch(/id="upd-later"[^>]*>Più tardi</)
    // l'area delle note SCORRE (flex + overflow), i bottoni stanno in un
    // footer FUORI dall'area che scorre
    expect(page).toMatch(/#upd-notes\s*\{[^}]*overflow-y:\s*auto/)
    expect(page).toMatch(/<footer/)
    // CSP stretta e NESSUNA rete: la pagina non carica niente da fuori
    expect(page).toMatch(/http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/)
    expect(page).not.toMatch(/(src|href)="(https?:|\/\/)/)
    // le NOTE non sono nella pagina: arrivano dopo, con textContent (mai HTML)
    expect(page).not.toContain('upd-notes-text')
  })

  it('le note arrivano con textContent (mai HTML), anche se contengono tag', () => {
    const js = updateOfferNotesScript('<p>una <strong>voce</strong></p>\n<script>male()</script>')
    expect(js).toContain('textContent')
    expect(js).not.toContain('innerHTML')
    // il testo viaggia come STRINGA JSON: nessun markup interpretato
    expect(js).toContain(JSON.stringify('<p>una <strong>voce</strong></p>\n<script>male()</script>'))
  })
})

// ---- BC1 (fase beta.4 — correzioni): la finestra dell'offerta si comporta ----

describe('BC1: le azioni della finestra dell\'offerta (puro)', () => {
  it('«Scarica e installa» chiude la finestra DOPO l\'azione; «Apri le note» NON chiude', () => {
    expect(offerWindowAction('download')).toEqual({ run: true, close: true })
    expect(offerWindowAction('notes')).toEqual({ run: true, close: false })
    // «Più tardi» (e qualunque valore sconosciuto) chiude senza azioni
    expect(offerWindowAction('later')).toEqual({ run: false, close: true })
    expect(offerWindowAction('qualunque')).toEqual({ run: false, close: true })
  })
})

describe('BC1: una SOLA finestra dell\'offerta alla volta (puro)', () => {
  it('la finestra già aperta si porta in primo piano, non se ne crea un\'altra', () => {
    expect(offerWindowPlan({ downloading: false, offerOpen: true })).toBe('focus')
    expect(offerWindowPlan({ downloading: false, offerOpen: false })).toBe('create')
    // come oggi: con un download in corso non si offre niente
    expect(offerWindowPlan({ downloading: true, offerOpen: true })).toBe('skip')
    expect(offerWindowPlan({ downloading: true, offerOpen: false })).toBe('skip')
  })
})

describe('BC1: la versione arriva dal feed e passa dall\'escape HTML', () => {
  it('un «<» nella versione esce come escape, sia nel titolo sia nell\'h1', () => {
    const s = {
      availableTitle: 'È disponibile Homun {version}',
      download: 'Scarica e installa', openNotes: 'Apri le note', later: 'Più tardi'
    } as never as Parameters<typeof buildUpdateOfferPage>[0]
    const evil = '0.9.9<script>&"\''
    const page = buildUpdateOfferPage(s, evil, false)
    // il markup NON contiene la versione GREZZA: niente tag, niente attributi
    expect(page).not.toContain(evil)
    expect(page).not.toContain('<script>')
    expect(page).not.toContain('0.9.9<')
    // l'escape c'è, nel titolo E nell'h1
    const esc = escapeHtml(evil)
    expect(page.match(new RegExp(esc, 'g'))?.length).toBeGreaterThanOrEqual(2)
    // anche le ETICHETTE dei bottoni passano dall'escape (testi interpolati)
    expect(page).toContain(`>${escapeHtml('Scarica e installa')}<`)
  })

  it('una versione pulita resta leggibile come prima', () => {
    const s = {
      availableTitle: 'È disponibile Homun {version}',
      download: 'Scarica e installa', openNotes: 'Apri le note', later: 'Più tardi'
    } as never as Parameters<typeof buildUpdateOfferPage>[0]
    const page = buildUpdateOfferPage(s, '0.3.1001-beta.4', false)
    expect(page).toContain('È disponibile Homun 0.3.1001-beta.4')
  })
})

describe('B1: il gancio di prova SANDBOT_TEST_UPDATE_NOTES (puro)', () => {
  it('con SANDBOT_TEST_USER_DATA e SANDBOT_TEST_UPDATE_NOTES: la finestra si apre con la versione finta', () => {
    expect(testUpdateOfferFromEnv({ SANDBOT_TEST_USER_DATA: '/x', SANDBOT_TEST_UPDATE_NOTES: '/x/note.html' }))
      .toEqual({ version: TEST_UPDATE_VERSION, notesFile: '/x/note.html' })
  })

  it('SENZA SANDBOT_TEST_USER_DATA la variabile è IGNORATA (mai fuori dalle prove)', () => {
    expect(testUpdateOfferFromEnv({ SANDBOT_TEST_UPDATE_NOTES: '/x/note.html' })).toBeNull()
    // e senza la variabile delle note non c'è niente da aprire
    expect(testUpdateOfferFromEnv({ SANDBOT_TEST_USER_DATA: '/x' })).toBeNull()
    expect(testUpdateOfferFromEnv({})).toBeNull()
  })
})
