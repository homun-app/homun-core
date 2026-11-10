// Test dell'import da GitHub (fase skill S6): repo git LOCALE con file://
// SOLO col flag di test (in produzione https://github.com/… soltanto, come
// la pipeline dei plugin che riusa). Tre skill nel repo: una valida con
// references/, una con un link simbolico che esce, una col nome sbagliato;
// più il flusso di aggiornamento sull'origin.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-skgit-test-'))
let REPO: string
const { setDataDir, dataDir } = await import('../../store/db')
const {
  parseGithubSkillUrl, previewSkillsFromGithub, addSkillsFromStaging, previewSkillUpdate,
  applySkillUpdate, findSkillDirs, availableSkillName
} = await import('../skill-github')
const { skillsLibrary, libraryDir, deleteLibrarySkill } = await import('../skills')

beforeAll(() => {
  setDataDir(TMP)
  dataDir()
  REPO = mkdtempSync(join(tmpdir(), 'sandbot-skill-repo-'))
  // una skill valida con references/
  mkdirSync(join(REPO, 'skills', 'riassunto-riunione', 'references'), { recursive: true })
  writeFileSync(join(REPO, 'skills', 'riassunto-riunione', 'SKILL.md'), '---\nname: riassunto-riunione\ndescription: come riassumere una riunione\nlicense: MIT\n---\nRispondi con punti elenco.')
  writeFileSync(join(REPO, 'skills', 'riassunto-riunione', 'references', 'stile.md'), '# Stile')
  // una con un LINK SIMBOLICO (interno: il clone passa, la SKILL risulta
  // non valida — S1.3 nessun link simbolico — e si mostra spenta col motivo)
  mkdirSync(join(REPO, 'skills', 'con-symlink', 'references'), { recursive: true })
  writeFileSync(join(REPO, 'skills', 'con-symlink', 'SKILL.md'), '---\nname: con-symlink\ndescription: d\n---\nb')
  writeFileSync(join(REPO, 'skills', 'con-symlink', 'references', ' vero.md'), 'contenuto')
  try { symlinkSync('references/vero.md', join(REPO, 'skills', 'con-symlink', 'link.md')) } catch { /* senza symlink: oltre il test */ }
  // una col NOME SBAGLIATO (maiuscole)
  mkdirSync(join(REPO, 'skills', 'nome-scorretto'), { recursive: true })
  writeFileSync(join(REPO, 'skills', 'nome-scorretto', 'SKILL.md'), '---\nname: Nome Sbagliato\ndescription: d\n---\nb')
  // una skill a UN LIVELLO (non in skills/)
  mkdirSync(join(REPO, 'singola'), { recursive: true })
  writeFileSync(join(REPO, 'singola', 'SKILL.md'), '---\nname: singola\ndescription: al primo livello\n---\nb')
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: REPO })
})
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  rmSync(REPO, { recursive: true, force: true })
})

const URL = () => `file://${REPO}`
const opts = () => ({ allowFileUrlsForTests: true })

describe('S6.1: l\'URL', () => {
  it('SOLO https://github.com (file:// col flag di test); il resto è errore', () => {
    expect(parseGithubSkillUrl('https://github.com/owner/repo')).toMatchObject({ ok: true, repo: 'owner/repo', path: '' })
    expect(parseGithubSkillUrl('https://github.com/owner/repo/tree/main/skills/x')).toMatchObject({ ok: true, repo: 'owner/repo', ref: 'main', path: 'skills/x' })
    expect(parseGithubSkillUrl('https://gitlab.com/owner/repo').ok).toBe(false)
    expect(parseGithubSkillUrl('https://evil.example/x').ok).toBe(false)
    expect(parseGithubSkillUrl('file:///qualcosa').ok).toBe(false)
    expect(parseGithubSkillUrl('file:///qualcosa', { allowFileUrlsForTests: true }).ok).toBe(true)
  })

  it('K7: ref o segmenti di path che iniziano con - o contengono .. sono RIFIUTATI (finirebbero come argomenti di git)', () => {
    // un ref che comincia con - diventerebbe un'opzione di git fetch
    expect(parseGithubSkillUrl('https://github.com/a/b/tree/--upload-pack=x/skills').ok).toBe(false)
    // un path con .. uscirebbe dal sparse-checkout
    expect(parseGithubSkillUrl('https://github.com/a/b/tree/main/../x').ok).toBe(false)
    expect(parseGithubSkillUrl('https://github.com/a/b/tree/main/a/../b').ok).toBe(false)
    expect(parseGithubSkillUrl('https://github.com/a/b/-pippo').ok).toBe(false)
    // i ref e i path LEGITTIMI passano (anche coi punti delle versioni)
    expect(parseGithubSkillUrl('https://github.com/o/r/tree/v1.2.3/skills/x')).toMatchObject({ ok: true, ref: 'v1.2.3', path: 'skills/x' })
    expect(parseGithubSkillUrl('https://github.com/a/b/skills/x')).toMatchObject({ ok: true, path: 'skills/x' })
  })
})

