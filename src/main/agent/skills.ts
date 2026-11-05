// Fase skill (S2/S3/S5): le skill diventano una LIBRERIA UNICA in
// <dataDir>/skills/<name>/ — una CARTELLA con SKILL.md (standard Agent
// Skills, parse in shared/skill-md.ts) più file di supporto facoltativi e
// le versioni precedenti in .versions/. I metadati di Homun (chi la usa, da
// dove arriva) NON stanno in SKILL.md: vivono nel setting `skills.library`.
// Le skill dei PLUGIN restano nella cartella del plugin, in sola lettura.
//
// Funzioni PURE (testabili senza fs): skillsSectionPrompt (il testo del
// prompt), skillInvocationExpansion (il `/nome` di fase skill S7),
// slugifyBotName. L'I/O file sta in fondo.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, statSync, lstatSync, existsSync, renameSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { dataDir, getSetting, setSetting } from '../store/db'
import { boxOwnerOf } from '../sandbox'
import {
  parseSkillMd, buildSkillMd, isValidSkillName, type ParsedSkillMd, type SkillMdIssue
} from '../../shared/skill-md'
import { UI } from '../../shared/ui-messages'
import { ui } from '../../shared/ui-text'
import { uiError } from '../ui-language'
import type { SkillLibraryEntry, SkillLibrarySettings, SkillLibraryItem } from '../../shared/types'

export { isValidSkillName }
export type { ParsedSkillMd }

/**
 * K5: la guardia UNICA del nome di cartella di una skill. Ogni RPC e ogni
 * funzione che costruisce un path con quel nome la chiama per prima: un nome
 * che non sia dello standard ('..', 'a/b', '', …) è l'errore UMANO di nome
 * non valido, prima di toccare il filesystem (il daemon si difende da solo,
 * come deleteLibrarySkill: il renderer è nostro, ma non basta).
 */
export function assertSkillFolder(name: string): string {
  const n = String(name ?? '').trim()
  if (!isValidSkillName(n)) throw uiError(UI.skillErrInvalidName)
  return n
}

// ---- fase 13 (punto 4): le skill dei PLUGIN (sola lettura, mai copiate) ----

import { installedPlugins, pluginSkillBody, type InstalledPlugin } from '../connectors/install'

/** Il rifiuto fisso di update_skill/delete_skill su una skill di plugin. */
export const PLUGIN_SKILL_REFUSAL = 'a plugin\'s skill: it is changed by updating the plugin'

/** Il rifiuto fisso di update_skill su una skill importata da GitHub (S3.3). */
export const GITHUB_SKILL_REFUSAL = 'an imported skill: the user edits or updates it from the Skills window'

/** I plugin installati abilitati per un bot (enabledFor; il figlio eredita dal padre). */
export function pluginsEnabledFor(agentId: string, parentId?: string): InstalledPlugin[] {
  const all = installedPlugins({ getSetting })
  return all.filter((p) => p.enabledFor.includes('*') || p.enabledFor.includes(agentId) || (parentId !== undefined && p.enabledFor.includes(parentId)))
}

/** Le skill dei plugin abilitati per un bot: nome nel prompt <plugin>--<skill> con "(plugin <nome>)". */
export function pluginSkillsOf(agentId: string): Array<{ name: string; description: string }> {
  const owner = boxOwnerOf(agentId)
  return pluginsEnabledFor(agentId, owner === agentId ? undefined : owner).flatMap((p) =>
    p.skills.map((s) => ({ name: s.name, description: `${s.description} (plugin ${p.name})` }))
  )
}

// ---- il testo del prompt (S3.1, PURO) ----

/** Tetto di voci nell'elenco del prompt; oltre, una riga di riscontro. */
export const SKILLS_PROMPT_MAX = 60
/** La descrizione nel prompt si taglia qui (intera nell'interfaccia). */
export const SKILLS_PROMPT_DESC_MAX = 300

/** La descrizione su UNA riga di al massimo 300 caratteri (PURO). */
export function oneLineDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  return flat.length <= SKILLS_PROMPT_DESC_MAX ? flat : `${flat.slice(0, SKILLS_PROMPT_DESC_MAX - 1)}…`
}

