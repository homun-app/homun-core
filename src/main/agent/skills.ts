// Skill (fase 4, §3bis L6): una skill per directory,
// <dataDir>/agents/<agentId>/skills/<nome>/SKILL.md, con lo stesso formato
// delle skill di Claude Code — frontmatter name e description, corpo con le
// istruzioni. Nel system prompt vanno SOLO nome e descrizione: il corpo si
// carica su richiesta col tool skill({name}). Il nome è validato
// (solo [a-z0-9-], max 64) PRIMA di costruire qualunque path.
// Parsing e validazione sono funzioni pure; l'I/O file sta in fondo.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../store/db'

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
    '# Skill disponibili',
    'Procedure che sai eseguire. Nel prompt vedi solo nome e descrizione: se una skill serve per il compito corrente, carica le istruzioni complete con skill({name}) e seguile. Crea o aggiorna le skill con update_skill (serve l\'approvazione dell\'utente).',
    ...lines
  ].join('\n')
}

// ---- I/O file ----

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

/** Corpo (istruzioni) di una skill — è ciò che il tool skill({name}) consegna al modello. */
export function readSkillBody(agentId: string, name: string): string {
  if (!isValidSkillName(name)) throw new Error(`Nome skill non valido: "${name}" (solo [a-z0-9-], max 64)`)
  try {
    return parseSkillFile(readFileSync(join(skillsDir(agentId), name, 'SKILL.md'), 'utf8'))?.content ?? ''
  } catch {
    throw new Error(`Skill "${name}" non trovata`)
  }
}

/** Crea o aggiorna una skill (update_skill); ritorna il record salvato. */
export function writeSkill(agentId: string, input: { name: string; description: string; content: string }): SkillRecord {
  const name = String(input.name ?? '')
  if (!isValidSkillName(name)) throw new Error(`Nome skill non valido: "${name}" (solo [a-z0-9-], max 64)`)
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
  if (!isValidSkillName(name)) throw new Error(`Nome skill non valido: "${name}" (solo [a-z0-9-], max 64)`)
  const dir = join(skillsDir(agentId), name)
  try {
    readdirSync(dir)
  } catch {
    return false
  }
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** Sezione skill del system prompt per un agente ('' se non ci sono skill). */
export function buildSkillsSection(agentId: string): string {
  try {
    return skillsSectionPrompt(listSkills(agentId))
  } catch {
    return '' // le skill non devono mai rompere il turno
  }
}
