// Fase catalogo app (P2): il modello PURO dell'elenco unico delle app — la
// fusione (una riga per marchio, strada scelta, nascoste, override, categorie)
// e la ricerca (prefisso, contenuto, accenti, rank). Tutto con cataloghi
// passati come input; l'ultima battuta prova anche il catalogo di prova del
// repo (composio-catalog.json di P1, DA SOSTITUIRE con quello vero).
import { describe, expect, it } from 'vitest'
import { loadAppCatalog, searchApps, appTaglineOf, appCategoryLabel, type AppCuration, type ComposioCatalogEntry, type DirectCatalogEntry } from '../app-catalog'

const direct = (id: string, extra: Partial<DirectCatalogEntry> = {}): DirectCatalogEntry => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), logo: '·', clientRegistration: 'dynamic', category: 'development', ...extra
})
const co = (slug: string, extra: Partial<ComposioCatalogEntry> = {}): ComposioCatalogEntry => ({
  slug, name: slug, description: `desc of ${slug}`, categories: ['productivity'], toolsCount: 5, logo: null, auth: 'managed', ...extra
})

const CURATION: AppCuration = {
  featured: ['gmail', 'slack'],
  hidden: [],
  categories: { productivity: 'productivity', travel: 'other' },
  overrides: {},
  brands: { gcalendar: { direct: 'gcalendar', composio: 'googlecalendar' } }
}

