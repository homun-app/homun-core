// Installazione dei server del registro e dei plugin (fase 13, punti 2, 4 e
// 7): il BOT propone (card in chat costruite in CODICE, niente testo del
// modello tranne `reason`) e l'installazione parte SOLO dal click
// dell'utente, mai dal modello e mai con "sempre". Regole di sicurezza:
// - i server stdio (registro npm, plugin) girano NEL BOX via docker exec,
//   MAI sul Mac; in modalità host la card li mostra col bottone disattivato;
// - pypi/oci/altro e le sorgenti npm/archive/command non si installano;
// - i segreti (chiavi, header, userConfig sensibili, variabili d'ambiente)
//   vivono SOLO nello store cifrato: mai in argv, mai nella chat;
// - di un plugin si importano SOLO skill e server MCP: hook, bin/, monitor,
//   LSP e compagnie non si eseguono mai (l'ispezione li elenca come ignorati).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SendMessagePayload } from '../../shared/types'
import type { McpServerConfig } from '../mcp'
import { boxHomePath } from '../sandbox/docker-argv'
import { createOAuthProvider, authorizeWithLoopback } from './oauth-provider'
import type { ConnectorsSecretStore } from './sealed-store'
import {
  findRegistryEntry, registryEnvVars, registryRuntime, registrySiteUrl, registryTrust,
  type RegistryEntry
} from './registry'
import {
  inspectPlugin, sourceSupported, stagePlugin, substitutePluginRoot, substituteUserConfig, userConfigKeysOf,
  type MarketplacePlugin, type PluginInspection, type PluginMcpServer
} from './marketplace'
import type { MarketplaceManager } from './marketplace-manager'
import gatewayPresetsJson from './gateway-presets.json'

type McpServerCard = Extract<SendMessagePayload, { type: 'mcp-server' }>
type PluginCard = Extract<SendMessagePayload, { type: 'plugin' }>

export const PROPOSAL_RESULT =
  'proposta mostrata all\'utente; quando la accetta ricevi un messaggio di sistema'

/** L'avviso per i server pubblicati da terzi (fiducia ≠ dominio verificato). */
export const THIRD_PARTY_SERVER_WARNING =
  'Server pubblicato da terzi: può leggere e fare quello che gli permettono i suoi strumenti'

/** Il bottone dei server stdio in modalità host. */
export const HOST_MODE_DISABLED =
  'si installa solo nel computer dei bot (modalità docker)'

/** L'avviso fisso del modulo Gateway (punto 7). */
export const GATEWAY_WARNING =
  'Un gateway custodisce l\'accesso a tutte le app che colleghi lì: è un servizio di terzi'

/** I preset dei gateway come DATI: compilano solo nome, header e testo d'aiuto. */
export interface GatewayPreset {
  id: string
  name: string
  auth: 'header' | 'bearer' | 'url'
  headerName?: string
  help: string
}
export const GATEWAY_PRESETS = gatewayPresetsJson as GatewayPreset[]

