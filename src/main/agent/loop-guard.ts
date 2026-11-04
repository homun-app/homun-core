// Protezioni e stato live del turno (fase 8, §3bis L7/L11) — modulo PURO:
// l'attività corrente del bot (nome tool + target, senza testo generato dal
// modello) e la loop detection (la stessa tool call ripetuta 3 volte di fila).
// Il nome del tool e il target arrivano dagli ARGOMENTI della chiamata, mai
// dall'output del modello: la sidebar mostra "sta facendo X…" senza rischio
// di mostrare testo iniettato.
import { createHash } from 'node:crypto'

/** Comando abbreviato su una riga (per la sidebar). */
export function abbreviateCommand(cmd: string, max = 48): string {
  const one = cmd.trim().split('\n')[0] ?? ''
  return one.length > max ? one.slice(0, max) + '…' : one
}

/**
 * L'attività corrente (§3bis L7): nome del tool e target leggibile —
 * path per i file, comando abbreviato per la shell, nome del connettore
 * per i tool MCP, il nome del tool altrimenti.
 */
export function activityOf(
  tool: string,
  input: Record<string, unknown>,
  serverName?: string
): { tool: string; target: string; app?: string; args?: string } {
  let target = ''
  let args: string | undefined
  let app: string | undefined
  if (tool === 'run-command') target = abbreviateCommand(String(input.command ?? ''))
  else if (tool === 'read-file' || tool === 'write-file' || tool === 'list-directory') target = String(input.path ?? '')
  else if (tool.startsWith('mcp__')) {
    target = tool.split('__')[1] ?? tool
    app = serverName
    // V5 (prova vera): gli argomenti COMPATTI degli strumenti meta di Composio
    // (SOLO i nomi delle azioni e dei toolkit, mai i valori: destinatari e
    // testi non si mostrano) — così la mascotte dice «usa Gmail · Elenca email…»
    const original = tool.split('__').slice(2).join('__')
    if (original === 'COMPOSIO_MULTI_EXECUTE_TOOL' && Array.isArray(input.tools)) {
      const slugs = input.tools
        .map((t) => (t && typeof t === 'object' ? String((t as { tool_slug?: unknown }).tool_slug ?? '') : ''))
        .filter(Boolean)
      if (slugs.length > 0) args = JSON.stringify({ tools: slugs.map((x) => ({ tool_slug: x })) })
    } else if (original === 'COMPOSIO_MANAGE_CONNECTIONS' && Array.isArray(input.toolkits)) {
      const entries = input.toolkits
        .map((t) => (t && typeof t === 'object'
          ? { name: String((t as { name?: unknown }).name ?? ''), action: String((t as { action?: unknown }).action ?? 'add') }
          : null))
        .filter((t): t is { name: string; action: string } => !!t)
      if (entries.length > 0) args = JSON.stringify({ toolkits: entries })
    }
  }
  else if (tool === 'use-app') target = String(input.action ?? '')
  // fase 16b correzioni (P2): anche web_fetch porta l'URL letto — la mascotte
  // dice «legge <host>…» invece della pagina web generica
  else if (tool === 'web_fetch') target = String(input.url ?? '')
  // fase 11b: il browser — l'URL per l'apertura, il ref per le azioni
  else if (tool === 'browser_open') target = String(input.url ?? '')
  else if (tool.startsWith('browser_')) target = String(input.ref ?? '')
  // fase 19a: lo schermo del bot — il motivo della richiesta, il numero di azioni
  else if (tool === 'request_takeover') target = abbreviateCommand(String(input.reason ?? ''))
  else if (tool === 'computer_act') target = `${Array.isArray(input.actions) ? input.actions.length : 0} actions`
  return { tool, target, ...(app ? { app } : {}), ...(args ? { args } : {}) }
}

/** Quante chiamate identiche di fila fanno scattare la loop detection. */
export const TOOL_LOOP_REPEATS = 3

/**
 * La chiave di ripetizione di una chiamata (pura). Fase 19a (V6): per
 * computer_act la chiave è l'HASH delle azioni — ripetere le STESSE azioni
 * con formattazione diversa (spazi, observe, chiavi in altro ordine dentro
 * gli oggetti è già normalizzato da JSON.stringify) con lo schermo che non
 * cambia è comunque la stessa chiamata; la regola resta quella delle altre
 * ripetizioni (3 di fila fermano il turno).
 */
export function repeatKeyOf(name: string, args: string): string {
  if (name !== 'computer_act') return `${name}\u0000${args}`
  try {
    const parsed = JSON.parse(args || '{}') as { actions?: unknown }
    return `computer_act\u0000${createHash('sha256').update(JSON.stringify(parsed.actions ?? null)).digest('hex')}`
  } catch {
    return `${name}\u0000${args}`
  }
}

/**
 * Loop detection (§3bis L11, puro): la PROSSIMA chiamata sarebbe la terza
 * identica di fila (stessa chiave di ripetizione: nome + argomenti, o l'hash
 * delle azioni per computer_act) nello stesso turno? true = il turno va
 * fermato con una notice leggibile invece di consumare MAX_STEPS.
 */
export function isToolLoop(
  seq: Array<{ name: string; args: string }>,
  next: { name: string; args: string }
): boolean {
  const key = repeatKeyOf(next.name, next.args)
  const last = seq.slice(-(TOOL_LOOP_REPEATS - 1))
  return last.length === TOOL_LOOP_REPEATS - 1 &&
    last.every((c) => repeatKeyOf(c.name, c.args) === key)
}

/**
 * Correzione C5 (fase 10): il motivo per cui un turno finisce STOPPED per un
 * errore del modello. 429 (o il testo "usage limit"/"rate limit", come scrive
 * Ollama cloud quando la sessione è esaurita) è un limite d'uso del provider:
 * va distinto dagli altri errori perché il gruppo si sospende, non fallisce.
 */
export type ModelStopReason = 'model-error' | 'rate-limit'

export function stopReasonOfError(err: unknown): ModelStopReason {
  const status = (err as { status?: number } | null)?.status
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return status === 429 || /429|usage limit|rate limit/i.test(msg) ? 'rate-limit' : 'model-error'
}
