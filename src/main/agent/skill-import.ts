// PL6 (fase plugin): «Importa skill» da altre app — si cercano le cartelle
// con SKILL.md in ~/.claude/skills, ~/.codex/skills, ~/.zcode/skills,
// ~/.cursor/skills (se esistono) e in una cartella scelta dall'utente. La
// scansione parte SOLO al clic del bottone (mai all'avvio); i doppioni si
// uniscono in UNA riga con tutte le fonti; importare COPIA la skill nella
// libreria di Homun oppure la COLLEGA in sola lettura quando l'utente sceglie
// «Usa la cartella originale». MAI script eseguiti all'import: si leggono e
// si copiano SOLO file di testo (scanSkillFolder li valida così).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseSkillMd } from '../../shared/skill-md'
import { libraryDir, saveSkillsLibrary, scanSkillFolder, skillsLibrary } from './skills'

/** Le quattro app di oggi (i nomi propri non si traducono). */
export const SKILL_IMPORT_SOURCES = [
  { id: 'claude', app: 'Claude Code', dir: '.claude/skills' },
  { id: 'codex', app: 'Codex', dir: '.codex/skills' },
  { id: 'zcode', app: 'ZCode', dir: '.zcode/skills' },
  { id: 'cursor', app: 'Cursor', dir: '.cursor/skills' }
] as const

export type SkillImportSourceId = (typeof SKILL_IMPORT_SOURCES)[number]['id'] | 'folder'

export interface SkillImportRow {
  name: string
  description: string
  /** le app dove la skill esiste (i doppioni esatti si uniscono) */
  sources: SkillImportSourceId[]
  /** il percorso della skill per ogni fonte (per importare) */
  paths: Partial<Record<SkillImportSourceId, string>>
  valid: boolean
  issues: Array<{ english: string; uiId: string }>
  files: string[]
  /** già in libreria con lo stesso nome: non selezionabile */
  existing: boolean
}

export interface SkillImportScanResult {
  rows: SkillImportRow[]
}

/** Il nome dell'app per l'etichetta (la cartella scelta è «cartella scelta»). */
export function skillImportAppOf(source: SkillImportSourceId): string {
  if (source === 'folder') return 'Cartella scelta'
  return SKILL_IMPORT_SOURCES.find((s) => s.id === source)?.app ?? String(source)
}

/** Scansiona UNA cartella di skill (una per app, o quella scelta dall'utente). */
export function scanSkillFolderImport(source: SkillImportSourceId, dir: string, existingNames: ReadonlySet<string> = new Set()): { rows: SkillImportRow[]; skipped: string[] } {
  const rows: SkillImportRow[] = []
  const skipped: string[] = []
  if (!existsSync(dir)) return { rows, skipped }
  // la cartella SCELTA può essere ESSA stessa una skill (SKILL.md diretto):
  // allora è UNA riga col NOME del frontmatter (non il nome della cartella)
  if (existsSync(join(dir, 'SKILL.md'))) {
    const parsed = parseSkillMd(readFileOr(dir, 'SKILL.md'))
    const name = parsed.ok ? parsed.skill.name : basenameOf(dir)
    const single = scanOneSkillDir(source, dir, name, new Set([...existingNames, parsed.ok && name !== basenameOf(dir) ? basenameOf(dir) : '']))
    return { rows: single ? [single] : [], skipped }
  }
  let entries: Array<{ name: string; isDirectory: boolean }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  } catch {
    return { rows, skipped }
  }
  for (const ent of entries.filter((e) => e.isDirectory && !e.name.startsWith('.'))) {
    const skillDir = join(dir, ent.name)
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      skipped.push(ent.name)
      continue
    }
    const row = scanOneSkillDir(source, skillDir, ent.name, existingNames)
    if (row) rows.push(row)
  }
  return { rows, skipped }
}

/** Il basename (senca dipendenze). */
function basenameOf(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || dir
}

/** UNA cartella di skill → UNA riga (valida o col motivo). */
function scanOneSkillDir(source: SkillImportSourceId, skillDir: string, folderName: string, existingNames: ReadonlySet<string>): SkillImportRow | null {
  const parsed = parseSkillMd(readFileOr(skillDir, 'SKILL.md'))
  const { files, issues } = scanSkillFolder(skillDir)
  const base = {
    sources: [source] as SkillImportSourceId[],
    paths: { [source]: skillDir } as SkillImportRow['paths'],
    files,
    existing: existingNames.has(folderName)
  }
  if (parsed.ok && parsed.skill.name !== folderName) {
    // K2 come la libreria: name ≠ cartella resta visibile ma non valida
    return {
      ...base,
      name: folderName, description: parsed.skill.description,
      valid: false,
      issues: [{ english: `The name in the file (${parsed.skill.name}) differs from the folder (${folderName}).`, uiId: 'skill.nameFolderMismatch' }, ...issues.map((i) => ({ english: i.english, uiId: i.ui.id }))]
    }
  }
  return {
    ...base,
    name: folderName,
    description: parsed.ok ? parsed.skill.description : '',
    valid: parsed.ok,
    issues: (parsed.ok ? issues.map((i) => ({ english: i.english, uiId: i.ui.id })) : parsed.issues.map((i) => ({ english: i.english, uiId: i.ui.id })))
  }
}

