// Fase catalogo app (P3): il modello dell'elenco unico — lo stato di
// collegamento delle righe (diretta, gateway, chiave), la sezione «Connesse»,
// le consigliate (massimo 6, non connesse), le sezioni per categoria (prime 6
// per rank, connesse escluse) e la griglia di ricerca/filtro senza doppioni.
import { describe, expect, it } from 'vitest'
import { appsCatalogModel } from '../apps-view'
import { loadAppCatalog, type AppCuration, type ComposioCatalogEntry, type DirectCatalogEntry } from '../../../../shared/app-catalog'
import type { ConnectorInfo, ComposioStatusInfo, ComposioGatewayStatusInfo } from '../../../../shared/types'

const CURATION: AppCuration = {
  featured: ['gmail', 'slack', 'github'],
  hidden: [],
  categories: { communication: 'communication', productivity: 'productivity', developer: 'development' },
  overrides: {},
  brands: {}
}

const direct = (id: string, category: string): DirectCatalogEntry => ({
  id, name: id, logo: '·', clientRegistration: 'dynamic', category: category as DirectCatalogEntry['category']
})
const co = (slug: string, category: string): ComposioCatalogEntry => ({
  slug, name: slug, description: `desc ${slug}`, categories: [category], toolsCount: 3, logo: null, auth: 'managed'
})

const APPS = loadAppCatalog({
  direct: [direct('linear', 'development')],
  composio: [co('gmail', 'communication'), co('slack', 'communication'), co('github', 'developer'), co('notion', 'productivity')],
  curation: CURATION
})
// ordine: linear (0), gmail (1), slack (2), github (3), notion (4)

const connector = (id: string, status: string): ConnectorInfo => ({
  id, name: id, logo: '·', mcpUrl: 'https://x.example', clientRegistration: 'dynamic', docsUrl: 'https://docs',
  notes: 'n', state: { status: status as ConnectorInfo['state']['status'], disabledTools: [], instructions: '' }, tools: []
})
const gateway = (slug: string, status: 'ACTIVE' | 'RECONNECT' | 'FAILED'): ComposioGatewayStatusInfo => ({
  active: true,
  connected: [{ slug, name: slug, status, accountId: `acc_${slug}` }],
  pending: null
})
const key = (slug: string, status: 'ACTIVE' | 'RECONNECT'): ComposioStatusInfo => ({
  active: true, hasKey: true, keyHint: 'ab…cd', pending: null,
  connected: [{ slug, name: slug, status, accountId: `acc_${slug}`, toolsCount: 3, enabledFor: ['*'], tools: [] }]
})

const model = (input: Partial<Parameters<typeof appsCatalogModel>[0]> = {}) =>
  appsCatalogModel({ apps: APPS, connectors: [], filter: 'all', query: '', lang: 'it', ...input })

describe('P3 — appsCatalogModel: lo stato delle righe', () => {
  it('diretta collegata → Connessa; needs_auth → da ricollegare', () => {
    const m = model({ connectors: [connector('linear', 'connected')] })
    expect(m.rows.find((r) => r.app.id === 'linear')!.connected).toBe('connected')
    const m2 = model({ connectors: [connector('linear', 'needs_auth')] })
    expect(m2.rows.find((r) => r.app.id === 'linear')!.connected).toBe('reconnect')
  })

  it('app del gateway: ACTIVE → Connessa, RECONNECT/FAILED → da ricollegare', () => {
    expect(model({ composioGateway: gateway('gmail', 'ACTIVE') }).rows.find((r) => r.app.id === 'gmail')!.connected).toBe('connected')
    expect(model({ composioGateway: gateway('gmail', 'RECONNECT') }).rows.find((r) => r.app.id === 'gmail')!.connected).toBe('reconnect')
  })

  it('app della chiave di progetto: vale come collegata', () => {
    expect(model({ composio: key('notion', 'ACTIVE') }).rows.find((r) => r.app.id === 'notion')!.connected).toBe('connected')
  })

  it('connectedCount conta le app collegate (testata «N connesse ›»)', () => {
    expect(model({ composioGateway: gateway('gmail', 'ACTIVE'), connectors: [connector('linear', 'connected')] }).connectedCount).toBe(2)
  })
})

