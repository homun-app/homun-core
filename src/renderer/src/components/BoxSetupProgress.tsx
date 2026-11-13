// OB2 (fase onboarding-b): la lista d'avanzamento della preparazione del
// computer del bot — SEI righe verticali (download, verifica,
// installazione, servizio, kernel, immagine), ognuna col suo stato: da
// fare, in corso (barra per il download, spinner per le altre), fatta ✓,
// SALTATA – (OBD2: non serviva — segno neutro e testo che dice perché),
// errore. Su awaiting-installer la riga dell'installazione diventa il
// bottone «Apri l'installazione». Il componente è CONDIVISO: lo usa il
// passo Computer della guida e la scheda del motore nelle Impostazioni
// (OB3). Le righe le decide la funzione pura boxSetupRows (lib).
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { BoxSetupState } from '../../../shared/types'
import { boxSetupRows, boxSetupCancellable, type BoxSetupRow } from '../lib/box-setup-rows'

/** Le etichette delle sei righe, in parole. */
const ROW_LABEL: Record<string, MessageDescriptor> = {
  download: msg`Scarico lo strumento di Apple`,
  verify: msg`Controllo che sia autentico`,
  installer: msg`Installazione`,
  service: msg`Accendo il servizio`,
  kernel: msg`Kernel`,
  image: msg`Preparo il computer`
}

/**
 * OBD2 (fase onboarding-b-dettagli): il testo sotto l'etichetta di una riga
 * SALTATA — non serviva, e il testo dice perché (catalogo it/en).
 */
const ROW_SKIP_TEXT: Record<string, MessageDescriptor> = {
  download: msg`Già installato: niente da scaricare`,
  verify: msg`Non serve`,
  installer: msg`Già installato`,
  service: msg`Era già acceso`,
  kernel: msg`Era già presente`
}

/** Il numero in percentuale del download (o null senza totale). */
export function downloadPercent(row: BoxSetupRow): number | null {
  if (row.total == null || row.total <= 0 || row.bytes == null) return null
  return Math.min(100, Math.round((row.bytes / row.total) * 100))
}

export function BoxSetupProgress({ state, onOpenInstaller, onCancel }: {
  state: BoxSetupState
  onOpenInstaller?(): void
  onCancel?(): void
}) {
  const { i18n } = useLingui()
  const rows = boxSetupRows(state)
  return (
    <div className="flex flex-col gap-1.5" data-testid="box-setup-progress">
      {rows.map((row) => {
        const label = i18n.t(ROW_LABEL[row.id]!)
        if (row.status === 'action') {
          return (
            <button
              key={row.id}
              type="button"
              data-testid="box-setup-open-installer"
              className="flex min-h-[44px] items-center justify-between gap-3 rounded-[14px] bg-card px-4 py-2.5 text-left text-[15px] font-semibold shadow-[0_0_0_2px_var(--foreground)] transition hover:opacity-90"
              onClick={() => onOpenInstaller?.()}
            >
              {label}
              <span className="text-xs font-medium text-muted-foreground">{i18n.t(msg`Apri l'installazione`)}</span>
            </button>
          )
        }
        const done = row.status === 'done'
        const error = row.status === 'error'
        const running = row.status === 'running'
        // OBD2: una riga saltata non è FATTA: segno neutro (–) e il testo che dice perché
        const skipped = row.status === 'skipped'
        const pct = running ? downloadPercent(row) : null
        return (
          <div
            key={row.id}
            data-testid={`box-setup-row-${row.id}`}
            data-status={row.status}
            className={`flex min-h-[44px] items-center gap-3 rounded-[14px] px-4 py-2.5 ${done || skipped ? 'bg-card/55' : running ? 'bg-card' : 'bg-card/35'} ${error ? 'shadow-[0_0_0_1.5px_var(--destructive)]' : ''}`}
          >
            {/* il segno dello stato: ✓ fatto, spinner in corso, punto da fare, – saltata, ! errore */}
            <span
              aria-hidden
              className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
                done ? 'bg-chart-2/15 text-chart-2' : error ? 'bg-destructive/15 text-destructive' : running ? 'bg-foreground/10 text-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {done ? '✓' : error ? '!' : running ? <span className="block size-2 animate-spin rounded-full border-2 border-current border-t-transparent" /> : skipped ? '–' : '·'}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className={`text-[14.5px] ${done || skipped ? 'text-muted-foreground' : 'font-medium'}`}>{label}</span>
              {skipped && (
                <span className="text-[11.5px] text-muted-foreground" data-testid={`box-setup-skip-text-${row.id}`}>{i18n.t(ROW_SKIP_TEXT[row.id]!)}</span>
              )}
              {running && row.id === 'download' && pct !== null && (
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-foreground/10" aria-hidden>
                  <span className="block h-full rounded-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
                </span>
              )}
              {running && row.id === 'download' && row.bytes != null && row.total != null && (
                <span className="text-[11.5px] text-muted-foreground" data-testid="box-setup-download-bytes">{pct}%</span>
              )}
              {running && row.id === 'image' && row.buildPhase && (
                <span className="text-[11.5px] text-muted-foreground">{row.buildPhase}</span>
              )}
            </span>
          </div>
        )
      })}
      {boxSetupCancellable(state.phase) && onCancel && (
        <button
          type="button"
          data-testid="box-setup-cancel"
          className="mt-1 self-start rounded-lg px-1.5 py-2 text-[13px] font-semibold text-muted-foreground transition hover:text-foreground"
          onClick={() => onCancel()}
        >
          {i18n.t(msg`Annulla`)}
        </button>
      )}
    </div>
  )
}