/**
 * La sezione «# Available skills» del system prompt (PURO): SOLO le skill
 * abilitate per il bot, ordinate per nome, descrizione tagliata a 300
 * caratteri, al massimo 60 voci (oltre: la riga «N more skills»). Il testo
 * dice quando caricarle, che l'utente può forzarle con /nome e che i file di
 * supporto si leggono con skill({name, file}). '' se non ce n'è nessuna.
 */
export function skillsSectionPrompt(skills: ReadonlyArray<{ name: string; description: string }>): string {
  if (!skills.length) return ''
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name))
  const shown = sorted.slice(0, SKILLS_PROMPT_MAX)
  const lines = shown.map((s) => `- ${s.name}: ${oneLineDescription(s.description)}`)
  const more = sorted.length - shown.length
  return [
    '# Available skills',
    'Reusable procedures with complete instructions. In the prompt you see only the name and description: when a skill matches the current task, load it with skill({name}) and follow it immediately.',
    'The user can force a skill by starting their message with /name.',
    'A skill can have support files (references, examples): the list arrives with the instructions; read one with skill({name, file}).',
    'Create or update skills with update_skill (the user\'s approval is required).',
    ...lines,
    ...(more > 0 ? [`${more} more skills: ask the user or use skill({name}) if you know the name.`] : [])
  ].join('\n')
}

// ---- il `/nome` del turno (S7.3, PURO) ----

/** L'apertura delle routine ([recurring routine: …]) davanti al prompt (S7.4). */
const ROUTINE_OPENING_RE = /^\[recurring routine: [^\]]*\][ \t\n]*/

/** True se il testo PUÒ contenere un'invocazione `/nome` all'inizio (S7.3/S7.4). */
export function mayInvokeSkill(text: string): boolean {
  const t = text.trimStart()
  if (t.startsWith('/')) return true
  return /^\[recurring routine: [^\]]*\][ \t\n]*\/[a-z0-9]/.test(t)
}

/** Le skill visibili al bot, nella forma che serve all'espansione del `/`. */
export interface InvocableSkill {
  name: string
  body: string
  /** github o plugin: testo di terzi — il turno parte contaminato (decisione 3) */
  imported: boolean
}

/** Un segmento di nome di skill: parole singole separate da trattini (niente --). */
const SKILL_NAME_SEGMENT = '[a-z0-9]+(?:-[a-z0-9]+)*'
/** Il `/nome`: un segmento, oppure `<plugin>--<skill>` per le skill dei PLUGIN (K2). */
const SKILL_INVOCATION_RE = new RegExp(`^/(${SKILL_NAME_SEGMENT}(?:--${SKILL_NAME_SEGMENT})?)(?:[ \\t\\n]+([\\s\\S]*))?$`)

/**
 * Il `/nome` all'inizio del messaggio (o del prompt di una routine, dopo
 * l'apertura `[recurring routine: …]`): PURO. Il nome è un segmento dello
 * standard OPPURE `<plugin>--<skill>` (K2: le skill dei plugin si invocano
 * così, col corpo letto dalla cartella del plugin). Se `<name>` è una skill
 * visibile al bot, il contenuto per il modello diventa l'invocazione + le
 * istruzioni + --- + il resto («(no further text)» se vuoto). Nome che non
 * esiste o non è abilitato → null (il testo arriva così com'è).
 */
export function skillInvocationExpansion(
  text: string,
  visible: ReadonlyArray<InvocableSkill>
): { content: string; imported: boolean; name: string } | null {
  const raw = text.replace(/^\uFEFF/, '')
  const routine = ROUTINE_OPENING_RE.exec(raw)
  const afterRoutine = routine ? raw.slice(routine[0].length) : raw
  const m = SKILL_INVOCATION_RE.exec(afterRoutine)
  if (!m) return null
  const name = m[1]!
  const rest = (m[2] ?? '').trim()
  const skill = visible.find((s) => s.name === name)
  if (!skill) return null
  const core = [
    // K9: le istruzioni sono GIÀ qui sotto — il modello non deve spenderci
    // una chiamata skill() per rileggerle
    `The user invoked the skill "${name}" for this message. Its full instructions are below — do not load it again with skill(); follow them now.`,
    '',
    skill.body.trim(),
    '---',
    rest || '(no further text)'
  ].join('\n')
  return { content: (routine ? routine[0] : '') + core, imported: skill.imported, name }
}

