// RV4 (fase beta.2), punto 2: dove porta il bottone «Scegli un modello»
// della notice in chat. Con almeno un provider ATTIVO si apre il selettore
// del BOT (nel pannello destro, lo stesso del foglio «Impostazioni del
// bot»); senza provider configurati resta Impostazioni › Modelli, dove
// prima va aggiunto un provider. PURA: i provider arrivano dallo store.
export type ModelNoticeTarget = 'bot' | 'settings'

/** I provider come li vede lo store (vista pubblica, senza chiavi). */
export interface ProviderLike {
  enabled: boolean
}

/**
 * Dove porta «Scegli un modello»: 'bot' se c'è almeno un provider ATTIVO (il
 * selettore del bot elenca i modelli di quelli attivi, e da lì si può anche
 * collegarne uno nuovo); 'settings' altrimenti — senza provider la prima
 * cosa da fare è aggiungerne uno in Impostazioni › Modelli.
 */
export function modelNoticeTarget(providers: readonly ProviderLike[]): ModelNoticeTarget {
  return providers.some((p) => p.enabled) ? 'bot' : 'settings'
}
