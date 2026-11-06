// Fase skill (S6): l'import da GitHub, SOLO istruzioni. L'utente incolla un
// repository (https://github.com/owner/repo), un percorso (…/tree/<ref>/<path>)
// o la cartella di una skill; il clone riusa la pipeline dei plugin (clone
// sparse e shallow in staging mkdtemp, hook disattivati, https SOLO — file://
// solo col flag di test SANDBOT_TEST_ALLOW_FILE_URLS), il commit viene
// risolto e fissato (SHA), le cartelle con SKILL.md si cercano alla radice
// del percorso, in skills/*/ e in */SKILL.md a un livello. Gli errori sono
// UMANI (indirizzo non GitHub, repository non trovato, nessuna skill, troppo
// grande, link simbolico): il git grezzo va nel log, mai in faccia all'utente.
//
// Gli script inclusi NON si eseguono mai: i file si copiano come testo.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { resolveTool } from '../tool-paths'
import {
  checkGitUrl, gitCloneArgv, findEscapingSymlink, dirStats, PLUGIN_MAX_BYTES, PLUGIN_MAX_FILES, PLUGIN_TIMEOUT_MS
} from '../connectors/marketplace'
import { parseSkillMd, buildSkillMd, isValidSkillName } from '../../shared/skill-md'
import { catalogFileIncluded, type SkillCatalogEntry } from '../../shared/skill-catalog'
import { catalogRepoUrl, catalogCopyFilter } from './skill-catalog'
import { scanSkillFolder, libraryDir, skillsLibrary, saveSkillsLibrary, appendSkillVersion, assertSkillFolder } from './skills'
import { UI } from '../../shared/ui-messages'
import { ui } from '../../shared/ui-text'
import type { UiText } from '../../shared/types'
import type {
  SkillGithubPreview, SkillGithubPreviewItem, SkillGithubUpdatePreview, SkillLibraryEntry, SkillLibrarySettings
} from '../../shared/types'

/** L'URL che l'utente ha incollato, ripulito (puro). */
export type ParsedSkillRepoUrl =
  | { ok: true; repo: string; ref?: string; path: string; url: string }
  | { ok: false; error: UiText }

/**
 * Accetta SOLO https://github.com/… (nei test file:// col flag): repository,
 * percorso …/tree/<ref>/<path> o la cartella di una skill (puro).
 */
export function parseGithubSkillUrl(raw: string, opts: { allowFileUrlsForTests?: boolean } = {}): ParsedSkillRepoUrl {
  const s = raw.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const isGithub = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/|$)/.test(s)
  const isFile = opts.allowFileUrlsForTests === true && s.startsWith('file://')
  if (!isGithub && !isFile) {
    return { ok: false, error: ui(UI.skillErrNotGithub) }
  }
  if (isFile) {
    // repo git locale di test: file:///path/to/repo[/tree-ish via query? no: solo il path]
    const rest = s.replace(/^file:\/\//, '')
    return { ok: true, repo: rest, path: '', url: s }
  }
  const after = s.replace(/^https:\/\/github\.com\//, '')
  const parts = after.split('/')
  const repo = parts.slice(0, 2).join('/')
  let ref: string | undefined
  let path = ''
  if (parts[2] === 'tree' && parts[3]) {
    ref = parts[3]
    path = parts.slice(4).join('/')
  } else if (parts.length > 2) {
    path = parts.slice(2).join('/')
  }
  // K7: ref e path finiscono come ARGOMENTI di git (fetch … <ref>,
  // sparse-checkout set <path>): uno che comincia con «-» diventerebbe
  // un'opzione, uno con «..» uscirebbe dal percorso — «indirizzo non valido»
  const dangerous = (seg: string): boolean => seg.startsWith('-') || seg.includes('..')
  if ((ref !== undefined && dangerous(ref)) || path.split('/').some(dangerous)) {
    return { ok: false, error: ui(UI.skillErrNotGithub) }
  }
  return { ok: true, repo, ...(ref ? { ref } : {}), path, url: s }
}

const runGit = (args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((res, rej) => {
    const child = spawn(resolveTool('git'), args, { stdio: ['ignore', 'pipe', 'pipe'], ...(opts.cwd ? { cwd: opts.cwd } : {}) })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { if (timer) clearTimeout(timer); rej(e) })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      res({ code: code ?? 1, stdout, stderr })
    })
  })