// ---- la libreria: setting e visibilità (S2) ----

export const SKILLS_LIBRARY_SETTING = 'skills.library'

export function skillsLibrary(): SkillLibrarySettings {
  return getSetting<SkillLibrarySettings>(SKILLS_LIBRARY_SETTING, {})
}

export function saveSkillsLibrary(lib: SkillLibrarySettings): void {
  setSetting(SKILLS_LIBRARY_SETTING, lib)
}

/** La radice della libreria: <dataDir>/skills/. */
export function libraryDir(): string {
  return join(dataDir(), 'skills')
}

/** Lo slug del nome di un bot, per i conflitti della migrazione: «Il Mio Bot» → il-mio-bot. */
export function slugifyBotName(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  return slug || 'bot'
}

/** Una skill della libreria, come la vede chi la elenca (valida o no). */
export interface LibrarySkill extends ParsedSkillMd {
  /** la cartella (di solito = name; con la migrazione può differire dal name del frontmatter) */
  folder: string
  entry: SkillLibraryEntry
  issues: SkillMdIssue[]
  /**
   * K2: false quando il FORMATO è rotto (parse fallito) o name ≠ cartella
   * (spec S1.2) — la finestra la mostra col motivo ma NON arriva al prompt,
   * al `/`, al tool skill né all'elenco del compositore. I problemi dei soli
   * file di supporto NON la disabilitano: tolgono solo quel file.
   */
  usable: boolean
  files: string[]
}

/**
 * K4: una skill è di TERZI quando arriva da GitHub (source 'github') oppure
 * quando ci ARRIVATA e conserva l'origin — cioè anche dopo che l'utente l'ha
 * modificata dalla finestra (source torna 'user', S4.2). Il testo è comunque
 * scritto da altri: tool, `/` ed etichetta la trattano come importata.
 */
export function isThirdPartySkill(entry: SkillLibraryEntry): boolean {
  return entry.source === 'github' || entry.origin !== undefined
}

/** L'id del bot le cui skill valgono: il padre per un sottoagente (S2.3). */
export function skillOwnerOf(agentId: string): string {
  return boxOwnerOf(agentId)
}

/** Tutte le skill della libreria (scan delle cartelle + setting). */
export function listLibrarySkills(): LibrarySkill[] {
  const lib = skillsLibrary()
  const out: LibrarySkill[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(libraryDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return [] // library assente: nessuna skill
  }
  for (const folder of dirs) {
    const entry: SkillLibraryEntry = lib[folder] ?? {
      enabledFor: ['*'],
      source: 'user',
      createdAt: 0,
      updatedAt: 0
    }
    let text = ''
    try {
      text = readFileSync(join(libraryDir(), folder, 'SKILL.md'), 'utf8')
    } catch {
      out.push({
        folder, name: folder, description: '', body: '', frontmatter: {},
        entry, usable: false,
        issues: [{ english: 'SKILL.md missing.', ui: { id: 'skill.noFrontmatter' } }], files: []
      })
      continue
    }
    const parsed = parseSkillMd(text)
    const { files, issues } = scanSkillFolder(join(libraryDir(), folder))
    if (parsed.ok && parsed.skill.name === folder) {
      out.push({ folder, ...parsed.skill, entry, usable: true, issues, files })
    } else if (parsed.ok) {
      // K2: name ≠ cartella (spec S1.2) — resta nella finestra col motivo ma
      // NON arriva al modello (il nome che il bot vedrebbe sarebbe l'altro)
      out.push({
        folder, ...parsed.skill, entry, usable: false,
        issues: [{
          english: `The name in the file (${parsed.skill.name}) is different from the folder (${folder}).`,
          ui: ui(UI.skillNameFolderMismatch, { name: parsed.skill.name, folder })
        }, ...issues],
        files
      })
    } else {
      out.push({ folder, name: folder, description: '', body: '', frontmatter: {}, entry, usable: false, issues: [...parsed.issues, ...issues], files })
    }
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder))
}

/** Le skill della libreria visibili a un bot: enabledFor '*' o l'id (S2.3).
 *  K2: SOLO le skill USABILI (formato sano e name = cartella). */
