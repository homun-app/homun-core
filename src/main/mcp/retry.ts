// RW (fase revisore sulla richiesta, punto 3): le cadute di connessione MCP
// (i tre «MCP error -32000: Connection closed» del turno di Trello) oggi
// finiscono nude al modello, che riprova — e ogni riprova è una card nuova.
// Qui: OGNI errore di trasporto di una chiamata MCP finisce nel log del
// daemon (server, strumento, millisecondi, messaggio: MAI gli argomenti) e
// se la chiamata era una LETTURA si riconnette e si ripete UNA volta da
// sole — la ripetizione è coperta dall'approvazione già data per QUELLA
// chiamata, niente card nuova. Le scritture non si ripetono mai: l'errore va
// al modello come oggi. Tutto PURO, con le dipendenze iniettate.
export interface McpRetryDeps {
  /** lo slug del server MCP (per la riga di log) */
  server: string
  /** il nome ORIGINALE dello strumento sul server (per la riga di log) */
  tool: string
  /** la chiamata era una lettura? (mcpCallIsRead: C3 read, PROXY GET/HEAD, MULTI di sole letture) */
  isRead: boolean
  /** un tentativo: `reconnect` true dopo la riconnessione forzata */
  attempt(reconnect: boolean): Promise<unknown>
  /** la riga di log (default: console.error — nel daemon finisce in daemon.log) */
  log?(line: string): void
  /** l'orologio, iniettabile nei test */
  now?(): number
  /** quando l'errore NON si ripete nemmeno per una lettura (es. token scaduto) */
  retryWhen?(error: unknown): boolean
}

/**
 * Esegue la chiamata; all'errore scrive UNA riga di log e, solo per le
 * letture (e solo se retryWhen lo ammette), ripete una volta dopo essersi
 * riconnessi. Qualunque altra cosa va al chiamante com'è.
 */
export async function callMcpWithRetry(deps: McpRetryDeps): Promise<unknown> {
  const log = deps.log ?? console.error
  const now = deps.now ?? Date.now
  const started = now()
  try {
    return await deps.attempt(false)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // mai gli argomenti: server, strumento, durata e solo il messaggio
    log(`[sandbotd] mcp call failed: server=${deps.server} tool=${deps.tool} ms=${now() - started} error=${message.slice(0, 300)}`)
    if (!deps.isRead) throw error
    if (deps.retryWhen && !deps.retryWhen(error)) throw error
    // lettura: si ripete UNA volta, da soli, dopo la riconnessione
    return await deps.attempt(true)
  }
}
