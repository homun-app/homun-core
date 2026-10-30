// Card dell'offerta di connessione (fase 5, funnel §3ter T2-T3): il bottone
// "Connetti" è dell'UTENTE — l'agente può solo proporre l'app. Quando la
// connessione riesce l'entry viene marcata meta.connected e il bot riceve un
// messaggio di sistema (CONNECTOR_CONNECTED) per proseguire.
// La stessa card con etichetta "Riconnetti" appare quando un token scade.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api, useStore } from '../store'
import type { ConnectorInfo, TranscriptEntry } from '../../../shared/types'

export function ConnectorCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const message = (entry.meta?.message ?? {}) as { connectorId?: string; name?: string; reason?: string }
  const [status, setStatus] = useState<'pending' | 'connecting' | 'connected' | 'failed'>(
    entry.meta?.connected ? 'connected' : 'pending'
  )
  const connectors = useStore((s) => s.connectors)

  // lo stato reale del connettore (la connessione può avvenire anche dalle Impostazioni)
  useEffect(() => {
    const live = connectors.find((c) => c.id === message.connectorId)
    if (live?.state.status === 'connected') setStatus('connected')
  }, [connectors, message.connectorId])

  if (!message.connectorId) return null
  const needsAuth = Boolean(entry.meta?.needsAuth)

  const connect = async (): Promise<void> => {
    setStatus('connecting')
    try {
      await api.connectorsConnect(message.connectorId!)
      // il flusso OAuth col browser dura qualche minuto: gli eventi
      // {type:'connectors'} aggiorneranno lo stato qui e nella vista Impostazioni
    } catch (e) {
      console.error('connectorsConnect:', e instanceof Error ? e.message : e)
      setStatus('failed')
    }
  }

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span className="text-base">{connectors.find((c) => c.id === message.connectorId)?.logo ?? '🔌'}</span>
        <span className="font-medium">{message.name ?? message.connectorId}</span>
        {needsAuth && <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">{t`token scaduto`}</span>}
      </div>
      {message.reason && <p className="mt-1 text-sm text-foreground">{message.reason}</p>}
      {needsAuth && !entry.meta?.connected && (
        <p className="mt-1 text-xs text-muted-foreground"><Trans>Il bot ha provato a usare questa app ma la sessione è scaduta.</Trans></p>
      )}
      {status === 'connected' ? (
        <p className="mt-2 text-xs text-chart-2"><Trans>✓ Connesso — il bot può usarlo</Trans></p>
      ) : (
        <button
          className="mt-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          disabled={status === 'connecting' || status === 'failed'}
          onClick={() => void connect()}
        >
          {status === 'connecting'
            ? <Trans>Autorizza nel browser…</Trans>
            : needsAuth
              ? <Trans>Riconnetti</Trans>
              : <Trans>Connetti</Trans>}
        </button>
      )}
    </div>
  )
}

/** Quale connettore serve a questa card (per il lookup del catalogo nella vista). */
export function connectorOf(connectors: ConnectorInfo[], id: string | undefined): ConnectorInfo | undefined {
  return connectors.find((c) => c.id === id)
}
