// E2 (fase mcp-env) + U7 (fase mcp-ui): «Importa da altre app» — le VIE degli
// otto file e il loro PARSE, PURI. Cursor, Claude Desktop e ZCode di E2; in
// più U7 legge Claude Code (~/.claude.json, utente E progetti), Codex CLI
// (~/.codex/config.toml, TOML con un parser MINIMO scritto qui, nessuna
// dipendenza nuova), Windsurf, Gemini CLI e VS Code. I file si leggono SOLO
// al clic dell'utente, nei due gestori locali di ipc.ts (mcp-import:scan /
// mcp-import:apply): mai all'avvio, mai dal bot, mai in nessun altro
// momento. La scansione mostra nome e tipo SENZA valori (i segreti restano
// nel main); la voce scelta diventa un server manuale: stdio con
// comando/argomenti/env, http con url e header; le variabili col nome da
// segreto e l'header Authorization vanno nello store CIFRATO. Le VARIABILI
// RIFERITE (${env:…}, ${input:…}, bearer_token_env_var) non hanno valore qui
//: si importano «da compilare» (needsAuth), MAI col placeholder letterale.
// I FORMATI NON CAPITI sono server SALTATI col motivo. Il file intero non si
// copia MAI: solo le voci scelte. La HOME si inietta (prove con HOME finta).
import { homedir } from 'node:os'
import { envNameLooksSecret } from '../../shared/mcp-env'
import type { McpServerInfo, McpServerSecret } from '../../shared/types'

/** Le app da cui si importa (U7: otto). */
export type ImportSource = 'cursor' | 'claude' | 'zcode' | 'claude-code' | 'codex' | 'windsurf' | 'gemini' | 'vscode'

/** Una voce il cui formato non si capisce: SALTATA col motivo (U7). */
export interface ImportSkipRow {
  source: ImportSource
  name: string
  reason: 'env-in-command' | 'env-in-url' | 'header-var' | 'format'
}

/** Il JSON di uno dei file mcpServers-like, nella forma LASSA comune. */
export type ImportedFileJson = Record<string, unknown> & {
  mcpServers?: Record<string, Record<string, unknown>>
  mcp?: { servers?: Record<string, Record<string, unknown>> }
}

/** Le VIE degli otto file, nell'ordine (la home dell'utente, iniettabile). */
export function importSourcePaths(home: string = homedir()): Array<{ source: ImportSource; path: string }> {
  return [
    { source: 'cursor', path: `${home}/.cursor/mcp.json` },
    { source: 'claude', path: `${home}/Library/Application Support/Claude/claude_desktop_config.json` },
    { source: 'zcode', path: `${home}/.zcode/cli/config.json` },
    // U7 (fase mcp-ui): le altre app
    { source: 'claude-code', path: `${home}/.claude.json` },
    { source: 'codex', path: `${home}/.codex/config.toml` },
    { source: 'windsurf', path: `${home}/.codeium/windsurf/mcp_config.json` },
    { source: 'gemini', path: `${home}/.gemini/settings.json` },
    { source: 'vscode', path: `${home}/Library/Application Support/Code/User/mcp.json` }
  ]
}

/** La variabile RIFERITA che non si può importare col valore: ${env:…}, ${input:…}. */
const REF_VAR = /\$\{(?:env|input):[^}]*\}/

// ---- U7: il parser TOML MINIMO (nessuna dipendenza nuova) ----
// Il sottoinsieme che basta ai config di Codex: commenti, tabelle
// [a.b] (chiavi nude o fra virgolette), key = valore con valore stringa
// base (con escape) o letterale, array di STRINGHE, tabella inline
// { k = "v", … }, booleani e numeri (per non inciampare nelle altre righe).
// Tutto ciò che esce dal sottoinsieme → null: quel file si salta, mai errori.

/** Un valore del sottoinsieme TOML: stringa, booleano, numero, array di stringhe o tabella inline. */
type TomlValue = string | boolean | number | string[] | Record<string, string | boolean | number>

/** Il cursore del testo: posizione e testo; null quando il sottoinsieme non basta più. */
class TomlCursor {
  i = 0
  constructor(readonly s: string) {}
  /** salta spazi, tab e commenti (fine riga). */
  ws(): void {
    for (;;) {
      while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t' || this.s[this.i] === '\r')) this.i++
      if (this.s[this.i] === '#') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++
        continue
      }
      return
    }
  }
  /** salta spazi e fine riga (tra le chiavi di una tabella). */
  blanks(): void {
    for (;;) {
      this.ws()
      if (this.s[this.i] === '\n') { this.i++; continue }
      return
    }
  }
  eof(): boolean { return this.i >= this.s.length }
}

