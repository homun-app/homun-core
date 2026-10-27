// Protezioni e stato live del turno (fase 8, §3bis L7/L11) — modulo PURO:
// l'attività corrente del bot (nome tool + target, senza testo generato dal
// modello) e la loop detection (la stessa tool call ripetuta 3 volte di fila).
// Il nome del tool e il target arrivano dagli ARGOMENTI della chiamata, mai
// dall'output del modello: la sidebar mostra "sta facendo X…" senza rischio
// di mostrare testo iniettato.

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
export function activityOf(tool: string, input: Record<string, unknown>): { tool: string; target: string } {
  let target = ''
  if (tool === 'run-command') target = abbreviateCommand(String(input.command ?? ''))
  else if (tool === 'read-file' || tool === 'write-file' || tool === 'list-directory') target = String(input.path ?? '')
  else if (tool.startsWith('mcp__')) target = tool.split('__')[1] ?? tool
  else if (tool === 'use-app') target = String(input.action ?? '')
  return { tool, target }
}

/** Quante chiamate identiche di fila fanno scattare la loop detection. */
export const TOOL_LOOP_REPEATS = 3

/**
 * Loop detection (§3bis L11, puro): la PROSSIMA chiamata sarebbe la terza
 * identica di fila (nome + argomenti identici) nello stesso turno? true = il
 * turno va fermato con una notice leggibile invece di consumare MAX_STEPS.
 */
export function isToolLoop(
  seq: Array<{ name: string; args: string }>,
  next: { name: string; args: string }
): boolean {
  const last = seq.slice(-(TOOL_LOOP_REPEATS - 1))
  return last.length === TOOL_LOOP_REPEATS - 1 &&
    last.every((c) => c.name === next.name && c.args === next.args)
}
