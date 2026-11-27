// Fase memoria-engramma v0.6.19 (E1): l'avviso del motore nella sezione
// «Memoria». Prima una frase sola per «il motore non c'è»; col motivo «space»
// — non c'è lo spazio per copiare le celle prima che il motore nuovo le
// aggiorni, e la memoria resta com'è — l'utente deve sapere cosa fare, cioè
// quanto liberare (neededBytes è quanto manca: il doppio della cartella più
// 256 MB di margine — cell-backup.ts — meno lo spazio libero; per una
// memoria piccola sono poche centinaia di MB). Il GB è decimale come in
// tutto Homun (disk-space.ts), arrotondato per eccesso: meglio chiedere un
// po' di più che pochi byte, e mai zero.
//
// Fase memoria-engramma v0.6.19 (E3): il motivo «schema-too-new» — una cella
// aggiornata da un Engramma più recente del motore (SCHEMA_TOO_NEW). La
// memoria non si tocca e non si apre: all'utente serve una cosa sola,
// sapere che AGGIORNARE Homun risolve.
//
// Componente PURO: riceve lo stato del motore e non chiama nessuno. La
// sezione Memoria lo carica con un effetto; così l'avviso si rende vero nei
// test del renderer, dove gli effetti non girano. I testi ai token di DS4
// come l'avviso che sostituisce.
//
// E3: qui vive anche l'avviso delle AZIONI sulla memoria (MemoryNotice):
// «quasi dimenticato» dopo una purga che trattiene ancora byte, l'errore
// generico, e la frase del catalogo con cui il demone dice perché ha
// rifiutato (memory-rpc.ts: dal e.code del motore, mai il suo inglese) —
// arriva già nella lingua dell'interfaccia, si mostra com'è. I due riquadri
// sono quelli che stavano in MemoryPanel, spostati qui con le stesse classi
// (tetto-ui.json: 12 da MemoryPanel a questo file, niente di nuovo).
import { Trans } from '@lingui/react/macro'
import type { MemoryOverview } from '../../../shared/types'

const NOTICE = 'mt-2 rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive'

/** L'avviso di un'azione sulla memoria: la frase del demone, oppure uno dei due casi di prima. */
export type MemoryNoticeState = 'pending' | 'error' | { kind: 'text'; text: string } | null

export function MemoryNotice({ notice }: { notice: MemoryNoticeState }): React.ReactElement | null {
  if (notice === null) return null
  if (notice === 'pending') {
    return (
      <p className="mt-2 rounded-control bg-muted px-3 py-2 text-small text-muted-foreground">
        <Trans>Quasi dimenticato: alcuni byte restano nel registro delle scritture e vengono rimossi alla prossima scrittura del motore.</Trans>
      </p>
    )
  }
  return (
    <p className="mt-2 rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive">
      {notice === 'error' ? <Trans>Operazione non riuscita.</Trans> : notice.text}
    </p>
  )
}

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
  if (engine.reason === 'schema-too-new') {
    return (
      <p className={NOTICE}>
        <Trans>Questa memoria è stata aggiornata da una versione più recente di Engramma: aggiorna Homun</Trans>
      </p>
    )
  }
  return (
    <p className={NOTICE}>
      <Trans>Motore della memoria non disponibile: le memorie non si leggono né si scrivono finché non torna.</Trans>
    </p>
  )
}