export function librarySkillsVisibleTo(agentId: string): LibrarySkill[] {
  const owner = skillOwnerOf(agentId)
  return listLibrarySkills().filter((s) => s.usable && (s.entry.enabledFor.includes('*') || s.entry.enabledFor.includes(owner)))
}

/** Le skill visibili al bot nella forma dell'espansione `/` (libreria + plugin). */
export function invocableSkillsOf(agentId: string): InvocableSkill[] {
  const own = librarySkillsVisibleTo(agentId).map((s): InvocableSkill => ({
    name: s.name,
    body: s.body,
    imported: isThirdPartySkill(s.entry)
  }))
  // K2: anche le skill dei plugin si invocano col `/` — col CORPO letto dalla
  // cartella del plugin (prima arrivava al modello un corpo vuoto)
  const owner = skillOwnerOf(agentId)
  const plugins = pluginsEnabledFor(owner).flatMap((p) =>
    p.skills.map((skill): InvocableSkill => {
      const text = pluginSkillBody(p, dataDir(), skill.name)
      const parsed = text !== null ? parseSkillMd(text) : null
      return { name: skill.name, body: parsed?.ok ? parsed.skill.body : (text ?? ''), imported: true }
    })
  )
  return [...own, ...plugins]
}

/**
 * K2: l'elenco del compositore `/` (RPC `skills:invocable`) — la STESSA
 * selezione di invocableSkillsOf (stesso filtro, stesse visibilità) SENZA i
 * corpi: un'unica fonte di verità, niente filtro duplicato nel renderer.
 */
export function invocableSkillList(agentId: string): Array<{ name: string; description: string; imported: boolean }> {
  const own = librarySkillsVisibleTo(agentId).map((s) => ({
    name: s.name, description: s.description, imported: isThirdPartySkill(s.entry)
  }))
  const plugins = pluginSkillsOf(agentId).map((s) => ({ name: s.name, description: s.description, imported: true }))
  return [...own, ...plugins]
}

/** La sezione skill del system prompt per un agente ('' se non ci sono skill). */
export function buildSkillsSection(agentId: string): string {
  try {
    let all: Array<{ name: string; description: string }>
    try {
      all = [
        ...librarySkillsVisibleTo(agentId).map((s) => ({ name: s.name, description: s.description })),
        ...pluginSkillsOf(agentId)
      ]
    } catch {
      all = [] // i plugin non devono mai rompere il prompt
    }
    return skillsSectionPrompt(all)
  } catch {
    return '' // le skill non devono mai rompere il turno
  }
}

// ---- i file di supporto (S1.3): limiti, symlink, testo ----

/** Tetti dei file di supporto (come Rakazo): 50 file, 256 KB l'uno, 2 MB in tutto. */
export const SKILL_MAX_FILES = 50
export const SKILL_MAX_FILE_BYTES = 256 * 1024
export const SKILL_MAX_TOTAL_BYTES = 2 * 1024 * 1024

/**
 * La scansione di una cartella di skill (pure sul filesystem): l'elenco dei
 * file di supporto VALIDI (percorsi relativi, ordinati) e i problemi trovati
 * — troppi file, troppo grandi, non testo, link simbolici, .versions/ escluso.
 */
