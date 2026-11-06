// Fase skill · catalogo (K4): le note per Homun vivono nella VOCE di
// LIBRERIA (homunNotes) e il motore le aggiunge in coda alla skill QUANDO
// arriva al modello — tool `skill` ed espansione `/nome` — col titolo
// «## Notes for Homun». Il file SKILL.md su disco NON cambia, e una skill
// senza note arriva al modello IDENTICA a oggi.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-sknotes-test-'))
const { setDataDir, dataDir, setSetting } = await import('../../store/db')
const { readSkillFor, invocableSkillsOf, skillInvocationExpansion, libraryItemsForUi, skillsLibrary } = await import('../skills')

const NOTES = 'Ignore the Codex setup step. Ask before writing to Notion.'
const BODY = 'Follow the guide step by step.'

function writeSkill(name: string, body: string, entry: Record<string, unknown>): void {
  mkdirSync(join(dataDir(), 'skills', name), { recursive: true })
  writeFileSync(join(dataDir(), 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: cosa fa ${name}\n---\n${body}`)
  const lib = skillsLibrary()
  lib[name] = { enabledFor: ['*'], source: 'github', createdAt: 1, updatedAt: 1, ...entry } as never
  setSetting('skills.library', lib)
}

beforeAll(() => {
  setDataDir(TMP)
  dataDir()
  setSetting('ui.activeLanguage', 'it')
  // una skill con le note (come le voci del catalogo installate)
  writeSkill('con-note', BODY, { homunNotes: NOTES, origin: { repo: 'owner/repo', commit: 'a'.repeat(40), path: 'skills/con-note', catalogId: 'con-note' } })
  // una senza note: deve arrivare al modello IDENTICA a oggi
  writeSkill('senza-note', BODY, {})
  // una con le note E un file di supporto: le note stanno DOPO il corpo
  writeSkill('con-note-e-file', BODY, { homunNotes: NOTES })
  writeFileSync(join(dataDir(), 'skills', 'con-note-e-file', 'riferimento.md'), '# Riferimento')
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('K4: le note per Homun nel corpo che arriva al MODELLO', () => {
  it('il tool skill: il corpo finisce con «## Notes for Homun» e le note', () => {
    const r = readSkillFor('agent_x', 'con-note')
    expect(r).not.toBeNull()
    expect(r!.output).toContain(`# con-note`)
    expect(r!.output).toContain(BODY)
    expect(r!.output.endsWith(`## Notes for Homun\n${NOTES}`)).toBe(true)
  })

  it('le note stanno DOPO il corpo, PRIMA dell\'elenco dei file di supporto', () => {
    const r = readSkillFor('agent_x', 'con-note-e-file')!
    const atNotes = r.output.indexOf('## Notes for Homun')
    const atBody = r.output.indexOf(BODY)
    const atFiles = r.output.indexOf('Support files')
    expect(atBody).toBeLessThan(atNotes)
    expect(atNotes).toBeLessThan(atFiles)
  })

  it('l\'espansione /nome porta le note in coda al corpo', () => {
    const visible = invocableSkillsOf('agent_x')
    const inv = skillInvocationExpansion('/con-note fai la cosa', visible)
    expect(inv).not.toBeNull()
    expect(inv!.content).toContain('The user invoked the skill "con-note"')
    expect(inv!.content).toContain(BODY)
    expect(inv!.content).toContain(`## Notes for Homun\n${NOTES}`)
    expect(inv!.imported).toBe(true) // di terzi, come sempre
  })

  it('il file SKILL.md su disco NON cambia', () => {
    const md = readFileSync(join(dataDir(), 'skills', 'con-note', 'SKILL.md'), 'utf8')
    expect(md).not.toContain('Notes for Homun')
    expect(md).not.toContain(NOTES)
    expect(md).toBe(`---\nname: con-note\ndescription: cosa fa con-note\n---\n${BODY}`)
  })

  it('una skill SENZA note arriva al modello identica a oggi', () => {
    expect(readSkillFor('agent_x', 'senza-note')!.output).toBe(`# senza-note\n\ncosa fa senza-note\n\n${BODY}`)
    const inv = skillInvocationExpansion('/senza-note fai la cosa', invocableSkillsOf('agent_x'))
    expect(inv!.content).not.toContain('Notes for Homun')
    expect(inv!.content).toBe('The user invoked the skill "senza-note" for this message. Its full instructions are below — do not load it again with skill(); follow them now.\n\n' +
      `${BODY}\n---\nfai la cosa`)
  })

  it('la finestra vede le note: SkillLibraryItem porta homunNotes', () => {
    const item = libraryItemsForUi().find((s) => s.folder === 'con-note')
    expect(item?.homunNotes).toBe(NOTES)
    expect(libraryItemsForUi().find((s) => s.folder === 'senza-note')?.homunNotes).toBeUndefined()
  })
})
