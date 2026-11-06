// Fase skill · catalogo (K5): due convenzioni di Claude Code che il motore
// rispetta per TUTTE le skill (non solo per quelle del catalogo):
//   1. `disable-model-invocation: true` nel frontmatter, oppure
//      `invocation: 'user'` nella voce di libreria → fuori da «# Available
//      skills», rifiutata dal tool `skill` con un errore chiaro, il `/nome`
//      dell'utente funziona come sempre e la finestra la marca «solo con /»;
//   2. i segnaposto nell'espansione `/nome`: $ARGUMENTS (e $TEXT, $OBJECTIVE)
//      diventano il testo dopo il nome, $1, $2… le parole; caricata col tool
//      i segnaposto restano e in coda c'è la riga che li spiega.
// K6: le skill del catalogo installate entrano nel prompt come le altre,
// tranne quelle «solo con /».
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-skcc-test-'))
const { setDataDir, dataDir, setSetting } = await import('../../store/db')
const {
  buildSkillsSection, readSkillFor, invocableSkillsOf, skillInvocationExpansion, libraryItemsForUi,
  skillsLibrary, SKILL_USER_ONLY_REFUSAL, SKILL_PLACEHOLDERS_NOTE, expandSkillPlaceholders
} = await import('../skills')
const { executeTool } = await import('../tools')

const AGENT = 'agent_cc'

function writeSkill(name: string, frontmatterExtra: string, body: string, entry: Record<string, unknown> = {}): void {
  mkdirSync(join(dataDir(), 'skills', name), { recursive: true })
  writeFileSync(join(dataDir(), 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: descrizione di ${name}\n${frontmatterExtra}---\n${body}`)
  const lib = skillsLibrary()
  lib[name] = { enabledFor: ['*'], source: 'user', createdAt: 1, updatedAt: 1, ...entry } as never
  setSetting('skills.library', lib)
}

beforeAll(() => {
  setDataDir(TMP)
  dataDir()
  setSetting('ui.activeLanguage', 'it')
  writeSkill('normale', '', 'Istruzioni normali.')
  writeSkill('solo-frontmatter', 'disable-model-invocation: true\n', 'Pensa al contrario.')
  writeSkill('solo-voce', '', 'Fai tre domande.', {
    source: 'github', invocation: 'user',
    origin: { repo: 'anthropics/skills', commit: 'c'.repeat(40), path: 'skills/solo-voce', catalogId: 'solo-voce' }
  })
  // un frontmatter con disable-model-invocation: false NON la toglie
  writeSkill('falso-esplicito', 'disable-model-invocation: false\n', 'Si carica da sola.')
  writeSkill('con-segnaposto', '', 'Riassumi: $ARGUMENTS\nTesto: $TEXT\nObiettivo: $OBJECTIVE\nPrima: $1, seconda: $2, terza: $3, decima: $10, prezzo: 5$.')
  // K6: una voce del catalogo installata, normale (entra nel prompt)
  writeSkill('dal-catalogo', '', 'Scrivi bene.', {
    source: 'github', homunNotes: 'Note.',
    origin: { repo: 'coreyhaines31/marketingskills', commit: 'd'.repeat(40), path: 'skills/dal-catalogo', catalogId: 'dal-catalogo' }
  })
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('K5.1: disable-model-invocation / invocation \'user\' — tabella', () => {
  const prompt = (): string => buildSkillsSection(AGENT)
  const rows: Array<{ skill: string; userOnly: boolean }> = [
    { skill: 'normale', userOnly: false },
    { skill: 'solo-frontmatter', userOnly: true },
    { skill: 'solo-voce', userOnly: true },
    { skill: 'falso-esplicito', userOnly: false }
  ]

  for (const row of rows) {
    it(`${row.skill}: nel prompt ${row.userOnly ? 'NO' : 'sì'}, tool ${row.userOnly ? 'rifiuta' : 'carica'}, / funziona, finestra ${row.userOnly ? '«solo con /»' : 'normale'}`, async () => {
      // «# Available skills»
      expect(prompt().includes(`- ${row.skill}:`)).toBe(!row.userOnly)
      // il tool skill caricato DAL MODELLO
      const r = await executeTool(AGENT, 'skill', { name: row.skill })
      if (row.userOnly) {
        expect(r.output).toBe(SKILL_USER_ONLY_REFUSAL)
        expect(r.meta.webContent).toBeUndefined()
      } else {
        expect(r.output).toContain(`# ${row.skill}`)
      }
      // il `/nome` dell'utente funziona come sempre
      const inv = skillInvocationExpansion(`/${row.skill} vai`, invocableSkillsOf(AGENT))
      expect(inv).not.toBeNull()
      expect(inv!.content).toContain(`The user invoked the skill "${row.skill}"`)
      // la finestra la marca «solo con /»
      expect(libraryItemsForUi().find((s) => s.folder === row.skill)?.userOnly === true).toBe(row.userOnly)
    })
  }

  it('l\'errore del rifiuto è inglese e chiaro (per il modello)', () => {
    expect(SKILL_USER_ONLY_REFUSAL).toBe('This skill runs only when the user invokes it with /name.')
  })

  it('anche skill({name, file}) è rifiutato: non si legge a pezzi una skill «solo con /»', async () => {
    writeFileSync(join(dataDir(), 'skills', 'solo-frontmatter', 'nota.md'), '# nota')
    const r = await executeTool(AGENT, 'skill', { name: 'solo-frontmatter', file: 'nota.md' })
    expect(r.output).toBe(SKILL_USER_ONLY_REFUSAL)
  })
})