export function scanSkillFolder(dir: string): { files: string[]; issues: SkillMdIssue[] } {
  const issues: SkillMdIssue[] = []
  const files: string[] = []
  let total = 0
  const walk = (sub: string): void => {
    for (const ent of readdirSync(join(dir, sub), { withFileTypes: true })) {
      if (sub === '' && ent.name === '.versions') continue // S5: non è un file di supporto
      const rel = sub ? `${sub}/${ent.name}` : ent.name
      if (ent.name === '..' || rel.includes('../')) {
        issues.push({ english: `The path "${rel}" leaves the skill folder.`, ui: { id: 'skill.escapingPath', values: { file: rel } } })
        continue
      }
      const p = join(dir, sub, ent.name)
      if (ent.isSymbolicLink()) {
        issues.push({ english: `The skill folder contains a symbolic link: "${rel}".`, ui: { id: 'skill.symlink', values: { file: rel } } })
        continue
      }
      if (ent.isDirectory()) {
        walk(rel)
        continue
      }
      if (!ent.isFile()) continue
      if (rel === 'SKILL.md') continue
      if (files.length >= SKILL_MAX_FILES) {
        if (files.length === SKILL_MAX_FILES) {
          issues.push({ english: `Too many support files (max ${SKILL_MAX_FILES}).`, ui: { id: 'skill.tooManyFiles', values: { n: SKILL_MAX_FILES + 1 } } })
        }
        continue
      }
      let size = 0
      try {
        size = statSync(p).size
      } catch {
        continue
      }
      if (size > SKILL_MAX_FILE_BYTES) {
        issues.push({ english: `The file "${rel}" is too large (${Math.round(size / 1024)} KB, max 256 KB).`, ui: { id: 'skill.fileTooLarge', values: { file: rel, n: Math.round(size / 1024) } } })
        continue
      }
      if (total + size > SKILL_MAX_TOTAL_BYTES) {
        issues.push({ english: `The skill folder is too large (max ${SKILL_MAX_TOTAL_BYTES / 1024} KB).`, ui: { id: 'skill.libraryTooLarge', values: { n: Math.round((total + size) / 1024) } } })
        continue
      }
      // solo testo: UTF-8 valido, senza NUL
      let buf: Buffer
      try {
        buf = readFileSync(p)
      } catch {
        continue
      }
      if (buf.includes(0) || !isValidUtf8(buf)) {
        issues.push({ english: `The file "${rel}" is not a valid UTF-8 text file.`, ui: { id: 'skill.notText', values: { file: rel } } })
        continue
      }
      total += size
      files.push(rel)
    }
  }
  try {
    walk('')
  } catch {
    return { files: [], issues }
  }
  return { files: files.sort(), issues }
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

// ---- le versioni (S5) ----

/** Le versioni conservate: al più 10 file in <skill>/.versions/. */
export const SKILL_VERSIONS_MAX = 10

function versionsDir(skillDir: string): string {
  return join(skillDir, '.versions')
}

/**
 * Conserva la versione CORRENTE di SKILL.md prima di sovrascriverla:
 * <skill>/.versions/<ISO>.md + l'indice con l'origine (tu, il bot, GitHub).
 * Si tengono le ultime 10. Il nome file è l'ISO con i due punti sostituiti.
 */
export function saveSkillVersion(skillDir: string, origin: 'user' | 'bot' | 'github', by?: string): void {
  const current = join(skillDir, 'SKILL.md')
  if (!existsSync(current)) return
  appendSkillVersion(skillDir, readFileSync(current, 'utf8'), origin, by)
}

/** Aggiunge UNA versione col contenuto dato (le ultime 10) e cura l'indice. */
export function appendSkillVersion(skillDir: string, content: string, origin: 'user' | 'bot' | 'github', by?: string): void {
  const stamp = new Date().toISOString().replace(/:/g, '-')
  mkdirSync(versionsDir(skillDir), { recursive: true })
  // due salvataggi nello stesso millisecondo non si sovrascrivono: -2, -3…
  let file = `${stamp}.md`
  for (let i = 2; existsSync(join(versionsDir(skillDir), file)); i++) file = `${stamp}-${i}.md`
  writeFileSync(join(versionsDir(skillDir), file), content)
  const indexFile = join(versionsDir(skillDir), 'index.json')
  let index: Array<{ file: string; ts: number; origin: string; by?: string }> = []
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8')) as typeof index
  } catch { /* indice nuovo */ }
  index.push({ file, ts: Date.now(), origin, ...(by ? { by } : {}) })
  index.sort((a, b) => a.ts - b.ts || a.file.localeCompare(b.file))
  const kept = index.slice(-SKILL_VERSIONS_MAX)
  for (const old of index.slice(0, -SKILL_VERSIONS_MAX)) {
    try { rmSync(join(versionsDir(skillDir), old.file), { force: true }) } catch { /* già via */ }
  }
  writeFileSync(indexFile, JSON.stringify(kept, null, 2))
}

/** L'elenco delle versioni (più recente prima), con data e origine. */
export function listSkillVersions(name: string): Array<{ file: string; ts: number; origin: string; by?: string }> {
  const skillDir = join(libraryDir(), assertSkillFolder(name))
  try {
    const index = JSON.parse(readFileSync(join(versionsDir(skillDir), 'index.json'), 'utf8')) as Array<{ file: string; ts: number; origin: string; by?: string }>
    return [...index].sort((a, b) => b.ts - a.ts)
  } catch {
    return []
  }
}

