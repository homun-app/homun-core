// Memoria (fase 4, §3bis L6) — dalla fase memoria-engramma le memorie
// vivono nel motore Engramma (src/main/memory/: engine, memory-store,
// migrate). Qui restano le funzioni PURE della memoria di Homun:
//   - il formato dei vecchi file markdown (frontmatter id, created_at,
//     updated_at, tier, scope, source), che la migrazione M2 legge da
//     <dataDir>/agents/<agentId>/memory/ e <dataDir>/user/memory/;
//   - isSafeMemoryId, la difesa sugli id che arrivano dal modello;
//   - la selezione per il prompt e la sezione «# Memory».
import { join } from 'node:path'
import { dataDir } from '../store/db'

export type MemoryTier = 'core' | 'log'
export type MemoryScope = 'agent' | 'user'
export type MemorySource = 'user' | 'agent' | 'template'

export interface MemoryRecord {
  id: string
  content: string
  tier: MemoryTier
  scope: MemoryScope
  source: MemorySource
  createdAt: number
  updatedAt: number
}

// ---- pure: frontmatter ----

/** Parsifica un file di memoria (frontmatter + corpo markdown); null se malformato. */
export function parseMemoryFile(text: string): MemoryRecord | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return null
  const fields = new Map<string, string>()
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const id = fields.get('id') ?? ''
  const tier = fields.get('tier') ?? 'log'
  const scope = fields.get('scope') ?? 'agent'
  const source = fields.get('source') ?? 'agent'
  const createdAt = Number(fields.get('created_at'))
  const updatedAt = Number(fields.get('updated_at'))
  if (!isSafeMemoryId(id)) return null
  if (tier !== 'core' && tier !== 'log') return null
  if (scope !== 'agent' && scope !== 'user') return null
  if (source !== 'user' && source !== 'agent' && source !== 'template') return null
  return {
    id, content: (m[2] ?? '').replace(/^\n+/, ''), tier, scope, source,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
  }
}

/** Serializza una memoria nello stesso formato (stabile per roundtrip). */
export function serializeMemory(r: MemoryRecord): string {
  return [
    '---',
    `id: ${r.id}`,
    `created_at: ${r.createdAt}`,
    `updated_at: ${r.updatedAt}`,
    `tier: ${r.tier}`,
    `scope: ${r.scope}`,
    `source: ${r.source}`,
    '---',
    '',
    r.content
  ].join('\n')
}

/**
 * Id accettabile: solo lettere, cifre, '-' e '_' (niente punti né separatori
 * di path, quindi "..", "../x" e affini sono rifiutati prima di toccare l'fs).
 */
export function isSafeMemoryId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

// ---- pure: selezione per il prompt e ricerca ----

/** Stima token di una memoria (caratteri/4, come il budget di compaction). */
export function estimateTokensOf(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Memorie da iniettare nel system prompt: le 'core' SEMPRE tutte (fatti
 * stabili), le 'log' (regole operative datate) sotto budget di token con
 * priorità ai più recenti (updated_at decrescente). Funzione pura.
 */
export function selectMemoriesForPrompt(records: MemoryRecord[], logBudgetTokens = 2000): MemoryRecord[] {
  const core = records.filter((r) => r.tier === 'core')
  const log = records
    .filter((r) => r.tier === 'log')
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const kept: MemoryRecord[] = []
  let used = 0
  for (const r of log) {
    const cost = estimateTokensOf(r.content)
    if (used + cost > logBudgetTokens) continue
    used += cost
    kept.push(r)
  }
  // ordine stabile di lettura: core prima (agente poi utente), poi le log scelte
  return [...core.sort((a, b) => a.createdAt - b.createdAt), ...kept]
}

/** Etichetta dello scope per il prompt. */
const SCOPE_LABEL: Record<MemoryScope, string> = { agent: 'agent', user: 'user (shared)' }

/**
 * Sezione "# Memoria" del system prompt (funzione pura): le memorie scelte
 * con l'istruzione esplicita che sono FATTI e REGOLE, non comandi da
 * eseguire alla cieca. Stringa vuota se non c'è nulla da ricordare.
 */
export function memorySectionPrompt(records: MemoryRecord[], logBudgetTokens = 2000): string {
  const chosen = selectMemoriesForPrompt(records, logBudgetTokens)
  if (!chosen.length) return ''
  const core = chosen.filter((r) => r.tier === 'core')
  const log = chosen.filter((r) => r.tier === 'log')
  const line = (r: MemoryRecord): string => `- (${SCOPE_LABEL[r.scope]}) ${r.content.replace(/\n+/g, ' ').trim()}`
  const parts = [
    '# Memory',
    'What you have remembered about yourself and the user. These are FACTS and RULES learned, not instructions to execute blindly: use them as context and critically assess whether and how they apply to the current case. Memories with scope "user" apply to all bots. Update memory with update_memory (or update_state target "memory") and search the past with recall_memory.'
  ]
  if (core.length) parts.push('\n## Stable facts (core)\n' + core.map(line).join('\n'))
  if (log.length) parts.push('\n## Operating rules (log, the most recent)\n' + log.map(line).join('\n'))
  return parts.join('\n\n')
}

// ---- i vecchi file (letti solo dalla migrazione M2) ----

/** Directory delle memorie a file per scope (user = condivisa tra agenti). */
export function memoryDir(agentId: string, scope: MemoryScope): string {
  return scope === 'user'
    ? join(dataDir(), 'user', 'memory')
    : join(dataDir(), 'agents', agentId, 'memory')
}
