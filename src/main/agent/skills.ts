// Skill (fase 4, §3bis L6): una skill per directory,
// <dataDir>/agents/<agentId>/skills/<nome>/SKILL.md, con lo stesso formato
// delle skill di Claude Code — frontmatter name e description, corpo con le
// istruzioni. Nel system prompt vanno SOLO nome e descrizione: il corpo si
// carica su richiesta col tool skill({name}). Il nome è validato
// (solo [a-z0-9-], max 64) PRIMA di costruire qualunque path.
// Parsing e validazione sono funzioni pure; l'I/O file sta in fondo.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, getSetting } from '../store/db'
import { boxOwnerOf } from '../sandbox'

export interface SkillRecord {
  name: string
  description: string
  content: string
}

/** Nome di skill valido: solo [a-z0-9-], da 1 a 64 caratteri. */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(name)
}

/** Parsifica un SKILL.md (frontmatter name/description + corpo); null se malformato. */
export function parseSkillFile(text: string): SkillRecord | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return null
  const fields = new Map<string, string>()
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const name = fields.get('name') ?? ''
  if (!isValidSkillName(name)) return null
  return { name, description: fields.get('description') ?? '', content: (m[2] ?? '').trim() }
}

/** Serializza una skill nello stesso formato (stabile per roundtrip). */
export function serializeSkill(s: SkillRecord): string {
  return ['---', `name: ${s.name}`, `description: ${s.description.replace(/\n+/g, ' ')}`, '---', '', s.content].join('\n')
}

/**
 * Sezione "# Skill disponibili" del system prompt: SOLO nome e descrizione
 * di ogni skill (il corpo non entra mai nel prompt di default), con
 * l'istruzione di caricarlo con skill({name}) quando serve. '' se vuote.
 */
export function skillsSectionPrompt(skills: SkillRecord[]): string {
  if (!skills.length) return ''
  const lines = skills
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- ${s.name}: ${s.description.replace(/\n+/g, ' ').trim()}`)
  return [
    '# Available skills',
    'Procedures you know how to execute. In the prompt you see only the name and description: if a skill is needed for the current task, load the full instructions with skill({name}) and follow them. Create or update skills with update_skill (the user\'s approval is required).',
    ...lines
  ].join('\n')
}

// ---- fase 13 (punto 4): le skill dei PLUGIN (sola lettura, mai copiate) ----

import { installedPlugins, pluginSkillBody, type InstalledPlugin } from '../connectors/install'

/** Il rifiuto fisso di update_skill/delete_skill su una skill di plugin. */
export const PLUGIN_SKILL_REFUSAL = 'a plugin\'s skill: it is changed by updating the plugin'

/** I plugin installati abilitati per un bot (enabledFor; il figlio eredita dal padre). */
export function pluginsEnabledFor(agentId: string, parentId?: string): InstalledPlugin[] {
  const all = installedPlugins({ getSetting })
  return all.filter((p) => p.enabledFor.includes('*') || p.enabledFor.includes(agentId) || (parentId !== undefined && p.enabledFor.includes(parentId)))
}

/** Le skill dei plugin abilitati per un bot: nome nel prompt <plugin>--<skill> con "(plugin <nome>)". */
export function pluginSkillsOf(agentId: string): SkillRecord[] {
  const owner = boxOwnerOf(agentId)
  return pluginsEnabledFor(agentId, owner === agentId ? undefined : owner).flatMap((p) =>
    p.skills.map((s) => ({ name: s.name, description: `${s.description} (plugin ${p.name})`, content: '' }))
  )
}



export function skillsDir(agentId: string): string {
  return join(dataDir(), 'agents', agentId, 'skills')
}

/** Tutte le skill dell'agente (directory figlie con un SKILL.md valido). */
export function listSkills(agentId: string): SkillRecord[] {
  try {
    return readdirSync(skillsDir(agentId), { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidSkillName(d.name))
      .map((d) => parseSkillFile(readFileSync(join(skillsDir(agentId), d.name, 'SKILL.md'), 'utf8')))
      .filter((s): s is SkillRecord => s !== null)
  } catch {
    return [] // directory assente: nessuna skill
  }
}

/** Corpo (istruzioni) di una skill — è ciò che il tool skill({name}) consegna al modello. Fase 13: le skill dei plugin si LEGGONO (sono in sola lettura nella cartella del plugin). */
export function readSkillBody(agentId: string, name: string): string {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: "${name}" (only [a-z0-9-], max 64)`)
  // fase 12: il figlio legge le skill del PADRE; fase 13: e le skill dei plugin
  const readFor = boxOwnerOf(agentId)
  try {
    return parseSkillFile(readFileSync(join(skillsDir(readFor), name, 'SKILL.md'), 'utf8'))?.content ?? ''
  } catch {
    // non è una skill del bot: può essere una skill di PLUGIN abilitato
    for (const p of pluginsEnabledFor(readFor)) {
      const body = pluginSkillBody(p, dataDir(), name)
      if (body !== null) return parseSkillFile(body)?.content ?? body
    }
    throw new Error(`Skill "${name}" not found`)
  }
}

/** Crea o aggiorna una skill (update_skill); ritorna il record salvato. */
export function writeSkill(agentId: string, input: { name: string; description: string; content: string }): SkillRecord {
  const name = String(input.name ?? '')
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: "${name}" (only [a-z0-9-], max 64)`)
  const record: SkillRecord = {
    name,
    description: String(input.description ?? ''),
    content: String(input.content ?? '')
  }
  const dir = join(skillsDir(agentId), name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), serializeSkill(record))
  return record
}

/** Elimina una skill (directory inclusa); true se esisteva. */
export function deleteSkill(agentId: string, name: string): boolean {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: "${name}" (only [a-z0-9-], max 64)`)
  const dir = join(skillsDir(agentId), name)
  try {
    readdirSync(dir)
  } catch {
    return false
  }
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** Sezione skill del system prompt per un agente ('' se non ci sono skill). Fase 13: anche le skill dei plugin. */
export function buildSkillsSection(agentId: string): string {
  try {
    const own = listSkills(agentId)
    let pluginSkills: SkillRecord[] = []
    try {
      pluginSkills = pluginSkillsOf(agentId)
    } catch {
      pluginSkills = [] // i plugin non devono mai rompere il prompt
    }
    return skillsSectionPrompt([...own, ...pluginSkills])
  } catch {
    return '' // le skill non devono mai rompere il turno
  }
}
