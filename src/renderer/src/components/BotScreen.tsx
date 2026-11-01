// Fase 19a (V4): il pannello dello SCHERMO del bot — la vista dal vivo del
// desktop nel box (il display Xvfb col browser headful), in sola lettura di
// default, con la presa di controllo dell'utente. Il client è la classe RFB
// di noVNC (1.7.0, MPL-2.0) usata direttamente nel renderer, senza iframe:
// si collega al ponte WebSocket del daemon con una capability MONOUSO.
// Stati visibili: connessione, connesso, «Il bot non ha uno schermo aperto»
// (con Apri), errore (con Riprova); se entro 15 s non arriva `connect` si
// mostra l'errore, non un riquadro nero.
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import RFB from '@novnc/novnc'
import { api, useStore } from '../store'
import { useBotInfo } from '../bot/use-bot'
import type { ScreenStatus } from '../../../shared/types'

/** I 15 s entro cui deve arrivare `connect`, o si mostra l'errore. */
const CONNECT_TIMEOUT_MS = 15_000

export function BotScreen({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { t } = useLingui()
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId))
  const info = useBotInfo(agentId)
  // il colore del bot per il bordo di controllo (token, mai un colore CSS)
  const color = info ? `var(--bot-${info.avatar.color})` : 'var(--foreground)'
  const busy = agent?.status === 'thinking' || agent?.status === 'running' || agent?.status === 'paused-for-approval'
  const initialMode = useStore((s) => s.botScreen.mode)
  const [mode, setMode] = useState<'view' | 'control'>(initialMode)
  const [phase, setPhase] = useState<'idle' | 'opening' | 'connecting' | 'connected' | 'error'>('idle')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<ScreenStatus | null>(null)
  const [note, setNote] = useState('')
  const holder = useRef<HTMLDivElement | null>(null)
  const rfb = useRef<RFB | null>(null)
  const opening = useRef(false)
  // la fase vista dai listener di noVNC (evita le stale closure)
  const phaseRef = useRef(phase)
  useEffect(() => { phaseRef.current = phase }, [phase])

  const destroy = () => {
    rfb.current?.disconnect()
    rfb.current = null
  }

  const open = async (wanted: 'view' | 'control') => {
    if (opening.current) return
    opening.current = true
    destroy()
    setError('')
    setPhase('opening')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // screen:open avvia il browser del bot (lazy) e torna l'URL con la
      // capability monouso; su bot occupato risponde rpcScreenBotBusy
      const { url } = await api.screenOpen(agentId, wanted)
      setMode(wanted)
      setPhase('connecting')
      const el = holder.current
      if (!el) return
      const client = new RFB(el, url, { wsProtocols: ['binary'] })
      rfb.current = client
      client.viewOnly = wanted === 'view'
      client.scaleViewport = true
      client.addEventListener('connect', () => {
        if (timer) clearTimeout(timer)
        setPhase('connected')
      })
      client.addEventListener('disconnect', (e) => {
        if (timer) clearTimeout(timer)
        rfb.current = null
        // chiusura VOLONTARIA (release o chiusura del pannello): niente errore
        const was = phaseRef.current
        if ((e as CustomEvent<{ clean?: boolean }>).detail?.clean && was === 'connected') {
          setPhase('idle')
        } else if (was === 'connected' || was === 'connecting') {
          setPhase('error')
          setError(t`La connessione allo schermo si è chiusa.`)
        }
      })
      // se entro 15 s non arriva connect: errore, mai un riquadro nero
      timer = setTimeout(() => {
        if (rfb.current) {
          destroy()
          setPhase('error')
          setError(t`Lo schermo non risponde.`)
        }
      }, CONNECT_TIMEOUT_MS)
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      opening.current = false
    }
  }

  // all'apertura del pannello: stato + connessione SUBITO (in vista, o in
  // controllo se l'ha chiesto la card della presa di controllo)
  useEffect(() => {
    void api.screenStatus(agentId).then(setStatus).catch(() => undefined)
    void open(initialMode)
    return () => {
      destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  // lo evento `screen` aggiorna lo stato mostrato (browser, controllo, attesa)
  useEffect(() => {
    const off = api.onEvent((e) => {
      if (e.type === 'screen' && e.agentId === agentId) setStatus(e.status)
    })
    return off
  }, [agentId])

  // «Ho finito»: chiude il controllo (con l'eventuale nota per il bot) e
  // torna in vista
  const release = async () => {
    try {
      await api.screenRelease(agentId, note.trim() || undefined)
    } catch {
      // anche se la risposta non arriva, il daemon chiude il controllo
    }
    setNote('')
    await open('view')
  }

  const noScreen = phase === 'idle' || (phase === 'error' && status?.browser === 'stopped')

  return (
    <section
      className="mx-5 mt-3 flex flex-col overflow-hidden rounded-xl border bg-card shadow-soft"
      style={{ borderColor: mode === 'control' && phase === 'connected' ? color : undefined }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <Trans>Schermo del bot</Trans>
          </p>
          {mode === 'control' && phase === 'connected' ? (
            <p className="truncate text-xs font-medium" style={{ color }}>
              <Trans>Stai controllando lo schermo di {agent?.name ?? ''}</Trans>
            </p>
          ) : (
            <p className="truncate text-xs text-muted-foreground">
              {phase === 'connected' || phase === 'connecting'
                ? t`Sola lettura — il bot non vede il tuo cursore`
                : t`Vista dal vivo del computer del bot`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {phase === 'connected' && mode === 'view' && (
            busy ? (
              <button
                className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
                title={t`Interrompe il turno del bot e apre il controllo`}
                onClick={() => {
                  void api.interrupt(agentId).catch(() => undefined).finally(() => void open('control'))
                }}
              >
                <Trans>Ferma e prendi il controllo</Trans>
              </button>
            ) : (
              <button
                className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
                onClick={() => void open('control')}
              >
                <Trans>Prendi il controllo</Trans>
              </button>
            )
          )}
          <button
            className="rounded-md px-2 py-1 text-muted-foreground transition hover:text-foreground"
            title={t`Chiudi`}
            onClick={() => { destroy(); onClose() }}
          >
            ✕
          </button>
        </div>
      </header>

      {/* il canvas di noVNC vive qui */}
      <div ref={holder} className="min-h-[320px] flex-1 bg-black/90" />

      {mode === 'control' && phase === 'connected' && (
        <footer className="space-y-2 border-t border-border px-4 py-3">
          <input
            className="w-full rounded-lg bg-muted px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
            placeholder={t`Nota per il bot (facoltativa): cosa hai fatto…`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
            style={{ background: color }}
            onClick={() => void release()}
          >
            <Trans>Ho finito</Trans>
          </button>
        </footer>
      )}

      {(phase === 'opening' || phase === 'connecting') && (
        <p className="border-t border-border px-4 py-3 text-center text-xs text-muted-foreground">
          <Trans>Connessione allo schermo…</Trans>
        </p>
      )}
      {noScreen && (
        <div className="border-t border-border px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground"><Trans>Il bot non ha uno schermo aperto.</Trans></p>
          <button
            className="mt-3 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
            onClick={() => void open('view')}
          >
            <Trans>Apri</Trans>
          </button>
        </div>
      )}
      {phase === 'error' && status?.browser !== 'stopped' && (
        <div className="border-t border-border px-4 py-6 text-center">
          <p className="text-sm text-destructive/90">{error || t`Errore di connessione.`}</p>
          <button
            className="mt-3 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
            onClick={() => void open(mode)}
          >
            <Trans>Riprova</Trans>
          </button>
        </div>
      )}
      {phase === 'connected' && status?.takeoverPending && (
        <p className="border-t border-border px-4 py-2 text-center text-xs text-muted-foreground">
          <Trans>Il bot ti sta chiedendo di intervenire sul suo schermo.</Trans>
        </p>
      )}
    </section>
  )
}
