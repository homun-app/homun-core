// Test delle skill (fase 4, §3bis L6): formato SKILL.md come Claude Code,
// nome validato prima di costruire path, nel prompt SOLO nome e descrizione,
// corpo caricato con skill({name}). Store reale su directory temporanea.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setDataDir, dataDir } = await import('../../store/db')
const {
  isValidSkillName, parseSkillFile, serializeSkill, skillsSectionPrompt,
  writeSkill, readSkillBody, deleteSkill, listSkills, buildSkillsSection, skillsDir
} = await import('../skills')

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-skills-test-'))
  setDataDir(root)
  dataDir()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('validazione del nome', () => {
  it('solo [a-z0-9-], max 64', () => {
    expect(isValidSkillName('ricerca-web')).toBe(true)
    expect(isValidSkillName('a')).toBe(true)
    expect(isValidSkillName('-')).toBe(true)
    expect(isValidSkillName('Ricerca')).toBe(false)
    expect(isValidSkillName('ricerca web')).toBe(false)
    expect(isValidSkillName('ricerca_web')).toBe(false)
    expect(isValidSkillName('../x')).toBe(false)
    expect(isValidSkillName('..')).toBe(false)
    expect(isValidSkillName('')).toBe(false)
    expect(isValidSkillName('x'.repeat(65))).toBe(false)
  })
})

describe('formato SKILL.md', () => {
  it('roundtrip serialize → parse (name + description in frontmatter, corpo)', () => {
    const s = { name: 'triage-email', description: 'come smistare la posta in arrivo', content: '## Passi\n1. leggi\n2. classifica' }
    expect(parseSkillFile(serializeSkill(s))).toEqual(s)
  })

  it('frontmatter mancante o nome invalido → null', () => {
    expect(parseSkillFile('solo istruzioni')).toBeNull()
    expect(parseSkillFile('---\nname: NoValid\n---\ncorpo')).toBeNull()
  })
})

describe('scrittura / lettura / eliminazione', () => {
  it('writeSkill crea la directory; readSkillBody dà il corpo; deleteSkill rimuove tutto', () => {
    writeSkill('agent_s', {
      name: 'daily-report',
      description: 'costruisce il report del giorno',
      content: 'Apri i dati e riassumi in 5 punti.'
    })
    expect(existsSync(join(skillsDir('agent_s'), 'daily-report', 'SKILL.md'))).toBe(true)
    expect(readSkillBody('agent_s', 'daily-report')).toBe('Apri i dati e riassumi in 5 punti.')
    // update = stessa write, sovrascrive
    writeSkill('agent_s', { name: 'daily-report', description: 'costruisce il report del giorno', content: 'Nuovo flusso.' })
    expect(readSkillBody('agent_s', 'daily-report')).toBe('Nuovo flusso.')
    expect(listSkills('agent_s')).toHaveLength(1)

    expect(deleteSkill('agent_s', 'daily-report')).toBe(true)
    expect(deleteSkill('agent_s', 'daily-report')).toBe(false)
    expect(listSkills('agent_s')).toHaveLength(0)
  })

  it('nome non valido rifiutato PRIMA di toccare il filesystem (niente directory)', () => {
    expect(() => writeSkill('agent_s', { name: '../escape', description: 'x', content: 'y' })).toThrow(/non valido/)
    expect(() => readSkillBody('agent_s', 'a/b')).toThrow(/non valido/)
    expect(() => deleteSkill('agent_s', '..')).toThrow(/non valido/)
    expect(existsSync(join(root, 'escape'))).toBe(false)
  })
})

describe('prompt: SOLO nome e descrizione', () => {
  it('la sezione elenca nome+descrizione e dice come caricare il corpo; il corpo NON c\'è', () => {
    writeSkill('agent_p', {
      name: 'triage-email',
      description: 'smista la posta in arrivo',
      content: 'ISTRUZIONI SEGRETE DEL FLUSSO: passo 1, passo 2'
    })
    const section = buildSkillsSection('agent_p')
    expect(section).toContain('# Skill disponibili')
    expect(section).toContain('triage-email: smista la posta in arrivo')
    expect(section).toContain('skill({name})')
    expect(section).not.toContain('ISTRUZIONI SEGRETE')
  })

  it('senza skill la sezione è vuota; skillsSectionPrompt puro ordina per nome', () => {
    expect(buildSkillsSection('agent_senza')).toBe('')
    const p = skillsSectionPrompt([
      { name: 'z-last', description: 'z', content: '' },
      { name: 'a-first', description: 'a', content: '' }
    ])
    expect(p.indexOf('a-first')).toBeLessThan(p.indexOf('z-last'))
    expect(skillsSectionPrompt([])).toBe('')
  })
})