/** Ripristina una versione: la versione CORRENTE si conserva prima (S5). */
export function restoreSkillVersion(name: string, file: string): boolean {
  if (!/^[0-9TZa-z.-]+(?:-\d+)?\.md$/.test(file)) throw new Error('invalid version file name')
  const skillDir = join(libraryDir(), assertSkillFolder(name))
  const source = join(versionsDir(skillDir), file)
  if (!existsSync(source)) return false
  saveSkillVersion(skillDir, 'user')
  cpSync(source, join(skillDir, 'SKILL.md'))
  touchLibraryEntry(name)
  return true
}

// ---- scrittura, lettura, eliminazione ----

function touchLibraryEntry(name: string, patch: Partial<SkillLibraryEntry> = {}): void {
  const lib = skillsLibrary()
  const cur = lib[name] ?? { enabledFor: ['*'] as string[], source: 'user' as const, createdAt: Date.now(), updatedAt: 0 }
  lib[name] = { ...cur, ...patch, updatedAt: Date.now() }
  saveSkillsLibrary(lib)
}

/** True se il nome è già usato da una skill della LIBRERIA (visibile o no). */
export function libraryHasName(name: string): boolean {
  return existsSync(join(libraryDir(), name))
}

export interface WriteSkillInput {
  name: string
  description: string
  /** il corpo (istruzioni markdown) */
  body: string
  /** frontmatter di un parse precedente: le chiavi sconosciute si conservano */
  frontmatter?: Record<string, unknown>
}

/**
 * Crea o AGGIORNA una skill della libreria scrivendo SKILL.md (S1). Chi
 * chiama decide i metadati: la finestra passa source 'user' (con origin
 * conservato per le importate), update_skill source 'bot'. La VERSIONE
 * precedente la salva il chiamante (sa l'origine) PRIMA di questa chiamata.
 */
