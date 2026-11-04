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
import type { McpServerConfig } from '../mcp'
import { templateVarNames } from '../../shared/registry-vars'
import { getSetting, setSetting } from './db'

/** Il setting che marca la migrazione fatta (idempotente). */
export const MCP_MIGRATION_FLAG = 'mcp.registryTemplatesMigrated'

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