describe('P2 — loadAppCatalog: una riga per marchio, la strada giusta', () => {
  it('marchio doppio (stesso id): UNA riga sola che porta le due strade', () => {
    const rows = loadAppCatalog({
      direct: [direct('gmail', { clientRegistration: 'static', category: 'mail-calendar', tagline: { it: 'Posta', en: 'Mail' } })],
      composio: [co('gmail'), co('slack')],
      curation: CURATION
    })
    expect(rows.filter((r) => r.id === 'gmail')).toHaveLength(1)
    const gmail = rows.find((r) => r.id === 'gmail')!
    expect(gmail.composioSlug).toBe('gmail')
    expect(gmail.directId).toBe('gmail')
    expect(gmail.via).toBe('composio') // static SENZA client → passa da Composio
    expect(gmail.tagline).toEqual({ it: 'Posta', en: 'Mail' }) // il tagline della curata resta
    expect(gmail.description).toBe('desc of gmail') // la descrizione viene da Composio
  })

  it('brands unisce anche id DIVERSI (gcalendar ↔ googlecalendar)', () => {
    const rows = loadAppCatalog({
      direct: [direct('gcalendar', { clientRegistration: 'static' })],
      composio: [co('googlecalendar')],
      curation: CURATION
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'gcalendar', directId: 'gcalendar', composioSlug: 'googlecalendar', via: 'composio' })
  })

  it('la dinamica Vince: dynamic resta DIRETTA anche se Composio ce l\'ha', () => {
    const rows = loadAppCatalog({
      direct: [direct('notion', { clientRegistration: 'dynamic' })],
      composio: [co('notion')],
      curation: CURATION
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.via).toBe('direct')
    expect(rows[0]!.composioSlug).toBe('notion') // l'altra strada resta, per il dettaglio
  })

  it('static DIVENTA diretta quando il client OAuth è salvato', () => {
    const rows = loadAppCatalog({
      direct: [direct('gmail', { clientRegistration: 'static' })],
      composio: [co('gmail')],
      curation: CURATION,
      staticClientsReady: new Set(['gmail'])
    })
    expect(rows[0]!.via).toBe('direct')
  })

  it('la voce gateway (composio) non è un\'app; le nascoste spariscono (slug o id)', () => {
    const rows = loadAppCatalog({
      direct: [direct('composio', { gateway: true }), direct('linear')],
      composio: [co('slack'), co('discord')],
      curation: { ...CURATION, hidden: ['discord'] }
    })
    expect(rows.map((r) => r.id).sort()).toEqual(['linear', 'slack'])
    const hiddenDirect = loadAppCatalog({
      direct: [direct('linear')],
      composio: [],
      curation: { ...CURATION, hidden: ['linear'] }
    })
    expect(hiddenDirect).toHaveLength(0)
  })

  it('override di nome, tagline e categoria; categoria Composio mappata; non mappata → Altro', () => {
    const rows = loadAppCatalog({
      direct: [],
      composio: [co('x_twitter', { categories: ['social_media', 'travel'] }), co('spotify', { categories: ['music'] })],
      curation: {
        ...CURATION,
        categories: { social_media: 'social' },
        overrides: { x_twitter: { name: 'X', tagline: { it: 'Post brevi', en: 'Short posts' }, category: 'social' } }
      }
    })
    const x = rows.find((r) => r.id === 'x_twitter')!
    expect(x).toMatchObject({ name: 'X', tagline: { it: 'Post brevi', en: 'Short posts' }, category: 'social' })
    // 'music' non è mappata → Altro
    expect(rows.find((r) => r.id === 'spotify')!.category).toBe('other')
  })

  it('rank: prima le curate nell\'ordine del catalogo, poi le app Composio in ordine d\'uso', () => {
    const rows = loadAppCatalog({
      direct: [direct('linear'), direct('notion')],
      composio: [co('slack'), co('github')],
      curation: CURATION
    })
    expect(rows.map((r) => r.id)).toEqual(['linear', 'notion', 'slack', 'github'])
    expect(rows.map((r) => r.rank)).toEqual([0, 1, 2, 3])
  })

  it('featured arriva da id, slug di marchio o slug Composio', () => {
    const rows = loadAppCatalog({
      direct: [direct('gmail', { clientRegistration: 'static' }), direct('linear')],
      composio: [co('gmail'), co('slack'), co('googlesheets')],
      curation: { ...CURATION, featured: ['gmail', 'linear', 'googlesheets'] }
    })
    expect(rows.filter((r) => r.featured).map((r) => r.id).sort()).toEqual(['gmail', 'googlesheets', 'linear'])
  })

  it('il logo di Composio vince sull\'emoji della curata; senza, resta l\'emoji', () => {
    const rows = loadAppCatalog({
      direct: [direct('gmail', { logo: '✉️' }), direct('linear', { logo: '📐' })],
      composio: [co('gmail', { logo: 'gmail.svg' }), co('linear')],
      curation: CURATION
    })
    expect(rows.find((r) => r.id === 'gmail')!.logo).toBe('gmail.svg')
    expect(rows.find((r) => r.id === 'linear')!.logo).toBe('📐')
  })
})

describe('P2 — searchApps: prefisso, contenuto, accenti, rank', () => {
  const rows = loadAppCatalog({
    direct: [],
    composio: [
      co('gmail', { name: 'Gmail', categories: ['communication'] }),
      co('gcal', { name: 'Google Calendar', categories: ['productivity'] }),
      co('gdrive', { name: 'Google Drive', categories: ['productivity'] }),
      co('googlesheets', { name: 'Agoogle Sheets', categories: ['productivity'] }),
      co('caffe', { name: 'Caffè', categories: ['communication'] })
    ],
    curation: { ...CURATION, categories: { communication: 'communication', productivity: 'mail-calendar' } }
  })
  // ordine d'uso: gmail, gcal, gdrive, googlesheets, caffe

  it('«gma» → Gmail per prima (chi INIZIA con la query prima di chi la contiene)', () => {
    expect(searchApps(rows, 'gma', 'it').map((r) => r.id)).toEqual(['gmail'])
  })

  it('«goo» → prima chi inizia (Calendar, Drive), poi chi contiene (Agoogle Sheets)', () => {
    expect(searchApps(rows, 'goo', 'it').map((r) => r.id)).toEqual(['gcal', 'gdrive', 'googlesheets'])
  })

  it('senza accenti trova gli accentati; il nome della categoria nella lingua attiva', () => {
    expect(searchApps(rows, 'caffe', 'it').map((r) => r.id)).toEqual(['caffe'])
    // in it la categoria mail-calendar si chiama «Posta e calendario»
    expect(searchApps(rows, 'posta e calendario', 'it').map((r) => r.id)).toEqual(['gcal', 'gdrive', 'googlesheets'])
    // in en si chiama «Mail & calendar»
    expect(searchApps(rows, 'mail & calendar', 'en').map((r) => r.id)).toEqual(['gcal', 'gdrive', 'googlesheets'])
  })

  it('le parole della ricerca devono esserci TUTTE; query vuota → ordine di rank', () => {
    expect(searchApps(rows, 'google drive', 'it').map((r) => r.id)).toEqual(['gdrive'])
    expect(searchApps(rows, '', 'it').map((r) => r.id)).toEqual(['gmail', 'gcal', 'gdrive', 'googlesheets', 'caffe'])
  })

  it('il tagline (nella lingua attiva) partecipa alla ricerca', () => {
    const withTagline = loadAppCatalog({
      direct: [],
      composio: [co('slack', { name: 'Slack' })],
      curation: { ...CURATION, overrides: { slack: { tagline: { it: 'Canali e messaggi', en: 'Team chat' } } } }
    })
    expect(searchApps(withTagline, 'canali messaggi', 'it').map((r) => r.id)).toEqual(['slack'])
    expect(searchApps(withTagline, 'team chat', 'en').map((r) => r.id)).toEqual(['slack'])
  })
})

describe('P2 — appTaglineOf: la descrizione inglese troncata SOLO in en', () => {
  it('in it niente tagline per le app Composio senza cura (meglio niente che l\'inglese)', () => {
    const rows = loadAppCatalog({ direct: [], composio: [co('slack', { description: 'Search messages and send DMs in Slack, manage channels and threads, and read the workspace history with one sign-in' })], curation: CURATION })
    expect(appTaglineOf(rows[0]!, 'it')).toBeNull()
    const en = appTaglineOf(rows[0]!, 'en')!
    expect(en.length).toBeLessThanOrEqual(91)
    expect(en.endsWith('…')).toBe(true)
  })

  it('le categorie nostre hanno l\'etichetta in entrambe le lingue', () => {
    expect(appCategoryLabel('mail-calendar', 'it')).toBe('Posta e calendario')
    expect(appCategoryLabel('mail-calendar', 'en')).toBe('Mail & calendar')
  })
})

describe('P2 — il catalogo di prova del repo (da sostituire col vero)', () => {
  it('il catalogo bundled si fonde: niente riga Composio, Gmail una volta sola, via Composio', () => {
    const rows = loadAppCatalog()
    expect(rows.some((r) => r.name === 'Composio')).toBe(false)
    expect(rows.filter((r) => r.directId === 'gmail' || r.composioSlug === 'gmail')).toHaveLength(1)
    const gmail = rows.find((r) => r.directId === 'gmail')!
    expect(gmail.via).toBe('composio')
    // le consigliate del file di cura ci sono tutte
    for (const id of ['gmail', 'googlecalendar', 'googledrive', 'notion', 'slack', 'googlesheets']) {
      expect(rows.some((r) => r.featured && (r.id === id || r.composioSlug === id))).toBe(true)
    }
    expect(rows.length).toBeGreaterThanOrEqual(40)
  })
})
