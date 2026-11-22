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

// ---- P7 (fase uso-permessi): i server http MAI CONNESSI si spengono ----
// V4 (fase stato-vivo): la migrazione PRIMA TESTA — spegne solo chi NON
// risponde (il campo firstOkAt nasceva nella STESSA fase di P7, quindi ogni
// server http esistente risultava «mai connesso» e la migrazione lo spegneva
// al primo avvio ANCHE se funzionava: il caso vero di orion-moon). E chi
// spegne scrive il MOTIVO (disabledReason).

/** P7: il setting che marca la migrazione fatta (idempotente). */
export const MCP_HTTP_MIGRATION_FLAG = 'mcp.httpNeverConnectedOff'

/** V4: il setting che marca la RIPARAZIONE una tantum fatta (idempotente). */
export const MCP_HTTP_OFF_REPAIR_FLAG = 'mcp.httpOffFirstOkRepair'

/** Le dipendenze dei runner http (P7 e riparazione), iniettabili per i test. */
export interface HttpMigrationsDeps {
  getServers: () => McpServerConfig[]
  saveServers: (servers: McpServerConfig[]) => void
  getFlag: (key: string) => boolean
  setFlag: (key: string) => void
  testServer: (id: string) => Promise<{ ok: boolean }>
  log: (message: string) => void
}

/** I runner sui setting veri (il daemon); i test iniettano i loro finti. */
async function realHttpDeps(): Promise<HttpMigrationsDeps> {
  const mcpMod = await import('../mcp')
  return {
    getServers: () => getSetting<McpServerConfig[]>('mcp.servers', []),
    saveServers: (servers) => setSetting('mcp.servers', servers),
    getFlag: (key) => getSetting<boolean>(key, false),
    setFlag: (key) => setSetting(key, true),
    testServer: (id) => mcpMod.testServer(id),
    log: (message) => console.log(message)
  }
}

/**
 * P7 (core puro): un'aggiunta http FALLITA di una volta lasciava il server in
 * mcp.servers e ABILITATO. La migrazione SPENGE i server http accesi che non
 * si sono MAI connessi con successo (nessun firstOkAt) — ma dal V4 SOLO
 * quelli che al test di connessione NON rispondono (`failing`: gli id che il
 * runner ha appena provato). NON si toccano: i server con firstOkAt (hanno
 * funzionato), quelli già spenti, quelli che aspettano la configurazione
 * (needsAuth) e gli stdio. Chi spegne scrive disabledReason 'never-connected'
 * (V4): così la UI può dire «spento da Homun» e offrire Riaccendi.
 */
export function migrateNeverConnectedHttpServers(servers: McpServerConfig[], failing: ReadonlySet<string>): { servers: McpServerConfig[]; changed: boolean } {
  let changed = false
  const out = servers.map((s) => {
    if (s.transport !== 'http' || !s.enabled || s.firstOkAt !== undefined || s.needsAuth) return s
    if (!failing.has(s.id)) return s
    changed = true
    return { ...s, enabled: false, disabledReason: 'never-connected' as const }
  })
  return { servers: out, changed }
}

/** P7 (runner, primo avvio del daemon): PRIMA TESTA i candidati, poi spegne chi non risponde. */
export async function migrateHttpNeverConnectedOff(deps?: HttpMigrationsDeps): Promise<void> {
  const d = deps ?? (await realHttpDeps())
  if (d.getFlag(MCP_HTTP_MIGRATION_FLAG)) return
  const servers = d.getServers()
  // i candidati: http accesi, mai connessi, non in attesa di configurazione
  const candidates = servers.filter((s) => s.transport === 'http' && s.enabled && s.firstOkAt === undefined && !s.needsAuth)
  const failing = new Set<string>()
  for (const c of candidates) {
    try {
      if (!(await d.testServer(c.id)).ok) failing.add(c.id)
    } catch {
      failing.add(c.id)
    }
  }
  const { servers: out, changed } = migrateNeverConnectedHttpServers(servers, failing)
  if (changed) {
    d.saveServers(out)
    const n = out.filter((s) => s.transport === 'http' && !s.enabled && s.firstOkAt === undefined && !s.needsAuth && s.disabledReason === 'never-connected').length
    d.log(`[sandbotd] migrazione server http: ${n} mai connessi e che NON rispondono → spenti`)
  }
  d.setFlag(MCP_HTTP_MIGRATION_FLAG)
}

/**
 * V4 (fase stato-vivo — core puro): la RIPARAZIONE del caso vero. orion-moon
 * (http, header, importato con la beta.15) era `enabled: false` con
 * `firstOkAt` del 21/11 18:46: la migrazione P7 l'aveva spento al primo avvio
 * (ogni server http risultava «mai connesso»), e un test successivo l'aveva
 * visto funzionare senza riaccenderlo. Qui: i server http SPENTI con
 * firstOkAt (la prova che funzionano) e SENZA un motivo di spegnimento
 * registrato si RIACCENDONO se il test risponde (`ok`: gli id che il runner
 * ha appena provato). Se non risponde, resta spento. Un server con
 * disabledReason (l'utente, un'aggiunta fallita, la P7 di oggi) non si tocca
 * MAI: il motivo è la parola dell'utente o del sistema, e vale più del test.
 */
export function repairHttpOffWithFirstOk(servers: McpServerConfig[], ok: ReadonlySet<string>): { servers: McpServerConfig[]; changed: boolean; repaired: Array<{ id: string; name: string }> } {
  let changed = false
  const repaired: Array<{ id: string; name: string }> = []
  const out = servers.map((s) => {
    if (s.transport !== 'http' || s.enabled || s.firstOkAt === undefined || s.disabledReason !== undefined) return s
    if (!ok.has(s.id)) return s
    changed = true
    const { disabledReason: _r, ...rest } = s
    repaired.push({ id: s.id, name: s.name })
    return { ...rest, enabled: true }
  })
  return { servers: out, changed, repaired }
}

/**
 * V4 (runner, una tantum al primo avvio dopo la fase): testa i server http
 * spenti con firstOkAt e senza motivo, e riaccende quelli che rispondono —
 * una riga di log per ciascuno, mai dati sensibili. Idempotente per flag.
 */
export async function runHttpOffFirstOkRepair(deps?: HttpMigrationsDeps): Promise<void> {
  const d = deps ?? (await realHttpDeps())
  if (d.getFlag(MCP_HTTP_OFF_REPAIR_FLAG)) return
  const servers = d.getServers()
  const candidates = servers.filter((s) => s.transport === 'http' && !s.enabled && s.firstOkAt !== undefined && s.disabledReason === undefined)
  const ok = new Set<string>()
  for (const c of candidates) {
    try {
      if ((await d.testServer(c.id)).ok) ok.add(c.id)
    } catch {
      // non risponde: resta spento
    }
  }
  const { servers: out, changed, repaired } = repairHttpOffWithFirstOk(servers, ok)
  if (changed) {
    d.saveServers(out)
    for (const r of repaired) d.log(`[sandbotd] riparazione server http: "${r.name}" riacceso — funziona (firstOkAt) ma era stato spento dalla migrazione P7`)
  }
  d.setFlag(MCP_HTTP_OFF_REPAIR_FLAG)
}
