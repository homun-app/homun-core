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