/** Una chiave nude o «fra virgolette»; null se il carattere non è di chiave. */
function tomlKey(c: TomlCursor): string | null {
  if (c.s[c.i] === '"' || c.s[c.i] === "'") return tomlString(c)
  const m = /^[A-Za-z0-9_-]+/.exec(c.s.slice(c.i))
  if (!m) return null
  c.i += m[0].length
  return m[0]
}

/** Una stringa base (con escape) o letterale; null se malformata. */
function tomlString(c: TomlCursor): string | null {
  const q = c.s[c.i]
  if (q !== '"' && q !== "'") return null
  c.i++
  let out = ''
  if (q === "'") {
    while (c.i < c.s.length && c.s[c.i] !== "'") out += c.s[c.i++]
    if (c.s[c.i] !== "'") return null
    c.i++
    return out
  }
  while (c.i < c.s.length && c.s[c.i] !== '"') {
    if (c.s[c.i] === '\\') {
      const e = c.s[c.i + 1]
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }
      if (e in map) { out += map[e]!; c.i += 2; continue }
      if (e === 'u' || e === 'U') {
        const w = e === 'u' ? 4 : 8
        const hex = /^[0-9a-fA-F]+/.exec(c.s.slice(c.i + 2, c.i + 2 + w))?.[0]
        if (!hex || hex.length !== w) return null
        out += String.fromCodePoint(parseInt(hex, 16))
        c.i += 2 + w
        continue
      }
      return null
    }
    out += c.s[c.i++]
  }
  if (c.s[c.i] !== '"') return null
  c.i++
  return out
}

/** Un valore del sottoinsieme; lancia se il testo esce dal sottoinsieme. */
function tomlValue(c: TomlCursor): TomlValue {
  c.ws()
  const ch = c.s[c.i]
  if (ch === '"' || ch === "'") {
    const v = tomlString(c)
    if (v === null) throw new Error('malformed string')
    return v
  }
  if (ch === '[') {
    c.i++
    const arr: string[] = []
    for (;;) {
      c.blanks()
      if (c.s[c.i] === ']') { c.i++; return arr }
      const v = tomlString(c)
      if (v === null) throw new Error('array with a non-string item')
      arr.push(v)
      c.blanks()
      if (c.s[c.i] === ',') { c.i++; continue }
      if (c.s[c.i] === ']') { c.i++; return arr }
      throw new Error('malformed array')
    }
  }
  if (ch === '{') {
    c.i++
    const obj: Record<string, string | boolean | number> = {}
    for (;;) {
      c.blanks()
      if (c.s[c.i] === '}') { c.i++; return obj }
      const k = tomlKey(c)
      if (!k) throw new Error('malformed inline key')
      c.ws()
      if (c.s[c.i] !== '=') throw new Error('missing = in inline table')
      c.i++
      const v = tomlValue(c)
      if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') obj[k] = v
      else throw new Error('nested inline table')
      c.blanks()
      if (c.s[c.i] === ',') { c.i++; continue }
      if (c.s[c.i] === '}') { c.i++; return obj }
      throw new Error('malformed inline table')
    }
  }
  const m = /^(?:true|false|-?\d+(?:\.\d+)?)/.exec(c.s.slice(c.i))
  if (!m) throw new Error('value outside the subset')
  c.i += m[0].length
  const t = m[0]
  return t === 'true' || t === 'false' ? t === 'true' : Number(t)
}

/**
 * Il parser del sottoinsieme TOML dei config di Codex (PURO): null quando il
 * testo esce dal sottoinsieme — quel file si salta, mai un errore.
 */
export function parseTomlSubset(text: string): Record<string, unknown> | null {
  try {
    const root: Record<string, unknown> = {}
    let cur: Record<string, unknown> = root
    const c = new TomlCursor(text)
    for (;;) {
      c.blanks()
      if (c.eof()) return root
      if (c.s[c.i] === '[') {
        if (c.s[c.i + 1] === '[') return null // array di tabelle: fuori dal sottoinsieme
        c.i++
        let node: Record<string, unknown> = root
        for (;;) {
          c.ws()
          const k = tomlKey(c)
          if (!k) return null
          if (typeof node[k] !== 'object' || node[k] === null || Array.isArray(node[k])) node[k] = {}
          node = node[k] as Record<string, unknown>
          c.ws()
          if (c.s[c.i] === '.') { c.i++; continue }
          break
        }
        if (c.s[c.i] !== ']') return null
        c.i++
        cur = node
        continue
      }
      const k = tomlKey(c)
      if (!k) return null
      c.ws()
      if (c.s[c.i] !== '=') return null
      c.i++
      cur[k] = tomlValue(c)
    }
  } catch {
    return null
  }
}

