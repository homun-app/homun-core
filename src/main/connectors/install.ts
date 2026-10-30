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
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SendMessagePayload, SecretKind } from '../../shared/types'
import { SECRET_KIND } from '../../shared/types'
import type { McpServerConfig } from '../mcp'
import { boxHomePath, dockerRmDirArgv } from '../sandbox/docker-argv'
import { createOAuthProvider, authorizeWithLoopback } from './oauth-provider'
import type { ConnectorsSecretStore } from './sealed-store'
import {
  findRegistryEntry, registryEnvVars, registryRuntime, registrySiteUrl, registryTrust,
  type RegistryEntry
} from './registry'
import {
  argvPlaceholdersOf, inspectPlugin, sourceSupported, stagePlugin, substitutePluginRoot, substituteUserConfig, userConfigKeysOf,
  type MarketplacePlugin, type PluginInspection, type PluginMcpServer
} from './marketplace'
import type { MarketplaceManager } from './marketplace-manager'
import gatewayPresetsJson from './gateway-presets.json'

// L1: un solo nome per ogni tipo di segreto (chiave logica UI/RPC → chiave dello
// store cifrato); anche la UI e l'RPC usano QUESTE costanti, mai stringhe separate
export { SECRET_KIND } from '../../shared/types'
export type { SecretKind } from '../../shared/types'

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
  /** flusso OAuth col callback di loopback (default: authorizeWithLoopback); iniettabile nei test */
  authorize?: typeof authorizeWithLoopback
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
    // L2: il nome mostrato è quello COMPLETO del registro (com.notion/mcp),
    // non l'ultimo segmento: "Server mcp aggiunto" non distingueva nulla
    name: entry.server.name,
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

/**
 * L2: l'id deterministico di un server — prefisso della fonte, nome sanificato
 * (max 40) e i primi 8 hex di sha256 della CHIAVE ESATTA. L'ultimo segmento del
 * nome del registro non basta: nel registro vero ~55 voci su 300 finiscono in
 * "/mcp" e `registry-mcp` se le scambierebbe (con la chiave dell'una addosso
 * all'altra). Chiave esatta: nome completo (registro), URL normalizzato (url e
 * gateway), marketplace/plugin/server (plugin).
 */
export type ServerIdSource =
  | { kind: 'registry'; name: string }
  | { kind: 'url'; url: string }
  | { kind: 'plugin'; marketplace: string; plugin: string; server: string }
  | { kind: 'gateway'; name: string; url: string }

/** L'URL normalizzato (href canonico) che identifica una sorgente url/gateway. */
function normalizedUrl(url: string): string {
  return new URL(url).href
}

export function serverIdFor(src: ServerIdSource): string {
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server'
  const key = src.kind === 'registry'
    ? src.name
    : src.kind === 'plugin'
      ? `${src.marketplace}/${src.plugin}/${src.server}`
      : normalizedUrl(src.url)
  const label = src.kind === 'registry'
    ? src.name
    : src.kind === 'url'
      ? new URL(src.url).host
      : src.kind === 'plugin'
        ? `${src.plugin}-${src.server}`
        : src.name
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8)
  return `${src.kind}-${clean(label)}-${hash}`
}

/**
 * L2: mai sostituire in silenzio. Un id che esiste già è un AGGIORNAMENTO solo
 * se la fonte è la stessa (la config si riscrive, i segreti restano); da una
 * fonte diversa è un errore — cintura di sicurezza: con l'hash non deve
 * succedere mai.
 */
export function serverSlotError(existing: McpServerConfig[], next: McpServerConfig): string | null {
  const cur = existing.find((s) => s.id === next.id)
  if (!cur) return null
  if ((cur.source?.kind ?? 'manual') === (next.source?.kind ?? 'manual')) return null
  return `esiste già un server con questo id (${next.id}): fonte ${cur.source?.kind ?? 'manuale'} diversa da ${next.source?.kind ?? 'manuale'}`
}

/** L2: registra una config — stesso id e stessa fonte = aggiornamento, fonte diversa = errore. */
function saveServerCfg(cfg: McpServerConfig, deps: InstallDeps): string | null {
  const err = serverSlotError(deps.listServers(), cfg)
  if (err) return err
  deps.saveServers([...deps.listServers().filter((s) => s.id !== cfg.id), cfg])
  return null
}

