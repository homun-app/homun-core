// C0 (fase linguaggio): pezzo di AppsWindow.tsx (smontato: non era più una
// finestra, nessuno la montava) — un file per cosa in components/plugin/.
// La riga di un'app dell'elenco unico: logo, nome, tagline (o lo stato del
// flusso) e a destra Connetti / Ricollega / l'attesa con Annulla. NIENTE
// etichetta di provenienza: quella sta nel foglio del dettaglio. Il clic sulla
// riga apre il dettaglio; il clic sul bottone collega. PP4: la riga è A FILO
// (FlatRow), il logo da 32. B3 (fase b20-bug): in avvio lo dice; quando non è
// partito mostra il motivo per esteso (sotto la riga) con «Riprova». Il
// contenitore porta `data-flow` (lo stato) per le sonde.
import { useLingui, Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { CatalogRowView } from '../../lib/apps-view'
import type { AppFlowFailure, AppFlowKind } from './connect-flows'
import { AppLogo } from './app-logo'
import { FlatRow } from '../ui/flat-list'
import { Button } from '../ui/button'

export function AppRow({ row, flow, failure, onConnect, onCancel, onConflictResolve, onOpen }: {
  row: CatalogRowView
  flow: AppFlowKind | null
  /** B3: il motivo quando `flow` è 'failed' (negli altri stati non si guarda) */
  failure?: AppFlowFailure | null
  onConnect(row: CatalogRowView): void
  onCancel(row: CatalogRowView): void
  onConflictResolve(row: CatalogRowView): void
  onOpen(row: CatalogRowView): void
}): ReactNode {
  const { t } = useLingui()
  const stop = (e: { stopPropagation(): void }): void => e.stopPropagation()
  const statusLine =
    flow === 'login' ? t`Accedi a Composio nel browser…`
    : flow === 'app' ? t`Completa il login di ${row.app.name} nel browser…`
    : row.tagline
  const failed = flow === 'failed' ? failure ?? null : null
  /** Ciò che sta sotto la riga: la casa vuota del logo, poi il testo alla stessa ascissa del nome. */
  const underRow = 'flex gap-row-gap pb-3'
  const logoRoom = <span className="size-8 shrink-0" aria-hidden="true" />
  return (
    <div data-testid={`app-state-${row.app.id}`} data-flow={flow ?? 'idle'} {...(failed ? { 'data-flow-reason': failed.reason } : {})}>
      <FlatRow
        clickable
        testId={`app-row-${row.app.id}`}
        onClick={() => onOpen(row)}
        leading={<AppLogo logo={row.app.logo} name={row.app.name} className="size-8 text-body" />}
        title={row.app.name}
        subtitle={statusLine ?? undefined}
        trailing={
          <>
            {flow === null && row.connected === 'reconnect' && (
              <Button variant="ghost" size="sm" data-testid={`app-connect-${row.app.id}`} onClick={(e) => { stop(e); onConnect(row) }}>
                <Trans>Ricollega</Trans>
              </Button>
            )}
            {flow === null && row.connected === null && (
              <Button variant="ghost" size="sm" data-testid={`app-connect-${row.app.id}`} onClick={(e) => { stop(e); onConnect(row) }}>
                <Trans>Connetti</Trans>
              </Button>
            )}
            {flow === 'starting' && (
              <span className="text-small text-muted-foreground" data-testid={`app-status-${row.app.id}`}>
                {t`Avvio del collegamento…`}
              </span>
            )}
            {flow === 'direct' && <span className="text-small text-muted-foreground">{t`autorizza nel browser…`}</span>}
            {(flow === 'login' || flow === 'app') && (
              <Button variant="ghost" size="sm" data-testid={`app-cancel-${row.app.id}`} onClick={(e) => { stop(e); onCancel(row) }}>
                <Trans>Annulla</Trans>
              </Button>
            )}
            {flow === 'failed' && (
              <>
                <span className="text-small text-destructive" data-testid={`app-status-${row.app.id}`}>
                  {failed?.reason === 'not-connectable'
                    ? <Trans>Non si può collegare</Trans>
                    : failed?.reason === 'timeout'
                      ? <Trans>Nessuna risposta</Trans>
                      : <Trans>Non riuscito</Trans>}
                </span>
                {failed?.reason === 'not-connectable' ? (
                  // R6 (b20-ritocchi): la causa è PERMANENTE (manca la
                  // configurazione di accesso sul conto Composio) — «Riprova»
                  // non cambierebbe niente. «Come si risolve» apre la scheda
                  // dell'app: dove stanno la configurazione e le alternative
                  // (per molte app, l'MCP diretto del fornitore)
                  <Button variant="ghost" size="sm" data-testid={`app-howto-${row.app.id}`} onClick={(e) => { stop(e); onOpen(row) }}>
                    <Trans>Come si risolve</Trans>
                  </Button>
                ) : (
                  // gli errori TEMPORANEI (rete, tempo scaduto) si riprovano
                  <Button variant="ghost" size="sm" data-testid={`app-retry-${row.app.id}`} onClick={(e) => { stop(e); onConnect(row) }}>
                    <Trans>Riprova</Trans>
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      {/* B3: il motivo per esteso, sotto la riga (la mezza riga si tronca: un motivo non si taglia) */}
      {flow === 'failed' && failed && (
        <div className={`${underRow} flex-wrap items-baseline gap-y-1`} onClick={stop} data-testid={`app-error-${row.app.id}`}>
          {logoRoom}
          <p className="min-w-0 flex-1 basis-64 text-small text-foreground/80">{failed.text}</p>
          {failed.detail && (
            <p className="min-w-0 flex-1 basis-64 truncate text-caption text-muted-foreground" title={failed.detail} data-testid={`app-error-detail-${row.app.id}`}>
              {failed.detail}
            </p>
          )}
        </div>
      )}
      {flow === 'conflict' && (
        <div className={`${underRow} flex-wrap items-center`} onClick={stop} data-testid={`app-conflict-${row.app.id}`}>
          {logoRoom}
          <p className="min-w-0 flex-1 text-small">
            <Trans>Composio è già attivo con la chiave di progetto (sviluppatori). Le due strade non possono stare insieme: disattivo la chiave e collego con il login?</Trans>
          </p>
          <Button variant="secondary" size="sm" onClick={() => onConflictResolve(row)}>
            <Trans>Disattiva la chiave e collega</Trans>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onCancel(row)}>
            <Trans>Annulla</Trans>
          </Button>
        </div>
      )}
    </div>
  )
}