/** Le voci di un file nella forma di ogni app; null = file assente/malformato. */
export interface ParsedSourceFile {
  entries: Record<string, Record<string, unknown>>
  /** le voci il cui formato non si capisce, col motivo (U7) */
  skipped: ImportSkipRow[]
}

/** Le voci server secondo la forma LASSA dell'app (mcpServers / mcp.servers / servers). */
function mcpServersOfJson(json: ImportedFileJson): Record<string, Record<string, unknown>> {
  return json.mcpServers ?? json.mcp?.servers ?? {}
}

/**
 * Il parse del file di UN'app (PURO): torna le voci valide e quelle SALTATE
 * col motivo; null quando il file è assente o malformato (quel file non c'è,
 * gli altri restano). Claude Code: le voci UTENTE e quelle dei PROGETTI
 * (projects.<path>.mcpServers — si legge SOLO quella chiave, il resto del
// file non si tocca). Codex: le tabelle [mcp_servers.<nome>] del TOML.
 */
export function parseSourceFile(source: ImportSource, text: string | null): ParsedSourceFile | null {
  if (text === null) return null
  let raw: Record<string, unknown> | null = null
  if (source === 'codex') {
    const toml = parseTomlSubset(text)
    raw = (toml?.mcp_servers as Record<string, unknown> | undefined) ?? null
    if (!toml) return null
  } else {
    try {
      raw = JSON.parse(text) as Record<string, unknown>
    } catch {
      return null
    }
  }
  let entries: Record<string, Record<string, unknown>> = {}
  if (source === 'codex') {
    entries = raw as Record<string, Record<string, unknown>>
  } else if (source === 'vscode') {
    entries = ((raw as ImportedFileJson).servers as Record<string, Record<string, unknown>> | undefined) ?? {}
  } else if (source === 'claude-code') {
    // le voci dell'utente, poi quelle di OGNI progetto (le prime vincono)
    const json = raw as ImportedFileJson
    entries = { ...mcpServersOfJson(json) }
    const projects = (json.projects ?? {}) as Record<string, ImportedFileJson>
    for (const p of Object.values(projects ?? {})) {
      for (const [name, entry] of Object.entries(mcpServersOfJson(p))) {
        if (!(name in entries)) entries[name] = entry
      }
    }
  } else {
    entries = mcpServersOfJson(raw as ImportedFileJson)
  }
  // il formato di ogni voce: command (stdio) o url (http); le variabili
  // RIFERITE nel comando/indirizzo/header non si possono importare → SALTATE
  const out: ParsedSourceFile = { entries: {}, skipped: [] }
  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      out.skipped.push({ source, name, reason: 'format' })
      continue
    }
    const command = typeof entry.command === 'string' ? entry.command : ''
    const url = typeof entry.url === 'string' ? entry.url : ''
    if (!command && !url) {
      out.skipped.push({ source, name, reason: 'format' })
      continue
    }
    if (command) {
      const args = Array.isArray(entry.args) ? entry.args : []
      if (REF_VAR.test(command) || args.some((a) => typeof a !== 'string' || REF_VAR.test(a))) {
        out.skipped.push({ source, name, reason: 'env-in-command' })
        continue
      }
    } else if (REF_VAR.test(url)) {
      out.skipped.push({ source, name, reason: 'env-in-url' })
      continue
    }
    const headers = (entry.headers ?? {}) as Record<string, unknown>
    if (Object.values(headers).some((v) => typeof v === 'string' && REF_VAR.test(v))) {
      out.skipped.push({ source, name, reason: 'header-var' })
      continue
    }
    out.entries[name] = entry
  }
  return out
}

/** La voce è stdio (command) o http (url)? null se né l'una né l'altra. */
function transportOf(entry: Record<string, unknown>): 'stdio' | 'http' | null {
  if (typeof entry.command === 'string' && entry.command) return 'stdio'
  if (typeof entry.url === 'string' && entry.url) return 'http'
  return null
}

/**
 * I NOMI segreti di una voce: env col nome da segreto, l'header Authorization
 * e — U7 — le variabili RIFERITE (${env:…} nel valore, bearer_token_env_var):
 * valori che qui NON ci sono, da compilare dopo l'import.
 */
