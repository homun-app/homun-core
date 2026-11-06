// Fase skill · catalogo (K3): installare una voce del catalogo col percorso
// dell'import da GitHub di oggi (stageRepo, anteprima, libreria) e il COMMIT
// FISSATO del catalogo come ref. Repository git LOCALE file:// SOLO col flag
// di test, e il catalogo finto SANDBOT_TEST_SKILL_CATALOG (letto solo insieme
// a SANDBOT_TEST_USER_DATA). Tre skill nel repository: una alla RADICE (come
// humanizer), una con evals/ ed examples/ da escludere, una «solo con /».
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-skcat-test-'))
let REPO = ''
let A = '' // il commit fissato dal catalogo
let B = '' // il repository è andato avanti
let BLOB = '' // un oggetto che ESISTE ma non è un commit
let TAG = '' // l'oggetto di un tag annotato (punta ad A, ma non È A)
const { setDataDir, dataDir } = await import('../../store/db')
const {
  activeSkillCatalog, previewCatalogSkill, addCatalogSkillFromStaging, catalogFileIncluded
} = await import('../skill-catalog')
const { previewSkillUpdate, applySkillUpdate } = await import('../skill-github')
const {
  skillsLibrary, libraryDir, isThirdPartySkill, readSkillFor, invocableSkillsOf, listLibrarySkills
} = await import('../skills')
const { skillCatalogInstallState, loadSkillCatalog } = await import('../../../shared/skill-catalog')
type Entry = import('../../../shared/skill-catalog').SkillCatalogEntry

const opts = () => ({ allowFileUrlsForTests: true })
const git = (cmd: string): string => execSync(cmd, { cwd: REPO }).toString().trim()

/** Il catalogo finto: le tre voci puntano al repository file:// al commit dato. */
function fakeCatalog(commit: string, notesSuffix = ''): { version: number; categories: string[]; skills: Entry[] } {
  const base = { license: 'MIT', reviewed: '2026-11-06' }
  return {
    version: 1,
    categories: ['writing', 'work', 'thinking', 'research', 'career'],
    skills: [
      {
        ...base, id: 'umanizza-testi', category: 'writing',
        source: { repo: `file://${REPO}`, commit, path: '' },
        description: { it: 'Toglie i tic da IA a un testo.', en: 'Removes AI tells from a text.' },
        files: { exclude: ['evals/**', 'examples/**', 'README.md', 'scripts/**', 'skills/**'] },
        homunNotes: `NOTE-UMANIZZA${notesSuffix}`
      },
      {
        ...base, id: 'con-esempi', category: 'work', license: 'Apache-2.0',
        source: { repo: `file://${REPO}`, commit, path: 'skills/con-esempi' },
        description: { it: 'Una skill con esempi da escludere.', en: 'A skill with examples to exclude.' },
        // *.txt colpirebbe LICENSE.txt: LICENSE* si copia SEMPRE
        files: { exclude: ['evals/**', 'examples/**', 'README.md', '*.txt'] },
        homunNotes: `NOTE-ESEMPI${notesSuffix}`
      },
      {
        ...base, id: 'solo-utente', category: 'thinking',
        source: { repo: `file://${REPO}`, commit, path: 'skills/solo-utente' },
        description: { it: 'Solo su richiesta.', en: 'On request only.' },
        files: { exclude: ['evals/**'] },
        homunNotes: `NOTE-SOLO${notesSuffix}`,
        invocation: 'user'
      }
    ]
  }
}

const catalogFile = (name: string, commit: string, notesSuffix = ''): string => {
  const f = join(TMP, name)
  writeFileSync(f, JSON.stringify(fakeCatalog(commit, notesSuffix), null, 2))
  return f
}

