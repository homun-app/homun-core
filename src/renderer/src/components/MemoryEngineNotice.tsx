// Fase memoria-engramma v0.6.19 (E1): l'avviso del motore nella sezione
// «Memoria». Prima una frase sola per «il motore non c'è»; col motivo «space»
// — non c'è lo spazio per copiare le celle prima che il motore nuovo le
// aggiorni, e la memoria resta com'è — l'utente deve sapere cosa fare, cioè
// quanto liberare (neededBytes è quanto manca: la cartella più il margine,
// meno lo spazio libero). Il GB è decimale come in tutto Homun
// (disk-space.ts), arrotondato per eccesso: meglio chiedere un po' di più
// che pochi byte, e mai zero.
//
// Componente PURO: riceve lo stato del motore e non chiama nessuno. La
// sezione Memoria lo carica con un effetto; così l'avviso si rende vero nei
// test del renderer, dove gli effetti non girano. I testi ai token di DS4
// come l'avviso che sostituisce.
import { Trans } from '@lingui/react/macro'
import type { MemoryOverview } from '../../../shared/types'

const NOTICE = 'mt-2 rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive'

/** I GB da liberare, per eccesso e mai zero. */
const gbToFree = (missingBytes: number): number => Math.max(1, Math.ceil(missingBytes / 1_000_000_000))

export function MemoryEngineNotice({ engine }: { engine: MemoryOverview['engine'] }): React.ReactElement | null {
  if (engine.available) return null
  if (engine.reason === 'space') {
    const gb = gbToFree(engine.neededBytes ?? 0)
    return (
      <p className={NOTICE}>
        <Trans>Serve spazio sul disco per aggiornare la memoria in sicurezza: liberane {gb} GB</Trans>
      </p>
    )
  }
  return (
    <p className={NOTICE}>
      <Trans>Motore della memoria non disponibile: le memorie non si leggono né si scrivono finché non torna.</Trans>
    </p>
  )
}