/** Un'id di server del registro o un URL proposto dal modello. */
export function parseMcpServerId(id: string): { kind: 'registry'; name: string } | { kind: 'url'; url: string } | { error: string } {
  if (id.startsWith('registry:')) {
    const name = id.slice('registry:'.length)
    return name ? { kind: 'registry', name } : { error: 'id registry: senza nome' }
  }
  if (id.startsWith('url:')) {
    const url = id.slice('url:'.length)
    if (!/^https:\/\//.test(url)) return { error: `l'URL deve essere https: ${url}` }
    return { kind: 'url', url }
  }
  return { error: 'id non valido: usa registry:<nome> (da search_connectors) oppure url:https://…' }
}

/** Le dipendenze dell'installatore (tutto iniettabile per i test). */
export interface InstallDeps {
  store: ConnectorsSecretStore
  marketplaces: Pick<MarketplaceManager, 'findPlugin' | 'cloneOf' | 'list'>
  /** cerca la voce ESATTA nel registro (fetch iniettabile) */
  findRegistryEntry(name: string): Promise<RegistryEntry | null>
  listServers(): McpServerConfig[]
  saveServers(s: McpServerConfig[]): void
  /** connette il server e lista i tool (throwa su 401/errore) */
  toolsOfServer(id: string): Promise<Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>>
  openExternal(url: string): Promise<void>
  hasUi(): boolean
  dockerMode(): boolean
  /** la dir dati dell'installazione (<dataDir>/plugins/…) */
  dataDir(): string
  /** runner docker (cp/chmod/rm nel box), iniettabile */
  runDocker?(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  /** URL del Client ID Metadata Document ospitato dall'utente (punto 6) */
  clientMetadataUrl?(): string
  onChange(): void
  now?(): number
}

/**
 * buildMcpServerCard (punto 2): la card "Aggiungi server MCP", TUTTA in
 * codice. pypi/oci/altro → NESSUNA card (l'errore torna al modello); stdio in
 * modalità host → card col bottone disattivato.
 */
export async function buildMcpServerCard(
  id: string,
  reason: string,
  deps: InstallDeps
): Promise<{ ok: true; card: McpServerCard } | { ok: false; error: string }> {
  const parsed = parseMcpServerId(id)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  if (parsed.kind === 'url') {
    const host = new URL(parsed.url).host
    return {
      ok: true,
      card: {
        type: 'mcp-server', id, name: host, publisher: host,
        trust: 'non verificato', trustKind: 'unverified',
        runtime: { kind: 'remote', host },
        needs: { kind: 'oauth' },
        thirdPartyWarning: true,
        ...(reason ? { reason } : {})
      }
    }
  }
  const entry = await deps.findRegistryEntry(parsed.name)
  if (!entry) return { ok: false, error: `voce del registro non trovata: ${parsed.name} (cerca l'id esatto con search_connectors)` }
  const rt = registryRuntime(entry)
  if (rt === null) return { ok: false, error: 'non installabile qui: la voce non espone né remotes né pacchetti npm' }
  if (rt.kind === 'not-installable') return { ok: false, error: `non installabile qui: tipo ${rt.registryType}` }
  const trust = registryTrust(entry.server.name)
  const base = {
    type: 'mcp-server' as const,
    id: `registry:${entry.server.name}`,
    name: entry.server.name.split('/').pop() ?? entry.server.name,
    publisher: entry.server.name.includes('/') ? entry.server.name.slice(0, entry.server.name.indexOf('/')) : undefined,
    trust: trust.label,
    trustKind: trust.kind === 'verified-domain' ? 'verified-domain' as const : trust.kind === 'github-account' ? 'github-account' as const : 'unverified' as const,
    ...(registrySiteUrl(entry) ? { siteUrl: registrySiteUrl(entry)! } : {}),
    ...(reason ? { reason } : {})
  }
  if (rt.kind === 'remote') {
    return {
      ok: true,
      card: {
        ...base,
        runtime: { kind: 'remote', host: new URL(rt.url).host },
        needs: rt.secretHeader ? { kind: 'key', header: rt.secretHeader } : { kind: 'oauth' },
        ...(trust.kind !== 'verified-domain' ? { thirdPartyWarning: true as const } : {})
      }
    }
  }
  // npm stdio: gira NEL BOX; in host il bottone è disattivato
  return {
    ok: true,
    card: {
      ...base,
      runtime: { kind: 'box-npm', command: `npx -y ${rt.identifier}@${rt.version}` },
      needs: { kind: 'env', vars: registryEnvVars(entry) },
      ...(trust.kind !== 'verified-domain' ? { thirdPartyWarning: true as const } : {}),
      ...(deps.dockerMode() ? {} : { disabledReason: HOST_MODE_DISABLED })
    }
  }
}

/** Server id e nome deterministici per una voce del registro. */
function registryServerCfg(entry: RegistryEntry, agentId: string, deps: InstallDeps): McpServerConfig {
  const name = entry.server.name.split('/').pop() ?? entry.server.name
  const rt = registryRuntime(entry)
  if (rt === null || rt.kind === 'not-installable') throw new Error('voce del registro non installabile')
  const trust = registryTrust(entry.server.name)
  if (rt.kind === 'remote') {
    return {
      id: `registry-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name, transport: 'http', url: rt.url, enabled: true,
      auth: rt.secretHeader ? { kind: 'headers' } : { kind: 'oauth' },
      enabledFor: [agentId],
      source: { kind: 'registry', name: entry.server.name, ...(entry.server.version ? { version: entry.server.version } : {}) },
      trustLabel: trust.label
    }
  }
  const vars = registryEnvVars(entry)
  return {
    id: `registry-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name, transport: 'stdio', enabled: true,
    box: {
      workdir: boxHomePath(agentId),
      command: 'npx',
      args: ['-y', `${rt.identifier}@${rt.version}`],
      envKeys: vars.map((v) => v.name)
    },
    enabledFor: [agentId],
    source: { kind: 'registry', name: entry.server.name, ...(entry.server.version ? { version: entry.server.version } : {}) },
    trustLabel: trust.label
  }
}

/** Il messaggio di esito per il bot: "Server X aggiunto: N strumenti (lettura: a, scrittura: b)". */
export function serverInstalledMessage(name: string, tools: Array<{ annotations?: { readOnlyHint?: boolean } }>): string {
  const read = tools.filter((t) => t.annotations?.readOnlyHint === true).length
  return `Server ${name} aggiunto: ${tools.length} strumenti (lettura: ${read}, scrittura: ${tools.length - read})`
}

/**
 * installMcpServer (punto 2, su Aggiungi — codice del daemon, mai del
 * modello): regola 1 remoto senza header (OAuth al 401), regola 2 remoto con
 * header isSecret (needs_auth + modulo chiavi), regola 3 npm stdio (solo
 * docker, nel box, env dallo store cifrato).
 */
export async function installMcpServer(
  card: McpServerCard,
  agentId: string,
  deps: InstallDeps
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const parsed = parseMcpServerId(card.id)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  if (parsed.kind === 'url') {
    const cfg: McpServerConfig = {
      id: `url-${new URL(parsed.url).host.replace(/[^a-z0-9.-]+/gi, '-')}`,
      name: new URL(parsed.url).host, transport: 'http', url: parsed.url, enabled: true,
      auth: { kind: 'oauth' }, enabledFor: [agentId],
      source: { kind: 'registry', name: parsed.url },
      trustLabel: 'non verificato'
    }
    return finishRemoteInstall(cfg, deps)
  }
  const entry = await deps.findRegistryEntry(parsed.name)
  if (!entry) return { ok: false, error: `voce del registro non trovata: ${parsed.name}` }
  const rt = registryRuntime(entry)
  if (rt === null || rt.kind === 'not-installable') return { ok: false, error: 'non installabile qui' }
  const cfg = registryServerCfg(entry, agentId, deps)
  if (rt.kind === 'box-npm') {
    if (!deps.dockerMode()) return { ok: false, error: HOST_MODE_DISABLED }
    // le env obbligatorie chiedono il valore nelle Impostazioni PRIMA del
    // primo avvio; le facoltative passano solo se l'utente le ha compilate
    const saved = (await deps.store.read<Record<string, string>>(cfg.id, 'env')) ?? {}
    const missing = registryEnvVars(entry).filter((v) => v.required && !saved[v.name]).map((v) => v.name)
    if (missing.length) {
      cfg.needsAuth = { kind: 'env', keys: missing }
      deps.saveServers([...deps.listServers().filter((s) => s.id !== cfg.id), cfg])
      deps.onChange()
      return { ok: true, message: `Server ${cfg.name} registrato, ma prima di avviarlo servono le variabili ${missing.join(', ')}: l'utente le inserisce nelle Impostazioni.` }
    }
    deps.saveServers([...deps.listServers().filter((s) => s.id !== cfg.id), cfg])
    deps.onChange()
    try {
      const tools = await deps.toolsOfServer(cfg.id)
      return { ok: true, message: serverInstalledMessage(cfg.name, tools) }
    } catch (e) {
      return { ok: false, error: `Server ${cfg.name} registrato ma non parte: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  // remoto: regola 1 (OAuth) o regola 2 (header isSecret)
  if (rt.secretHeader) {
    const saved = (await deps.store.read<Record<string, string>>(cfg.id, 'staticHeaders')) ?? {}
    if (!saved[rt.secretHeader]) cfg.needsAuth = { kind: 'key', keys: [rt.secretHeader] }
    deps.saveServers([...deps.listServers().filter((s) => s.id !== cfg.id), cfg])
    deps.onChange()
    if (cfg.needsAuth) {
      return { ok: true, message: `Server ${cfg.name} registrato: serve la chiave (${rt.secretHeader}), l'utente la inserisce nelle Impostazioni.` }
    }
    try {
      const tools = await deps.toolsOfServer(cfg.id)
      return { ok: true, message: serverInstalledMessage(cfg.name, tools) }
    } catch (e) {
      return { ok: false, error: `Server ${cfg.name} registrato ma non risponde: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return finishRemoteInstall(cfg, deps)
}

/** Regola 1: remoto senza header — connessione; su 401 il flusso OAuth (fase 5 + punto 6). */
async function finishRemoteInstall(cfg: McpServerConfig, deps: InstallDeps): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  deps.saveServers([...deps.listServers().filter((s) => s.id !== cfg.id), cfg])
  deps.onChange()
  try {
    const tools = await deps.toolsOfServer(cfg.id)
    return { ok: true, message: serverInstalledMessage(cfg.name, tools) }
  } catch {
    // 401 o connessione rifiutata: flusso OAuth col loopback e iss verificato
    if (!deps.hasUi()) {
      return { ok: false, error: `Server ${cfg.name} registrato: serve l'accesso con il tuo account (OAuth). Apri la finestra di SandBot e riavvia la connessione dalle Impostazioni.` }
    }
    try {
      await authorizeWithLoopback(cfg.url!, (redirectUrl, stateFactory) =>
        createOAuthProvider(
          {
            serverId: cfg.id, redirectUrl, openExternal: deps.openExternal, store: deps.store, stateFactory,
            ...(deps.clientMetadataUrl?.() ?? '' ? { clientMetadataUrl: deps.clientMetadataUrl!() } : {})
          }
        )
      )
      const tools = await deps.toolsOfServer(cfg.id)
      return { ok: true, message: serverInstalledMessage(cfg.name, tools) }
    } catch (e) {
      return { ok: false, error: `Server ${cfg.name}: autorizzazione non riuscita (${e instanceof Error ? e.message : String(e)})` }
    }
  }
}

// ---- plugin (punto 4) ----

/** Il registro dei plugin installati (settings). */
export interface InstalledPlugin {
  name: string
  marketplace: string
  marketplaceSource: string
  sha: string
  sha12: string
  /** path della cartella del plugin, RELATIVO a dataDir */
  dir: string
  /** path della copia nel box (solo docker) */
  boxDir?: string
  skills: Array<{ name: string; description: string; dir: string }>
  /** id dei server MCP registrati */
  servers: string[]
  enabledFor: string[]
  installedAt: number
}

export const PLUGINS_SETTING = 'connectors.plugins'

export function installedPlugins(deps: { getSetting<T>(key: string, fallback: T): T }): InstalledPlugin[] {
  return deps.getSetting<InstalledPlugin[]>(PLUGINS_SETTING, [])
}

/** Le proposte di plugin in attesa della decisione (staging vivo). */
interface PendingPlugin {
  plugin: MarketplacePlugin
  marketplaceName: string
  marketplaceSource: string
  staging: string
  sha: string
  sha12: string
  inspection: PluginInspection
  /** clone interi del marketplace fatti per le sorgenti relative (da pulire) */
  extraDirs: string[]
}
const pendingPlugins = new Map<string, PendingPlugin>()

/** Il path del box di un plugin installato: /box/plugins/<mp>/<nome>/<sha12>. */
export function pluginBoxDir(marketplace: string, name: string, sha12: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-')
  return `/box/plugins/${clean(marketplace)}/${clean(name)}/${sha12}`
}

/**
 * buildPluginCard (punto 4): PRIMA della card il daemon scarica il plugin in
 * STAGING e lo ispeziona, per mostrare cosa contiene DAVVERO. Sorgenti
 * npm/archive/command → NESSUNA card. Lo staging resta in attesa del click.
 */
/** Il flag di test della verifica d'integrazione: repo git locali su file:// (in produzione MAI). */
const testCloneDeps = (): { allowFileUrlsForTests?: boolean } =>
  process.env.SANDBOT_TEST_ALLOW_FILE_URLS === '1' ? { allowFileUrlsForTests: true } : {}

export async function buildPluginCard(
  id: string,
  reason: string,
  deps: InstallDeps,
  cloneDeps: { allowFileUrlsForTests?: boolean } = testCloneDeps()
): Promise<{ ok: true; card: PluginCard } | { ok: false; error: string }> {
  const found = await deps.marketplaces.findPlugin(id)
  if (!found) return { ok: false, error: `plugin non trovato: ${id} (cerca l'id esatto con search_connectors)` }
  const { plugin } = found
  if (!sourceSupported(plugin.source)) {
    return { ok: false, error: `sorgente ${plugin.source.kind} non supportata` }
  }
  const marketplaceName = (await marketplaceOf(deps, id)) ?? ''
  let cloneDir = deps.marketplaces.cloneOf(found.reg.source)
  const extraDirs: string[] = []
  // il clone del CATALOGO è sparsO (solo .claude-plugin/): una sorgente
  // RELATIVA vive nell'albero intero del marketplace — clone depth 1 con le
  // STESSE regole sicure (hook off, no submoduli, tetti, https only)
  if (plugin.source.kind === 'relative') {
    const url = found.reg.kind === 'github' ? githubRepoUrlOf(found.reg.source) : found.reg.source
    const full = await stagePlugin({ kind: 'url', url }, null, cloneDeps)
    if (full.ok) {
      cloneDir = full.dir
      extraDirs.push(full.dir)
    }
  }
  const staged = await stagePlugin(plugin.source, cloneDir, cloneDeps)
  if (!staged.ok) return { ok: false, error: `download del plugin non riuscito: ${staged.error}` }
  const inspection = inspectPlugin(staged.dir)
  if (inspection.errors.length) {
    rmSync(staged.dir, { recursive: true, force: true })
    return { ok: false, error: `il plugin contiene percorsi o file non validi: ${inspection.errors[0]}` }
  }
  pendingPlugins.set(id, {
    plugin,
    marketplaceName,
    marketplaceSource: found.reg.source,
    staging: staged.dir,
    sha: staged.sha,
    sha12: staged.sha12,
    inspection,
    extraDirs
  })
  const card: PluginCard = {
    type: 'plugin',
    id,
    name: inspection.name ?? plugin.name,
    marketplace: marketplaceName,
    trust: found.reg.official ? 'marketplace ufficiale' : 'marketplace aggiunto da te',
    ...(repoUrlOf(plugin) ? { repoUrl: repoUrlOf(plugin)! } : {}),
    sha12: staged.sha12,
    skills: inspection.skills.map((s) => s.name),
    servers: inspection.mcpServers.map((s) => ({ name: s.name, runtimeLabel: serverRuntimeLabel(s) })),
    settings: inspection.userConfig.map((f) => ({ key: f.key, ...(f.description ? { description: f.description } : {}), ...(f.sensitive ? { sensitive: true } : {}) })),
    ignored: inspection.ignored,
    ...(reason ? { reason } : {})
  }
  return { ok: true, card }
}

/** L'URL github di una sorgente marketplace (owner/repo o url diretta). */
function githubRepoUrlOf(source: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}.git` : source
}

/** Il nome del marketplace di un id plugin:<nome>@<marketplace>. */
async function marketplaceOf(deps: InstallDeps, id: string): Promise<string | null> {
  const rest = id.startsWith('plugin:') ? id.slice('plugin:'.length) : id
  const at = rest.lastIndexOf('@')
  if (at <= 0) return null
  return rest.slice(at + 1)
}

function repoUrlOf(plugin: MarketplacePlugin): string | null {
  const s = plugin.source
  if (s.kind === 'github') return `https://github.com/${s.repo.replace(/^github:/, '').replace(/\.git$/, '')}`
  if (s.kind === 'url' || s.kind === 'git-subdir') return s.url
  return null
}

function serverRuntimeLabel(s: PluginMcpServer): string {
  if (s.url) return `remoto (${new URL(s.url).host})`
  return `nel box (${[s.command, ...(s.args ?? [])].slice(0, 3).join(' ')})`
}

/**
 * installPlugin (su Installa — codice del daemon): lo staging si sposta in
 * <dataDir>/plugins/<marketplace>/<nome>/<sha12>/ e (in docker) si copia nel
 * box in SOLA LETTURA; i server MCP si registrano (http come punto 2, stdio
 * nel box); il plugin è abilitato per il bot che l'ha proposto.
 */
export async function installPlugin(
  card: PluginCard,
  agentId: string,
  deps: InstallDeps,
  setSetting: (key: string, value: unknown) => void,
  getSetting: <T>(key: string, fallback: T) => T,
  cloneDeps: { allowFileUrlsForTests?: boolean } = testCloneDeps()
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  let pending = pendingPlugins.get(card.id)
  if (!pending) {
    // daemon riavviato (o proposta vecchia): si ri-scarica lo stesso plugin
    const rebuilt = await buildPluginCard(card.id, '', deps, cloneDeps)
    if (!rebuilt.ok) return { ok: false, error: `ri-download del plugin non riuscito: ${rebuilt.error}` }
    pending = pendingPlugins.get(card.id)!
  }
  const dest = join(deps.dataDir(), 'plugins', pending.marketplaceName, pending.plugin.name, pending.sha12)
  mkdirSync(dest, { recursive: true })
  // .git NON si copia: i pack file sono read-only e nel plugin installato non serve
  cpSync(pending.staging, dest, { recursive: true, filter: (src) => !src.includes('/.git') })
  rmSync(pending.staging, { recursive: true, force: true })
  for (const d of pending.extraDirs) rmSync(d, { recursive: true, force: true })
  pendingPlugins.delete(card.id)

  // copia nel box, SOLA LETTURA per l'utente 1000 (solo docker)
  const boxDir = pluginBoxDir(pending.marketplaceName, pending.plugin.name, pending.sha12)
  if (deps.dockerMode() && deps.runDocker) {
    const run = deps.runDocker
    const { dockerCpDirArgv, dockerChmodReadOnlyArgv } = await import('../sandbox/docker-argv')
    const cp = await run(dockerCpDirArgv(dest, boxDir))
    if (cp.code === 0) await run(dockerChmodReadOnlyArgv(boxDir))
  }

  // i server MCP del plugin: http come il punto 2; stdio nel box con
  // ${CLAUDE_PLUGIN_ROOT} = il path del box e ${user_config.KEY} risolto
  // SOLO in env/headers/url al momento della connessione (dallo store cifrato)
  const serverIds: string[] = []
  const settingsKeys: string[] = []
  for (const s of pending.inspection.mcpServers) {
    const serverId = `plugin-${pending.plugin.name}-${s.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)
    const uck = userConfigKeysOf(s)
    const values = (await deps.store.read<Record<string, string>>(serverId, 'userConfig')) ?? {}
    const missingKeys = uck.filter((k) => !(k in values))
    settingsKeys.push(...missingKeys)
    if (s.url) {
      const cfg: McpServerConfig = {
        id: serverId, name: s.name, transport: 'http', url: s.url, enabled: true,
        auth: { kind: 'oauth' }, enabledFor: [agentId],
        source: { kind: 'plugin', plugin: pending.plugin.name, marketplace: pending.marketplaceName, sha: pending.sha12 }
      }
      if (s.headers && Object.keys(s.headers).length) cfg.auth = { kind: 'headers' }
      if (missingKeys.length) cfg.needsAuth = { kind: 'settings', keys: missingKeys }
      deps.saveServers([...deps.listServers().filter((x) => x.id !== serverId), cfg])
      serverIds.push(serverId)
    } else if (s.command) {
      const cfg: McpServerConfig = {
        id: serverId, name: s.name, transport: 'stdio', enabled: true,
        box: {
          workdir: boxDir,
          command: substitutePluginRoot(s.command, boxDir),
          args: (s.args ?? []).map((a) => substitutePluginRoot(a, boxDir)),
          envKeys: Object.keys(s.env ?? {})
        },
        enabledFor: [agentId],
        source: { kind: 'plugin', plugin: pending.plugin.name, marketplace: pending.marketplaceName, sha: pending.sha12 }
      }
      if (missingKeys.length) cfg.needsAuth = { kind: 'settings', keys: missingKeys }
      deps.saveServers([...deps.listServers().filter((x) => x.id !== serverId), cfg])
      serverIds.push(serverId)
    }
  }

  const record: InstalledPlugin = {
    name: pending.plugin.name,
    marketplace: pending.marketplaceName,
    marketplaceSource: pending.marketplaceSource,
    sha: pending.sha,
    sha12: pending.sha12,
    dir: join('plugins', pending.marketplaceName, pending.plugin.name, pending.sha12),
    ...(deps.dockerMode() ? { boxDir } : {}),
    skills: pending.inspection.skills,
    servers: serverIds,
    enabledFor: [agentId],
    installedAt: (deps.now ?? Date.now)()
  }
  setSetting(PLUGINS_SETTING, [...installedPlugins({ getSetting }).filter((p) => !(p.name === record.name && p.marketplace === record.marketplace)), record])
  deps.onChange()
  const parts = [
    `${pending.inspection.skills.length} skill`,
    `${serverIds.length} server${serverIds.length ? ` (${serverIds.map((id) => deps.listServers().find((x) => x.id === id)?.name ?? id).join(', ')})` : ''}`
  ]
  if (settingsKeys.length) parts.push(`da configurare: ${settingsKeys.join(', ')} (Impostazioni)`)
  return { ok: true, message: `Plugin ${record.name} installato: ${parts.join(', ')}` }
}

/** Disinstallazione (solo dalle Impostazioni): cartelle (Mac e box), server, skill. I dati dell'utente NON si toccano. */
export async function uninstallPlugin(
  record: InstalledPlugin,
  deps: InstallDeps,
  setSetting: (key: string, value: unknown) => void,
  getSetting: <T>(key: string, fallback: T) => T
): Promise<void> {
  const dir = join(deps.dataDir(), record.dir)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  if (record.boxDir && deps.dockerMode() && deps.runDocker) {
    // argv PURO sul path esatto della NOSTRA copia (mai volumi, mai dati utente)
    const { dockerRmDirArgv } = await import('../sandbox/docker-argv')
    await deps.runDocker(dockerRmDirArgv(record.boxDir))
  }
  deps.saveServers(deps.listServers().filter((s) => !record.servers.includes(s.id)))
  setSetting(PLUGINS_SETTING, installedPlugins({ getSetting }).filter((p) => !(p.name === record.name && p.marketplace === record.marketplace)))
  await deps.store.removeAll(`plugin-${record.name}`).catch(() => undefined)
  deps.onChange()
}

/** Le skill di un plugin installato per il prompt e il tool skill (lettura). */
export function pluginSkillBody(record: InstalledPlugin, dataDir: string, skillName: string): string | null {
  const rel = record.skills.find((s) => s.name === skillName)?.dir
  if (!rel) return null
  try {
    return readFileSync(join(dataDir, record.dir, rel, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
}

// ---- gateway (punto 7) ----

export interface GatewayInput {
  name: string
  url: string
  auth: 'oauth' | 'bearer' | 'headers'
  preset?: string
  headerName?: string
  /** valori CIFRATI nello store (mai nei settings in chiaro) */
  bearerToken?: string
  headers?: Record<string, string>
}

/**
 * addGateway (punto 7): il modulo delle Impostazioni chiama QUI — il BOT non
 * può creare gateway (nessun tool). Preset come DATI: compilano nome, header
 * e testo d'aiuto; NESSUNA chiamata alle API dei fornitori.
 */
export async function addGateway(input: GatewayInput, deps: InstallDeps): Promise<McpServerConfig> {
  // https in produzione; http locale SOLO col flag di test della verifica
  const urlOk = /^https:\/\//.test(input.url) || (process.env.SANDBOT_TEST_ALLOW_HTTP_REMOTES === '1' && input.url.startsWith('http://'))
  if (!urlOk) throw new Error('l\'URL del gateway deve essere https')
  if (!input.name.trim()) throw new Error('serve un nome per il gateway')
  const id = `gateway-${input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const cfg: McpServerConfig = {
    id, name: input.name.trim(), transport: 'http', url: input.url, enabled: true,
    ...(input.auth === 'bearer' ? { auth: { kind: 'bearer' as const } } : {}),
    ...(input.auth === 'headers' ? { auth: { kind: 'headers' as const } } : {}),
    ...(input.auth === 'oauth' ? { auth: { kind: 'oauth' as const } } : {}),
    // il gateway lo aggiunge l'utente per i SUOI bot: abilitato a tutti
    enabledFor: ['*'],
    source: { kind: 'gateway', ...(input.preset ? { preset: input.preset } : {}) }
  }
  if (input.bearerToken) await deps.store.write(id, 'bearer', input.bearerToken)
  if (input.headers && Object.keys(input.headers).length) await deps.store.write(id, 'staticHeaders', input.headers)
  deps.saveServers([...deps.listServers().filter((s) => s.id !== id), cfg])
  deps.onChange()
  return cfg
}

/** La sostituzione di ${user_config.KEY} in env/headers/url DI UN SERVER PLUGIN al momento della connessione (puro). */
export function resolvePluginServerPlaceholders(
  server: PluginMcpServer,
  values: Record<string, string>,
  boxPath: string
): { url?: string; headers?: Record<string, string>; env?: Record<string, string> } {
  const out: { url?: string; headers?: Record<string, string>; env?: Record<string, string> } = {}
  if (server.url) out.url = substituteUserConfig(server.url, values)
  if (server.headers) {
    const h: Record<string, string> = {}
    for (const [k, v] of Object.entries(server.headers)) h[k] = substituteUserConfig(v, values)
    out.headers = h
  }
  if (server.env) {
    const e: Record<string, string> = {}
    for (const [k, v] of Object.entries(server.env)) e[k] = substitutePluginRoot(substituteUserConfig(v, values), boxPath)
    out.env = e
  }
  return out
}

export { findRegistryEntry }
