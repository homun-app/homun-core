// Test della migrazione una tantum delle skill (fase skill S2.4): dalla
// copia per bot (agents/<id>/skills/) alla LIBRERIA UNICA (skills/).
// Fixture con due bot: una skill uguale, una con lo stesso nome ma contenuto
// diverso, una sola; poi idempotenza, errore a metà (niente perso) e il
// runner col flag.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setDataDir, dataDir, createAgent, setSetting, getSetting, listAgents } = await import('../db')
const { migrateSkillFolders, migrateAgentSkills, SKILLS_MIGRATED_FLAG, botSlug } = await import('../skills-migrations')
const { skillsLibrary, libraryDir, librarySkillsVisibleTo } = await import('../../agent/skills')

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-skills-mig-'))
  setDataDir(root)
  dataDir()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mkSkill = (agentId: string, name: string, body: string): void => {
  mkdirSync(join(root, 'agents', agentId, 'skills', name), { recursive: true })
  writeFileSync(join(root, 'agents', agentId, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: descrizione di ${name}\n---\n${body}`)
}

describe('S2.4: la migrazione alla libreria unica', () => {
  it('fixture con due bot: uguale → uniti, omonima diversa → -<slug>, sola → spostata', () => {
    const botA = createAgent('Alfa')
    const botB = createAgent('Beta Bot')
    mkSkill(botA.id, 'riassunto-riunione', 'Passi del riassunto.')
    mkSkill(botB.id, 'riassunto-riunione', 'Passi del riassunto.') // IDENTICA → unita
    mkSkill(botA.id, 'triage', 'Versione di Alfa.')
    mkSkill(botB.id, 'triage', 'Versione di Beta, DIVERSA.') // → triage-beta-bot
    mkSkill(botB.id, 'solo-di-beta', 'Solo di Beta.')
    const agents = listAgents().map((a) => ({ id: a.id, name: a.name }))
    const r = migrateSkillFolders({ root, agents, library: {} })
    expect(r.error).toBeUndefined()
    // la skill identica: UNA sola, enabledFor unito
    expect(readdirSync(join(root, 'skills')).sort()).toEqual(['riassunto-riunione', 'solo-di-beta', 'triage', `triage-${botSlug('Beta Bot')}`].sort())
    expect(r.library['riassunto-riunione']?.enabledFor.sort()).toEqual([botA.id, botB.id].sort())
    expect(r.library['riassunto-riunione']?.source).toBe('migrated')
    // la omonima diversa: cartella E nome nel frontmatter insieme
    expect(r.library[`triage-${botSlug('Beta Bot')}`]).toBeTruthy()
    const renamed = readdirSync(join(root, 'skills', `triage-${botSlug('Beta Bot')}`), { withFileTypes: true })
    expect(renamed.length).toBeGreaterThan(0)
    const renamedMd = readFileSync(join(root, 'skills', `triage-${botSlug('Beta Bot')}`, 'SKILL.md'), 'utf8')
    expect(renamedMd).toContain(`name: triage-${botSlug('Beta Bot')}`)
    expect(renamedMd).toContain('Versione di Beta, DIVERSA.')
    expect(r.conflicts).toEqual([{ bot: 'Beta Bot', name: 'triage', to: `triage-${botSlug('Beta Bot')}` }])
    // le cartelle VECCHIE sono state tolte DOPO la copia riuscita
    expect(existsSync(join(root, 'agents', botA.id, 'skills'))).toBe(false)
    expect(existsSync(join(root, 'agents', botB.id, 'skills'))).toBe(false)
    // visibilità: riassunto-riunione per ENTRAMBI i bot
    expect(librarySkillsVisibleTo(botA.id).map((s) => s.name)).toContain('riassunto-riunione')
    expect(librarySkillsVisibleTo(botB.id).map((s) => s.name)).toContain('riassunto-riunione')
    expect(librarySkillsVisibleTo(botB.id).map((s) => s.name)).toContain(`triage-${botSlug('Beta Bot')}`)
  })

  it('un SKILL.md con nome diverso dalla cartella: il nomeSegue la cartella', () => {
    const bot = createAgent('Gamma')
    mkdirSync(join(root, 'agents', bot.id, 'skills', 'nome-cartella'), { recursive: true })
    writeFileSync(join(root, 'agents', bot.id, 'skills', 'nome-cartella', 'SKILL.md'), '---\nname: altro-nome\ndescription: d\n---\ncorpo')
    const r = migrateSkillFolders({ root, agents: listAgents().map((a) => ({ id: a.id, name: a.name })), library: {} })
    expect(r.error).toBeUndefined()
    const md = readFileSync(join(root, 'skills', 'nome-cartella', 'SKILL.md'), 'utf8')
    expect(md).toContain('name: nome-cartella')
  })

  it('il runner è idempotente col flag; senza flag migra e lo scrive', () => {
    expect(getSetting(SKILLS_MIGRATED_FLAG, false)).toBe(false)
    const r1 = migrateAgentSkills()
    expect(r1.error).toBeUndefined()
    expect(getSetting(SKILLS_MIGRATED_FLAG, false)).toBe(true)
    // secondo giro: niente da fare (il flag scatta)
    const r2 = migrateAgentSkills()
    expect(r2.moved).toHaveLength(0)
    expect(r2.conflicts).toHaveLength(0)
  })

  it('errore a metà: le copie già fatte si tolgono, gli ORIGINALI restano, niente flag', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'sandbot-skills-mig-err-'))
    try {
      const mkSkill2 = (agentId: string, name: string, body: string): void => {
        mkdirSync(join(root2, 'agents', agentId, 'skills', name), { recursive: true })
        writeFileSync(join(root2, 'agents', agentId, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}`)
      }
      // il bot della fixture esiste già nel DB condiviso del test: se ne crea
      // uno NUOVO con directory NON SCRIVIBILE a metà (una skill buona, poi
      // una cartella-file al posto della directory → readdir ok ma cp fallisce)
      const bot = createAgent('Delta Errore')
      mkSkill2(bot.id, 'buona', 'corpo')
      // una "directory" che in realtà contiene un file dove cpSync dovrà
      // creare una directory: SKILL.md c'è ma la copia fallirà perché il
      // nodo target nella libreria è già un FILE
      mkdirSync(join(root2, 'skills'), { recursive: true })
      writeFileSync(join(root2, 'skills', 'bloccona'), 'sono un file') // conflitto di tipo
      mkdirSync(join(root2, 'agents', bot.id, 'skills', 'bloccona'), { recursive: true })
      writeFileSync(join(root2, 'agents', bot.id, 'skills', 'bloccona', 'SKILL.md'), '---\nbloccona\n---\nx')
      const r = migrateSkillFolders({ root: root2, agents: [{ id: bot.id, name: 'Delta Errore' }], library: {} })
      expect(r.error).toBeTruthy()
      // gli ORIGINALI restano tutti
      expect(existsSync(join(root2, 'agents', bot.id, 'skills', 'buona', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(root2, 'agents', bot.id, 'skills', 'bloccona', 'SKILL.md'))).toBe(true)
      // le copie della corsa fallita si tolgono (buona non è in libreria)
      expect(existsSync(join(root2, 'skills', 'buona'))).toBe(false)
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })
})