// K7 (difesa in profondità): le capacità del git del sistema si sondano UNA
// volta per processo. Se --end-of-options non c'è (o il sondo fallisce) si
// fa a meno del separatore: il parse ha GIÀ rifiutato ref e path pericolosi.
let eooProbe: Promise<boolean> | null = null
function gitSupportsEndOfOptions(cwd: string): Promise<boolean> {
  eooProbe ??= runGit(['fetch', '--end-of-options', 'sandbot-sondo-remoto-inesistente'], { cwd, timeoutMs: 10_000 })
    .then((r) => !/unknown option/i.test(r.stderr))
    .catch(() => false)
  return eooProbe
}
let dashDashProbe: Promise<boolean> | null = null
function gitSparseSupportsDashDash(cwd: string): Promise<boolean> {
  dashDashProbe ??= runGit(['sparse-checkout', 'set', '--'], { cwd, timeoutMs: 10_000 })
    .then((r) => r.code === 0)
    .catch(() => false)
  return dashDashProbe
}

/**
 * Il clone in staging: riusa checkGitUrl + gitCloneArgv + i limiti dei plugin.
 * Fase skill · catalogo (K3): esportata — l'installazione di una voce del
 * catalogo passa da QUI, col commit fissato della voce come ref.
 */
export async function stageRepo(url: string, ref: string | undefined, path: string, opts: { allowFileUrlsForTests?: boolean; mkdtemp?: (p: string) => string }): Promise<
  { ok: true; dir: string; sha: string } | { ok: false; error: UiText; kind: 'not-found' | 'too-large' | 'symlink' | 'clone' }