describe('S6.2/S6.3: anteprima dal repo (non si salva niente)', () => {
  it('trova le skill (skills/*, */SKILL.md a un livello) con nome, file, licenza; il commit è SHA', async () => {
    const r = await previewSkillsFromGithub(URL(), opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(/^[0-9a-f]{40}$/.test(r.preview.commit)).toBe(true)
    const names = r.preview.skills.map((s) => s.name)
    expect(names).toContain('riassunto-riunione')
    expect(names).toContain('singola')
    expect(names).toContain('nome-scorretto') // mostrata SPENTA col motivo
    // la skill col link simbolico INTERNO: il clone passa, la skill è NON
    // valida col motivo del symlink (S1.3)
    const symlinked = r.preview.skills.find((s) => s.name === 'con-symlink')
    expect(symlinked?.valid).toBe(false)
    expect(symlinked?.issues.some((i) => i.uiId === 'skill.symlink')).toBe(true)
    const buona = r.preview.skills.find((s) => s.name === 'riassunto-riunione')!
    expect(buona.valid).toBe(true)
    expect(buona.fileCount).toBe(1)
    expect(buona.license).toBe('MIT')
    const sbagliata = r.preview.skills.find((s) => s.name === 'nome-scorretto')!
    expect(sbagliata.valid).toBe(false)
    expect(sbagliata.issues.some((i) => i.uiId === 'skill.nameInvalid')).toBe(true)
    // la libreria NON è stata toccata
    expect(existsSync(join(libraryDir(), 'riassunto-riunione'))).toBe(false)
    rmSync(r.staging, { recursive: true, force: true })
  })

  it('errori umani: repository non trovato, indirizzo non GitHub', async () => {
    const nf = await previewSkillsFromGithub('file:///non-esiste-proprio', opts())
    expect(nf.ok).toBe(false)
    if (!nf.ok) expect(nf.error.id).toBe('skill.err.repoNotFound')
    const ng = await previewSkillsFromGithub('https://example.com/x', opts())
    expect(ng.ok).toBe(false)
    if (!ng.ok) expect(ng.error.id).toBe('skill.err.notGithub')
  })
})

describe('S6.4: Aggiungi', () => {
  it('copia SOLO le cartelle scelte con source github e origin; il conflitto propone -2', async () => {
    const p = await previewSkillsFromGithub(URL(), opts())
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const added = addSkillsFromStaging(p.staging, p.preview, [{ path: 'skills/riassunto-riunione' }], ['*'])
    expect(added).toEqual([{ name: 'riassunto-riunione', path: 'skills/riassunto-riunione' }])
    expect(existsSync(join(libraryDir(), 'riassunto-riunione', 'references', 'stile.md'))).toBe(true)
    expect(skillsLibrary()['riassunto-riunione']).toMatchObject({
      source: 'github',
      enabledFor: ['*'],
      origin: { repo: p.preview.repo, commit: p.preview.commit, path: 'skills/riassunto-riunione' }
    })
    // aggiungerla DI NUOVO senza rename → -2 (mai sovrascrittura silenziosa)
    const again = addSkillsFromStaging(p.staging, p.preview, [{ path: 'skills/riassunto-riunione' }], ['*'])
    expect(again[0]!.name).toBe('riassunto-riunione-2')
    expect(availableSkillName('x', () => false)).toBe('x')
    // x e x-2 già presi → x-3 (un predicato sempre-vero non ha fine: non capita)
    const takenSome = (n: string): boolean => n === 'x' || n === 'x-2'
    expect(availableSkillName('x', takenSome)).toBe('x-3')
    rmSync(p.staging, { recursive: true, force: true })
    deleteLibrarySkill('riassunto-riunione')
    deleteLibrarySkill('riassunto-riunione-2')
  })
})

describe('S6.5: Aggiorna da GitHub', () => {
  it('commit vecchio → nuovo, file aggiunti/tolti/cambiati; la versione vecchia va in .versions/', async () => {
    const p = await previewSkillsFromGithub(URL(), opts())
    if (!p.ok) return
    addSkillsFromStaging(p.staging, p.preview, [{ path: 'skills/riassunto-riunione' }], ['*'])
    rmSync(p.staging, { recursive: true, force: true })
    // il repository CAMBIA: nuovo commit, un file aggiunto, uno tolto
    writeFileSync(join(REPO, 'skills', 'riassunto-riunione', 'references', 'nuovo.md'), 'nuovo')
    rmSync(join(REPO, 'skills', 'riassunto-riunione', 'references', 'stile.md'))
    writeFileSync(join(REPO, 'skills', 'riassunto-riunione', 'SKILL.md'), '---\nname: riassunto-riunione\ndescription: come riassumere una riunione\nlicense: MIT\n---\nNuove istruzioni.')
    execSync('git add -A && git commit -qm cambia', { cwd: REPO })
    const oldCommit = skillsLibrary()['riassunto-riunione']!.origin!.commit
    const u = await previewSkillUpdate('riassunto-riunione', opts())
    expect(u.ok).toBe(true)
    if (!u.ok) return
    expect(u.diff.oldCommit).toBe(oldCommit)
    expect(u.diff.newCommit).not.toBe(oldCommit)
    expect(u.diff.added).toContain('references/nuovo.md')
    expect(u.diff.removed).toContain('references/stile.md')
    expect(u.diff.changed).toContain('SKILL.md')
    // applica: la vecchia versione si conserva
    expect(applySkillUpdate('riassunto-riunione', u.staging, u.diff).ok).toBe(true)
    expect(readFileSync(join(libraryDir(), 'riassunto-riunione', 'SKILL.md'), 'utf8')).toContain('Nuove istruzioni.')
    const versions = readdirSync(join(libraryDir(), 'riassunto-riunione', '.versions'))
    expect(versions.some((f) => f.endsWith('.md'))).toBe(true)
    expect(skillsLibrary()['riassunto-riunione']!.origin!.commit).toBe(u.diff.newCommit)
    rmSync(u.staging, { recursive: true, force: true })
  })
})

describe('S6.2: findSkillDirs (puro sul fs)', () => {
  it('radice, skills/*/ e un livello', () => {
    const dirs = findSkillDirs(REPO, '')
    expect(dirs).toContain('skills/riassunto-riunione')
    expect(dirs).toContain('singola')
    // con un percorso: radice del percorso e skills/ dentro il percorso
    expect(findSkillDirs(REPO, 'skills/riassunto-riunione')).toEqual(['skills/riassunto-riunione'])
  })
})

// ---- K5/K6 (fase skill ritocchi): righe con nome scelto invalido, update
// che non copia troppo, name riscritto = cartella, .versions del repo ignorato

/** Un repository LOCALE con UNA skill (file:// SOLO col flag di test). */
function makeRepo(withFakeVersions = false): string {
  const repo = mkdtempSync(join(tmpdir(), 'sandbot-skill-repo-k6-'))
  mkdirSync(join(repo, 'skills', 'stile-readme'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'stile-readme', 'SKILL.md'),
    '---\nname: stile-readme\ndescription: come sistemare un README\n---\n# Regole del README\nTitolo breve, sezioni Obiettivi, Installazione, Uso.')
  if (withFakeVersions) {
    // un repository OSTILE può piantare versioni finte col loro index.json
    mkdirSync(join(repo, 'skills', 'stile-readme', '.versions'), { recursive: true })
    writeFileSync(join(repo, 'skills', 'stile-readme', '.versions', '2020-01-01T00-00-00-000Z.md'), '---\nname: stile-readme\ndescription: MALICIOSA\n---\nistruzioni contraffatte')
    writeFileSync(join(repo, 'skills', 'stile-readme', '.versions', 'index.json'), JSON.stringify([{ file: '2020-01-01T00-00-00-000Z.md', ts: 1, origin: 'user' }]))
  }
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: repo })
  return repo
}

