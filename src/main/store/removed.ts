// X1 (fase sicurezza-beta16): i bot rimossi stanno fermi — funzioni PURE sui
// dati della riga agents (niente db, niente import del modulo vivo): così il
// loop può usarle anche dove lo store è mockato nei test, e db.ts ci costruisce
// sopra le versioni per id. Un bot rimosso è una riga con archived_at o
// deleted_at; i FIGLI seguono il padre (fase 12: un sottoagente non vive senza).
import type { Agent } from '../../shared/types'

/** true se la riga è un bot rimosso o il FIGLIO di un padre rimosso. */
export function agentRemoved(a: Agent | null | undefined, parentOf: (id: string) => Agent | null | undefined = () => undefined): boolean {
  if (!a) return false
  if (a.deletedAt || a.archivedAt) return true
  if (!a.parentId) return false
  // un figlio ha SEMPRE un padre nella tabella (fase 12): un livello basta
  const p = parentOf(a.parentId)
  return Boolean(p?.deletedAt || p?.archivedAt)
}

/**
 * Il rifiuto per un bot RIMOSSO passato a un tool che vuole un bot
 * (send_to_agent, gruppi): «questo bot non è disponibile». null se non è
 * rimosso (vivo, figlio vivo o sconosciuto: quelli hanno i loro rifiuti).
 */
export function removedAgentRefusalOf(a: Agent | null | undefined): string | null {
  if (!a || !(a.deletedAt || a.archivedAt)) return null
  return `"${a.name}" (id ${a.id}) is not available: this bot has been archived or deleted.`
}