function readFileOr(dir: string, file: string): string {
  try {
    return readFileSync(join(dir, file), 'utf8')
  } catch {
    return ''
  }
}

/**
 * La scansione delle quattro app (e di cartelle extra scelte): i DOPPIONI
 * esatti (stesso nome) si uniscono in una riga con tutte le fonti. Legge i
 * file SOLO qui — al clic, mai all'avvio.
 */
export function scanSkillsImport(home: string, extraDirs: Array<{ source: SkillImportSourceId; dir: string }> = []): SkillImportScanResult {
  const existing = new Set(Object.keys(skillsLibrary()))
  const byName = new Map<string, SkillImportRow>()
  const dirs: Array<{ source: SkillImportSourceId; dir: string }> = [
    ...SKILL_IMPORT_SOURCES.map((s) => ({ source: s.id as SkillImportSourceId, dir: join(home, s.dir) })),
    ...extraDirs
  ]
  for (const { source, dir } of dirs) {
    const { rows } = scanSkillFolderImport(source, dir, existing)
    for (const row of rows) {
      const hit = byName.get(row.name)
      if (hit) {
        // doppione: si unisce (le fonti si sommano, i file di quella certa)
        hit.sources = [...new Set([...hit.sources, ...row.sources])]
        hit.paths = { ...hit.paths, ...row.paths }
      } else {
        byName.set(row.name, row)
      }
    }
  }
  return { rows: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

export interface SkillImportPick {
  sources: SkillImportSourceId[]
  name: string
}

export type SkillImportOutcome = { name: string; outcome: 'created' | 'linked' | 'duplicate' | 'invalid' | 'missing' }

/**
 * L'import vero: COPIA la skill nella libreria (file di testo, mai eseguiti)
 * oppure la COLLEGA in sola lettura (l'entry punta alla cartella originale).
 * I doppioni non si sovrascrivono, le non valide non entrano.
 */
export function applySkillsImport(home: string, picks: SkillImportPick[], mode: 'copy' | 'link', extraDirs: Array<{ source: SkillImportSourceId; dir: string }> = []): SkillImportOutcome[] {
  const scan = scanSkillsImport(home, extraDirs)
  const lib = skillsLibrary()
  const out: SkillImportOutcome[] = []
  for (const pick of picks) {
    const row = scan.rows.find((r) => r.name === pick.name)
    if (!row) { out.push({ name: pick.name, outcome: 'missing' }); continue }
    if (!row.valid) { out.push({ name: pick.name, outcome: 'invalid' }); continue }
    if (row.existing || existsSync(join(libraryDir(), row.name)) || lib[row.name]) {
      out.push({ name: row.name, outcome: 'duplicate' }); continue
    }
    // la fonte che esiste davvero, tra quelle chieste
    const source = pick.sources.find((s) => row.paths[s]) ?? row.sources.find((s) => row.paths[s])
    const skillDir = source ? row.paths[source] : undefined
    if (!skillDir) { out.push({ name: row.name, outcome: 'missing' }); continue }
    const app = skillImportAppOf(source!)
    const now = Date.now()
    if (mode === 'copy') {
      const dest = join(libraryDir(), row.name)
      mkdirSync(dest, { recursive: true })
      copyFileSync(join(skillDir, 'SKILL.md'), join(dest, 'SKILL.md'))
      for (const f of row.files) {
        mkdirSync(dirname(join(dest, f)), { recursive: true })
        copyFileSync(join(skillDir, f), join(dest, f))
      }
      lib[row.name] = { enabledFor: ['*'], source: 'app', importedFromApp: app, createdAt: now, updatedAt: now }
      out.push({ name: row.name, outcome: 'created' })
    } else {
      lib[row.name] = { enabledFor: ['*'], source: 'app', importedFromApp: app, linkedPath: skillDir, createdAt: now, updatedAt: now }
      out.push({ name: row.name, outcome: 'linked' })
    }
  }
  saveSkillsLibrary(lib)
  return out
}

