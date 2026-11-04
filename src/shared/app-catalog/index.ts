// Fase catalogo app (P2): il modello dei dati dell'elenco UNICO delle app.
// Composio è il MOTORE, non un'app: le sue app compaiono ognuna col suo nome,
// la voce «Composio» del catalogo dei connettori (gateway: true) non è una
// riga. Il catalogo Composio è un FILE CURATO nel repo (composio-catalog.json,
// aggiornato da scripts/aggiorna-catalogo-composio.mjs) e il file di cura
// curation.json è scritto a MANO: qui si fondono e basta, nessuna chiamata
// ad alcuna API. Modulo PURO (due JSON importati come dati): gira uguale nel
// renderer, nel main e nel daemon, e nei test.
//
// UNA RIGA PER MARCHIO: se un marchio ha sia la strada diretta (un connettore
// del catalogo) sia Composio, la riga è UNA e porta le due strade. Quale si
// usa al clic: la diretta SOLO se è pronta senza configurazione (registrazione
// dynamic, o static col client OAuth salvato); altrimenti Composio. Oggi
// Gmail, Calendar e Drive diretti sono static senza client → passano da
// Composio; Cloudflare, Sentry, Stripe, Notion e Linear sono dynamic → restano
// diretti.
import type { Localized } from '../types'

/** Il tagline di una riga: localizzato com'è nel repo, o con le lingue che il file di cura riempia. */
export type AppTagline = Localized | { it?: string; en?: string }
import composioCatalogJson from './composio-catalog.json'
import curationJson from './curation.json'
import connectorsCatalogJson from '../../main/connectors/catalog.json'

export type AppLang = 'it' | 'en'

/** Le categorie nostre: poche e fisse. */
export type AppCategoryId =
  | 'mail-calendar'
  | 'documents'
  | 'communication'
  | 'productivity'
  | 'development'
  | 'sales'
  | 'finance'
  | 'social'
  | 'other'

/** L'ordine fisso delle categorie (pilastro dell'elenco e dei filtri). */
export const APP_CATEGORIES: readonly AppCategoryId[] = [
  'mail-calendar', 'documents', 'communication', 'productivity', 'development', 'sales', 'finance', 'social', 'other'
]

export const APP_CATEGORY_LABELS: Readonly<Record<AppCategoryId, { it: string; en: string }>> = {
  'mail-calendar': { it: 'Posta e calendario', en: 'Mail & calendar' },
  documents: { it: 'Documenti e file', en: 'Docs & files' },
  communication: { it: 'Comunicazione', en: 'Communication' },
  productivity: { it: 'Produttività', en: 'Productivity' },
  development: { it: 'Sviluppo', en: 'Development' },
  sales: { it: 'Vendite e marketing', en: 'Sales & marketing' },
  finance: { it: 'Finanza', en: 'Finance' },
  social: { it: 'Social', en: 'Social' },
  other: { it: 'Altro', en: 'Other' }
}

/** Il nome della categoria nella lingua attiva. */
export function appCategoryLabel(id: AppCategoryId, lang: AppLang): string {
  return APP_CATEGORY_LABELS[id][lang]
}

/** Una voce del catalogo Composio curato (la forma di composio-catalog.json). */
export interface ComposioCatalogEntry {
  slug: string
  name: string
  description: string
  /** gli slug delle CATEGORIE COMPOSIO (il file di cura li mappa nelle nostre) */
  categories: string[]
  toolsCount: number
  /** il file del logo in src/renderer/src/assets/app-logos, o null */
  logo: string | null
  auth: 'managed' | 'none'
}

/** Una voce diretta del catalogo dei connettori, come serve all'elenco app. */
export interface DirectCatalogEntry {
  id: string
  name: string
  logo?: string
  /** la categoria già NOSTRA del catalogo dei connettori */
  category?: string
  tagline?: Localized
  clientRegistration?: 'dynamic' | 'static'
  gateway?: boolean
}

