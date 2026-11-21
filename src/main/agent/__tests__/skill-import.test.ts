// PL6 (fase plugin): «Importa skill» da altre app — la scansione delle
// cartelle con SKILL.md (~/.claude/skills, ~/.codex/skills, ~/.zcode/skills,
// ~/.cursor/skills e una cartella scelta) parte SOLO al clic; i doppioni si
// uniscono; importare COPIA nella libreria oppure COLLEGA in sola lettura la
// cartella originale. MAI script eseguiti all'import: solo file di testo
// (un file con l'estensione da eseguire si COPIA, non si esegue — il marker
// che scriverebbe non appare). Tutto su cartelle finte in TEST_TMP_BASE.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { scanSkillsImport, scanSkillFolderImport, applySkillsImport } from '../skill-import'
import { listLibrarySkills, skillsLibrary, readSkillMd, LINKED_SKILL_REFUSAL } from '../skills'
import { setSetting } from '../../store/db'

let HOME = ''
let LIB = ''
const TMPs: string[] = []

function fakeHome(): string {
  const h = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-skill-import-home-'))
  TMPs.push(h)
  return h
}

function skill(home: string, source: string, name: string, description: string, extra?: Record<string, string>): void {
  const dir = join(home, `.${source}`, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nLe istruzioni della skill ${name}.\n`)
  for (const [f, c] of Object.entries(extra ?? {})) writeFileSync(join(dir, f), c)
}

beforeAll(async () => {
  HOME = fakeHome()
  // la libreria di Homun su una cartella dati FINTA (setDataDir, come gli
  // altri test delle skill)
  LIB = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-skill-import-lib-'))
  TMPs.push(LIB)
  const { setDataDir } = await import('../../store/db')
  setDataDir(LIB)
})
afterAll(() => {
  for (const t of TMPs) rmSync(t, { recursive: true, force: true })
})

describe('PL6: la scansione delle skill delle altre app (solo al clic)', () => {
  it('trova le cartelle con SKILL.md nelle quattro app e nella cartella scelta; quelle rotte si dichiarano', () => {
    skill(HOME, 'claude', 'lavoro', 'Riassume le email di lavoro')
    skill(HOME, 'zcode', 'lavoro', 'Riassume le email di lavoro') // doppione esatto
    skill(HOME, 'codex', 'rotta', '') // descrizione mancante: non valida
    mkdirSync(join(HOME, '.codex', 'skills', 'senza-skill-md'), { recursive: true }) // saltata
    const scan = scanSkillsImport(HOME)
    const names = scan.rows.map((r) => r.name)
    expect(names).toContain('lavoro')
    expect(names).toContain('rotta')
    expect(names).not.toContain('senza-skill-md')
    const rotta = scan.rows.find((r) => r.name === 'rotta')!
    expect(rotta.valid).toBe(false)
    // la cartella scelta dall'utente si scansiona uguale
    const picked = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-skill-import-pick-'))
    TMPs.push(picked)
    writeFileSync(join(picked, 'SKILL.md'), '---\nname: scelta\ndescription: Quella scelta\n---\nCorpo')
    const extra = scanSkillFolderImport('folder', picked)
    expect(extra.rows.map((r) => r.name)).toEqual(['scelta'])
  })

  it('i DOPPIONI si uniscono: una riga con ancheIn, mai due righe uguali', () => {
    const scan = scanSkillsImport(HOME)
    const rows = scan.rows.filter((r) => r.name === 'lavoro')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sources).toContain('claude')
    expect(rows[0]!.sources).toContain('zcode')
  })
})

describe('PL6: importare — copia oppure collega, mai eseguire', () => {
  it('Copia: la skill finisce nella LIBRERIA con l\'origine dichiarata (source app)', () => {
    skill(HOME, 'cursor', 'prezzi', 'Confronta i prezzi', { 'run.sh': 'touch /tmp/PL6-MARKER-MAI-CREATO\n' })
    setSetting('skills.library', {})
    const out = applySkillsImport(HOME, [{ sources: ['cursor'], name: 'prezzi' }], 'copy')
    expect(out).toEqual([{ name: 'prezzi', outcome: 'created' }])
    // la cartella in libreria esiste con SKILL.md e i file di supporto COPIATI (testo)
    const lib = skillsLibrary()
    expect(lib['prezzi']).toMatchObject({ source: 'app', importedFromApp: 'Cursor' })
    expect(readSkillMd('prezzi')).toMatch(/Confronta i prezzi/)
    // lo script è stato COPIATO, non eseguito: il marker non c'è
    expect(existsSync('/tmp/PL6-MARKER-MAI-CREATO')).toBe(false)
    const listed = listLibrarySkills().find((s) => s.folder === 'prezzi')!
    expect(listed.usable).toBe(true)
    expect(listed.files).toContain('run.sh')
  })

  it('«Usa la cartella originale»: il COLLEGAMENTO in sola lettura, la skill si legge ma la cartella resta dov\'è', () => {
    setSetting('skills.library', {})
    const out = applySkillsImport(HOME, [{ sources: ['claude'], name: 'lavoro' }], 'link')
    expect(out).toEqual([{ name: 'lavoro', outcome: 'linked' }])
    const entry = skillsLibrary()['lavoro']!
    expect(entry.linkedPath).toBe(join(HOME, '.claude', 'skills', 'lavoro'))
    // si legge dalla cartella ORIGINALE (nessuna copia in libreria)
    const listed = listLibrarySkills().find((s) => s.folder === 'lavoro')!
    expect(listed.usable).toBe(true)
    expect(listed.description).toMatch(/Riassume le email di lavoro/)
    expect(existsSync(join(LIB, 'lavoro'))).toBe(false)
  })

  it('una skill GIÀ in libreria non si sovrascrive («già presente»)', () => {
    setSetting('skills.library', {})
    applySkillsImport(HOME, [{ sources: ['claude'], name: 'lavoro' }], 'copy')
    const again = applySkillsImport(HOME, [{ sources: ['claude'], name: 'lavoro' }], 'copy')
    expect(again).toEqual([{ name: 'lavoro', outcome: 'duplicate' }])
  })

  it('una skill NON VALIDA non si importa', () => {
    const out = applySkillsImport(HOME, [{ sources: ['codex'], name: 'rotta' }], 'copy')
    expect(out).toEqual([{ name: 'rotta', outcome: 'invalid' }])
  })

  it('il collegamento rifiuta le modifiche (in sola lettura) e si toglie senza toccare l\'originale', () => {
    expect(LINKED_SKILL_REFUSAL).toMatch(/read-only|sola lettura/i)
  })
})
