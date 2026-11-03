// Fase Composio OAuth (C4): la FIDUCIA PER APP nel turno e l'azione negata
// ripetuta, sul modello di Rakazo:
// - packages/adapters/src/run-trust.ts:37–53 (connectorTrustKeys): la chiave
//   di fiducia è il TOOLKIT dell'azione (gmail, slack…), non il server — un
//   blocco Gmail non rende fidato Slack;
// - packages/core/src/action-approval.ts:258–263 (connectorReadRequiresApproval):
//   una lettura connector passa senza card finché nel turno NON è entrato
//   contenuto esterno; dopo, una lettura su un'app che il turno non ha
//   ancora usato né approvato chiede (un testo iniettato potrebbe
//   sceglierne gli argomenti). Le letture su un'app già usata restano
//   libere, così «elenca poi leggi» non chiede due volte;
// - packages/core/src/action-approval.ts:158–177 (repeatsDeniedAction): nel
//   turno, se l'utente ha negato un blocco che conteneva lo slug X, un
//   blocco nuovo che contiene X si rifiuta da solo («Telling the model not
//   to retry did not stop it»).
// Modulo PURO: le dipendenze arrivano da fuori (i test in nodo puro).
import { toolBatchOf, composioToolkitOfSlug } from '../connectors/tool-batch'
import { composioActionOfToolName } from '../connectors/composio-actions'

/**
 * La fiducia per una lettura (Rakazo connectorReadRequiresApproval): dopo
 * che nel turno è entrato contenuto esterno (`tainted`), una lettura su
 * un'app NON ancora fidata chiede la card.
 */
export function connectorReadRequiresApproval(input: { tainted: boolean; trusted: boolean }): boolean {
  return input.tainted && !input.trusted
}

/**
 * Le chiavi di fiducia delle azioni di una chiamata (Rakazo
 * connectorTrustKeys): una per TOOLKIT, ricavato dallo slug dell'azione
 * (prefisso più lungo fra gli slug noti, altrimenti il primo segmento).
 */
export function composioTrustKeysOfActions(actions: readonly string[], connectedSlugs: readonly string[] = []): string[] {
  return [...new Set(actions.map((slug) => composioToolkitOfSlug(slug, connectedSlugs)))]
}

/** La chiave di fiducia di uno strumento composio__<tk>__ACTION (flusso SDK). */
export function composioTrustKeyOfToolName(toolName: string): string | null {
  return composioActionOfToolName(toolName)?.toolkit ?? null
}

/** Una richiesta di tool negata dall'utente nel turno (per repeatsDeniedAction). */
export interface DeniedToolRequest {
  toolName: string
  args: unknown
}

/**
 * La chiamata ripete un'azione che l'utente ha GIÀ negato nel turno?
 * (Rakazo repeatsDeniedAction:158–177): per il blocco di Composio conta il
 * CONFRONTO PER SLUG INTERNO — un blocco nuovo che contiene uno slug già
 * negato si rifiuta da solo; per gli altri strumenti vale il nome intero.
 */
export function repeatsDeniedAction(input: { toolName: string; args: unknown; denied: readonly DeniedToolRequest[] }): string | null {
  const isBatch = (name: string): boolean => toolBatchOf(originalToolNameOf(name)) !== undefined
  const currentIsBatch = isBatch(input.toolName)
  for (const request of input.denied) {
    if (currentIsBatch) {
      // un blocco ripete solo un negato che era ANCHE esso un blocco, e solo
      // se condividono uno slug interno (Rakazo:158–177)
      if (!isBatch(request.toolName)) continue
      const before = innerToolSlugs(request.args)
      const now = innerToolSlugs(input.args)
      const repeated = now.find((slug) => before.includes(slug))
      if (repeated) return repeated
      continue
    }
    if (request.toolName === input.toolName) return input.toolName
  }
  return null
}

/** Il nome originale di uno strumento mcp__<server>__<tool> (o il nome stesso). */
export function originalToolNameOf(toolName: string): string {
  const parts = toolName.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : toolName
}

/** Gli slug interni di una chiamata al blocco (innerToolSlugs di Rakazo). */
export function innerToolSlugs(args: unknown): string[] {
  const tools = (args as { tools?: unknown } | null)?.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((item) => {
    const slug = (item as { tool_slug?: unknown } | null)?.tool_slug
    return typeof slug === 'string' && slug.trim() ? [slug.trim().toUpperCase()] : []
  })
}

/**
 * Il rifiuto che torna al modello quando una chiamata ripete un'azione
 * negata (C4 punto 2).
 */
export function deniedRepeatRefusal(action: string): string {
  return `The user denied ${action} in this turn; do not retry it.`
}
