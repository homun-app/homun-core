// Fase skill · catalogo (K1): il catalogo delle skill CURATO DA NOI, un file
// JSON nel repo (skill-catalog.json, copiato tale e quale dalla bozza di
// analisi/skill-catalog-bozza.json) con 38 voci da 8 repository GitHub a
// commit fissato e licenze permissive. Il file è un DATO: questo modulo,
// sul modello di src/shared/app-catalog/, è PURO (gira uguale nel renderer,
// nel main, nel daemon e nei test) e non fa MAI rete — l'elenco di Sfoglia
// appare subito perché il catalogo è già nell'app (K2).
//
// Il download al commit fissato (K3) passa dall'import da GitHub di oggi:
// qui ci sono solo i tipi, la validazione (i test K1), la descrizione nella
// lingua dell'interfaccia e la ricerca condivisa della finestra (che batte
// nome, descrizione, repo e categoria, senza accenti né maiuscole).
import catalogJson from './skill-catalog.json'

/** Le categorie nostre: poche e fisse, in quest'ordine (titoletti e filtri di Sfoglia). */
export const SKILL_CATEGORIES = ['writing', 'work', 'thinking', 'research', 'career'] as const

export type SkillCategoryId = (typeof SKILL_CATEGORIES)[number]

/** Il titolo di ogni categoria nelle due lingue (K7). */
export const SKILL_CATEGORY_LABELS: Readonly<Record<SkillCategoryId, { it: string; en: string }>> = {
  writing: { it: 'Scrittura', en: 'Writing' },
  work: { it: 'Lavoro', en: 'Work' },
  thinking: { it: 'Pensiero', en: 'Thinking' },
  research: { it: 'Ricerca', en: 'Research' },
  career: { it: 'Carriera', en: 'Career' }
}

/** La lingua dell'interfaccia, come la usa il catalogo. */
export type SkillCatalogLang = 'it' | 'en'

/** Una voce del catalogo (la forma di skill-catalog.json). */
export interface SkillCatalogEntry {
  /** l'id dello standard Agent Skills: diventa anche il nome della cartella (K3) */
  id: string
  source: {
    /** il repository nella forma owner/name (file:// SOLO nel catalogo finto dei test) */
    repo: string
    /** il commit fissato: si scarica ESATTAMENTE quella versione (K3) */
    commit: string
    /** la cartella della skill nel repository ('' = radice, come humanizer) */
    path: string
  }
  license: string
  category: SkillCategoryId
  description: { it: string; en: string }
  /** i pattern da escludere dalla copia (glob con **); SKILL.md e LICENSE* si copiano sempre */
  files: { exclude: string[] }
  /** le note per Homun: il motore le aggiunge in coda alla skill caricata (K4) */
  homunNotes: string
  /** assente = il modello può caricarla; 'user' = solo con /nome (K5) */
  invocation?: 'user'
  reviewed: string
}

const COMMIT_RE = /^[0-9a-f]{40}$/
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CATEGORIES = SKILL_CATEGORIES as readonly string[]

/**
 * La validazione del catalogo (K1): ogni violazione torna come riga
 * «<id>: <problema>». È la stessa che i test esigono sul file del repo.
 */
export function skillCatalogIssues(raw: unknown): string[] {
  const issues: string[] = []
  if (!Array.isArray(raw)) return ['the catalog is not a list']
  const seen = new Set<string>()
  for (const v of raw) {
    const e = v as Partial<SkillCatalogEntry> | null
    const id = typeof e?.id === 'string' ? e.id : '(missing id)'
    if (typeof e?.id !== 'string' || !NAME_RE.test(e.id) || e.id.length > 64) {
      issues.push(`${id}: the id is not a valid Agent Skills name`)
    } else if (seen.has(e.id)) {
      issues.push(`${id}: duplicate id`)
    }
    seen.add(id)
    const s = e?.source as Partial<SkillCatalogEntry['source']> | undefined
    if (typeof s?.commit !== 'string' || !COMMIT_RE.test(s.commit)) issues.push(`${id}: the commit is not 40 hex chars`)
    if (typeof s?.repo !== 'string' || !REPO_RE.test(s.repo)) issues.push(`${id}: the repo is not owner/name`)
    if (typeof s?.path !== 'string' || s.path.startsWith('/') || s.path.split('/').includes('..')) {
      issues.push(`${id}: the path leaves the repository or is absolute`)
    }
    if (typeof e?.category !== 'string' || !CATEGORIES.includes(e.category)) issues.push(`${id}: unknown category`)
    const d = e?.description as Partial<{ it: string; en: string }> | undefined
    for (const lang of ['it', 'en'] as const) {
      const text = d?.[lang]
      if (typeof text !== 'string' || !text.trim()) issues.push(`${id}: missing ${lang} description`)
      else if (text.length > 140) issues.push(`${id}: the ${lang} description is longer than 140 chars`)
    }
    if (typeof e?.homunNotes !== 'string' || !e.homunNotes.trim()) issues.push(`${id}: missing homunNotes`)
    else if (e.homunNotes.length > 1200) issues.push(`${id}: homunNotes is longer than 1200 chars`)
    if (e?.invocation !== undefined && e.invocation !== 'user') issues.push(`${id}: invocation must be absent or "user"`)
    const excl = (e?.files as Partial<{ exclude: unknown[] }> | undefined)?.exclude
    if (!Array.isArray(excl) || excl.some((x) => typeof x !== 'string' || !x)) issues.push(`${id}: files.exclude must be a list of patterns`)
  }
  return issues
}