describe('K5.2: i segnaposto — tabella', () => {
  const cases: Array<{ input: string; args: string; expected: Record<string, string> }> = [
    {
      input: 'riscrivi questo testo', args: 'riscrivi questo testo',
      expected: { ARGUMENTS: 'riscrivi questo testo', TEXT: 'riscrivi questo testo', OBJECTIVE: 'riscrivi questo testo', '1': 'riscrivi', '2': 'questo', '3': 'testo', '10': '' }
    },
    {
      input: '  una   parola  ', args: 'una   parola',
      expected: { ARGUMENTS: 'una   parola', TEXT: 'una   parola', OBJECTIVE: 'una   parola', '1': 'una', '2': 'parola', '3': '', '10': '' }
    },
    {
      input: '', args: '',
      expected: { ARGUMENTS: '', TEXT: '', OBJECTIVE: '', '1': '', '2': '', '3': '', '10': '' }
    },
    {
      // i $ nel testo dell'utente restano letterali (niente $1 di replace)
      input: 'costa $1 e $& euro', args: 'costa $1 e $& euro',
      expected: { ARGUMENTS: 'costa $1 e $& euro', TEXT: 'costa $1 e $& euro', OBJECTIVE: 'costa $1 e $& euro', '1': 'costa', '2': '$1', '3': 'e', '10': '' }
    }
  ]

  for (const c of cases) {
    it(`/con-segnaposto «${c.input}»`, () => {
      const inv = skillInvocationExpansion(`/con-segnaposto ${c.input}`.trimEnd(), invocableSkillsOf(AGENT))
      expect(inv).not.toBeNull()
      const content = inv!.content
      expect(content).toContain(`Riassumi: ${c.expected.ARGUMENTS}\n`)
      expect(content).toContain(`Testo: ${c.expected.TEXT}\n`)
      expect(content).toContain(`Obiettivo: ${c.expected.OBJECTIVE}\n`)
      expect(content).toContain(`Prima: ${c.expected['1']}, seconda: ${c.expected['2']}, terza: ${c.expected['3']}, decima: ${c.expected['10']}, prezzo: 5$.`)
      expect(content).not.toMatch(/\$ARGUMENTS|\$TEXT|\$OBJECTIVE/)
    })
  }

  it('la funzione pura: $10 non è $1 seguito da 0', () => {
    expect(expandSkillPlaceholders('$1-$10-$2', 'a b c d e f g h i j')).toBe('a-j-b')
  })

  it('caricata col tool (senza /): i segnaposto RESTANO e in coda c\'è la riga che li spiega', async () => {
    expect(SKILL_PLACEHOLDERS_NOTE).toBe('Placeholders like $ARGUMENTS refer to the user\'s request.')
    const r = readSkillFor(AGENT, 'con-segnaposto')!
    expect(r.output).toContain('Riassumi: $ARGUMENTS')
    expect(r.output).toContain('$1')
    expect(r.output.endsWith(SKILL_PLACEHOLDERS_NOTE)).toBe(true)
    const t = await executeTool(AGENT, 'skill', { name: 'con-segnaposto' })
    expect(t.output.endsWith(SKILL_PLACEHOLDERS_NOTE)).toBe(true)
  })

  it('una skill SENZA segnaposto: niente riga in coda (identica a oggi)', () => {
    expect(readSkillFor(AGENT, 'normale')!.output).toBe('# normale\n\ndescrizione di normale\n\nIstruzioni normali.')
  })
})

describe('K6: il catalogo nella sezione «# Available skills»', () => {
  it('una voce del catalogo installata entra con nome e descrizione, come le altre', () => {
    const p = buildSkillsSection(AGENT)
    expect(p).toContain('- dal-catalogo: descrizione di dal-catalogo')
    expect(p).toContain('- normale: descrizione di normale')
  })

  it('quelle «solo con /» (invocation \'user\' o disable-model-invocation) restano FUORI', () => {
    const p = buildSkillsSection(AGENT)
    expect(p).not.toContain('solo-voce')
    expect(p).not.toContain('solo-frontmatter')
  })

  it('nessun\'altra modifica al prompt: intestazione e istruzioni come oggi', () => {
    const p = buildSkillsSection(AGENT)
    expect(p.split('\n').slice(0, 5)).toEqual([
      '# Available skills',
      'Reusable procedures with complete instructions. In the prompt you see only the name and description: when a skill matches the current task, load it with skill({name}) and follow it immediately.',
      'The user can force a skill by starting their message with /name.',
      'A skill can have support files (references, examples): the list arrives with the instructions; read one with skill({name, file}).',
      'Create or update skills with update_skill (the user\'s approval is required).'
    ])
  })
})
