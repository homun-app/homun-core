// Fase 16c correzioni (R3/R4): il modello che un bot ESEGUE, deciso in UN
// SOLO punto (l'idea di resolveRunModel di Rakazo: chat, squadre e routine
// passano tutte da qui, nessun percorso ha una propria copia della regola).
// Modulo PURO, zero dipendenze: lo usano il daemon (loop, giro di squadra),
// le RPC e il renderer (il selettore resolvedModelOf dello store).
//
// La regola «provider, modello e credenziale vincono insieme» è adattata da
// Rakazo (selectConfiguredModel, commit 29cd6da, Apache-2.0): il modello
// PROPRIo di un bot vale solo se il suo provider è ancora collegato e attivo;
// altrimenti si segue il principale (che torna appena il provider rientra —
// il bot NON viene migrato, tiene i suoi providerId e model).
import type { MainModel, ThinkingSetting } from './types'

/** Un bot, per chi legge il modello: i campi che servono a resolveAgentModel. */
export interface AgentModelView {
  providerId?: string | null
  model?: string | null
  thinking?: ThinkingSetting | null
}

/**
 * I provider ATTIVI della installazione (id + enabled bastano alla regola):
 * li passa il daemon (listProviders) e il renderer (providers:list). Se
 * l'elenco non c'è, la disponibilità del provider non si controlla (il
 * comportamento resta quello dei chiamanti che non lo sanno).
 */
export type ActiveProviders = ReadonlyArray<{ id: string; enabled: boolean }>

/** Il modello che un bot ESEGUE: il suo, quello principale, o niente. */
export interface ResolvedAgentModel {
  providerId: string
  model: string
  thinking?: ThinkingSetting | null
  /** true quando il bot segue il modello principale («Come gli altri») */
  followsMain: boolean
  /**
   * R3.6: il bot ha un modello PROPRIO ma il suo provider non è più
   * collegato o è disattivato — si segue il principale finché non torna
   * (il bot tiene providerId e model: nessuna migrazione)
   */
  ownModelMissing?: true
}

/** Il thinking di un bot che segue il principale: il suo se ESPlicito, altrimenti quello del principale. */
function followThinking(agent: AgentModelView, main: MainModel): ThinkingSetting | null {
  return agent.thinking && agent.thinking !== 'default' ? agent.thinking : (main.thinking ?? null)
}

/**
 * Fase 16c (C3.3) + correzioni R3, PURA: il modello risolto di un bot.
 * - providerId E model propri, provider ATTIVO → quelli (thinking del bot);
 * - providerId E model propri ma provider sparito/disattivato, e models.main
 *   c'è → il principale, `followsMain: true` + `ownModelMissing: true`
 *   (regola di Rakazo: provider, modello e credenziale vincono insieme);
 * - bot null/null e models.main impostato → il principale («Come gli altri»);
 * - altrimenti → null (l'avviso di sempre, notice.configureProviderFirst).
 * Nessuna migrazione: i bot esistenti tengono il modello esplicito.
 */
export function resolveAgentModel(
  agent: AgentModelView,
  main: MainModel | null | undefined,
  activeProviders?: ActiveProviders
): ResolvedAgentModel | null {
  const hasMain = !!(main && main.providerId && main.model)
  const providerActive = (id: string): boolean =>
    !activeProviders || activeProviders.some((p) => p.id === id && p.enabled)
  if (agent.providerId && agent.model) {
    if (providerActive(agent.providerId)) {
      return { providerId: agent.providerId, model: agent.model, thinking: agent.thinking ?? null, followsMain: false }
    }
    if (hasMain) {
      return {
        providerId: main!.providerId,
        model: main!.model,
        thinking: followThinking(agent, main!),
        followsMain: true,
        ownModelMissing: true
      }
    }
    return null
  }
  if (!agent.providerId && !agent.model && hasMain) {
    return { providerId: main!.providerId, model: main!.model, thinking: followThinking(agent, main!), followsMain: true }
  }
  return null
}
