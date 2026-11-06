// Fase skill · catalogo (K3): installare una VOCE del catalogo curato col
// percorso dell'import da GitHub di oggi — `stageRepo` (clone sicuro in
// staging, hook disattivati, https SOLAMENTE: file:// solo col flag di test
// SANDBOT_TEST_ALLOW_FILE_URLS) con il COMMIT FISSATO del catalogo come ref.
// Lo sha dello staging deve essere ESATTAMENTE quello della voce, altrimenti
// si rifiuta: si scarica quella versione e nessun'altra.
//
// La copia porta SOLO i file ammessi: si escludono i pattern `files.exclude`
// (glob con `**`, rispetto alla cartella della skill), mentre SKILL.md e
// LICENSE* si copiano SEMPRE. La cartella della libreria è l'`id` della voce
// (con il solito `-2` ai conflitti), il `name` del frontmatter si allinea
// come nell'import di oggi, e la voce di libreria porta source 'github',
// l'origin col catalogId, le homunNotes e l'eventuale invocation — così la
// skill è SEMPRE «di terzi» (contaminazione col tool skill, imported col `/`).
//
// Il catalogo attivo: il file del REPO (src/shared/skill-catalog), sostituito
// da SANDBOT_TEST_SKILL_CATALOG=<file json> nei test e nella sonda — letto
// SOLO insieme a SANDBOT_TEST_USER_DATA, mai in produzione.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  loadSkillCatalog, skillCatalogIssues, skillCatalogInstallState, catalogFileIncluded,
  type SkillCatalogEntry, type SkillCatalogInstallState
} from '../../shared/skill-catalog'
import { parseSkillMd, buildSkillMd, isValidSkillName } from '../../shared/skill-md'
import { stageRepo, availableSkillName } from './skill-github'
import { scanSkillFolder, skillsLibrary, saveSkillsLibrary, libraryDir } from './skills'
import { UI } from '../../shared/ui-messages'
import { ui } from '../ui-language'
import type { UiText, SkillCatalogPreview, SkillLibrarySettings } from '../../shared/types'

export { skillCatalogInstallState, catalogFileIncluded }
export type { SkillCatalogEntry, SkillCatalogInstallState }

/** Il catalogo del repo, letto UNA volta (è un file nostro: non cambia in corsa). */
const REPO_CATALOG = loadSkillCatalog()

/**
 * Il catalogo attivo del processo: quello del REPO, o il catalogo finto dei
 * test (SANDBOT_TEST_SKILL_CATALOG, letto SOLO insieme a SANDBOT_TEST_USER_DATA).
 */
export function activeSkillCatalog(): SkillCatalogEntry[] {
  const file = process.env.SANDBOT_TEST_USER_DATA !== undefined ? process.env.SANDBOT_TEST_SKILL_CATALOG : undefined
  if (!file) return REPO_CATALOG
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { skills?: unknown }
    const entries = loadSkillCatalog(raw.skills)
    // il catalogo finto punta a repository file:// (il repo vero è owner/name):
    // qui si contano le voci USABILI, la validazione integrale sta ai test K1
    const declared = Array.isArray(raw.skills) ? raw.skills.length : 0
    if (entries.length < declared) {
      console.error(`[skills] catalogo di test: ${declared - entries.length} voci su ${declared} non usabili e scartate`)
    }
    return entries
  } catch (e) {
    console.error(`[skills] catalogo di test illeggibile (${file}): ${e instanceof Error ? e.message : e}`)
    return []
  }
}

/** L'URL git di una voce: github in produzione, file:// SOLO col flag di test. */
export function catalogRepoUrl(entry: SkillCatalogEntry, opts: { allowFileUrlsForTests?: boolean }): string {
  if (entry.source.repo.startsWith('file://') && opts.allowFileUrlsForTests === true) return entry.source.repo
  return `https://github.com/${entry.source.repo.replace(/\.git$/, '')}.git`
}

// ---- i file che entrano (la regola PURA delle esclusioni sta in shared) ----

/**
 * L'elenco dei file (relativi, ordinati) che entrano dalla cartella della
 * skill nello staging: l'albero senza .git/.versions, con le esclusioni e i
 * SEMPRE (SKILL.md, LICENSE*). Le directory vuote non si copiano.
 */