/**
 * Il caricatore PURO del catalogo: restituisce le voci strutturalmente sane
 * (quelle con un id, una sorgente e le descrizioni); le violazioni della
 * validazione si vedono con skillCatalogIssues — i test le esigono ZERO sul
 * file del repo, e il catalogo finto dei test (SANDBOT_TEST_SKILL_CATALOG,
 * K3) passa dalla stessa porta. Senza argomento: il file del repo.
 */
export function loadSkillCatalog(raw: unknown = (catalogJson as { skills: unknown }).skills): SkillCatalogEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is SkillCatalogEntry => {
    const e = v as Partial<SkillCatalogEntry> | null
    return typeof e?.id === 'string' && NAME_RE.test(e.id)
      && typeof e?.source?.commit === 'string' && typeof e?.source?.repo === 'string' && typeof e?.source?.path === 'string'
      && CATEGORIES.includes(e.category as string)
      && typeof e?.description?.it === 'string' && typeof e?.description?.en === 'string'
      && typeof e?.homunNotes === 'string'
  })
}

/** La descrizione della voce nella lingua attiva. */
export function skillCatalogDescription(entry: SkillCatalogEntry, lang: SkillCatalogLang): string {
  return lang === 'en' ? entry.description.en : entry.description.it
}

// ---- le esclusioni della copia (K3): glob con «**», PURA ----

/** Un segmento senza «**»: `*` vale [^/]* (niente barre), il resto è letterale. */
function segmentMatches(pattern: string, seg: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
  return re.test(seg)
}

/** Un pattern a segmenti batte un percorso a segmenti: «**» vale zero o più segmenti. */
function globMatches(pattern: string[], segs: string[]): boolean {
  if (pattern.length === 0) return segs.length === 0
  const [head, ...rest] = pattern
  if (head === '**') {
    for (let k = 0; k <= segs.length; k++) {
      if (globMatches(rest, segs.slice(k))) return true
    }
    return false
  }
  if (segs.length === 0 || !segmentMatches(head, segs[0]!)) return false
  return globMatches(rest, segs.slice(1))
}

/**
 * La regola PURA delle esclusioni (K3): un percorso relativo alla cartella
 * della skill entra, o no, secondo i pattern `files.exclude` (glob con `**`).
 * Un pattern che batte una CARTELLA lungo il percorso porta via l'albero
 * intero (così «X/**» esclude anche la cartella X). SKILL.md e LICENSE* si
 * copiano SEMPRE, qualunque pattern.
 */
export function catalogFileIncluded(rel: string, exclude: readonly string[]): boolean {
  if (rel === 'SKILL.md' || /^LICENSE[^/]*$/i.test(rel)) return true
  const segs = rel.split('/')
  for (const pattern of exclude) {
    const pat = pattern.split('/')
    if (globMatches(pat, segs)) return false
    // la regola delle directory: il pattern batte un prefisso di cartelle
    for (let d = 1; d < segs.length; d++) {
      if (globMatches(pat, segs.slice(0, d))) return false
    }
  }
  return true
}

/** Lo stato di una voce rispetto alle skill installate (per la riga della finestra). */
export type SkillCatalogInstallState = 'available' | 'installed' | 'update'

/**
 * Lo stato di una voce del catalogo (K3), PURO: «available» libera,
 * «installed» già aggiunta (origin.catalogId), «update» quando il catalogo
 * porta un commit DIVERSO da quello installato («Aggiornamento disponibile»).
 * `library` sono le skill della libreria col loro origin (la finestra le ha
 * già da skills:library).
 */
export function skillCatalogInstallState(
  entry: SkillCatalogEntry,
  library: ReadonlyArray<{ origin?: { catalogId?: string; commit?: string } | undefined }>
): SkillCatalogInstallState {
  const mine = library.filter((s) => s.origin?.catalogId === entry.id)
  if (mine.length === 0) return 'available'
  // la voce convive con la sua -2: se UNA delle cartelle è al commit giusto,
  // non c'è niente da aggiornare
  return mine.some((s) => s.origin!.commit === entry.source.commit) ? 'installed' : 'update'
}

/** minuscole e senza accenti (NFKD, i segni diacritici via), come la ricerca di oggi. */
function normalizeText(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * La ricerca condivisa del catalogo (K2): la query batte nome, descrizione
 * nella lingua attiva, repo (owner/name) e titolo della categoria — le
 * parole contano tutte, maiuscole e accenti non contano. PURA.
 */
export function searchSkillCatalog(
  entries: readonly SkillCatalogEntry[],
  query: string,
  lang: SkillCatalogLang
): SkillCatalogEntry[] {
  const q = normalizeText(query.trim())
  if (!q) return [...entries]
  const words = q.split(/\s+/).filter(Boolean)
  return entries.filter((e) => {
    const label = SKILL_CATEGORY_LABELS[e.category][lang]
    const hay = [e.id, skillCatalogDescription(e, lang), e.source.repo, label].map(normalizeText).join(' ')
    return words.every((w) => hay.includes(w))
  })
}
