// RW (fase revisore sulla richiesta, punto 3): il nome di uno strumento che
// non esiste. Il caso vero: il modello ha chiamato mcp__composio-2__
// COMPROSIO_PROXY_EXECUTE (nome inventato), è uscita una card di
// approvazione e l'utente ha cliccato «Sempre» — nascendo il grant per uno
// strumento mai esistito. Qui il rifiuto è subito, PRIMA del gate, con i
// nomi validi VICINI per distanza di edit. Tutto PURO.
import type { ToolDef } from '../agent/llm'

/** Distanza di edit (Levenshtein) fra due stringhe (puro). */
export function editDistance(a: string, b: string): number {
  // riga precedente e corrente della matrice, rolling array
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...Array<number>(b.length).fill(0)]
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    prev = cur
  }
  return prev[b.length]!
}

/** Soglia oltre la quale un nome non è più «vicino»: cresce col nome lungo. */
const closeThreshold = (name: string): number => Math.max(3, Math.floor(name.length / 4))

/**
 * Fino a 3 nomi validi vicini al nome chiamato, per distanza di edit
 * (pareggio in ordine alfabetico: deterministico). Solo i VICINI: un nome
 * lontano non propone niente — meglio nessun suggerimento che uno a caso.
 */
export function closestToolNames(called: string, offered: readonly string[], limit = 3): string[] {
  const threshold = closeThreshold(called)
  return offered
    .filter((name) => name !== called)
    .map((name) => ({ name, distance: editDistance(called, name) }))
    .filter((c) => c.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : 1))
    .slice(0, limit)
    .map((c) => c.name)
}

/**
 * Il testo dell'errore per il modello (inglese, è un result): dice che lo
 * strumento non esiste e propone i nomi validi più vicini.
 */
export function unknownToolMessage(called: string, offered: readonly string[]): string {
  const close = closestToolNames(called, offered)
  return [
    `Unknown tool "${called}": it does not exist. Check the exact name and call it again.`,
    ...(close.length ? [`Closest available tools: ${close.join(', ')}.`] : [])
  ].join('\n')
}

/** L'elenco dei nomi offerti al modello nel turno (turnTools + catalogo, senza doppioni). */
export function offeredToolNames(turnTools: readonly ToolDef[], catalog: readonly ToolDef[]): string[] {
  return [...new Set([...turnTools.map((t) => t.name), ...catalog.map((t) => t.name)])]
}