export function listCatalogFiles(dir: string, exclude: readonly string[]): string[] {
  const out: string[] = []
  const walk = (sub: string): void => {
    let entries
    try {
      entries = readdirSync(join(dir, sub), { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (sub === '' && (ent.name === '.git' || ent.name === '.versions')) continue
      const rel = sub ? `${sub}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        walk(rel)
        continue
      }
      if (!ent.isFile()) continue
      if (catalogFileIncluded(rel, exclude)) out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

// ---- l'anteprima (non si salva niente) ----

export type CatalogPreviewResult =
  | { ok: true; preview: SkillCatalogPreview; staging: string }
  | { ok: false; error: UiText }

/**
 * L'ANTEPRIMA di una voce del catalogo: staging al COMMIT FISSATO (rifiuto se
 * lo sha non è quello), i file che entreranno, fonte, licenza e note. La
 * skill deve rispettare il formato S1: se no, l'anteprima torna non valida
 * col motivo (come l'import di oggi, «Aggiungi» resta spento).
 */
export async function previewCatalogSkill(
  entry: SkillCatalogEntry,
  opts: { allowFileUrlsForTests?: boolean; mkdtemp?: (p: string) => string } = {}
): Promise<CatalogPreviewResult> {
  const staged = await stageRepo(catalogRepoUrl(entry, opts), entry.source.commit, entry.source.path, opts)
  if (!staged.ok) return { ok: false, error: staged.error }
  // si scarica ESATTAMENTE la versione del catalogo: nessun'altra
  if (staged.sha !== entry.source.commit) {
    rmSync(staged.dir, { recursive: true, force: true })
    console.error(`[skills] catalogo: lo staging è ${staged.sha}, la voce fissa ${entry.source.commit}`)
    return { ok: false, error: ui(UI.skillErrCatalogPin) }
  }
  const skillDir = join(staged.dir, ...entry.source.path.split('/'))
  const files = listCatalogFiles(skillDir, entry.files.exclude)
  const text = existsSync(join(skillDir, 'SKILL.md')) ? readFileSync(join(skillDir, 'SKILL.md'), 'utf8') : ''
  const parsed = parseSkillMd(text)
  const { issues } = scanSkillFolder(skillDir)
  const preview: SkillCatalogPreview = {
    id: entry.id,
    name: parsed.ok ? parsed.skill.name : entry.id,
    description: parsed.ok ? parsed.skill.description : '',
    repo: entry.source.repo,
    commit: entry.source.commit,
    path: entry.source.path,
    license: entry.license,
    files,
    homunNotes: entry.homunNotes,
    ...(entry.invocation ? { invocation: entry.invocation } : {}),
    valid: parsed.ok && issues.length === 0,
    issues: (parsed.ok ? issues : parsed.issues).map((i) => ({ english: i.english, uiId: i.ui.id, ...(i.ui.values ? { values: i.ui.values } : {}) }))
  }
  return { ok: true, preview, staging: staged.dir }
}

// ---- Aggiungi ----

/**
 * «Aggiungi» dalla finestra: copia dallo staging DELL'ANTEPRIMA i soli file
 * ammessi in <dataDir>/skills/<id> (con `-2` ai conflitti), allinea il name
 * del frontmatter alla cartella e scrive la voce di libreria completa
 * (source 'github', origin col catalogId, homunNotes, invocation). La skill
 * resta SEMPRE «di terzi».
 */
export function addCatalogSkillFromStaging(
  staging: string,
  preview: SkillCatalogPreview,
  enabledFor: string[]
): { ok: true; name: string } | { ok: false; error: UiText } {
  const folder = availableSkillName(preview.id, (n) => existsSync(join(libraryDir(), n)) || Boolean(skillsLibrary()[n]))
  if (!isValidSkillName(folder)) return { ok: false, error: ui(UI.skillErrInvalidName) }
  const src = join(staging, ...preview.path.split('/'))
  const dest = join(libraryDir(), folder)
  for (const rel of preview.files) {
    const to = join(dest, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(join(src, rel), to)
  }
  // il name del frontmatter segue la cartella, come l'import di oggi (una
  // voce col name originale diverso dall'id si legge col nome della sua cartella)
  const text = readFileSync(join(dest, 'SKILL.md'), 'utf8')
  const parsed = parseSkillMd(text)
  if (parsed.ok && parsed.skill.name !== folder) {
    writeFileSync(join(dest, 'SKILL.md'), buildSkillMd({ ...parsed.skill, name: folder }))
  }
  const lib: SkillLibrarySettings = { ...skillsLibrary() }
  lib[folder] = {
    enabledFor: enabledFor.length ? enabledFor : ['*'],
    source: 'github',
    origin: { repo: preview.repo, commit: preview.commit, path: preview.path, catalogId: preview.id },
    homunNotes: preview.homunNotes,
    ...(preview.invocation ? { invocation: preview.invocation } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  saveSkillsLibrary(lib)
  return { ok: true, name: folder }
}

/** Il filtro di copia per cpSync (l'albero ammesso di UNA voce del catalogo). */
export function catalogCopyFilter(src: string, exclude: readonly string[]): (p: string) => boolean {
  const versions = join(src, '.versions')
  return (p): boolean => {
    if (p === src) return true
    if (p === versions || p.startsWith(versions + '/')) return false
    if (p.endsWith('/.git') || p.includes('/.git/')) return false
    const rel = p.slice(src.length + 1)
    if (!rel) return true
    // una directory esclusa porta via l'albero (SKILL.md/LICENSE* non sono directory)
    return catalogFileIncluded(rel, exclude)
  }
}