describe('K5: addSkillsFromStaging con nomi scelti invalidi', () => {
  it('il nome scelto invalido salta quella riga e torna come ERRORE della riga (niente eccezione per il lotto)', async () => {
    const repo = makeRepo()
    try {
      const p = await previewSkillsFromGithub(`file://${repo}`, opts())
      expect(p.ok).toBe(true)
      if (!p.ok) return
      const added = addSkillsFromStaging(p.staging, p.preview, [
        { path: 'skills/stile-readme', name: '../male' },
        { path: 'skills/stile-readme', name: 'a/b' },
        { path: 'skills/stile-readme' }
      ], ['*'])
      // le prime due righe: ERRORE per quella riga, con l'errore umano
      expect(added[0]).toMatchObject({ path: 'skills/stile-readme' })
      expect(added[0]!.error).toMatchObject({ uiId: 'skill.err.invalidName' })
      expect(added[1]!.error).toMatchObject({ uiId: 'skill.err.invalidName' })
      // la terza (nome di default valido) è entrata
      expect(added[2]).toMatchObject({ name: 'stile-readme', path: 'skills/stile-readme' })
      expect(existsSync(join(libraryDir(), 'stile-readme', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(libraryDir(), '..', 'male'))).toBe(false)
      rmSync(p.staging, { recursive: true, force: true })
      deleteLibrarySkill('stile-readme')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('K6: «Aggiungi» e «Aggiorna» copiano il giusto', () => {
  // LE2: ogni test fa cloni git locali + copie di file (da soli stanno
  // intorno al secondo), ma A SUITE PIENA con la macchina carica (load
  // 29-54) superano i 5 s predefiniti di vitest. Nessuna attesa su tempi
  // fissi; i tetti espliciti sono solo limiti di sicurezza, ampi e dichiarati
  it('il .versions/ del repository NON entra in libreria (né con Aggiungi né con Aggiorna)', async () => {
    const repo = makeRepo(true)
    try {
      const p = await previewSkillsFromGithub(`file://${repo}`, opts())
      expect(p.ok).toBe(true)
      if (!p.ok) return
      // AGGIUNGI
      addSkillsFromStaging(p.staging, p.preview, [{ path: 'skills/stile-readme' }], ['*'])
      expect(existsSync(join(libraryDir(), 'stile-readme', '.versions'))).toBe(false)
      rmSync(p.staging, { recursive: true, force: true })
      // il repository cambia
      writeFileSync(join(repo, 'skills', 'stile-readme', 'references.md'), '# Riferimento')
      execSync('git add -A && git commit -qm cambia', { cwd: repo })
      const u = await previewSkillUpdate('stile-readme', opts())
      expect(u.ok).toBe(true)
      if (!u.ok) return
      expect(applySkillUpdate('stile-readme', u.staging, u.diff).ok).toBe(true)
      // le versioni finte del repository NON ci sono; la VECCHIA versione
      // (quella vera, di GitHub) sì
      const versionsDir = join(libraryDir(), 'stile-readme', '.versions')
      expect(existsSync(versionsDir)).toBe(true)
      expect(readdirSync(versionsDir)).not.toContain('2020-01-01T00-00-00-000Z.md')
      const idx = JSON.parse(readFileSync(join(versionsDir, 'index.json'), 'utf8')) as Array<{ file: string; origin: string }>
      expect(idx.every((v) => v.origin === 'github')).toBe(true)
      // il file nuovo del repository è arrivato
      expect(existsSync(join(libraryDir(), 'stile-readme', 'references.md'))).toBe(true)
      rmSync(u.staging, { recursive: true, force: true })
      deleteLibrarySkill('stile-readme')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 60_000)

  it('dopo l\'aggiornamento il name del frontmatter segue la CARTELLA (stile-readme-2 non torna stile-readme)', async () => {
    const repo = makeRepo()
    try {
      const p = await previewSkillsFromGithub(`file://${repo}`, opts())
      expect(p.ok).toBe(true)
      if (!p.ok) return
      addSkillsFromStaging(p.staging, p.preview, [{ path: 'skills/stile-readme', name: 'stile-readme-2' }], ['*'])
      rmSync(p.staging, { recursive: true, force: true })
      expect(readFileSync(join(libraryDir(), 'stile-readme-2', 'SKILL.md'), 'utf8')).toContain('name: stile-readme-2')
      // K4: l'utente la MODIFICA dalla finestra (source 'user', origin conservato)
      const { saveSkillsLibrary } = await import('../skills')
      const libEdit = skillsLibrary()
      libEdit['stile-readme-2']!.source = 'user'
      saveSkillsLibrary(libEdit)
      // il repository cambia (il name nel repo resta stile-readme)
      writeFileSync(join(repo, 'skills', 'stile-readme', 'SKILL.md'),
        '---\nname: stile-readme\ndescription: come sistemare un README (nuova versione)\n---\n# Regole NUOVE')
      execSync('git add -A && git commit -qm cambia', { cwd: repo })
      const u = await previewSkillUpdate('stile-readme-2', opts())
      expect(u.ok).toBe(true)
      if (!u.ok) return
      expect(applySkillUpdate('stile-readme-2', u.staging, u.diff).ok).toBe(true)
      const after = readFileSync(join(libraryDir(), 'stile-readme-2', 'SKILL.md'), 'utf8')
      expect(after).toContain('Regole NUOVE')
      expect(after).toContain('name: stile-readme-2')
      // K4: «Aggiorna da GitHub» riporta source 'github' (non resta 'user')
      expect(skillsLibrary()['stile-readme-2']!.source).toBe('github')
      // e la libreria vede UNA sola skill, col nome della cartella
      const { listLibrarySkills } = await import('../skills')
      const mine = listLibrarySkills().filter((s) => s.name.startsWith('stile-readme'))
      expect(mine.map((s) => s.name)).toEqual(['stile-readme-2'])
      expect(mine[0]!.usable).toBe(true)
      rmSync(u.staging, { recursive: true, force: true })
      deleteLibrarySkill('stile-readme-2')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 60_000)

  it('una skill NON valida nel repository non si aggiorna: errore umano, la libreria resta com\'era', async () => {
    const repo = makeRepo()
    try {
      const p = await previewSkillsFromGithub(`file://${repo}`, opts())
      expect(p.ok).toBe(true)
      if (!p.ok) return
      addSkillsFromStaging(p.staging, p.preview, [{ path: 'skills/stile-readme' }], ['*'])
      rmSync(p.staging, { recursive: true, force: true })
      const before = readFileSync(join(libraryDir(), 'stile-readme', 'SKILL.md'), 'utf8')
      // il repository ora contiene un LINK SIMBOLICO INTERNO nella skill
      // (come «con-symlink» della sonda: il clone passa — non esce — ma la
      // skill risulta NON valida per S1.3)
      try { symlinkSync('SKILL.md', join(repo, 'skills', 'stile-readme', 'link.md')) } catch {
        deleteLibrarySkill('stile-readme')
        return // piattaforma senza symlink: oltre il limite del test
      }
      execSync('git add -A && git commit -qm symlink', { cwd: repo })
      const u = await previewSkillUpdate('stile-readme', opts())
      expect(u.ok).toBe(true)
      if (!u.ok) return
      // il diff la mostra GIÀ non valida
      expect(u.diff.skill.valid).toBe(false)
      expect(u.diff.skill.issues.some((i) => i.uiId === 'skill.symlink')).toBe(true)
      // e l'applicazione rifiuta con l'errore umano
      const r = applySkillUpdate('stile-readme', u.staging, u.diff)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.id).toBe('skill.err.invalidSkill')
      // la libreria è INTATTA
      expect(readFileSync(join(libraryDir(), 'stile-readme', 'SKILL.md'), 'utf8')).toBe(before)
      expect(existsSync(join(libraryDir(), 'stile-readme', 'link.md'))).toBe(false)
      rmSync(u.staging, { recursive: true, force: true })
      deleteLibrarySkill('stile-readme')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 60_000)
})
