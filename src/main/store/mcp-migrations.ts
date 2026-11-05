// Fase mcp-setup (M7): migrazione UNA TANTUM dei server del registro salvati
// dalle versioni di prima — quelle che ignoravano `remotes[].variables` e
// conservavano l'URL con i `{segnaposto}` letterali (il Mattermost della
// prova dell'utente). Come le migrazioni delle Impostazioni: core PURO
// (dict in/dict out, testato su fixture), runner sui setting veri al primo
// avvio del daemon, FLAG che la rende idempotente.
//
//   M7.1  un server del registro con `{var}` nell'URL diventa `urlTemplate`
//         con needsAuth 'setup': le variabili si rileggono dalla voce del
//         registro alla prima apertura del foglio (serverSetupSpec), e se il
//         registro non risponde si ricavano dai nomi tra graffe, senza
//         descrizione. L'`auth: headers` di un header in realtà facoltativo
//         NON cambia da solo: l'utente ha scelto un token, e resta.
//   M7.3  il `cfg.name` rimasto al nome tecnico diventa il titolo del
//         registro alla prima CONNESSIONE RIUSCITA (install.ts,
//         fixTitleFromRegistry) — non qui, dove il registro può non rispondere.
//
// Fase mcp-setup ritocchi (R1): PRIMA di qualsiasi rinomina, ogni server
// senza `toolSlug` riceve lo slug del nome di OGGI (congelato): da lì in poi
// il prefisso degli strumenti (mcp__<toolSlug>__) non cambia più quando il
// nome diventa il titolo del registro — permessi, disabledTools e riferimenti
// sopravvivono alla rinomina. Chi oggi va in collisione riceve -2, -3…; i
// server del catalogo non si toccano (il loro slug non cambia).
import type { McpServerConfig } from '../mcp'
import { toolSlugOf } from '../mcp/slug'
import { templateVarNames } from '../../shared/registry-vars'
import { getSetting, setSetting } from './db'

/** Il setting che marca la migrazione fatta (idempotente). */
export const MCP_MIGRATION_FLAG = 'mcp.registryTemplatesMigrated'

/** R1: il setting che marca il congelamento dei toolSlug (idempotente). */
export const MCP_TOOLSLUG_FLAG = 'mcp.toolSlugsMigrated'

/** Il core puro: i server come li riscrive la migrazione (solo se cambia qualcosa). */
export function migrateRegistryServerTemplates(servers: McpServerConfig[]): { servers: McpServerConfig[]; changed: boolean } {
  let changed = false
  const out = servers.map((s) => {
    // solo i server del registro con un URL che ha ancora i segnaposto letterali
    if (s.source?.kind !== 'registry' || !s.url || !/\{[A-Za-z0-9_][A-Za-z0-9_.-]*\}/.test(s.url)) return s
    const vars = templateVarNames(s.url)
    if (!vars.length) return s
    changed = true
    // il vecchio needsAuth (kind 'key' dell'header) si porta dietro le sue
    // chiavi: il token manca ancora, se non è mai stato salvato
    const oldKeys = s.needsAuth?.keys ?? []
    const needs: McpServerConfig['needsAuth'] = { kind: 'setup', keys: [...new Set([...vars, ...oldKeys])] }
    const { url: _url, ...rest } = s
    return { ...rest, urlTemplate: s.url, needsAuth: needs }
  })
  return { servers: out, changed }
}

/** Il runner sui setting veri (daemon, primo avvio): una riga di log, niente dati. */
export function migrateMcpServers(): void {
  if (getSetting<boolean>(MCP_MIGRATION_FLAG, false)) return
  const { servers, changed } = migrateRegistryServerTemplates(getSetting<McpServerConfig[]>('mcp.servers', []))
  if (changed) {
    setSetting('mcp.servers', servers)
    const n = servers.filter((s) => s.urlTemplate && s.source?.kind === 'registry').length
    console.log(`[sandbotd] migrazione server del registro: ${n} con template da completare (needsAuth setup)`)
  }
  setSetting(MCP_MIGRATION_FLAG, true)
}

// ---- R1: il congelamento dei toolSlug (prima di qualsiasi rinomina) ----

/** Un toolSlug rinumerato dalla migrazione (per il log e il REPORT). */
export interface SlugDuplicate {
  id: string
  name: string
  /** lo slug di oggi, uguale a quello di un server precedente */
  from: string
  /** lo slug assegnato (-2, -3…) */
  to: string
}

/**
 * R1 (core puro): ogni server SENZA toolSlug riceve `toolSlug = slug(nome di
 * OGGI)` — i nomi degli strumenti dei server già installati NON cambiano
 * (nemmeno il taglio a 24: lo slug di oggi resta COME È). Chi oggi va in
 * collisione con un server precedente riceve -2, -3…; i server del CATALOGO
 * non si toccano (il loro nome non cambia mai: lo slug resta per fallback),
 * però il loro slug CONTA per i successivi. Un server che ha già toolSlug
 * (installato col codice nuovo) resta com'è.
 */
export function migrateToolSlugs(servers: McpServerConfig[]): { servers: McpServerConfig[]; changed: boolean; duplicates: SlugDuplicate[] } {
  let changed = false
  const duplicates: SlugDuplicate[] = []
  // verifica: gli slug che NON si toccano (catalogo, già congelati) si
  // prenotano PRIMA del giro — altrimenti un server del registro che nella
  // lista viene prima del catalogo si prenderebbe lo slug del catalogo
  const fixed = (s: McpServerConfig): boolean => Boolean(s.catalogId || s.toolSlug)
  const taken = new Set<string>(servers.filter(fixed).map((s) => toolSlugOf(s)))
  const out = servers.map((s) => {
    const current = toolSlugOf(s)
    // il server del catalogo non si tocca; chi ha già toolSlug nemmeno
    if (fixed(s)) return s
    let next = current
    for (let i = 2; taken.has(next); i++) next = `${current}-${i}`
    taken.add(next)
    changed = true
    if (next !== current) duplicates.push({ id: s.id, name: s.name, from: current, to: next })
    return { ...s, toolSlug: next }
  })
  return { servers: out, changed, duplicates }
}

/**
 * R1 (runner, primo avvio del daemon): gira PRIMA di qualsiasi rinomina (il
 * congelamento degli slug precede la migrazione dei template e il titolo del
 * registro, che arriva solo alla prima connessione riuscita). Idempotente per
 * flag; i duplicati rinumerati si scrivono nel log.
 */
export function migrateToolSlugFreeze(): void {
  if (getSetting<boolean>(MCP_TOOLSLUG_FLAG, false)) return
  const { servers, changed, duplicates } = migrateToolSlugs(getSetting<McpServerConfig[]>('mcp.servers', []))
  if (changed) {
    setSetting('mcp.servers', servers)
    const note = duplicates.length
      ? ` (${duplicates.length} duplicati rinumerati: ${duplicates.map((d) => `${d.from} → ${d.to}`).join(', ')})`
      : ''
    console.log(`[sandbotd] migrazione toolSlug: ${servers.filter((s) => s.toolSlug).length} slug congelati${note}`)
  }
  setSetting(MCP_TOOLSLUG_FLAG, true)
}
