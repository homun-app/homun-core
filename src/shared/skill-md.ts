// Fase skill (S1): il formato Agent Skills (agentskills.io), letto e scritto
// per intero. Lo standard: SKILL.md con frontmatter YAML `name` e
// `description` obbligatori più chiavi note facoltative (`license`,
// `compatibility`, `metadata`, `allowed-tools`) e OGNI chiave sconosciuta
// conservata e riscritta identica (il giro lettura→scrittura non perde
// niente). Il parse usa js-yaml con JSON_SCHEMA (mai tipi custom): le
// descrizioni su più righe (`>` e `|`), le mappe e le liste sono YAML vero.
// Modulo PURO (niente fs, niente Electron): lo usano il main, il daemon e
// l'editor del renderer.
//
// Ogni errore è DOPPIO: un testo inglese per il modello (i result dei tool)
// e un UiText del catalogo UI per l'interfaccia, nella lingua dell'utente.
import yaml from 'js-yaml'
import { UI } from './ui-messages'
import { ui } from './ui-text'
import type { UiText } from './types'

/** Il frontmatter fence: BOM tolto, CRLF ammesso. */
const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export const SKILL_NAME_MAX = 64
export const SKILL_DESCRIPTION_MAX = 1024
export const SKILL_COMPATIBILITY_MAX = 500
export const SKILL_MD_MAX = 100_000

/**
 * Nome di skill valido secondo lo standard: 1–64 caratteri di [a-z0-9-], con
 * NIENTE trattino iniziale o finale e nessun "--" (i trattini separano parole
 * singole). La forma regex evita le tre violazioni in un colpo solo.
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(name)
}

/** Una skill parsificata: name e description noti, il corpo e TUTTO il frontmatter. */
export interface ParsedSkillMd {
  name: string
  description: string
  body: string
  /** ogni chiave del frontmatter (name e description comprese), per il roundtrip */
  frontmatter: Record<string, unknown>
  /** chiavi note facoltative, già tipizzate quando ci sono e sono valide */
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string[]
}

/** Un errore del formato: inglese per il modello, UiText per la UI. */
export interface SkillMdIssue {
  english: string
  ui: UiText
}

export type ParseSkillMdResult = { ok: true; skill: ParsedSkillMd } | { ok: false; issues: SkillMdIssue[] }

const issue = (m: { english: string; ui: UiText }): SkillMdIssue => ({ english: m.english, ui: m.ui })

/** Tutti i problemi di un frontmatter in un colpo (l'editor li mostra sul campo). */
export function skillMdIssues(input: { name: unknown; description: unknown; frontmatter: Record<string, unknown> }): SkillMdIssue[] {
  const issues: SkillMdIssue[] = []
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (!name) {
    issues.push(issue({ english: 'The frontmatter requires "name".', ui: ui(UI.skillNameMissing) }))
  } else if (!isValidSkillName(name)) {
    issues.push(issue({
      english: `Invalid name "${name}": 1-64 characters, only lowercase letters, digits and single hyphens.`,
      ui: ui(UI.skillNameInvalid, { name })
    }))
  }
  if (!description) {
    issues.push(issue({ english: 'The frontmatter requires a non-empty "description".', ui: ui(UI.skillDescriptionMissing) }))
  } else if (description.length > SKILL_DESCRIPTION_MAX) {
    issues.push(issue({
      english: `The description must be at most ${SKILL_DESCRIPTION_MAX} characters (now ${description.length}).`,
      ui: ui(UI.skillDescriptionTooLong, { n: description.length })
    }))
  }
  const compatibility = input.frontmatter.compatibility
  if (typeof compatibility === 'string' && compatibility.length > SKILL_COMPATIBILITY_MAX) {
    issues.push(issue({
      english: `"compatibility" must be at most ${SKILL_COMPATIBILITY_MAX} characters (now ${compatibility.length}).`,
      ui: ui(UI.skillCompatibilityTooLong, { n: compatibility.length })
    }))
  }
  const metadata = input.frontmatter.metadata
  if (metadata !== undefined && !isStringMap(metadata)) {
    issues.push(issue({ english: '"metadata" must be a map of strings.', ui: ui(UI.skillMetadataInvalid) }))
  }
  return issues
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
}

/**
 * Parsifica uno SKILL.md (BOM e CRLF in testa non rompono niente).
 * Le chiavi sconosciute restano in `frontmatter`; il corpo è il testo dopo
 * il secondo `---`. Gli errori raccolgono TUTTI i problemi, non solo il primo.
 */
