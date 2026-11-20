// E2 (fase mcp-env): «Importa da Cursor, Claude o ZCode» — le VIE dei tre
// file e il loro PARSE, PURI. I file si leggono SOLO al clic dell'utente,
// nei due gestori locali di ipc.ts (mcp-import:scan / mcp-import:apply):
// mai all'avvio, mai dal bot, mai in nessun altro momento. La scansione
// mostra nome e tipo SENZA valori (i segreti restano nel main); la voce
// scelta diventa un server manuale: stdio con comando/argomenti/env, http
// con url e header; le variabili col nome da segreto e l'header
// Authorization vanno nello store CIFRATO. Il file intero non si copia MAI:
// solo le voci scelte. La HOME si inietta (prove con HOME finta).
import { homedir } from 'node:os'
import { envNameLooksSecret } from '../../shared/mcp-env'
import type { McpServerInfo, McpServerSecret } from '../../shared/types'

export type ImportSource = 'cursor' | 'claude' | 'zcode'

/** Il JSON di uno dei tre file, nella forma LASSA comune (mcpServers / mcp.servers). */
export type ImportedFileJson = Record<string, unknown> & {
  mcpServers?: Record<string, Record<string, unknown>>
  mcp?: { servers?: Record<string, Record<string, unknown>> }
}

/** Le tre VIE, nell'ordine (la home dell'utente, iniettabile). */
export function importSourcePaths(home: string = homedir()): Array<{ source: ImportSource; path: string }> {
  return [
    { source: 'cursor', path: `${home}/.cursor/mcp.json` },
    { source: 'claude', path: `${home}/Library/Application Support/Claude/claude_desktop_config.json` },
    { source: 'zcode', path: `${home}/.zcode/cli/config.json` }
  ]
}

/** Le voci server di un file (Cursor/Claude: mcpServers; ZCode: mcp.servers). */
function serversOf(json: ImportedFileJson): Record<string, Record<string, unknown>> {
  return json.mcpServers ?? json.mcp?.servers ?? {}
}

/** La voce è stdio (command) o http (url)? null se né l'una né l'altra. */
function transportOf(entry: Record<string, unknown>): 'stdio' | 'http' | null {
  if (typeof entry.command === 'string' && entry.command) return 'stdio'
  if (typeof entry.url === 'string' && entry.url) return 'http'
  return null
}

/** I NOMI segreti di una voce: env col nome da segreto, o l'header Authorization. */
function secretNamesOf(entry: Record<string, unknown>, transport: 'stdio' | 'http'): string[] {
  if (transport === 'stdio') {
    const env = (entry.env ?? {}) as Record<string, unknown>
    return Object.keys(env).filter((k) => envNameLooksSecret(k))
  }
  const headers = (entry.headers ?? {}) as Record<string, unknown>
  return Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization')
}

/** Una riga della scansione: nome e tipo, MAI valori (i segreti restano nel main). */
export interface ImportScanRow {
  source: ImportSource
  name: string
  transport: 'stdio' | 'http'
  envNames: string[]
  secretNames: string[]
}

/**
 * La scansione dei tre file (la lettura la passa il chiamante: qui non si
 * tocca il fs). File assente/malformato → niente righe da quel file; voci
 * senza command né url → saltate.
 */
export async function scanImportedSources(deps: {
  paths?: Array<{ source: ImportSource; path: string }>
  readJson(path: string): Promise<ImportedFileJson | null>
}): Promise<ImportScanRow[]> {
  const paths = deps.paths ?? importSourcePaths()
  const out: ImportScanRow[] = []
  for (const { source, path } of paths) {
    const json = await deps.readJson(path)
    if (!json) continue
    for (const [name, entry] of Object.entries(serversOf(json))) {
      const transport = transportOf(entry)
      if (!transport) continue
      out.push({
        source, name, transport,
        envNames: transport === 'stdio' ? Object.keys((entry.env ?? {}) as Record<string, unknown>) : Object.keys((entry.headers ?? {}) as Record<string, unknown>),
        secretNames: secretNamesOf(entry, transport)
      })
    }
  }
  return out
}

/**
 * La voce SCELTA diventa server manuale: stdio con comando/argomenti ed env
 * (non segreti in envValues, segreti nel canale cifrato secret.env), http
 * con url e header (tutti cifrati, come il bearer di oggi). Solo quella
 * voce, mai il file intero. Voce scomparsa → null.
 */
export function buildImportedServer(source: ImportSource, name: string, json: ImportedFileJson): { cfg: McpServerInfo; secret: McpServerSecret | undefined } | null {
  const entry = serversOf(json)[name]
  if (!entry) return null
  const transport = transportOf(entry)
  if (!transport) return null
  const base: McpServerInfo = {
    id: 'mcp_import_' + Date.now().toString(36) + '_' + name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24),
    name,
    transport,
    enabled: true
  }
  if (transport === 'stdio') {
    const env = (entry.env ?? {}) as Record<string, string>
    const envSpec = Object.keys(env).map((n) => ({ name: n, secret: envNameLooksSecret(n) }))
    const envValues: Record<string, string> = {}
    const envSecrets: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      if (envNameLooksSecret(k)) envSecrets[k] = String(v)
      else envValues[k] = String(v)
    }
    return {
      cfg: {
        ...base,
        command: String(entry.command),
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        ...(envSpec.length ? { envSpec, envValues } : {})
      },
      secret: Object.keys(envSecrets).length ? { env: envSecrets } : undefined
    }
  }
  // http: url + header (tutti cifrati, come il flusso manuale di oggi)
  const headers = (entry.headers ?? {}) as Record<string, string>
  return {
    cfg: { ...base, url: String(entry.url), ...(Object.keys(headers).length ? { auth: { kind: 'headers' as const } } : {}) },
    secret: Object.keys(headers).length ? { headers } : undefined
  }
}
