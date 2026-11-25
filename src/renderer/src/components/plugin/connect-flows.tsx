// C0 (fase linguaggio): pezzo di AppsWindow.tsx (smontato: non era più una
// finestra, nessuno la montava) — un file per cosa in components/plugin/.
// PL1 (fase plugin): il motore dei flussi «Connetti in un passo» delle app,
// ESTRATTO da AppsView così la pagina Plugin lo riusa senza riscriverlo —
// le fasi per riga (starting/direct/login/app/conflict/failed), il polling
// mentre un flusso è in corsa, la promozione login → app quando il gateway si
// collega e la chiusura quando la riga diventa collegata. `rows` sono le righe
// del modello del catalogo (appsCatalogModel().rows), per riconoscere la riga
// di un flusso in corsa. B3 (fase b20-bug): la logica è PURA
// (lib/app-connect-flow): qui solo il cablaggio con l'api e lo store.
import { useEffect, useReducer, useRef } from 'react'
import { api, useStore } from '../../store'
import type { ComposioGatewayStatusInfo } from '../../../../shared/types'
import { createAppConnectFlows, type AppConnectFlows, type AppFlowFailure, type AppFlowKind } from '../../lib/app-connect-flow'
import type { CatalogRowView } from '../../lib/apps-view'

export type { AppFlowFailure, AppFlowKind }

export function useConnectFlows(rows: CatalogRowView[], options: { maxMs?: number } = {}): {
  gatewayConnected: boolean
  composioGateway: ComposioGatewayStatusInfo | null
  flowOf(row: CatalogRowView): AppFlowKind | null
  /** B3: il motivo quando flowOf è 'failed' (null negli altri stati) */
  failureOf(row: CatalogRowView): AppFlowFailure | null
  connect(row: CatalogRowView): Promise<void>
  cancel(row: CatalogRowView): Promise<void>
  onConflictResolve(row: CatalogRowView): Promise<void>
  refresh(): void
} {
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const refreshComposio = useStore((s) => s.refreshComposio)
  const composioGateway = useStore((s) => s.composioGateway)
  const refreshComposioGateway = useStore((s) => s.refreshComposioGateway)
  const gatewayConnected = connectors.find((c) => c.id === 'composio')?.state.status === 'connected'
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  // niente promesse orfane: una rilettura che rifiuta non è un errore dell'utente
  const reread = (): void => {
    void refreshConnectors().catch(() => undefined)
    void refreshComposioGateway().catch(() => undefined)
  }

  // B3: il flusso PURO, una volta per montaggio (orologio e timer sono quelli del browser)
  const flowsRef = useRef<AppConnectFlows | null>(null)
  if (flowsRef.current === null) {
    flowsRef.current = createAppConnectFlows({
      appsConnect: (id) => api.appsConnect(id),
      appsCancelConnect: (id) => api.appsCancelConnect(id),
      changed: () => redraw(),
      refreshed: reread,
      ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {})
    })
  }
  const flows = flowsRef.current

  const view = (row: CatalogRowView) => flows.viewOf(row.app.id, {
    connected: row.connected,
    ...(row.app.composioSlug ? { composioSlug: row.app.composioSlug } : {}),
    gatewayConnected,
    pending: composioGateway?.pending,
    published: composioGateway?.appConnect
  })

  // mentre un flusso è in corsa (o un collegamento è in attesa) si rilegge lo
  // stato ogni 2 s: gli eventi {type:'connectors'} arrivano, il polling chiude
  const flowBusy = flows.hasPending() || Boolean(composioGateway?.pending)
  useEffect(() => {
    if (!flowBusy) return
    const timer = setInterval(() => {
      void refreshConnectors().catch(() => undefined)
      void refreshComposioGateway().catch(() => undefined)
    }, 2000)
    return () => clearInterval(timer)
  }, [flowBusy, refreshConnectors, refreshComposioGateway])

  // una riga COLLEGATA chiude il suo flusso (e con lei il polling)
  useEffect(() => {
    if (flows.dropClosed(...rows.filter((r) => r.connected === 'connected').map((r) => r.app.id))) redraw()
  }, [rows, flows])

  // allo smontaggio nessun timer del flusso resta acceso
  useEffect(() => () => flows.dispose(), [flows])

  const onConflictResolve = async (row: CatalogRowView): Promise<void> => {
    await api.composioDisable().catch(() => undefined)
    await refreshComposio()
    await flows.connect(row)
  }
  return {
    gatewayConnected,
    composioGateway,
    flowOf: (row) => view(row).kind,
    failureOf: (row) => view(row).failure,
    connect: (row) => flows.connect(row),
    cancel: (row) => flows.cancel(row),
    onConflictResolve,
    refresh: reread
  }
}