const ENV_KEYS = ['SANDBOT_TEST_USER_DATA', 'SANDBOT_TEST_SKILL_CATALOG'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  setDataDir(join(TMP, 'data'))
  dataDir()
  REPO = mkdtempSync(join(tmpdir(), 'sandbot-skcat-repo-'))
  // 1. la skill alla RADICE (come humanizer): il name del frontmatter è
  //    DIVERSO dall'id del catalogo (si allinea come nell'import di oggi)
  writeFileSync(join(REPO, 'SKILL.md'), '---\nname: umanizza\ndescription: toglie i tic da IA\nlicense: MIT\n---\nRiscrivi il testo come una persona.')
  writeFileSync(join(REPO, 'LICENSE'), 'MIT License')
  writeFileSync(join(REPO, 'README.md'), '# leggimi')
  mkdirSync(join(REPO, 'scripts'), { recursive: true })
  writeFileSync(join(REPO, 'scripts', 'check.py'), 'print(1)')
  mkdirSync(join(REPO, 'references'), { recursive: true })
  writeFileSync(join(REPO, 'references', 'patterns.md'), '# pattern')
  // 2. la skill con evals/ ed examples/ da ESCLUDERE
  const ce = join(REPO, 'skills', 'con-esempi')
  mkdirSync(join(ce, 'references'), { recursive: true })
  mkdirSync(join(ce, 'evals'), { recursive: true })
  mkdirSync(join(ce, 'examples'), { recursive: true })
  writeFileSync(join(ce, 'SKILL.md'), '---\nname: con-esempi\ndescription: una skill con esempi\n---\nSegui la guida.')
  writeFileSync(join(ce, 'LICENSE.txt'), 'Apache License 2.0')
  writeFileSync(join(ce, 'README.md'), '# leggimi')
  writeFileSync(join(ce, 'references', 'guida.md'), '# guida')
  writeFileSync(join(ce, 'evals', 'evals.json'), '{}')
  writeFileSync(join(ce, 'examples', 'esempio.md'), '# esempio')
  // 3. la skill «solo con /» (invocation 'user' nel catalogo)
  mkdirSync(join(REPO, 'skills', 'solo-utente'), { recursive: true })
  writeFileSync(join(REPO, 'skills', 'solo-utente', 'SKILL.md'), '---\nname: solo-utente\ndescription: solo su richiesta\n---\nFai tre domande.')
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm A', { cwd: REPO })
  A = git('git rev-parse HEAD')
  BLOB = git('git rev-parse HEAD:skills/con-esempi/SKILL.md')
  execSync('git tag -a v-a -m "tag annotato su A"', { cwd: REPO })
  TAG = git('git rev-parse v-a')
  // il repository VA AVANTI: il catalogo resta fissato ad A
  writeFileSync(join(ce, 'SKILL.md'), '---\nname: con-esempi\ndescription: una skill con esempi\n---\nVERSIONE B, non fissata.')
  execSync('git add -A && git commit -qm B', { cwd: REPO })
  B = git('git rev-parse HEAD')
  process.env.SANDBOT_TEST_USER_DATA = join(TMP, 'data')
  process.env.SANDBOT_TEST_SKILL_CATALOG = catalogFile('catalogo-a.json', A)
})
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(TMP, { recursive: true, force: true })
  rmSync(REPO, { recursive: true, force: true })
})

const entryOf = (id: string): Entry => {
  const e = activeSkillCatalog().find((x) => x.id === id)
  if (!e) throw new Error(`voce ${id} assente dal catalogo finto`)
  return e
}

describe('K3: il catalogo finto SANDBOT_TEST_SKILL_CATALOG', () => {
  it('si legge SOLO insieme a SANDBOT_TEST_USER_DATA; senza, vale il catalogo del repo', () => {
    expect(activeSkillCatalog().map((e) => e.id)).toEqual(['umanizza-testi', 'con-esempi', 'solo-utente'])
    const data = process.env.SANDBOT_TEST_USER_DATA
    delete process.env.SANDBOT_TEST_USER_DATA
    try {
      const ids = activeSkillCatalog().map((e) => e.id)
      expect(ids).toEqual(loadSkillCatalog().map((e) => e.id))
      expect(ids).toContain('humanizer')
    } finally {
      process.env.SANDBOT_TEST_USER_DATA = data
    }
  })
})

describe('K3: lo sha fissato del catalogo', () => {
  it('il repository è andato avanti (B) ma si scarica ESATTAMENTE il commit del catalogo (A)', async () => {
    expect(B).not.toBe(A)
    const r = await previewCatalogSkill(entryOf('con-esempi'), opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.preview.commit).toBe(A)
    expect(readFileSync(join(r.staging, 'skills', 'con-esempi', 'SKILL.md'), 'utf8')).toContain('Segui la guida.')
    rmSync(r.staging, { recursive: true, force: true })
  })

  it('uno sha che il repository non ha → RIFIUTATO', async () => {
    const e = { ...entryOf('con-esempi'), source: { ...entryOf('con-esempi').source, commit: '0123456789abcdef0123456789abcdef01234567' } }
    const r = await previewCatalogSkill(e, opts())
    expect(r.ok).toBe(false)
  })

  it('uno sha DIVERSO da quello dello staging (un oggetto che non è un commit: il clone resta in cima al ramo) → RIFIUTATO', async () => {
    const e = { ...entryOf('con-esempi'), source: { ...entryOf('con-esempi').source, commit: BLOB } }
    const r = await previewCatalogSkill(e, opts())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.id).toBe('skill.err.catalogPin')
  })

  it('l\'oggetto di un tag annotato: lo staging finisce sul commit puntato, sha diverso → RIFIUTATO', async () => {
    const e = { ...entryOf('con-esempi'), source: { ...entryOf('con-esempi').source, commit: TAG } }
    const r = await previewCatalogSkill(e, opts())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.id).toBe('skill.err.catalogPin')
  })
})