export function writeLibrarySkill(
  input: WriteSkillInput,
  opts: { folder?: string; entry?: Partial<SkillLibraryEntry> } = {}
): { folder: string; created: boolean } {
  const name = input.name.trim()
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: "${name}" (1-64 chars, [a-z0-9-], single hyphens)`)
  const folder = opts.folder ?? name
  if (!isValidSkillName(folder)) throw new Error(`Invalid skill folder: "${folder}"`)
  const skillDir = join(libraryDir(), folder)
  const created = !existsSync(skillDir)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), buildSkillMd({
    name, description: input.description, body: input.body, frontmatter: input.frontmatter
  }))
  const lib = skillsLibrary()
  const cur = lib[folder] ?? { enabledFor: ['*'] as string[], source: 'user' as const, createdAt: Date.now(), updatedAt: 0 }
  lib[folder] = { ...cur, ...opts.entry, updatedAt: Date.now() }
  saveSkillsLibrary(lib)
  return { folder, created }
}

/**
 * update_skill del bot (S3.3): crea con enabledFor [quel bot] e source
 * 'bot'; aggiorna mantenendo enabledFor. Rifiuta plugin e github. Un nome
 * già usato da una skill che il bot NON vede è un errore, senza sovrascrivere.
 */
export function writeSkillFromBot(
  agentId: string,
  input: { name: string; description: string; content: string }
): { ok: true; created: boolean; name: string } | { ok: false; error: string } {
  const name = String(input.name ?? '').trim()
  if (!isValidSkillName(name)) {
    return { ok: false, error: `Invalid skill name: "${name}" (1-64 chars, only lowercase letters, digits and single hyphens).` }
  }
  // plugin: in sola lettura (come oggi)
  if (pluginSkillsOf(agentId).some((x) => x.name === name)) {
    return { ok: false, error: PLUGIN_SKILL_REFUSAL }
  }
  const visible = librarySkillsVisibleTo(agentId)
  const existingVisible = visible.find((s) => s.name === name || s.folder === name)
  // il nome esiste ma il bot NON lo vede: errore, niente sovrascrittura silenziosa
  if (!existingVisible && libraryHasName(name)) {
    return { ok: false, error: `A skill named "${name}" already exists (it is not enabled for this bot): choose a different name.` }
  }
  if (existingVisible && isThirdPartySkill(existingVisible.entry)) {
    // K4: rifiutata anche se l'importata è stata MODIFICATA (source 'user'
    // con origin): il testo resta scritto da altri
    return { ok: false, error: GITHUB_SKILL_REFUSAL }
  }
  const created = !existingVisible
  const frontmatter = existingVisible?.frontmatter
  // la versione precedente si conserva solo se è un AGGIORNAMENTO (S5)
  if (!created) saveSkillVersion(join(libraryDir(), existingVisible!.folder), 'bot', agentId)
  // cartella e name del frontmatter cambiano insieme (rename)
  if (!created && existingVisible!.folder !== name) renameLibraryFolder(existingVisible!.folder, name)
  writeLibrarySkill(
    {
      name,
      description: String(input.description ?? ''),
      body: String(input.content ?? ''),
      ...(frontmatter ? { frontmatter } : {})
    },
    created ? { entry: { enabledFor: [skillOwnerOf(agentId)], source: 'bot' as const, createdBy: agentId } } : {}
  )
  return { ok: true, created, name }
}

/** Rinomina la cartella di una skill (e la sua voce nel setting). */
export function renameLibraryFolder(from: string, to: string): void {
  const src = join(libraryDir(), from)
  const dest = join(libraryDir(), to)
  if (existsSync(src)) renameSync(src, dest)
  const lib = skillsLibrary()
  const cur = lib[from]
  if (cur) {
    delete lib[from]
    lib[to] = { ...cur, updatedAt: Date.now() }
    saveSkillsLibrary(lib)
  }
}

/** Elimina una skill della libreria (directory inclusa); true se esisteva. */
export function deleteLibrarySkill(name: string): boolean {
  const folder = assertSkillFolder(name)
  const dir = join(libraryDir(), folder)
  try {
    readdirSync(dir)
  } catch {
    return false
  }
  rmSync(dir, { recursive: true, force: true })
  const lib = skillsLibrary()
  if (lib[folder]) {
    delete lib[folder]
    saveSkillsLibrary(lib)
  }
  return true
}

/** «Bot che la usano» dalla finestra (come i server MCP). */
export function setSkillEnabledFor(name: string, enabledFor: string[]): void {
  touchLibraryEntry(assertSkillFolder(name), { enabledFor })
}

// ---- lettura per il tool skill (S3.2) ----

/** Il risultato del tool skill senza `file`: istruzioni ed elenco dei file. */
export function readSkillFor(agentId: string, name: string): { output: string; files: string[]; webContent: boolean } | null {
  const visible = librarySkillsVisibleTo(agentId)
  const mine = visible.find((s) => s.name === name)
  if (mine) {
    const lines = [`# ${mine.name}`, '', mine.description, '', mine.body.trim()]
    if (mine.files.length) {
      lines.push('', 'Support files (read with skill({name, file})):', ...mine.files.map((f) => `- ${f}`))
    }
    return { output: lines.join('\n'), files: mine.files, webContent: isThirdPartySkill(mine.entry) }
  }
  // plugin: si LEGGE dalla cartella del plugin (fase 13)
  const owner = skillOwnerOf(agentId)
  for (const p of pluginsEnabledFor(owner)) {
    const body = pluginSkillBody(p, dataDir(), name)
    if (body !== null) {
      const parsed = parseSkillMd(body)
      const content = parsed.ok ? parsed.skill.body : body
      const dir = join(dataDir(), p.dir, p.skills.find((s) => s.name === name)?.dir ?? '')
      const { files } = scanSkillFolder(dir)
      const lines = [`# ${name}`, '', content.trim()]
      if (files.length) {
        lines.push('', 'Support files (read with skill({name, file})):', ...files.map((f) => `- ${f}`))
      }
      return { output: lines.join('\n'), files, webContent: true }
    }
  }
  return null
}

