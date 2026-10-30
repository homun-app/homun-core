// Fase 17c (C1): il formattatore dei testi U per daemon, main e shared —
// un'istanza setupI18n PROPRIA (mai quella globale del renderer), caricata
// coi cataloghi compilati delle due lingue (output di `lingui compile`, gli
// stessi .po del renderer). Modulo PURO: niente store, niente Electron — lo
// usa anche il renderer tramite cron-human. `formatUi` risolve un UiText
// (id + valori) nella lingua richiesta; l'id mancante ricade sull'id stesso
// (mai crash: le entry vecchie mostrano il loro content).
//
// Perché cataloghi compilati (`lingui compile`) e non il plugin vite come il
// renderer: questo codice gira in TRE contesti con un solo import statico —
// bundle del main/daemon (rollup di electron-vite), test vitest (niente
// plugin .po) e bundle del renderer. I .mjs compilati funzionano uguale in
// tutti e tre, senza duplicare la catena di plugin; i .po restano la fonte
// di verità e `npm run i18n:extract` ricompila.
import { setupI18n } from '@lingui/core'
import type { Messages } from '@lingui/core'
import type { UiText } from './types'
import type { UiLanguage } from './ui-language'
import { messages as itMessages } from '../renderer/src/locales/it/messages.mjs'
import { messages as enMessages } from '../renderer/src/locales/en/messages.mjs'

/** Il descrittore di un messaggio del catalogo UI (id esplicito). */
export interface UiMessageDescriptor {
  id: string
  message?: string
}

const uiI18n = setupI18n({
  locale: 'it',
  messages: { it: itMessages as Messages, en: enMessages as Messages }
})

/**
 * Un messaggio del catalogo UI + i valori → il UiText che si salva nel
 * database (meta.ui) o si passa a formatUi. Pura: l'id si legge dal
 * descrittore compilato della macro, i valori restano stringhe e numeri.
 */
export function ui(m: UiMessageDescriptor, values?: Record<string, string | number>): UiText {
  return { id: m.id, ...(values ? { values } : {}) }
}

/**
 * Formatta un UiText nella lingua richiesta. Id sconosciuto → l'id stesso
 * (il chiamante di mostra può ripiegare sul content della entry).
 */
export function formatUi(text: UiText, lang: UiLanguage): string {
  if (uiI18n.locale !== lang) uiI18n.activate(lang)
  return uiI18n._(text.id, text.values ?? {})
}

/**
 * Fase 17c (C3): l'errore che serve sia alla UI sia al modello. `message`
 * è inglese (il result dei tool la mostra al modello); `ui` è il UiText che
 * il confine RPC (ws-server) traduce nella lingua dell'interfaccia per la
 * UI. Per gli errori SOLO UI basta `uiError` di src/main/ui-language.ts.
 */
export class UiError extends Error {
  constructor(message: string, public readonly uiText: UiText) {
    super(message)
    this.name = 'UiError'
  }
}