describe('K3: le esclusioni (glob con **, SKILL.md e LICENSE* sempre)', () => {
  it('la regola pura', () => {
    expect(catalogFileIncluded('evals/a.json', ['evals/**'])).toBe(false)
    expect(catalogFileIncluded('evals/x/y.md', ['evals/**'])).toBe(false)
    expect(catalogFileIncluded('references/evals/a.md', ['evals/**'])).toBe(true)
    expect(catalogFileIncluded('README.it.md', ['README.*.md'])).toBe(false)
    expect(catalogFileIncluded('README.md', ['README.*.md'])).toBe(true)
    expect(catalogFileIncluded('docs/README.it.md', ['README.*.md'])).toBe(true)
    expect(catalogFileIncluded('scripts/validate-package.py', ['scripts/validate-package.py'])).toBe(false)
    expect(catalogFileIncluded('scripts/altro.py', ['scripts/validate-package.py'])).toBe(true)
    expect(catalogFileIncluded('a/b/c.md', ['**/c.md'])).toBe(false)
    // SKILL.md e LICENSE* si copiano SEMPRE, anche con «tutto escluso»
    expect(catalogFileIncluded('SKILL.md', ['**'])).toBe(true)
    expect(catalogFileIncluded('LICENSE', ['**'])).toBe(true)
    expect(catalogFileIncluded('LICENSE.txt', ['*.txt'])).toBe(true)
    expect(catalogFileIncluded('LICENSE-MIT', ['**'])).toBe(true)
    expect(catalogFileIncluded('references/x.md', ['**'])).toBe(false)
  })

  it('l\'anteprima elenca SOLO i file che entreranno (niente evals/ né examples/)', async () => {
    const r = await previewCatalogSkill(entryOf('con-esempi'), opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.preview.files).toEqual(['LICENSE.txt', 'SKILL.md', 'references/guida.md'])
    expect(r.preview).toMatchObject({
      id: 'con-esempi', repo: `file://${REPO}`, path: 'skills/con-esempi', license: 'Apache-2.0',
      homunNotes: 'NOTE-ESEMPI', valid: true
    })
    rmSync(r.staging, { recursive: true, force: true })
  })

  it('la skill alla RADICE: tutto il repository meno le esclusioni (README, scripts/, le altre skill)', async () => {
    const r = await previewCatalogSkill(entryOf('umanizza-testi'), opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.preview.files).toEqual(['LICENSE', 'SKILL.md', 'references/patterns.md'])
    rmSync(r.staging, { recursive: true, force: true })
  })
})