/** Il file di cura, scritto a mano (lo script del catalogo NON lo tocca). */
export interface AppCuration {
  /** gli id (riga, curata o slug) delle consigliate in «Consigliate per te» */
  featured: string[]
  /** slug Composio (o id di curata) da NON mostrare */
  hidden: string[]
  /** categoria Composio → categoria nostra (quelle non mappate finiscono in «Altro») */
  categories: Record<string, AppCategoryId>
  overrides: Record<string, { name?: string; tagline?: { it?: string; en?: string }; category?: AppCategoryId }>
  /** un marchio con DUE strade: la riga è una sola */
  brands: Record<string, { direct: string; composio: string }>
}

/** Una riga dell'elenco unico delle app. */
export interface AppCatalogRow {
  id: string
  name: string
  /** la descrizione inglese di Composio (il foglio del dettaglio), se c'è */
  description: string | null
  /** la mezza riga sotto il nome, già localizzata (null = niente) */
  tagline: AppTagline | null
  category: AppCategoryId
  /** emoji per le dirette, «<slug>.<est>» per i loghi Composio, null = l'iniziale */
  logo: string | null
  via: 'direct' | 'composio'
  directId?: string
  composioSlug?: string
  featured: boolean
  rank: number
}

const DEFAULT_CURATION: AppCuration = { featured: [], hidden: [], categories: {}, overrides: {}, brands: {} }

const isCategoryId = (v: unknown): v is AppCategoryId =>
  typeof v === 'string' && (APP_CATEGORIES as readonly string[]).includes(v)

/** La prima categoria Composio mappata dalle nostre; nessuna → «Altro». */
function mappedCategory(composioCategories: string[], curation: AppCuration): AppCategoryId {
  for (const slug of composioCategories) {
    const mapped = curation.categories[slug]
    if (isCategoryId(mapped)) return mapped
  }
  return 'other'
}

/** La categoria di una curata è già nostra; valori ignoti → undefined. */
function directCategory(entry: DirectCatalogEntry): AppCategoryId | undefined {
  return isCategoryId(entry.category) ? entry.category : undefined
}

/** La curata è pronta senza configurazione: dynamic, o static col client salvato. */
function isDirectReady(entry: DirectCatalogEntry, staticReady: ReadonlySet<string>): boolean {
  if (entry.clientRegistration === 'static') return staticReady.has(entry.id)
  return true
}

/**
 * L'elenco UNICO delle app: le voci dirette del catalogo dei connettori (senza
 * la voce gateway) fuse con il catalogo Composio curato, una riga per marchio,
 * con nascoste, override e categorie applicati. PURA e deterministica: lo
 * stesso input dà lo stesso elenco (prima le curate nell'ordine del catalogo,
 * poi le app Composio in ordine d'uso).
 */
