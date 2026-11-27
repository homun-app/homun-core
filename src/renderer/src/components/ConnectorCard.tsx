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
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Plug } from 'lucide-react'
import { api, useStore } from '../store'
import type { TranscriptEntry } from '../../../shared/types'
import { logoUrlForSlug } from '../lib/app-logos'
import { composioRouteFor } from '../lib/connector-route'
// B3 (fase b20-bug): l'esito che il daemon pubblica per i flussi in background (stessa regola della riga)
import { appConnectPublishedFailure } from '../lib/app-connect-flow'
// K2 (fase conversione-chat): la card è LOGICA — i dati e i clic — sopra ProposalCard, l'oggetto del catalogo (a sua volta sopra ChatCard, il guscio): la testata col logo o col segno, l'etichetta, le righe, lo stato e la riga delle azioni sono suoi slot; qui non si disegna più niente (stessi testi, azioni e testid di prima)
import { ProposalCard } from './ui/proposal-card'
import { Stack } from './ui/stack'
import { Tag } from './ui/tag'
import { Text } from './ui/text'
import { Button } from './ui/button'

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
  // V6 (prova vera): l'utente ha annullato DALLA CARD → torna a «Collega»;
  // il flag distingue l'annullo volontario dall'attesa finita male (Riprova)
  const cancelledHere = useRef(false)
  // B3 (fase b20-bug): sulla strada di apps:connect il motivo quando non è
  // partito (dalla risposta, o dall'esito che il daemon pubblica per i flussi
  // in background) — la card non resta «In attesa del login…» per sempre
  const [routeError, setRouteError] = useState('')
  const routeClickedAt = useRef(0)

  // Verifica impostazioni: una curata diretta che non può aprire il login
  // (Gmail di Google senza client OAuth) segue la strada della finestra App —
  // apps:connect, cioè il login di Composio e poi l'app. Null = strada diretta.
  const route = useMemo(
    () => (isComposio || isGatewayApp ? null : composioRouteFor(message.connectorId, connectors)),
    [isComposio, isGatewayApp, message.connectorId, connectors]
  )

  // lo stato reale del connettore (la connessione può avvenire anche dalle Impostazioni)
  useEffect(() => {
    const live = connectors.find((c) => c.id === message.connectorId)
    if (live?.state.status === 'connected') setStatus('connected')
    // verifica impostazioni: il flusso può fermarsi PRIMA del browser (per
    // esempio un connettore Google senza client OAuth): lo stato vero passa a
    // 'error' e la card non deve restare «In attesa del login…» per sempre.
    // L'effetto rigira solo quando arriva un evento {type:'connectors'}, quindi
    // un errore vecchio non chiude subito un nuovo tentativo
    // (solo sulla strada diretta: su quella di Composio l'errore vecchio del
    // connettore diretto non dice niente del tentativo in corso)
    if (!route && live?.state.status === 'error') setStatus((s) => (s === 'connecting' ? 'failed' : s))
    // fase app: lo stato reale di un'app Composio (collegata anche dalla finestra App)
    if (composioSlug && composio?.connected.some((a) => a.slug === composioSlug && a.status === 'ACTIVE')) setStatus('connected')
  }, [connectors, message.connectorId, composio, composioSlug, route])

  // C5: lo stato reale di un'app del gateway — collegata, in attesa o fallita;
  // mentre l'attesa è viva si rilegge ogni 2 s (il daemon emette {type:'connectors'}).
  // V6 (prova vera): quando il gateway NON ha più un'attesa per questo slug la
  // card non resta MAI «in attesa»: o è collegata, o è fallita (Riprova), o è
  // tornata a «Collega» dopo l'annullo di qui
  useEffect(() => {
    if (!gatewaySlug) return
    const app = composioGateway?.connected.find((a) => a.slug === gatewaySlug)
    if (app?.status === 'ACTIVE') {
      setStatus('connected')
      return
    }
    const pending = composioGateway?.pending
    if (pending?.slug === gatewaySlug) {
      setStatus((s) => (s === 'connected' ? s : pending.failed ? 'failed' : 'connecting'))
      return
    }
    setStatus((s) => {
      if (s === 'connected') return s
      if (cancelledHere.current) return 'pending'
      return s === 'connecting' || s === 'failed' ? 'failed' : s
    })
  }, [composioGateway, gatewaySlug])
  useEffect(() => {
    if (!gatewaySlug || status !== 'connecting') return
    const timer = setInterval(() => { void refreshComposioGateway() }, 2000)
    return () => clearInterval(timer)
  }, [gatewaySlug, status, refreshComposioGateway])

  const refreshConnectors = useStore((s) => s.refreshConnectors)
  useEffect(() => {
    if (!route) return
    if (composioGateway?.connected.some((a) => a.slug === route.composioSlug && a.status === 'ACTIVE')) {
      setStatus('connected')
      return
    }
    const pending = composioGateway?.pending
    if (pending?.slug === route.composioSlug && pending.failed) setStatus((s) => (s === 'connecting' ? 'failed' : s))
    // B3: finito male in background (per esempio il login di Composio) — solo l'esito di QUESTO clic
    const failed = appConnectPublishedFailure(route.appId, routeClickedAt.current, composioGateway?.appConnect)
    if (failed) {
      setRouteError(failed.error)
      setStatus((s) => (s === 'connecting' ? 'failed' : s))
    }
  }, [route, composioGateway])
  useEffect(() => {
    if (!route || status !== 'connecting') return
    // come la finestra App: durante il login e l'attesa dell'app si rilegge
    const timer = setInterval(() => {
      void refreshConnectors()
      void refreshComposioGateway()
    }, 2000)
    return () => clearInterval(timer)
  }, [route, status, refreshConnectors, refreshComposioGateway])

  if (!message.connectorId) return null
  const needsAuth = Boolean(entry.meta?.needsAuth)
  const liveError = route ? undefined : connectors.find((c) => c.id === message.connectorId)?.state.error
  // fase catalogo app (P7): il logo VERO del catalogo quando c'è (per le app
  // Composio; le curate dirette hanno il segno lucide di un collegamento —
  // prima l'emoji del connettore: nell'interfaccia non ce ne sono, DS4)
  const catalogLogo = composioSlug ?? gatewaySlug ? logoUrlForSlug((composioSlug ?? gatewaySlug)!) : null

  const connect = async (): Promise<void> => {
    setStatus('connecting')
    cancelledHere.current = false
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
      // la strada della finestra App (login di Composio, poi l'app): il
      // collegamento lo decide apps:connect, come il «Connetti» delle App
      if (route) {
        routeClickedAt.current = Date.now()
        setRouteError('')
        const r = await api.appsConnect(route.appId)
        // B3: non partito → il motivo (prima solo «Non riuscito», o peggio l'attesa senza fine)
        if (!r.started) {
          setRouteError(r.error ?? '')
          setStatus('failed')
        }
        void refreshConnectors().catch(() => undefined)
        void refreshComposioGateway().catch(() => undefined)
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

  // V6 (prova vera): Annulla durante l'attesa — l'attesa del login si ferma e
  // la card torna a «Collega»
  const cancelGateway = async (): Promise<void> => {
    cancelledHere.current = true
    try { await api.composioGatewayCancel() } catch { /* il gateway può essere già fermo */ }
    await refreshComposioGateway().catch(() => undefined)
    setStatus('pending')
  }

  const cancelRoute = async (): Promise<void> => {
    if (!route) return
    try { await api.appsCancelConnect(route.appId) } catch { /* già fermo */ }
    void refreshConnectors()
    void refreshComposioGateway()
    setStatus('pending')
  }

  // V6 (prova vera): Riprova dopo un fallimento — chiede un link NUOVO
  // (quello vecchio è monouso) con una nuova chiamata `add` e una nuova attesa
  const retryGateway = async (): Promise<void> => {
    if (!gatewaySlug) return
    cancelledHere.current = false
    setStatus('connecting')
    try {
      const r = await api.composioGatewayConnect(gatewaySlug, message.name ?? undefined)
      if (!r.ok && !r.already) setStatus('failed')
      await refreshComposioGateway().catch(() => undefined)
    } catch {
      setStatus('failed')
    }
  }

  // K2: le righe grigie — la strada (Composio), la sessione scaduta, cosa fa il bottone
  const righe = (
    <>
      {(isComposio || isGatewayApp || route) && <Text size="small" tone="muted"><Trans>Tramite Composio: login e azioni passano dai suoi server</Trans></Text>}
      {needsAuth && !entry.meta?.connected && <Text size="small" tone="muted"><Trans>Il bot ha provato a usare questa app ma la sessione è scaduta.</Trans></Text>}
      {isGatewayApp && (
        <Text size="small" tone="muted">
          <Trans>Il bottone apre la pagina di login dell'app nel browser: finisci lì, poi la card si aggiorna da sola.</Trans>
        </Text>
      )}
    </>
  )

  // la coda: lo stato finale, oppure la riga delle azioni (con accanto, quando serve, lo stato che dura)
  let stato: ReactNode
  let azioni: ReactNode
  if (status === 'connected') {
    // fase 16b: lo stato «collegato» è testo verde, non un badge
    stato = <Text tone="ok"><Trans>✓ Collegata — il bot può usarla</Trans></Text>
  } else if (status === 'failed' && isGatewayApp) {
    // V6 (prova vera): l'attesa è finita male (timeout, errore) — Riprova
    // chiede un link NUOVO, perché quello vecchio è monouso
    azioni = (
      <>
        <Text tone="destructive"><Trans>Non riuscito</Trans></Text>
        <Button onClick={() => void retryGateway()}>
          <Trans>Riprova</Trans>
        </Button>
      </>
    )
  } else if (status === 'failed') {
    // verifica impostazioni: il motivo vero (dallo stato del connettore),
    // non solo «non riuscito»
    stato = (
      <Stack gap="tight">
        <Text tone="destructive"><Trans>Non riuscito: chiedi al bot di riprovare il collegamento.</Trans></Text>
        {liveError && <Text size="small" tone="muted">{liveError}</Text>}
        {/* B3: sulla strada di Composio il motivo in parole (per esempio: l'app senza configurazione di accesso) */}
        {routeError && <Text size="small" tone="muted" testId="connector-card-error">{routeError}</Text>}
      </Stack>
    )
  } else if (status === 'connecting' && route) {
    // la strada della finestra App: anche qui Annulla durante l'attesa
    azioni = (
      <>
        <Text tone="muted"><Trans>In attesa del login nel browser…</Trans></Text>
        <Button variant="ghost" onClick={() => void cancelRoute()}>
          <Trans>Annulla</Trans>
        </Button>
      </>
    )
  } else if (status === 'connecting' && isGatewayApp) {
    // V6 (prova vera): durante l'attesa c'è ANNULLA — la card torna a «Collega»
    azioni = (
      <>
        <Text tone="muted"><Trans>In attesa del login nel browser…</Trans></Text>
        <Button variant="ghost" onClick={() => void cancelGateway()}>
          <Trans>Annulla</Trans>
        </Button>
      </>
    )
  } else {
    azioni = (
      <Button disabled={status === 'connecting'} onClick={() => void connect()}>
        {status === 'connecting'
          ? <Trans>In attesa del login nel browser…</Trans>
          : needsAuth
            ? <Trans>Riconnetti</Trans>
            : isGatewayApp
              ? <Trans>Collega</Trans>
              : <Trans>Connetti</Trans>}
      </Button>
    )
  }

  return (
    <ProposalCard
      testId="connector-card"
      logo={catalogLogo}
      icona={catalogLogo ? undefined : Plug}
      titolo={isGatewayApp
        // C5 punto 1: «Collega <app> tramite Composio» — il link NON sta nel testo
        ? t`Collega ${message.name ?? ''} tramite Composio`
        : (message.name ?? message.connectorId)}
      nota={needsAuth ? <Tag tone="error">{t`token scaduto`}</Tag> : undefined}
      righe={righe}
      perché={message.reason ? <Text>{message.reason}</Text> : undefined}
      stato={stato}
      azioni={azioni}
    />
  )
}