describe('P3 — appsCatalogModel: le sezioni (Tutte, senza ricerca)', () => {
  it('«Connesse» in cima, «Consigliate per te» (≤6, non connesse), una sezione per categoria con le prime 6', () => {
    const m = model({ composioGateway: gateway('gmail', 'ACTIVE') })
    expect(m.connectedRows.map((r) => r.app.id)).toEqual(['gmail'])
    // le consigliate sono le featured NON connesse, in ordine di rank
    expect(m.featured.map((r) => r.app.id)).toEqual(['slack', 'github'])
    // le sezioni: communication ha slack (featured) esclusa → vuota e non c'è;
    // l'ordine è quello FISSO delle categorie: productivity prima di development
    expect(m.sections.map((s) => s.category)).toEqual(['productivity', 'development'])
    expect(m.sections.find((s) => s.category === 'communication')).toBeUndefined()
  })

  it('una sezione mostra le prime 6 per rank e il totale per «Visualizza tutto»', () => {
    const many: ComposioCatalogEntry[] = Array.from({ length: 9 }, (_, i) => co(`app${i}`, 'productivity'))
    const apps = loadAppCatalog({ direct: [], composio: many, curation: CURATION })
    const m = appsCatalogModel({ apps, connectors: [], filter: 'all', query: '', lang: 'it' })
    expect(m.sections).toHaveLength(1)
    expect(m.sections[0]!.rows).toHaveLength(6)
    expect(m.sections[0]!.total).toBe(9)
    expect(m.sections[0]!.rows.map((r) => r.app.id)).toEqual(['app0', 'app1', 'app2', 'app3', 'app4', 'app5'])
  })

  it('nessun doppione: consigliate, connesse e sezioni non si intersecano', () => {
    const m = model({ composioGateway: gateway('slack', 'ACTIVE') })
    const ids = [...m.connectedRows, ...m.featured, ...m.sections.flatMap((s) => s.rows)].map((r) => r.app.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('P3 — appsCatalogModel: la griglia di ricerca e filtro', () => {
  it('con una ricerca: UNA griglia con TUTTO ciò che corrisponde (consigliate e connesse incluse)', () => {
    const m = model({ query: 'git', composioGateway: gateway('github', 'ACTIVE') })
    expect(m.grid).not.toBeNull()
    expect(m.grid!.map((r) => r.app.id)).toEqual(['github'])
    expect(m.featured).toEqual([]) // le sezioni non ci sono con la ricerca
    expect(m.sections).toEqual([])
  })

  it('con una categoria: la griglia di quella categoria; con «Connesse»: solo le collegate', () => {
    const byCat = model({ filter: 'communication' })
    expect(byCat.grid!.map((r) => r.app.id)).toEqual(['gmail', 'slack'])
    const byConn = model({ filter: 'connected', composioGateway: gateway('gmail', 'ACTIVE'), connectors: [connector('linear', 'connected')] })
    expect(byConn.grid!.map((r) => r.app.id).sort()).toEqual(['gmail', 'linear'])
  })

  it('ricerca senza risultati → nothingFound (il messaggio vuoto gentile)', () => {
    expect(model({ query: 'zzz' }).nothingFound).toBe(true)
    expect(model({ query: 'gmail' }).nothingFound).toBe(false)
  })

  it('le categorie presenti seguono l\'ordine fisso (le pillole)', () => {
    const m = model({ composioGateway: gateway('gmail', 'ACTIVE') })
    expect(m.categoriesPresent).toEqual(['communication', 'productivity', 'development'])
  })
})