/** Il file di una skill: SOLO se il percorso è esattamente uno dell'elenco (S3.2). */
export function readSkillFileFor(agentId: string, name: string, file: string): { output: string; webContent: boolean } | null {
  const wanted = file.trim()
  // nessuna normalizzazione che apra ../: solo i percorsi esatti dell'elenco
  if (!wanted || wanted.includes('..') || isAbsolute(wanted)) return null
  const base = readSkillFor(agentId, name)
  if (!base || !base.files.includes(wanted)) return null
  const visible = librarySkillsVisibleTo(agentId)
  const mine = visible.find((s) => s.name === name)
  if (mine) {
    const dir = join(libraryDir(), mine.folder)
    // il path è nell'elenco => già validato dalla scansione (interno, testo)
    const target = join(dir, wanted)
    const rel = relative(dir, target)
    if (rel.startsWith('..') || isAbsolute(rel)) return null
    try {
      if (lstatSync(target).isSymbolicLink()) return null
      return { output: readFileSync(target, 'utf8'), webContent: base.webContent }
    } catch {
      return null
    }
  }
  // plugin
  const owner = skillOwnerOf(agentId)
  for (const p of pluginsEnabledFor(owner)) {
    const rec = p.skills.find((s) => s.name === name)
    if (!rec) continue
    const dir = join(dataDir(), p.dir, rec.dir)
    const target = join(dir, wanted)
    const rel = relative(dir, target)
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    try {
      if (lstatSync(target).isSymbolicLink()) continue
      return { output: readFileSync(target, 'utf8'), webContent: true }
    } catch {
      continue
    }
  }
  return null
}

// ---- l'elenco per la finestra (S4) ----

/** La voce della finestra «Skill»: metadati, validità, file (SENZA il corpo). */
export function libraryItemsForUi(): SkillLibraryItem[] {
  return listLibrarySkills().map((s) => ({
    name: s.name,
    folder: s.folder,
    description: s.description,
    enabledFor: s.entry.enabledFor,
    source: s.entry.source,
    ...(s.entry.createdBy ? { createdBy: s.entry.createdBy } : {}),
    ...(s.entry.origin ? { origin: s.entry.origin } : {}),
    createdAt: s.entry.createdAt,
    updatedAt: s.entry.updatedAt,
    files: s.files,
    // K2: valid = formato sano e name = cartella (i problemi dei SOLI file di
    // supporto non rendono la skill non valida: tolgono solo quel file)
    valid: s.usable,
    ...(s.entry.source !== 'github' && s.entry.origin ? { importedModified: true } : {}),
    issues: s.issues.map((i) => ({ english: i.english, uiId: i.ui.id, ...(i.ui.values ? { values: i.ui.values } : {}) }))
  }))
}

/** Lo SKILL.md intero di una skill (per l'editor della finestra). */
export function readSkillMd(folder: string): string {
  return readFileSync(join(libraryDir(), assertSkillFolder(folder), 'SKILL.md'), 'utf8')
}

/** Le skill dei plugin installati per la finestra (sola lettura, per plugin). */
export function pluginSkillGroups(): Array<{ plugin: string; enabledFor: string[]; skills: Array<{ name: string; description: string }> }> {
  return installedPlugins({ getSetting }).map((p) => ({
    plugin: p.name,
    enabledFor: p.enabledFor,
    skills: p.skills.map((s) => ({ name: s.name, description: s.description }))
  }))
}

/** Un file di supporto in sola lettura (per il riquadro della finestra). */
export function readSupportFile(folder: string, file: string): string | null {
  const skill = listLibrarySkills().find((s) => s.folder === folder)
  if (!skill || !skill.files.includes(file)) return null
  try {
    return readFileSync(join(libraryDir(), assertSkillFolder(folder), file), 'utf8')
  } catch {
    return null
  }
}

/** L'esportazione (S4): copia la cartella in ~/Downloads/Homun/skills/<name>/. */
export function exportSkillFolder(name: string): { ok: boolean; path: string } {
  const folder = assertSkillFolder(name)
  const src = join(libraryDir(), folder)
  const downloads = join(homedir(), 'Downloads', 'Homun', 'skills')
  mkdirSync(downloads, { recursive: true })
  let dest = join(downloads, folder)
  for (let i = 2; existsSync(dest); i++) dest = join(downloads, `${folder}-${i}`)
  cpSync(src, dest, {
    recursive: true,
    // .versions/ NON va nell'export (S5)
    filter: (p) => p !== join(src, '.versions') && !p.startsWith(join(src, '.versions') + '/')
  })
  return { ok: true, path: dest }
}
