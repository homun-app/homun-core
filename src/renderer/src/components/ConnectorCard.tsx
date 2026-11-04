// Card dell'offerta di connessione (fase 5, funnel §3ter T2-T3): il bottone
// "Connetti" è dell'UTENTE — l'agente può solo proporre l'app. Quando la
// connessione riesce l'entry viene marcata meta.connected e il bot riceve un
// messaggio di sistema (CONNECTOR_CONNECTED) per proseguire.
// La stessa card con etichetta "Riconnetti" appare quando un token scade.
// Fase Composio OAuth (C5): le card «Collega <app> tramite Composio»
// (connectorId composio-app:<slug>) nascono dal flusso MANAGE_CONNECTIONS
// del server Composio — il clic apre il link nel browser e il daemon aspetta
// il login (WAIT_FOR_CONNECTIONS, 5 minuti, annullabile), la card si aggiorna
// a «Collegata» o «Non riuscito».
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api, useStore } from '../store'
import type { ConnectorInfo, TranscriptEntry } from '../../../shared/types'
import { logoUrlForSlug } from '../lib/app-logos'
import { CardShell } from './DecidedRow'

export function ConnectorCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const message = (entry.meta?.message ?? {}) as { connectorId?: string; name?: string; reason?: string }
  const [status, setStatus] = useState<'pending' | 'connecting' | 'connected' | 'failed'>(
    entry.meta?.connected ? 'connected' : 'pending'
  )
  const connectors = useStore((s) => s.connectors)
  // fase app (A4 punto 6): la card può proporre anche un'app Composio — il
  // bottone chiama l'attivazione Composio, il click resta dell'utente
  const composio = useStore((s) => s.composio)
  const isComposio = (message.connectorId ?? '').startsWith('composio:')
  const composioSlug = isComposio ? (message.connectorId ?? '').slice('composio:'.length) : null
  // fase Composio OAuth (C5): la card di collegamento del gateway
  const isGatewayApp = (message.connectorId ?? '').startsWith('composio-app:')
  const gatewaySlug = isGatewayApp ? (message.connectorId ?? '').slice('composio-app:'.length) : null
  const gatewayKey = entry.meta?.gatewayKey as string | undefined
  const composioGateway = useStore((s) => s.composioGateway)
  const refreshComposioGateway = useStore((s) => s.refreshComposioGateway)

  // lo stato reale del connettore (la connessione può avvenire anche dalle Impostazioni)
  useEffect(() => {
    const live = connectors.find((c) => c.id === message.connectorId)
    if (live?.state.status === 'connected') setStatus('connected')
    // fase app: lo stato reale di un'app Composio (collegata anche dalla finestra App)
    if (composioSlug && composio?.connected.some((a) => a.slug === composioSlug && a.status === 'ACTIVE')) setStatus('connected')
  }, [connectors, message.connectorId, composio, composioSlug])

  // C5: lo stato reale di un'app del gateway — collegata, in attesa o fallita;
  // mentre l'attesa è viva si rilegge ogni 2 s (il daemon emette {type:'connectors'})
  useEffect(() => {
    if (!gatewaySlug) return
    const app = composioGateway?.connected.find((a) => a.slug === gatewaySlug)
    if (app?.status === 'ACTIVE') setStatus('connected')
    else if (composioGateway?.pending?.slug === gatewaySlug) setStatus((s) => (s === 'connected' ? s : 'connecting'))
    else if (composioGateway?.pending?.failed) setStatus((s) => (s === 'connected' ? s : 'failed'))
  }, [composioGateway, gatewaySlug])
  useEffect(() => {
    if (!gatewaySlug || status !== 'connecting') return
    const timer = setInterval(() => { void refreshComposioGateway() }, 2000)
    return () => clearInterval(timer)
  }, [gatewaySlug, status, refreshComposioGateway])

  if (!message.connectorId) return null
  const needsAuth = Boolean(entry.meta?.needsAuth)
  // fase catalogo app (P7): il logo VERO del catalogo quando c'è (per le app
  // Composio; le curate dirette restano con l'emoji del connettore)
  const catalogLogo = composioSlug ?? gatewaySlug ? logoUrlForSlug((composioSlug ?? gatewaySlug)!) : null

  const connect = async (): Promise<void> => {
    setStatus('connecting')
    try {
      // fase app: l'app Composio si collega col flusso Composio (chiave già
      // attiva o foglio di attivazione dalla finestra App)
      if (composioSlug) {
        const r = await api.composioConnect(composioSlug)
        if (!r.started && r.error) setStatus('failed')
        return
      }
      // fase Composio OAuth (C5): il clic apre il link registrato dal daemon
      // e l'attesa del login aggiorna la card (polling qui sopra)
      if (gatewaySlug) {
        if (!gatewayKey) {
          setStatus('failed')
          return
        }
        const r = await api.composioGatewayCardConnect(gatewayKey)
        if (!r.ok) setStatus('failed')
        return
      }
      await api.connectorsConnect(message.connectorId!)
      // il flusso OAuth col browser dura qualche minuto: gli eventi
      // {type:'connectors'} aggiorneranno lo stato qui e nella vista Impostazioni
    } catch (e) {
      console.error('connectorsConnect:', e instanceof Error ? e.message : e)
      setStatus('failed')
    }
  }

  return (
    <CardShell testid="connector-card">
      <div className="flex items-center gap-2 text-sm text-foreground">
        {catalogLogo ? (
          <img src={catalogLogo} alt="" className="size-5 shrink-0 rounded-[6px] object-cover" />
        ) : (
          <span className="text-base">{connectors.find((c) => c.id === message.connectorId)?.logo ?? '🔌'}</span>
        )}
        {isGatewayApp ? (
          // C5 punto 1: «Collega <app> tramite Composio» — il link NON sta nel testo
          <span className="font-medium">{t`Collega ${message.name ?? ''} tramite Composio`}</span>
        ) : (
          <span className="font-medium">{message.name ?? message.connectorId}</span>
        )}
        {needsAuth && <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">{t`token scaduto`}</span>}
      </div>
      {message.reason && <p className="mt-1 text-sm text-foreground">{message.reason}</p>}
      {(isComposio || isGatewayApp) && (
        <p className="mt-1 text-[11px] text-muted-foreground"><Trans>Tramite Composio: login e azioni passano dai suoi server</Trans></p>
      )}
      {needsAuth && !entry.meta?.connected && (
        <p className="mt-1 text-xs text-muted-foreground"><Trans>Il bot ha provato a usare questa app ma la sessione è scaduta.</Trans></p>
      )}
      {isGatewayApp && (
        <p className="mt-1 text-xs text-muted-foreground">
          <Trans>Il bottone apre la pagina di login dell'app nel browser: finisci lì, poi la card si aggiorna da sola.</Trans>
        </p>
      )}
      {status === 'connected' ? (
        // fase 16b: lo stato «collegato» è testo verde, non un badge
        <p className="mt-2 text-sm text-chart-2"><Trans>✓ Collegata — il bot può usarla</Trans></p>
      ) : status === 'failed' ? (
        <p className="mt-2 text-sm text-destructive"><Trans>Non riuscito: chiedi al bot di riprovare il collegamento.</Trans></p>
      ) : (
        <button
          className="mt-2.5 rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
          disabled={status === 'connecting'}
          onClick={() => void connect()}
        >
          {status === 'connecting'
            ? <Trans>In attesa del login nel browser…</Trans>
            : needsAuth
              ? <Trans>Riconnetti</Trans>
              : isGatewayApp
                ? <Trans>Collega</Trans>
                : <Trans>Connetti</Trans>}
        </button>
      )}
    </CardShell>
  )
}

/** Quale connettore serve a questa card (per il lookup del catalogo nella vista). */
export function connectorOf(connectors: ConnectorInfo[], id: string | undefined): ConnectorInfo | undefined {
  return connectors.find((c) => c.id === id)
}