export function loadAppCatalog(input: LoadAppCatalogInput = {}): AppCatalogRow[] {
  const direct = (input.direct ?? (connectorsCatalogJson as unknown as DirectCatalogEntry[])).filter((e) => !e.gateway)
  const composio = input.composio ?? (composioCatalogJson as unknown as ComposioCatalogEntry[])
  const curation: AppCuration = { ...DEFAULT_CURATION, ...(input.curation ?? (curationJson as unknown as AppCuration)) }
  const staticReady = toSet(input.staticClientsReady)
  const hidden = new Set(curation.hidden.map((h) => h.toLowerCase()))
  const featured = new Set(curation.featured.map((f) => f.toLowerCase()))
  const composioBySlug = new Map(composio.map((e) => [e.slug.toLowerCase(), e]))

  const rows: AppCatalogRow[] = []
  const usedSlugs = new Set<string>()
  let rank = 0

  // 1. le curate: se il marchio esiste anche su Composio, la riga è UNA
  for (const entry of direct) {
    if (hidden.has(entry.id.toLowerCase())) continue
    const brandSlug = Object.values(curation.brands).find((b) => b.direct === entry.id)?.composio
    const slug = brandSlug ?? (composioBySlug.has(entry.id.toLowerCase()) ? entry.id.toLowerCase() : null)
    const co = slug ? composioBySlug.get(slug) : undefined
    if (slug) usedSlugs.add(slug)
    const override = curation.overrides[entry.id] ?? (slug ? curation.overrides[slug] : undefined)
    rows.push({
      id: entry.id,
      name: override?.name ?? entry.name,
      description: co?.description ?? null,
      tagline: override?.tagline ?? entry.tagline ?? null,
      category: override?.category ?? directCategory(entry) ?? (co ? mappedCategory(co.categories, curation) : 'other'),
      // il logo VERO di Composio vince sull'emoji della curata
      logo: co?.logo ?? entry.logo ?? null,
      via: co && !isDirectReady(entry, staticReady) ? 'composio' : 'direct',
      directId: entry.id,
      ...(co && slug ? { composioSlug: slug } : {}),
      featured: featured.has(entry.id.toLowerCase()) || (slug ? featured.has(slug) : false),
      rank: rank++
    })
  }

  // 2. le app Composio che restano (ordine d'uso del file curato)
  for (const co of composio) {
    const slug = co.slug.toLowerCase()
    if (usedSlugs.has(slug) || hidden.has(slug)) continue
    const override = curation.overrides[slug]
    rows.push({
      id: slug,
      name: override?.name ?? co.name,
      description: co.description || null,
      tagline: override?.tagline ?? null,
      category: override?.category ?? mappedCategory(co.categories, curation),
      logo: co.logo,
      via: 'composio',
      composioSlug: slug,
      featured: featured.has(slug),
      rank: rank++
    })
  }

  return rows
}

export interface LoadAppCatalogInput {
  direct?: readonly DirectCatalogEntry[]
  composio?: readonly ComposioCatalogEntry[]
  curation?: AppCuration
  /** gli id delle curate STATIC col client OAuth salvato (le rende «pronte») */
  staticClientsReady?: ReadonlySet<string> | readonly string[]
}

function toSet(v: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
  if (!v) return new Set()
  return v instanceof Set ? v : new Set(v)
}

/** Minuscolo e senza accenti (la ricerca non bada a «è» contro «e»). */
function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

/** Il tagline nella lingua scelta (le stringhe semplici restano com'erano). */
export function appTaglineOf(row: AppCatalogRow, lang: AppLang): string | null {
  if (row.tagline) return typeof row.tagline === 'string' ? row.tagline : (row.tagline[lang] ?? null)
  // le app Composio senza tagline curato: la descrizione inglese TRONCATA,
  // solo in inglese — meglio niente che l'inglese in italiano
  if (lang === 'en' && row.description) return truncate(row.description, 90)
  return null
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * La ricerca dell'elenco app: nome, slug, tagline e nome della categoria
 * nella lingua attiva; senza accenti e maiuscole. Prima chi INIZIA con la
 * query, poi chi la contiene, poi per rank.
 */
export function searchApps(apps: readonly AppCatalogRow[], query: string, lang: AppLang): AppCatalogRow[] {
  const q = normalize(query.trim())
  if (!q) return [...apps].sort((a, b) => a.rank - b.rank)
  const words = q.split(/\s+/)
  const scored: Array<{ row: AppCatalogRow; score: number }> = []
  for (const app of apps) {
    const name = normalize(app.name)
    const slug = normalize(app.composioSlug ?? app.directId ?? app.id)
    const tagline = normalize(appTaglineOf(app, lang) ?? '')
    const category = normalize(appCategoryLabel(app.category, lang))
    const hay = `${name} ${slug} ${tagline} ${category}`
    if (!words.every((w) => hay.includes(w))) continue
    scored.push({ row: app, score: name.startsWith(q) || slug.startsWith(q) ? 0 : 1 })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.row.rank - b.row.rank)
    .map((s) => s.row)
}