function secretNamesOf(entry: Record<string, unknown>, transport: 'stdio' | 'http'): string[] {
  if (transport === 'stdio') {
    const env = (entry.env ?? {}) as Record<string, unknown>
    const out = Object.keys(env).filter((k) => envNameLooksSecret(k) || (typeof env[k] === 'string' && REF_VAR.test(env[k] as string)))
    const bearerVar = typeof entry.bearer_token_env_var === 'string' ? entry.bearer_token_env_var : ''
    if (bearerVar && !out.includes(bearerVar)) out.push(bearerVar)
    return out
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
  /** stdio: «npx -y pacchetto» (comando e argomenti: pubblici, non segreti) */
  commandLine?: string
  /** http: l'URL del server */
  url?: string
  /** il file da cui arriva la voce (per l'intestazione del gruppo) */
  sourcePath: string
}

/**
 * La scansione degli otto file (la lettura la passa il chiamante: qui non si
 * tocca il fs). File assente/malformato → niente righe da quel file; le voci
 * col formato non capito sono SALTATE col motivo (U7); i valori MAI.
 */
export async function scanImportedSources(deps: {
  paths?: Array<{ source: ImportSource; path: string }>
  readText(path: string): Promise<string | null>
}): Promise<{ rows: ImportScanRow[]; skipped: ImportSkipRow[] }> {
  const paths = deps.paths ?? importSourcePaths()
  const rows: ImportScanRow[] = []
  const skipped: ImportSkipRow[] = []
  for (const { source, path } of paths) {
    const parsed = parseSourceFile(source, await deps.readText(path))
    if (!parsed) continue
    for (const skip of parsed.skipped) skipped.push(skip)
    for (const [name, entry] of Object.entries(parsed.entries)) {
      const transport = transportOf(entry)
      if (!transport) continue // già nelle skipped col motivo
      const args = Array.isArray(entry.args) ? entry.args.map(String) : []
      rows.push({
        source, name, transport,
        envNames: transport === 'stdio' ? Object.keys((entry.env ?? {}) as Record<string, unknown>) : Object.keys((entry.headers ?? {}) as Record<string, unknown>),
        secretNames: secretNamesOf(entry, transport),
        ...(transport === 'stdio'
          ? { commandLine: [String(entry.command), ...args].filter(Boolean).join(' ') }
          : { url: String(entry.url) }),
        sourcePath: path
      })
    }
  }
  return { rows, skipped }
}

/**
 * La voce SCELTA diventa server manuale: stdio con comando/argomenti ed env
 * (non segreti in envValues, segreti nel canale cifrato secret.env), http
 * con url e header (tutti cifrati, come il bearer di oggi). Solo quella
 * voce, mai il file intero. Voce scomparsa o SALTATA → null.
 * U7: le variabili RIFERITE (${env:…}, bearer_token_env_var) diventano righe
 * «da compilare»: envSpec segreta SENZA valore e needsAuth col nome — il
 * placeholder non passa MAI al server.
 */
export function buildImportedServer(
  source: ImportSource,
  name: string,
  parsed: ParsedSourceFile
): { cfg: McpServerInfo; secret: McpServerSecret | undefined } | null {
  const entry = parsed.entries[name]
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
    const envSpec: Array<{ name: string; secret: boolean }> = []
    const envValues: Record<string, string> = {}
    const envSecrets: Record<string, string> = {}
    const toFill: string[] = []
    const bearerVar = typeof entry.bearer_token_env_var === 'string' ? entry.bearer_token_env_var : ''
    const pushFill = (n: string): void => {
      envSpec.push({ name: n, secret: true })
      if (!toFill.includes(n)) toFill.push(n)
    }
    if (bearerVar) pushFill(bearerVar)
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string' && REF_VAR.test(v)) {
        pushFill(k)
        continue
      }
      const secret = envNameLooksSecret(k)
      envSpec.push({ name: k, secret })
      if (secret) envSecrets[k] = String(v)
      else envValues[k] = String(v)
    }
    return {
      cfg: {
        ...base,
        command: String(entry.command),
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        envSpec,
        envValues,
        // U7: «da compilare» finché l'utente non mette i valori
        ...(toFill.length ? { needsAuth: { kind: 'env' as const, keys: toFill } } : {})
      },
      secret: Object.keys(envSecrets).length ? { env: envSecrets } : undefined
    }
  }
  // http: url + header (tutti cifrati, come il flusso manuale di oggi; le
  // header con variabili riferite sono già nelle SALTATE)
  const headers = (entry.headers ?? {}) as Record<string, string>
  return {
    cfg: { ...base, url: String(entry.url), ...(Object.keys(headers).length ? { auth: { kind: 'headers' as const } } : {}) },
    secret: Object.keys(headers).length ? { headers } : undefined
  }
}