> {
  const staging = (opts.mkdtemp ?? ((p: string) => mkdtempSync(join(tmpdir(), p))))('sandbot-skill-import-')
  let done = false
  try {
    const check = checkGitUrl(url, opts)
    if (!check.ok) return { ok: false, error: ui(UI.skillErrNotGithub), kind: 'clone' }
    const clone = await runGit(gitCloneArgv(url, staging, true, opts), { timeoutMs: PLUGIN_TIMEOUT_MS })
    if (clone.code !== 0) {
      console.error(`[skills] clone fallito (${url}): ${clone.stderr.trim().slice(0, 200)}`)
      return { ok: false, error: ui(UI.skillErrRepoNotFound), kind: 'not-found' }
    }
    // il ref richiesto (branch/tag), poi lo sparse-checkout DEL PERCORSO (il
    // clone --sparse arriva con l'albero vuoto); senza percorso, tutto l'albero.
    // K7: --end-of-options prima del ref e -- prima del path, se il git del
    // sistema li supporta (mai un ref/path come opzione, anche se già rifiutati)
    if (ref) {
      const eoo = await gitSupportsEndOfOptions(staging)
      const fe = await runGit(['fetch', '--depth', '1', ...(eoo ? ['--end-of-options'] : []), 'origin', ref], { cwd: staging, timeoutMs: PLUGIN_TIMEOUT_MS })
      if (fe.code === 0) await runGit(['checkout', 'FETCH_HEAD'], { cwd: staging })
      else {
        console.error(`[skills] ref ${ref} non trovato: ${fe.stderr.trim().slice(0, 160)}`)
        return { ok: false, error: ui(UI.skillErrRepoNotFound), kind: 'not-found' }
      }
    }
    let sp: { code: number; stdout: string; stderr: string }
    if (path) {
      const dd = await gitSparseSupportsDashDash(staging)
      sp = await runGit(['sparse-checkout', 'set', ...(dd ? ['--'] : []), path], { cwd: staging })
    } else {
      sp = await runGit(['sparse-checkout', 'disable'], { cwd: staging })
    }
    if (sp.code !== 0) {
      console.error(`[skills] percorso ${path || '(radice)'} mancante nel repository`)
      return { ok: false, error: ui(UI.skillErrNoSkills), kind: 'not-found' }
    }
    const shaR = await runGit(['rev-parse', 'HEAD'], { cwd: staging })
    const sha = shaR.stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, error: ui(UI.skillErrRepoNotFound), kind: 'clone' }
    const stats = dirStats(staging)
    if (stats.files > PLUGIN_MAX_FILES || stats.bytes > PLUGIN_MAX_BYTES) {
      return { ok: false, error: ui(UI.skillErrTooLarge), kind: 'too-large' }
    }
    const esc = findEscapingSymlink(staging)
    if (esc) {
      console.error(`[skills] symlink che esce: ${esc}`)
      return { ok: false, error: ui(UI.skillErrSymlink), kind: 'symlink' }
    }
    done = true
    return { ok: true, dir: staging, sha }
  } catch (e) {
    console.error('[skills] errore di staging:', e instanceof Error ? e.message : e)
    return { ok: false, error: ui(UI.skillErrRepoNotFound), kind: 'clone' }
  } finally {
    if (!done) rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Le cartelle delle skill nel clone: SKILL.md alla radice del percorso, nelle
 * sottocartelle di skills/ e a UN livello sotto il percorso (puro sul fs).
 */
export function findSkillDirs(root: string, path: string): string[] {
  const base = path ? join(root, ...path.split('/')) : root
  if (!existsSync(base)) return []
  const out: string[] = []
  if (existsSync(join(base, 'SKILL.md'))) out.push(path)
  const one = (dir: string): void => {
    try {
      for (const ent of readdirSync(join(root, ...dir.split('/')), { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name === '.git' || ent.name === '.versions') continue
        const rel = dir ? `${dir}/${ent.name}` : ent.name
        if (existsSync(join(root, ...rel.split('/'), 'SKILL.md'))) out.push(rel)
      }
    } catch { /* cartella illeggibile: si salta */ }
  }
  one(path)
  const skillsSub = path ? `${path}/skills` : 'skills'
  try {
    for (const ent of readdirSync(join(root, ...skillsSub.split('/')), { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const rel = `${skillsSub}/${ent.name}`
      if (existsSync(join(root, ...rel.split('/'), 'SKILL.md'))) out.push(rel)
    }
  } catch { /* niente sottocartella skills/ */ }
  return [...new Set(out)].sort()
}

/**
 * L'ANTEPRIMA (non si salva niente): per ogni skill trovata nome,
 * descrizione, numero di file, licenza ed errori S1; in alto repository e
 * commit (che si FISSA).
 */
export async function previewSkillsFromGithub(
  url: string,
  opts: { allowFileUrlsForTests?: boolean; mkdtemp?: (p: string) => string } = {}
): Promise<{ ok: true; preview: SkillGithubPreview; staging: string } | { ok: false; error: UiText }> {
  const parsed = parseGithubSkillUrl(url, opts)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  let repoUrl = parsed.url
  if (parsed.url.startsWith('https://github.com/')) repoUrl = `https://github.com/${parsed.repo}`
  const staged = await stageRepo(repoUrl, parsed.ref, parsed.path, opts)
  if (!staged.ok) return { ok: false, error: staged.error }
  const dirs = findSkillDirs(staged.dir, parsed.path)
  const items: SkillGithubPreviewItem[] = []
  for (const dir of dirs) {
    const abs = join(staged.dir, ...dir.split('/'))
    const text = readFileSync(join(abs, 'SKILL.md'), 'utf8')
    const parsedMd = parseSkillMd(text)
    const { files, issues } = scanSkillFolder(abs)
    if (parsedMd.ok) {
      items.push({
        name: parsedMd.skill.name,
        description: parsedMd.skill.description,
        path: dir,
        fileCount: files.length,
        ...(parsedMd.skill.license ? { license: parsedMd.skill.license } : {}),
        valid: issues.length === 0,
        issues: issues.map((i) => ({ english: i.english, uiId: i.ui.id, ...(i.ui.values ? { values: i.ui.values } : {}) }))
      })
    } else {
      // non valida: si mostra SPENTA col motivo
      items.push({
        name: dir.split('/').pop() ?? dir,
        description: '',
        path: dir,
        fileCount: files.length,
        valid: false,
        issues: parsedMd.issues.map((i) => ({ english: i.english, uiId: i.ui.id, ...(i.ui.values ? { values: i.ui.values } : {}) }))
      })
    }
  }
  if (!items.length) {
    rmSync(staged.dir, { recursive: true, force: true })
    return { ok: false, error: ui(UI.skillErrNoSkills) }
  }
  return { ok: true, preview: { repo: repoUrl, commit: staged.sha, skills: items }, staging: staged.dir }
}

/** Il nome disponibile in libreria: <name>-2, -3… (mai una sovrascrittura silenziosa). */
export function availableSkillName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name
  for (let i = 2; ; i++) {
    const candidate = `${name}-${i}`
    if (!taken(candidate)) return candidate
  }
}

/** Il risultato di una scelta in «Aggiungi»: aggiunta, o ERRORE per quella riga (K5). */
export interface SkillAddResult {
  name?: string
  path: string
  error?: { english: string; uiId: string; values?: Record<string, string | number> }
}

/** K6: il filtro di copia dal repository — niente .git e niente .versions ALLA RADICE della skill. */
const repoCopyFilter = (src: string): ((p: string) => boolean) => {
  const versions = join(src, '.versions')
  return (p: string): boolean =>
    !p.endsWith('/.git') && !p.includes('/.git/') && p !== versions && !p.startsWith(versions + '/')
}

/**
 * «Aggiungi»: copia SOLO le cartelle scelte nella libreria, con source
 * 'github' e origin { repo, commit, path }. `renames` sono i nomi scelti
 * dall'utente per i conflitti (path → nome). K5: un nome SCELTO non valido
 * salta quella skill e torna nel risultato come errore della riga — niente
 * eccezione che si porta via il lotto.
 */
export function addSkillsFromStaging(
  staging: string,
  preview: SkillGithubPreview,
  choices: Array<{ path: string; name?: string }>,
  enabledFor: string[]
): SkillAddResult[] {
  const added: SkillAddResult[] = []
  const lib: SkillLibrarySettings = { ...skillsLibrary() }
  for (const choice of choices) {
    const item = preview.skills.find((s) => s.path === choice.path)
    if (!item || !item.valid) continue
    const chosen = (choice.name ?? item.name).trim()
    if (!isValidSkillName(chosen)) {
      added.push({
        path: choice.path,
        error: {
          english: `Invalid skill name "${chosen}" (1-64 chars, only lowercase letters, digits and single hyphens): skipped.`,
          uiId: 'skill.err.invalidName'
        }
      })
      continue
    }
    const name = availableSkillName(chosen, (n) => existsSync(join(libraryDir(), n)) || Boolean(lib[n]))
    const src = join(staging, ...choice.path.split('/'))
    const dest = join(libraryDir(), name)
    cpSync(src, dest, { recursive: true, filter: repoCopyFilter(src) })
    // se il nome è cambiato (conflitto → <name>-2), il nome nel FRONTMATTER
    // segue la cartella: nome e cartella cambiano insieme (come la migrazione)
    if (name !== item.name) {
      const text = readFileSync(join(dest, 'SKILL.md'), 'utf8')
      const parsed = parseSkillMd(text)
      if (parsed.ok) writeFileSync(join(dest, 'SKILL.md'), buildSkillMd({ ...parsed.skill, name }))
    }
    lib[name] = {
      enabledFor: enabledFor.length ? enabledFor : ['*'],
      source: 'github',
      origin: { repo: preview.repo, commit: preview.commit, path: choice.path },
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    added.push({ name, path: choice.path })
  }
  saveSkillsLibrary(lib)
  return added
}

/**
 * «Aggiorna da GitHub» (S6.5): l'anteprima di cosa cambia sull'origin —
 * commit vecchio → nuovo, file aggiunti, tolti e cambiati. Fase skill ·
 * catalogo (K3): una voce del catalogo installata si aggiorna al COMMIT
 * FISSATO che il catalogo attivo porta per lei (`catalog`), non alla HEAD —
 * e lo sha dello staging dev'essere quello, altrimenti rifiuto.
 */
export async function previewSkillUpdate(
  name: string,
  opts: { allowFileUrlsForTests?: boolean; mkdtemp?: (p: string) => string; catalog?: readonly SkillCatalogEntry[] } = {}
): Promise<{ ok: true; diff: SkillGithubUpdatePreview; staging: string } | { ok: false; error: UiText }> {
  const folder = assertSkillFolder(name) // K5: mai un nome che costruisce path
  const lib = skillsLibrary()
  const entry = lib[folder]
  if (!entry?.origin) return { ok: false, error: ui(UI.skillErrNoOrigin) }
  // K3: la voce del catalogo per questa skill installata (se c'è)
  const catEntry = entry.origin.catalogId !== undefined ? opts.catalog?.find((c) => c.id === entry.origin!.catalogId) : undefined
  const catUrl = catEntry ? catalogRepoUrl(catEntry, opts) : entry.origin.repo
  const ref = catEntry ? catEntry.source.commit : undefined
  const staged = await stageRepo(catUrl, ref, entry.origin.path, opts)
  if (!staged.ok) return { ok: false, error: staged.error }
  // si scarica ESATTAMENTE la versione del catalogo: nessun'altra
  if (catEntry && staged.sha !== catEntry.source.commit) {
    rmSync(staged.dir, { recursive: true, force: true })
    return { ok: false, error: ui(UI.skillErrCatalogPin) }
  }
  const dirs = findSkillDirs(staged.dir, entry.origin.path)
  const dir = dirs.includes(entry.origin.path) ? entry.origin.path : dirs[0]
  if (!dir) {
    rmSync(staged.dir, { recursive: true, force: true })
    return { ok: false, error: ui(UI.skillErrNoSkills) }
  }
  const abs = join(staged.dir, ...dir.split('/'))
  const text = readFileSync(join(abs, 'SKILL.md'), 'utf8')
  const parsedMd = parseSkillMd(text)
  if (!parsedMd.ok) {
    rmSync(staged.dir, { recursive: true, force: true })
    return { ok: false, error: ui(UI.skillErrNoSkills) }
  }
  const exclude = catEntry?.files.exclude ?? []
  const { files: scanned, issues } = scanSkillFolder(abs)
  // K3: nel diff contano SOLO i file ammessi (le esclusioni del catalogo):
  // la skill installata non ha evals/ né examples/, non siano «rimossi»
  const files = scanned.filter((f) => catalogFileIncluded(f, exclude))
  const currentDir = join(libraryDir(), folder)
  const currentFiles = scanSkillFolder(currentDir).files
  const added = files.filter((f) => !currentFiles.includes(f))
  const removed = currentFiles.filter((f) => !files.includes(f))
  const changed = files.filter((f) => {
    if (currentFiles.includes(f)) {
      try {
        return readFileSync(join(currentDir, f), 'utf8') !== readFileSync(join(abs, f), 'utf8')
      } catch { return true }
    }
    return false
  })
  const oldText = existsSync(join(currentDir, 'SKILL.md')) ? readFileSync(join(currentDir, 'SKILL.md'), 'utf8') : ''
  const skillChanged = oldText !== text
  return {
    ok: true,
    staging: staged.dir,
    diff: {
      repo: entry.origin.repo,
      oldCommit: entry.origin.commit,
      newCommit: staged.sha,
      added,
      removed,
      changed: skillChanged && !changed.includes('SKILL.md') ? [...changed, 'SKILL.md'] : changed,
      skill: {
        name: parsedMd.skill.name,
        description: parsedMd.skill.description,
        path: dir,
        fileCount: files.length,
        ...(parsedMd.skill.license ? { license: parsedMd.skill.license } : {}),
        valid: issues.length === 0,
        issues: issues.map((i) => ({ english: i.english, uiId: i.ui.id, ...(i.ui.values ? { values: i.ui.values } : {}) }))
      }
    }
  }
}

/**
 * Applica l'aggiornamento: la versione vecchia va in .versions/, l'origin si
 * aggiorna. K5: il nome è una cartella valida (guardia unica). K6: una skill
 * NON valida nel repository non si aggiorna (errore umano — il diff la
 * mostra già spenta); la copia esclude .git e .versions alla radice; dopo la
 * copia il `name` del frontmatter si riscrive uguale alla cartella (come
 * «Aggiungi»: un'importata stile-readme-2 non torna stile-readme).
 * K4: l'aggiornamento riporta source 'github' (l'importata MODIFICATA torna
 * di GitHub: il testo torna quello del repository).
 * Fase skill · catalogo (K3): per una voce del catalogo (`catalog` con la
 * voce installata) la copia rispetta le esclusioni (SKILL.md e LICENSE*
 * sempre), l'origin porta il catalogId e le note per Homun e l'eventuale
 * invocation si aggiornano col catalogo.
 */
export function applySkillUpdate(
  name: string,
  staging: string,
  diff: SkillGithubUpdatePreview,
  opts: { catalog?: readonly SkillCatalogEntry[] } = {}
): { ok: true } | { ok: false; error: UiText } {
  const folder = assertSkillFolder(name) // K5: mai un nome che costruisce path
  const lib = skillsLibrary()
  const entry = lib[folder]
  if (!entry?.origin) return { ok: false, error: ui(UI.skillErrNoOrigin) }
  const catEntry = entry.origin.catalogId !== undefined ? opts.catalog?.find((c) => c.id === entry.origin!.catalogId) : undefined
  // K6: il symlink (o troppi file) del repository non entra in libreria
  if (!diff.skill.valid) return { ok: false, error: ui(UI.skillErrInvalidSkill) }
  const dest = join(libraryDir(), folder)
  try {
    // la versione VECCHIA si conserva (S5, origine GitHub) e le PRECEDENTI
    // attraversano lo scambio di cartella: si spostano di lato e tornano
    const oldText = existsSync(join(dest, 'SKILL.md')) ? readFileSync(join(dest, 'SKILL.md'), 'utf8') : null
    const keptVersions = join(dest, '.versions')
    const versionsStash = dest + '.versions-stash'
    const hadVersions = existsSync(keptVersions)
    if (hadVersions) renameSync(keptVersions, versionsStash)
    // la cartella si sostituisce (SOLO i file del repository: niente .git,
    // niente .versions alla radice — K6: un repository non pianta versioni
    // finte); per una voce del catalogo contano le esclusioni di K3
    rmSync(dest, { recursive: true, force: true })
    const src = join(staging, ...diff.skill.path.split('/'))
    cpSync(src, dest, { recursive: true, filter: catEntry ? catalogCopyFilter(src, catEntry.files.exclude) : repoCopyFilter(src) })
    if (hadVersions) renameSync(versionsStash, keptVersions)
    if (oldText !== null) appendSkillVersion(dest, oldText, 'github')
    // K6: il name del frontmatter segue la cartella, come «Aggiungi»
    const after = readFileSync(join(dest, 'SKILL.md'), 'utf8')
    const parsed = parseSkillMd(after)
    if (parsed.ok && parsed.skill.name !== folder) {
      writeFileSync(join(dest, 'SKILL.md'), buildSkillMd({ ...parsed.skill, name: folder }))
    }
    // K3: l'origin di una voce del catalogo resta della voce (catalogId
    // compreso), e le note per Homun seguono il catalogo attivo
    const next: SkillLibraryEntry = {
      ...entry,
      source: 'github',
      origin: catEntry
        ? { repo: catEntry.source.repo, commit: catEntry.source.commit, path: catEntry.source.path, catalogId: catEntry.id }
        : { repo: diff.repo, commit: diff.newCommit, path: diff.skill.path },
      updatedAt: Date.now()
    }
    if (catEntry) {
      next.homunNotes = catEntry.homunNotes
      if (catEntry.invocation) next.invocation = catEntry.invocation
      else delete next.invocation
    }
    lib[folder] = next
    saveSkillsLibrary(lib)
    return { ok: true }
  } catch (e) {
    console.error('[skills] aggiornamento fallito:', e instanceof Error ? e.message : e)
    return { ok: false, error: ui(UI.skillErrRepoNotFound) }
  }
}
