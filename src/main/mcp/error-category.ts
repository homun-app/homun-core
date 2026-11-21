// X2 (fase sicurezza-beta16): l'errore di un server MCP non entra nel
// messaggio di sistema al bot. Qui vive l'elenco CHIUSO delle categorie e la
// classificazione — che guarda CODICI e TIPI d'errore (errno di node nella
// causa, codici numerici JSON-RPC, status HTTP, classi note), MAI il testo
// libero: un corpo d'errore scelto dal server non può cambiarla. Modulo
// PURO (nessuna dipendenza di node): lo usano il daemon e, per il taglio a
// 300, anche il renderer.

/** L'elenco CHIUSO: «non parte (comando non trovato)», «non parte (errore all'avvio)», «accesso rifiutato», «non raggiungibile», «risposta non valida», «errore sconosciuto». */
export type McpErrorCategory =
  | 'command-not-found'
  | 'startup-error'
  | 'access-denied'
  | 'unreachable'
  | 'invalid-response'
  | 'unknown-error'

/**
 * L'errore LOCALE con la categoria già decisa: il comando di un server stdio
 * manuale che non si risolve (command-not-found), i rifiuti del recinto prima
 * di ogni exec (startup-error). Il messaggio resta quello di oggi per la UI.
 */
export class McpServerError extends Error {
  constructor(message: string, public readonly category: McpErrorCategory) {
    super(message)
    this.name = 'McpServerError'
  }
}

/** errno di node che dicono «la rete non c'è arrivata». */
const NET_ERRNOS = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EADDRNOTAVAIL'
])

/** status HTTP che dicono «qui non parla MCP». */
const NOT_MCP_STATUSES = new Set([404, 405, 406, 415, 422, 500, 501, 502, 503, 504])

type ErrLike = { name?: unknown; code?: unknown; status?: unknown; cause?: unknown }

/**
 * La categoria di un errore di connessione, dal CODICE o dal TIPO:
 *  · ENOENT (spawn o dentro la causa) → command-not-found;
 *  · errno di rete / causa fetch → unreachable;
 *  · UnauthorizedError, status 401/403 → access-denied;
 *  · codici JSON-RPC -32700/-32600, SyntaxError, status «non è MCP» → invalid-response;
 *  · il resto della famiglia -32xxx (connection closed e simili) → startup-error;
 *  · qualsiasi altra cosa (anche un corpo a scelta del server) → unknown-error.
 */
export function classifyMcpError(err: unknown): McpErrorCategory {
  const seen = new Set<unknown>()
  const walk = (e: unknown): McpErrorCategory => {
    if (!e || typeof e !== 'object' || seen.has(e)) return 'unknown-error'
    seen.add(e)
    const { name, code, status, cause } = e as ErrLike
    if (name === 'McpServerError') return (e as McpServerError).category
    if (name === 'UnauthorizedError') return 'access-denied'
    if (typeof code === 'string') {
      if (code === 'ENOENT') return 'command-not-found'
      if (NET_ERRNOS.has(code)) return 'unreachable'
    }
    if (typeof code === 'number') {
      if (code === -32700 || code === -32600) return 'invalid-response'
      // la famiglia di errore del protocollo: -32000 Connection closed (il
      // processo stdio è morto), -32001 Request timeout…
      if (code <= -32000 && code > -33000) return 'startup-error'
    }
    if (status === 401 || status === 403) return 'access-denied'
    if (typeof status === 'number' && NOT_MCP_STATUSES.has(status)) return 'invalid-response'
    if (name === 'SyntaxError') return 'invalid-response'
    if (cause !== undefined && cause !== null) return walk(cause)
    return 'unknown-error'
  }
  return walk(err)
}

/** La frase fissa di ogni categoria per il messaggio al bot (inglese, come i [sistema]). */
export function mcpErrorCategoryText(category: McpErrorCategory): string {
  switch (category) {
    case 'command-not-found': return 'command not found'
    case 'startup-error': return 'startup error'
    case 'access-denied': return 'access denied'
    case 'unreachable': return 'unreachable'
    case 'invalid-response': return 'invalid response'
    case 'unknown-error': return 'unknown error'
  }
}

/**
 * Il nome del server nella nota al bot (cfg.name, scelto dall'utente o
 * importato da file): niente a capo (diventano spazio), niente < >, al
 * massimo 60 caratteri. Il nome entra nel testo che legge il modello (anche
 * nella query di find_tools): non può portare markup né spezzare la riga.
 */
export function sanitizeServerNoteName(name: string): string {
  return name
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, '')
    .slice(0, 60)
    .trim()
}

/** Il tetto del testo d'errore mostrato nella UI (X2: mai oltre, mai al bot). */
export const MCP_ERROR_CLIP = 300

/** Il testo d'errore per la UI: integro se corto, tagliato a 300 + ellissi. */
export function clipErrorText(text: string): string {
  return text.length <= MCP_ERROR_CLIP ? text : text.slice(0, MCP_ERROR_CLIP) + '…'
}