/** Server id e nome (COMPLETO: L2) per una voce del registro. */
function registryServerCfg(entry: RegistryEntry, agentId: string): McpServerConfig {
  const rt = registryRuntime(entry)
  if (rt === null || rt.kind === 'not-installable') throw new Error('voce del registro non installabile')
  const trust = registryTrust(entry.server.name)
  const id = serverIdFor({ kind: 'registry', name: entry.server.name })
  if (rt.kind === 'remote') {
    return {
      id,
      name: entry.server.name, transport: 'http', url: rt.url, enabled: true,
      auth: rt.secretHeader ? { kind: 'headers' } : { kind: 'oauth' },
      enabledFor: [agentId],
      source: { kind: 'registry', name: entry.server.name, ...(entry.server.version ? { version: entry.server.version } : {}) },
      trustLabel: trust.label
    }
  }
  const vars = registryEnvVars(entry)
  return {
    id,
    name: entry.server.name, transport: 'stdio', enabled: true,
    box: {
      workdir: boxHomePath(agentId),
      home: boxHomePath(agentId),
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
      id: serverIdFor({ kind: 'url', url: parsed.url }),
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
  if (rt === null || rt.kind === 'not-installable') {
    return { ok: false, error: rt?.kind === 'not-installable' ? `non installabile qui: ${rt.reason ?? `tipo ${rt.registryType}`}` : 'non installabile qui' }
  }
  const cfg = registryServerCfg(entry, agentId)
  const slot = saveServerCfg(cfg, deps)
  if (slot) return { ok: false, error: slot }
  if (rt.kind === 'box-npm') {
    if (!deps.dockerMode()) return { ok: false, error: HOST_MODE_DISABLED }
    // le env obbligatorie chiedono il valore nelle Impostazioni PRIMA del
    // primo avvio; le facoltative passano solo se l'utente le ha compilate
    const saved = (await deps.store.read<Record<string, string>>(cfg.id, SECRET_KIND.env)) ?? {}
    const missing = registryEnvVars(entry).filter((v) => v.required && !saved[v.name]).map((v) => v.name)
    if (missing.length) {
      cfg.needsAuth = { kind: 'env', keys: missing }
      deps.onChange()
      return { ok: true, message: `Server ${cfg.name} registrato, ma prima di avviarlo servono le variabili ${missing.join(', ')}: l'utente le inserisce nelle Impostazioni.` }
    }
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
    const saved = (await deps.store.read<Record<string, string>>(cfg.id, SECRET_KIND.headers)) ?? {}
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
      return { ok: false, error: `Server ${cfg.name} registrato: serve l'accesso con il tuo account (OAuth). Apri la finestra di Homun e riavvia la connessione dalle Impostazioni.` }
    }
    try {
      const authorize = deps.authorize ?? authorizeWithLoopback
      await authorize(cfg.url!, (redirectUrl, stateFactory) =>
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
  /** la cartella del PLUGIN nello staging (quella che si copia all'installazione) */
  staging: string
  /** la RADICE dello staging da cancellare (per git-subdir è il repo clonato) */
  stagingRoot: string
  /** cloni interi del marketplace fatti per le sorgenti relative (da pulire) */
  extraDirs: string[]
  sha: string
  sha12: string
  inspection: PluginInspection
  createdAt: number
}
const pendingPlugins = new Map<string, PendingPlugin>()

/** L7: una proposta non decisa si tiene al massimo 30 minuti, poi lo staging si cancella. */
export const PENDING_PLUGIN_TTL_MS = 30 * 60_000

/** Cancella lo staging di una proposta (radice + cloni del marketplace). */
function dropStaging(root: string, extraDirs: string[]): void {
  rmSync(root, { recursive: true, force: true })
  for (const d of extraDirs) rmSync(d, { recursive: true, force: true })
}

/** L7: le proposte più vecchie del TTL si cancellano (chiamata a ogni nuova card). */
function sweepPendingPlugins(now: number): void {
  for (const [id, p] of pendingPlugins) {
    if (now - p.createdAt > PENDING_PLUGIN_TTL_MS) {
      dropStaging(p.stagingRoot, p.extraDirs)
      pendingPlugins.delete(id)
    }
  }
}

/** L7: il "No" sulla card del plugin cancella lo staging e la proposta. */
export function discardPluginProposal(id: string): void {
  const p = pendingPlugins.get(id)
  if (!p) return
  dropStaging(p.stagingRoot, p.extraDirs)
  pendingPlugins.delete(id)
}

/**
 * M4: il path del plugin installato nel box: `/plugins/<mp>/<nome>/<sha12>`
 * dentro il volume DEDICATO `sandbot-plugins`, montato in SOLA LETTURA dal
 * kernel (`-v sandbot-plugins:/plugins:ro`). Non è più `/box/plugins/…`: il
 * volume /box è del bot (uid 1000) e il bot potrebbe rimpiazzare il codice
 * dei server stdio di terzi; qui il kernel nega la scrittura.
 */
export function pluginBoxDir(marketplace: string, name: string, sha12: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-')
  return `/plugins/${clean(marketplace)}/${clean(name)}/${sha12}`
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
  cloneDeps: { allowFileUrlsForTests?: boolean; mkdtemp?: (prefix: string) => string } = testCloneDeps()
): Promise<{ ok: true; card: PluginCard } | { ok: false; error: string }> {
  const found = await deps.marketplaces.findPlugin(id)
  if (!found) return { ok: false, error: `plugin non trovato: ${id} (cerca l'id esatto con search_connectors)` }
  const { plugin } = found
  if (!sourceSupported(plugin.source)) {
    return { ok: false, error: `sorgente ${plugin.source.kind} non supportata` }
  }
  // L7: le proposte vecchie non decise non tengono lo staging per sempre
  sweepPendingPlugins((deps.now ?? Date.now)())
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
    dropStaging(staged.root, extraDirs)
    return { ok: false, error: `il plugin contiene percorsi o file non validi: ${inspection.errors[0]}` }
  }
  // L7: una NUOVA proposta dello stesso plugin sostituisce la vecchia: lo
  // staging della vecchia si cancella subito (niente orfani in $TMPDIR)
  const previous = pendingPlugins.get(id)
  if (previous) dropStaging(previous.stagingRoot, previous.extraDirs)
  pendingPlugins.set(id, {
    plugin,
    marketplaceName,
    marketplaceSource: found.reg.source,
    staging: staged.dir,
    stagingRoot: staged.root,
    extraDirs,
    sha: staged.sha,
    sha12: staged.sha12,
    inspection,
    createdAt: (deps.now ?? Date.now)()
  })
  // M3: le impostazioni della card sono il userConfig del MANIFEST più le
  // chiavi OBBLIGATORIE usate dai server (${user_config.K} e ${VAR} senza
  // default) che il manifest non dichiara: github usa
  // ${GITHUB_PERSONAL_ACCESS_TOKEN} senza dichiararlo da nessuna parte
  const declared = new Set(inspection.userConfig.map((f) => f.key))
  const serverKeys = [...new Set(inspection.mcpServers.flatMap((s) => userConfigKeysOf(s)))]
    .filter((k) => !declared.has(k))
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
    settings: [
      ...inspection.userConfig.map((f) => ({ key: f.key, ...(f.description ? { description: f.description } : {}), ...(f.sensitive ? { sensitive: true } : {}) })),
      ...serverKeys.map((key) => ({ key }))
    ],
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

/** M3: il server con `${VAR}` in command/args non si registra: il motivo in card. */
function serverRuntimeLabel(s: PluginMcpServer): string {
  const argvVars = argvPlaceholdersOf(s)
  if (argvVars.length) return `non supportato: valore in argv (${argvVars[0]})`
  if (s.url) return `remoto (${new URL(s.url).host})`
  return `nel box (${[s.command, ...(s.args ?? [])].slice(0, 3).join(' ')})`
}

/**
 * installPlugin (su Installa — codice del daemon): lo staging si sposta in
 * <dataDir>/plugins/<marketplace>/<nome>/<sha12>/ e (in docker) si copia nel
 * box in SOLA LETTURA; i server MCP si registrano (http come punto 2, stdio
 * nel box); il plugin è abilitato per il bot che l'ha proposto.
 * L6: lo sha che si installa è QUELLO approvato nella card. L5: la copia nel
 * box è una sequenza controllata (container → mkdir → cp → chmod) e un passo
 * fallito blocca l'installazione — tranne i plugin di sole skill, per i quali
 * la copia nel box non serve.
 */
export async function installPlugin(
  card: PluginCard,
  agentId: string,
  deps: InstallDeps,
  setSetting: (key: string, value: unknown) => void,
  getSetting: <T>(key: string, fallback: T) => T,
  cloneDeps: { allowFileUrlsForTests?: boolean; mkdtemp?: (prefix: string) => string } = testCloneDeps()
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  let pending = pendingPlugins.get(card.id)
  if (!pending) {
    // daemon riavviato (o proposta vecchia): si ri-scarica lo stesso plugin
    const rebuilt = await buildPluginCard(card.id, '', deps, cloneDeps)
    if (!rebuilt.ok) return { ok: false, error: `ri-download del plugin non riuscito: ${rebuilt.error}` }
    pending = pendingPlugins.get(card.id)!
  }
  // L6: l'utente ha approvato la card con QUESTO sha12; se il marketplace nel
  // frattempo è andato avanti, niente installazione silenziosa di altro codice
  if (pending.sha12 !== card.sha12) {
    const error = `il plugin è cambiato dopo la proposta (era ${card.sha12}, ora ${pending.sha12}): chiedi una nuova proposta`
    dropStaging(pending.stagingRoot, pending.extraDirs)
    pendingPlugins.delete(card.id)
    return { ok: false, error }
  }
  const dest = join(deps.dataDir(), 'plugins', pending.marketplaceName, pending.plugin.name, pending.sha12)
  mkdirSync(dest, { recursive: true })
  // .git NON si copia: i pack file sono read-only e nel plugin installato non serve
  cpSync(pending.staging, dest, { recursive: true, filter: (src) => !src.includes('/.git') })
  dropStaging(pending.stagingRoot, pending.extraDirs)
  pendingPlugins.delete(card.id)

  const cleanupDest = (): void => rmSync(dest, { recursive: true, force: true })
  const abort = (error: string): { ok: false; error: string } => {
    // L5: tutto com'era — nessun server registrato, cartella sul Mac rimossa
    cleanupDest()
    return { ok: false, error }
  }

  // M4: copia nel volume DEDICATO sandbot-plugins (montato /plugins:ro nel
  // box dal KERNEL) con one-shot ROOT, stesso schema di init e migrate: il
  // volume /box è del bot (uid 1000) e chmod/chown come 1000 su file del Mac
  // (501:20) falliscono — e comunque il bot potrebbe rimpiazzare il codice
  // dei server stdio di terzi. Sequenza: create dell'usa-e-getta col volume
  // rw, mkdir del padre (docker cp NON crea le cartelle intermedie), cp,
  // chown/chmod come root, rm dell'usa-e-getta SEMPRE; OGNI passo controllato
  const boxDir = pluginBoxDir(pending.marketplaceName, pending.plugin.name, pending.sha12)
  let boxCopied = false
  let boxNote = ''
  if (deps.dockerMode() && deps.runDocker) {
    const run = deps.runDocker
    const {
      dockerPluginCopyCreateArgv, dockerPluginsMkdirArgv, dockerPluginCpArgv, dockerPluginsChownArgv,
      dockerPluginsChmodArgv, dockerPluginsRmHelperArgv, dockerPluginsVolumeCreateArgv
    } = await import('../sandbox/docker-argv')
    const { boxImage } = await import('../sandbox')
    const { dirname } = await import('node:path')
    const image = boxImage()
    const helper = `sandbot-plugin-copy-${randomUUID().slice(0, 8)}`
    const parent = dirname(boxDir)
    try {
      const vc = await run(dockerPluginsVolumeCreateArgv())
      if (vc.code !== 0) throw new Error(`creazione del volume dei plugin non riuscita: ${vc.stderr.trim().slice(0, 160)}`)
      const create = await run(dockerPluginCopyCreateArgv(helper, image))
      if (create.code !== 0) throw new Error(`creazione del contenitore di copia non riuscita: ${create.stderr.trim().slice(0, 160)}`)
      try {
        const mkdir = await run(dockerPluginsMkdirArgv(image, parent))
        if (mkdir.code !== 0) throw new Error(`creazione della cartella ${parent} nel volume dei plugin non riuscita: ${mkdir.stderr.trim().slice(0, 160)}`)
        const cp = await run(dockerPluginCpArgv(dest, helper, boxDir))
        if (cp.code !== 0) throw new Error(`copia del plugin nel volume dei plugin non riuscita: ${cp.stderr.trim().slice(0, 160)}`)
        const chown = await run(dockerPluginsChownArgv(image, boxDir))
        if (chown.code !== 0) throw new Error(`chown del plugin nel volume dei plugin non riuscito: ${chown.stderr.trim().slice(0, 160)}`)
        const chmod = await run(dockerPluginsChmodArgv(image, boxDir))
        if (chmod.code !== 0) throw new Error(`sola lettura del plugin nel volume dei plugin non riuscita: ${chmod.stderr.trim().slice(0, 160)}`)
        boxCopied = true
      } finally {
        // M4: l'usa-e-getta si rimuove SEMPRE, anche dopo un errore a metà;
        // la copia parziale della cartella del plugin si butta via (best-effort)
        await run(dockerPluginsRmHelperArgv(helper))
        if (!boxCopied) await run(dockerRmDirArgv(boxDir, image))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const hasStdio = pending.inspection.mcpServers.some((s) => !s.url && !argvPlaceholdersOf(s).length)
      if (!hasStdio) {
        // eccezione L5/M4.6: senza server stdio la copia nel volume non serve
        // al funzionamento (le skill si leggono dalla dir dati sul Mac)
        boxNote = `copia nel box non riuscita (${msg.slice(0, 120)}): plugin di sole skill, resta installato`
      } else {
        return abort(msg)
      }
    }
  }

  // i server MCP del plugin: http come il punto 2; stdio nel box con
  // ${CLAUDE_PLUGIN_ROOT} = il path del box e ${user_config.KEY}/${VAR} risolti
  // SOLO in env/headers/url al momento della connessione (dallo store cifrato).
  // L1: la config conserva la DICHIARAZIONE (pluginSpec, template pubblici).
  // M3: un ${VAR} in command/args finirebbe in argv (regola dei segreti): il
  // server NON si registra e il messaggio lo dice.
  const serverIds: string[] = []
  const settingsKeys: string[] = []
  const needsConnectorAuth: string[] = []
  const notRegistered: Array<{ name: string; vars: string[] }> = []
  for (const s of pending.inspection.mcpServers) {
    const argvVars = argvPlaceholdersOf(s)
    if (argvVars.length) {
      notRegistered.push({ name: s.name, vars: argvVars })
      continue
    }
    const serverId = serverIdFor({ kind: 'plugin', marketplace: pending.marketplaceName, plugin: pending.plugin.name, server: s.name })
    const uck = userConfigKeysOf(s)
    const values = (await deps.store.read<Record<string, string>>(serverId, SECRET_KIND.userConfig)) ?? {}
    const missingKeys = uck.filter((k) => !Object.hasOwn(values, k))
    settingsKeys.push(...missingKeys)
    const source = { kind: 'plugin' as const, plugin: pending.plugin.name, marketplace: pending.marketplaceName, sha: pending.sha12 }
    if (s.url) {
      const cfg: McpServerConfig = {
        id: serverId, name: s.name, transport: 'http', url: s.url, enabled: true,
        auth: { kind: 'oauth' }, enabledFor: [agentId],
        source,
        pluginSpec: {
          url: s.url,
          ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {})
        }
      }
      if (s.headers && Object.keys(s.headers).length) cfg.auth = { kind: 'headers' }
      if (missingKeys.length) cfg.needsAuth = { kind: 'settings', keys: missingKeys }
      deps.saveServers([...deps.listServers().filter((x) => x.id !== serverId), cfg])
      serverIds.push(serverId)
      // M2: server http OAuth senza token salvati → stato connettore needs_auth
      // (lo vedono la scheda Installati e skippedByConnectorState). Il browser
      // NON si apre qui: un plugin può avere più server, l'autorizzazione si
      // dà su richiesta dal bottone Connetti della scheda Installati.
      if (cfg.auth?.kind === 'oauth' && !(await deps.store.read(serverId, 'oauth.tokens'))) {
        needsConnectorAuth.push(serverId)
      }
    } else if (s.command) {
      const cfg: McpServerConfig = {
        id: serverId, name: s.name, transport: 'stdio', enabled: true,
        box: {
          workdir: boxDir,
          home: boxHomePath(agentId),
          command: substitutePluginRoot(s.command, boxDir),
          args: (s.args ?? []).map((a) => substitutePluginRoot(a, boxDir)),
          envKeys: Object.keys(s.env ?? {})
        },
        enabledFor: [agentId],
        source,
        pluginSpec: {
          ...(s.env && Object.keys(s.env).length ? { env: s.env } : {})
        }
      }
      if (missingKeys.length) cfg.needsAuth = { kind: 'settings', keys: missingKeys }
      deps.saveServers([...deps.listServers().filter((x) => x.id !== serverId), cfg])
      serverIds.push(serverId)
    }
  }
  if (needsConnectorAuth.length) {
    const states = getSetting<Record<string, Record<string, unknown>>>('connectors.state', {})
    for (const id of needsConnectorAuth) {
      states[id] = { ...(states[id] ?? {}), status: 'needs_auth', error: 'da autorizzare (Impostazioni → Installati → Connetti)' }
    }
    setSetting('connectors.state', states)
  }

  const record: InstalledPlugin = {
    name: pending.plugin.name,
    marketplace: pending.marketplaceName,
    marketplaceSource: pending.marketplaceSource,
    sha: pending.sha,
    sha12: pending.sha12,
    dir: join('plugins', pending.marketplaceName, pending.plugin.name, pending.sha12),
    ...(deps.dockerMode() && boxCopied ? { boxDir } : {}),
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
  if (needsConnectorAuth.length) {
    const names = needsConnectorAuth.map((id) => deps.listServers().find((x) => x.id === id)?.name ?? id).join(', ')
    parts.push(`da autorizzare: ${names} (Impostazioni → Installati → Connetti)`)
  }
  if (notRegistered.length) parts.push(`server non installati (valore in argv): ${notRegistered.map((s) => `${s.name} (${s.vars.join(', ')})`).join(', ')}`)
  if (boxNote) parts.push(boxNote)
  return { ok: true, message: `Plugin ${record.name} installato: ${parts.join(', ')}` }
}

/** Disinstallazione (solo dalle Impostazioni): cartelle (Mac e volume dei plugin), server, skill. I dati dell'utente NON si toccano. */
export async function uninstallPlugin(
  record: InstalledPlugin,
  deps: InstallDeps,
  setSetting: (key: string, value: unknown) => void,
  getSetting: <T>(key: string, fallback: T) => T
): Promise<void> {
  const dir = join(deps.dataDir(), record.dir)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  if (record.boxDir && deps.dockerMode() && deps.runDocker) {
    // argv PURO sul path esatto della NOSTRA copia (mai volumi interi, mai
    // dati utente). M4: i path NUOVI (/plugins/…) passano dal one-shot ROOT
    // sul volume dei plugin; i VECCHI (/box/plugins/…) dall'exec nel box rw
    // — la disinstallazione non si rompe coi record di prima della correzione
    const { boxImage } = await import('../sandbox')
    await deps.runDocker(dockerRmDirArgv(record.boxDir, boxImage()))
  }
  deps.saveServers(deps.listServers().filter((s) => !record.servers.includes(s.id)))
  setSetting(PLUGINS_SETTING, installedPlugins({ getSetting }).filter((p) => !(p.name === record.name && p.marketplace === record.marketplace)))
  // L2: i segreti seguono il server — uno removeAll per OGNI id registrato
  // (il vecchio `plugin-<nome>` non era l'id di nessun server e non cancellava nulla)
  for (const id of record.servers) await deps.store.removeAll(id).catch(() => undefined)
  deps.onChange()
}

/**
 * L1: la card "Connetti"/"Riconnetti" della scheda Installati rifà l'OAuth di
 * un server del registro/plugin/url (authorizeWithLoopback con i token salvati
 * sotto cfg.id, lo stesso provider del trasporto). M2: per i server di PLUGIN
 * l'URL è quello RISOLTO dal resolver (placeholder sostituiti coi valori
 * dello store), non il template di pluginSpec.
 */
export async function reconnectServer(
  id: string,
  deps: InstallDeps,
  getSetting: <T>(key: string, fallback: T) => T,
  setSetting: (key: string, value: unknown) => void
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const cfg = deps.listServers().find((s) => s.id === id)
  if (!cfg) return { ok: false, error: `server non trovato: ${id}` }
  if (cfg.auth?.kind !== 'oauth') return { ok: false, error: 'il server non usa OAuth' }
  if (cfg.catalogId) return { ok: false, error: 'usa la vista "Connetti app" per i connettori del catalogo' }
  if (!cfg.url) return { ok: false, error: 'il server non ha un URL' }
  if (!deps.hasUi()) return { ok: false, error: 'serve la finestra di Homun per autorizzare' }
  // M2: il template del plugin si risolve PRIMA di autorizzare — un URL con
  // ${user_config.K}/${VAR} non sostituito non è un URL valido
  let url = cfg.url
  if (cfg.pluginSpec?.url) {
    const values = (await deps.store.read<Record<string, string>>(cfg.id, SECRET_KIND.userConfig)) ?? {}
    const resolved = resolvePluginServerPlaceholders(
      { name: cfg.name, from: 'config', url: cfg.pluginSpec.url },
      values,
      cfg.box?.workdir ?? ''
    )
    const missing = unresolvedUserConfigKeys(resolved)
    if (missing.length) {
      return { ok: false, error: `il server "${cfg.name}" richiede i valori ${missing.join(', ')}: l'utente li inserisce nelle Impostazioni` }
    }
    url = resolved.url ?? cfg.url
  }
  try {
    const authorize = deps.authorize ?? authorizeWithLoopback
    await authorize(url, (redirectUrl, stateFactory) =>
      createOAuthProvider(
        {
          serverId: cfg.id, redirectUrl, openExternal: deps.openExternal, store: deps.store, stateFactory,
          ...(deps.clientMetadataUrl?.() ?? '' ? { clientMetadataUrl: deps.clientMetadataUrl!() } : {})
        }
      )
    )
  } catch (e) {
    return { ok: false, error: `autorizzazione non riuscita (${e instanceof Error ? e.message : String(e)})` }
  }
  // la sessione è di nuova valida: needs_auth si pulisce e il server si prova
  const states = getSetting<Record<string, Record<string, unknown>>>('connectors.state', {})
  const cur = (states[id] ?? {}) as Record<string, unknown>
  setSetting('connectors.state', { ...states, [id]: { ...cur, status: 'connected', error: undefined } })
  deps.onChange()
  try {
    const tools = await deps.toolsOfServer(cfg.id)
    return { ok: true, message: serverInstalledMessage(cfg.name, tools) }
  } catch (e) {
    return { ok: false, error: `autorizzazione riuscita ma il server non risponde: ${e instanceof Error ? e.message : String(e)}` }
  }
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
  const id = serverIdFor({ kind: 'gateway', name: input.name.trim(), url: input.url })
  const cfg: McpServerConfig = {
    id, name: input.name.trim(), transport: 'http', url: input.url, enabled: true,
    ...(input.auth === 'bearer' ? { auth: { kind: 'bearer' as const } } : {}),
    ...(input.auth === 'headers' ? { auth: { kind: 'headers' as const } } : {}),
    ...(input.auth === 'oauth' ? { auth: { kind: 'oauth' as const } } : {}),
    // il gateway lo aggiunge l'utente per i SUOI bot: abilitato a tutti
    enabledFor: ['*'],
    source: { kind: 'gateway', ...(input.preset ? { preset: input.preset } : {}) }
  }
  if (input.bearerToken) await deps.store.write(id, SECRET_KIND.bearer, input.bearerToken)
  if (input.headers && Object.keys(input.headers).length) await deps.store.write(id, SECRET_KIND.headers, input.headers)
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

/**
 * L1+M3: i placeholder rimasti dopo la sostituzione (valore mai salvato e
 * senza default): `${user_config.KEY}` e `${VAR}`. Un placeholder senza
 * valore lascia needsAuth e il server NON parte: niente stringhe vuote
 * silenziose (puro).
 */
export function unresolvedUserConfigKeys(resolved: { url?: string; headers?: Record<string, string>; env?: Record<string, string> }): string[] {
  const keys = new Set<string>()
  const scan = (s: string): void => {
    for (const m of s.matchAll(/\$\{([A-Za-z0-9_.-]+)(?::-[^}]*)?\}/g)) {
      const key = (m[1] ?? '').replace(/^user_config\./, '')
      if (key && key !== 'CLAUDE_PLUGIN_ROOT') keys.add(key)
    }
  }
  if (resolved.url) scan(resolved.url)
  for (const v of Object.values(resolved.headers ?? {})) scan(v)
  for (const v of Object.values(resolved.env ?? {})) scan(v)
  return [...keys]
}

export { findRegistryEntry }