describe('K3: Aggiungi — la voce di libreria è completa e la skill resta «di terzi»', () => {
  it('con-esempi per il SOLO bot Alfa: cartella = id, file esclusi assenti, voce completa', async () => {
    const r = await previewCatalogSkill(entryOf('con-esempi'), opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const added = addCatalogSkillFromStaging(r.staging, r.preview, ['agent_alfa'])
    rmSync(r.staging, { recursive: true, force: true })
    expect(added).toEqual({ ok: true, name: 'con-esempi' })
    const dir = join(libraryDir(), 'con-esempi')
    expect(readdirSync(dir).sort()).toEqual(['LICENSE.txt', 'SKILL.md', 'references'])
    expect(existsSync(join(dir, 'evals'))).toBe(false)
    expect(existsSync(join(dir, 'examples'))).toBe(false)
    expect(existsSync(join(dir, 'README.md'))).toBe(false)
    const entry = skillsLibrary()['con-esempi']!
    expect(entry).toMatchObject({
      enabledFor: ['agent_alfa'],
      source: 'github',
      origin: { repo: `file://${REPO}`, commit: A, path: 'skills/con-esempi', catalogId: 'con-esempi' },
      homunNotes: 'NOTE-ESEMPI'
    })
    expect(entry.invocation).toBeUndefined()
    expect(typeof entry.createdAt).toBe('number')
    // «di terzi»: contaminazione col tool skill, imported col `/`
    expect(isThirdPartySkill(entry)).toBe(true)
    expect(readSkillFor('agent_alfa', 'con-esempi')?.webContent).toBe(true)
    expect(invocableSkillsOf('agent_alfa').find((s) => s.name === 'con-esempi')?.imported).toBe(true)
    // il `/` di Alfa sì, quello di Beta no
    expect(invocableSkillsOf('agent_beta').some((s) => s.name === 'con-esempi')).toBe(false)
    // «Aggiunta» nella riga del catalogo
    expect(skillCatalogInstallState(entryOf('con-esempi'), [{ origin: entry.origin }])).toBe('installed')
  })

  it('la skill alla radice: il name del frontmatter si allinea all\'id (la cartella)', async () => {
    const r = await previewCatalogSkill(entryOf('umanizza-testi'), opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(addCatalogSkillFromStaging(r.staging, r.preview, ['*'])).toEqual({ ok: true, name: 'umanizza-testi' })
    rmSync(r.staging, { recursive: true, force: true })
    const md = readFileSync(join(libraryDir(), 'umanizza-testi', 'SKILL.md'), 'utf8')
    expect(md).toContain('name: umanizza-testi')
    expect(md).toContain('Riscrivi il testo come una persona.')
    expect(existsSync(join(libraryDir(), 'umanizza-testi', 'skills'))).toBe(false)
    expect(existsSync(join(libraryDir(), 'umanizza-testi', 'scripts'))).toBe(false)
    expect(listLibrarySkills().find((s) => s.folder === 'umanizza-testi')?.usable).toBe(true)
  })

  it('la voce «solo con /» porta invocation \'user\' nella libreria', async () => {
    const r = await previewCatalogSkill(entryOf('solo-utente'), opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(addCatalogSkillFromStaging(r.staging, r.preview, ['*'])).toEqual({ ok: true, name: 'solo-utente' })
    rmSync(r.staging, { recursive: true, force: true })
    expect(skillsLibrary()['solo-utente']).toMatchObject({ invocation: 'user', homunNotes: 'NOTE-SOLO' })
  })
})

describe('K3: «Aggiornamento disponibile» con un catalogo che cambia il commit', () => {
  it('diff (vecchio → nuovo) senza i file esclusi, versione vecchia conservata, note aggiornate', async () => {
    // il repository va avanti di nuovo: C cambia la skill e aggiunge un
    // file escluso (evals/) e uno ammesso (references/)
    const ce = join(REPO, 'skills', 'con-esempi')
    writeFileSync(join(ce, 'SKILL.md'), '---\nname: con-esempi\ndescription: una skill con esempi\n---\nGuida AGGIORNATA.')
    writeFileSync(join(ce, 'evals', 'nuovo.json'), '{}')
    writeFileSync(join(ce, 'references', 'nuovo.md'), '# nuovo')
    execSync('git add -A && git commit -qm C', { cwd: REPO })
    const C = git('git rev-parse HEAD')
    // una versione NUOVA di Homun porta il commit C per la voce installata
    process.env.SANDBOT_TEST_SKILL_CATALOG = catalogFile('catalogo-c.json', C, '-2')
    const catalog = activeSkillCatalog()
    const installed = skillsLibrary()['con-esempi']!
    expect(skillCatalogInstallState(catalog.find((e) => e.id === 'con-esempi')!, [{ origin: installed.origin }])).toBe('update')
    const u = await previewSkillUpdate('con-esempi', { ...opts(), catalog })
    expect(u.ok).toBe(true)
    if (!u.ok) return
    expect(u.diff.oldCommit).toBe(A)
    expect(u.diff.newCommit).toBe(C)
    expect(u.diff.added).toEqual(['references/nuovo.md'])
    expect(u.diff.changed).toContain('SKILL.md')
    expect(applySkillUpdate('con-esempi', u.staging, u.diff, { catalog }).ok).toBe(true)
    rmSync(u.staging, { recursive: true, force: true })
    const dir = join(libraryDir(), 'con-esempi')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('Guida AGGIORNATA.')
    expect(existsSync(join(dir, 'evals'))).toBe(false)
    expect(existsSync(join(dir, 'references', 'nuovo.md'))).toBe(true)
    expect(readdirSync(join(dir, '.versions')).some((f) => f.endsWith('.md'))).toBe(true)
    expect(skillsLibrary()['con-esempi']).toMatchObject({
      source: 'github',
      enabledFor: ['agent_alfa'],
      origin: { commit: C, catalogId: 'con-esempi', path: 'skills/con-esempi' },
      homunNotes: 'NOTE-ESEMPI-2'
    })
    expect(skillCatalogInstallState(catalog.find((e) => e.id === 'con-esempi')!, [{ origin: skillsLibrary()['con-esempi']!.origin }])).toBe('installed')
  })
})
