// Fase 17c correzioni (D3): i campi del login nella card del fill viaggiano
// come CODICI ('username' | 'password' | 'totp'), non come parole italiane —
// la card li traduce qui col catalogo del renderer. Le entry VECCHIE (17b)
// salvano le parole italiane: un codice sconosciuto passa invariato, così si
// mostrano come sono. Funzione pura, come sidebar-utils.
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

/** I codici dei campi del login → il testo da tradurre (italiano = sorgente). */
const FILL_FIELD_LABELS: Record<string, MessageDescriptor> = {
  username: msg`nome utente`,
  password: msg`password`,
  totp: msg`codice TOTP`
}

/** L'etichetta di un campo: codice noto → descriptor da tradurre, sconosciuto → il codice com'è. */
export function fillFieldLabel(code: string): MessageDescriptor | string {
  return FILL_FIELD_LABELS[code] ?? code
}