export function parseSkillMd(text: string): ParseSkillMdResult {
  const cleaned = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = FRONTMATTER_FENCE.exec(cleaned)
  if (!match) {
    return { ok: false, issues: [issue({
      english: 'SKILL.md must start with the YAML frontmatter (--- ... ---).',
      ui: ui(UI.skillNoFrontmatter)
    })] }
  }
  let frontmatter: unknown
  try {
    // JSON_SCHEMA: niente tipi custom, niente date/booleani alla YAML 1.1
    frontmatter = yaml.load(match[1], { schema: yaml.JSON_SCHEMA })
  } catch (e) {
    return { ok: false, issues: [issue({
      english: `Invalid frontmatter YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      ui: ui(UI.skillYamlInvalid, { reason: e instanceof Error ? e.message.split('\n')[0]!.slice(0, 160) : String(e).slice(0, 160) })
    })] }
  }
  if (frontmatter === null || frontmatter === undefined) frontmatter = {}
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { ok: false, issues: [issue({ english: 'The frontmatter must be a YAML mapping.', ui: ui(UI.skillYamlInvalid, { reason: 'not a mapping' }) })] }
  }
  const record = frontmatter as Record<string, unknown>
  const issues = skillMdIssues({ name: record.name, description: record.description, frontmatter: record })
  if (issues.length > 0) return { ok: false, issues }
  const body = cleaned.slice(match[0].length).replace(/^\n/, '')
  if (cleaned.length > SKILL_MD_MAX) {
    return { ok: false, issues: [...issues, issue({
      english: `SKILL.md is too large: at most ${SKILL_MD_MAX} characters (now ${cleaned.length}).`,
      ui: ui(UI.skillBodyTooLarge, { n: cleaned.length })
    })] }
  }
  const name = String(record.name).trim()
  const description = String(record.description).trim()
  const allowedRaw = record['allowed-tools']
  const allowedTools = typeof allowedRaw === 'string'
    ? [allowedRaw]
    : Array.isArray(allowedRaw) && allowedRaw.every((x) => typeof x === 'string')
      ? allowedRaw as string[]
      : undefined
  return {
    ok: true,
    skill: {
      name,
      description,
      body,
      frontmatter: record,
      ...(typeof record.license === 'string' && record.license ? { license: record.license } : {}),
      ...(typeof record.compatibility === 'string' && record.compatibility ? { compatibility: record.compatibility } : {}),
      ...(isStringMap(record.metadata) ? { metadata: record.metadata } : {}),
      ...(allowedTools ? { allowedTools } : {})
    }
  }
}

/**
 * Costruisce lo SKILL.md: `name` e `description` per primi, poi le altre
 * chiavi nell'ordine in cui sono arrivate (roundtrip stabile). I valori con
 * a capo diventano block scalar `|`/`|-`/`|+`, gli altri restano su una riga.
 */
export function buildSkillMd(input: {
  name: string
  description: string
  body: string
  /** il frontmatter di un parse precedente: le chiavi sconosciute si conservano */
  frontmatter?: Record<string, unknown>
}): string {
  const merged: Record<string, unknown> = { ...(input.frontmatter ?? {}) }
  merged.name = input.name.trim()
  merged.description = input.description.trim()
  const rank = (key: string): number => (key === 'name' ? 0 : key === 'description' ? 1 : 2)
  const keys = Object.keys(merged).sort((a, b) => {
    const diff = rank(a) - rank(b)
    return diff !== 0 ? diff : a.localeCompare(b)
  })
  const lines = keys.map((key) => formatYamlLine(key, merged[key]))
  const body = input.body.replace(/^\r?\n/, '')
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`
}

/** True quando il testo è uno scalare YAML che non serve proteggere. */
function plainScalar(value: string): boolean {
  if (value === '' || value !== value.trim()) return false
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith('&') || value.startsWith('*')) return false
  if (/[:#{}[\],&*?|>!%@`]/.test(value)) return false
  if (value === 'true' || value === 'false' || value === 'null' || value === '~') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return false
  return true
}

function formatYamlBlockScalar(key: string, value: string): string {
  const trailing = /\n*$/.exec(value)?.[0]?.length ?? 0
  let indicator = '|'
  let lines: string[]
  if (trailing === 0) {
    indicator = '|-'
    lines = value.split('\n')
  } else if (trailing === 1) {
    indicator = '|'
    lines = value.slice(0, -1).split('\n')
  } else {
    indicator = '|+'
    lines = [...value.slice(0, -trailing).split('\n'), ...Array.from({ length: trailing - 1 }, () => '')]
  }
  return `${key}: ${indicator}\n${lines.map((line) => `  ${line}`).join('\n')}`
}

function formatYamlLine(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}:`
  if (typeof value === 'string') {
    if (value.includes('\n')) return formatYamlBlockScalar(key, value)
    if (plainScalar(value)) return `${key}: ${value}`
    return `${key}: ${JSON.stringify(value)}`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${value}`
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      return `${key}: [${value.map((item) => JSON.stringify(String(item))).join(', ')}]`
    }
    return `${key}:\n${value.map((item) => `  - ${typeof item === 'string' ? JSON.stringify(item) : JSON.stringify(item)}`).join('\n')}`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return `${key}:`
    return `${key}:\n${entries.map(([k, v]) => `  ${formatYamlLine(k, v)}`).join('\n')}`
  }
  return `${key}: ${JSON.stringify(String(value))}`
}

/** Il nome umanizzato per l'elenco: `pubblica-articolo` → «Pubblica articolo». */
export function humanizeSkillName(name: string): string {
  const joined = name.split('-').filter(Boolean).join(' ')
  if (!joined) return name
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}
