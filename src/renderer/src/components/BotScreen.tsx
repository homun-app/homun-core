// Fase 19a (V4): il pannello dello SCHERMO del bot — la vista dal vivo del
// desktop nel box (il display Xvfb col browser headful), in sola lettura di
// default, con la presa di controllo dell'utente. Il client è la classe RFB
// di noVNC (1.7.0, MPL-2.0) usata direttamente nel renderer, senza iframe:
// si collega al ponte WebSocket del daemon con una capability MONOUSO.
// Stati visibili: connessione, connesso, «Il bot non ha uno schermo aperto»
// (con Apri), errore (con Riprova); se entro 15 s non arriva `connect` si
// mostra l'errore, non un riquadro nero.
//
// Fase design (DS4, con la barra di sinistra): il pannello ai token di DS1 —
// cambia soltanto COME SI VEDE. Il titolo del blocco è text-body 500 e lo
// stato sotto un metadato (text-caption grigio); i comandi passano dal pezzo
// Button (da 32, text-body, col raggio dei controlli); «Chiudi» è un'icona
// lucide e non più il carattere «✕»; i campi sono alti 36. Resta scritto a
// mano UN solo bottone, «Ho finito»: ha il colore del bot, e Button non ha
// una variante per lui — prende però le classi del pezzo (buttonVariants).
import { useEffect, useRef, useState } from 'react'
// U8 correzione #2 (dalla sonda fase-prima-release): noVNC si importa
// DINAMICAMENTE, come già PipView e ScreenThumb — l'import STATICO nel
// bundle del renderer principale non si collegava MAI (la connessione si
// chiudeva subito), mentre le viste con l'import dinamico funzionavano

import { useLingui, Trans } from '@lingui/react/macro'
import { PictureInPicture2, X } from 'lucide-react'
import { api, useStore } from '../store'
import { useBotInfo } from '../bot/use-bot'
import { ipcErrorMessage } from '../lib/ipc-error'
import { Button, buttonVariants } from './ui/button'
import type RFB from '@novnc/novnc'
import type { ScreenStatus } from '../../../shared/types'

/** I 15 s entro cui deve arrivare `connect`, o si mostra l'errore. */
const CONNECT_TIMEOUT_MS = 15_000

export function BotScreen({ agentId, onClose, inPanel = false }: { agentId: string; onClose?: () => void; inPanel?: boolean }) {
  const { t } = useLingui()
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId))
  const info = useBotInfo(agentId)
  // il colore del bot per il bordo di controllo (token, mai un colore CSS)
  const color = info ? `var(--bot-${info.avatar.color})` : 'var(--foreground)'
  const busy = agent?.status === 'thinking' || agent?.status === 'running' || agent?.status === 'paused-for-approval'
  // fase 19b (T1): il modo iniziale lo decide il pannello (la card della
  // presa di controllo lo apre GIÀ in controllo)
  const initialMode = useStore((s) => s.computerPanel.mode)
  const [mode, setMode] = useState<'view' | 'control'>(initialMode)
  // SV5 (fase schermo-vivo): lo schermo di QUESTO bot è in una finestra PiP?
  const pipForMe = useStore((s) => s.pipAgentId === agentId)
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
  // SV5: il modo VISTO dagli effetti (la riapertura dopo la PiP vale solo in vista)
  const modeRef = useRef<'view' | 'control'>(initialMode)
  useEffect(() => { modeRef.current = mode }, [mode])

  const destroy = () => {
    rfb.current?.disconnect()
    rfb.current = null
  }

  const open = async (wanted: 'view' | 'control') => {
    if (opening.current) return
    // SV5: lo schermo di questo bot è in una finestra a parte — la vista
    // grande resta giù finché la PiP non si chiude
    if (useStore.getState().pipAgentId === agentId) return
    opening.current = true
    destroy()
    setError('')
    setPhase('opening')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // screen:open avvia il browser del bot (lazy) e torna l'URL con la
      // capability monouso; su bot occupato risponde rpcScreenBotBusy.
      // SV1: senza opts non torna MAI null (il browser lo avvia lui), il
      // controllo del tipo resta per i chiamanti con { peek } / { noLaunch }
      const opened = await api.screenOpen(agentId, wanted)
      if (!opened) {
        setPhase('error')
        setError(t`Il bot non ha uno schermo aperto.`)
        return
      }
      const { url } = opened
      setMode(wanted)
      setPhase('connecting')
      const el = holder.current
      if (!el) return
      const { default: RFB } = await import('@novnc/novnc')
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
      // fase 19b (T8.2): niente prefisso grezzo «Error invoking remote method…»
      setError(ipcErrorMessage(e))
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

  // SV5: la PiP di questo bot si apre → la vista grande si SCOLLEGA (la
  // stessa cosa in grande basta una volta); si chiude → la vista torna. La
  // riapertura vale solo in VISTA: se nel frattempo l'utente ha preso il
  // CONTROLLO, il posto è suo
  const pipRef = useRef(pipForMe)
  useEffect(() => {
    if (pipForMe === pipRef.current) return
    pipRef.current = pipForMe
    if (pipForMe) {
      destroy()
      setPhase('idle')
    } else if (modeRef.current === 'view') {
      void open('view')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipForMe])

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
      className={inPanel ? 'flex h-full flex-col overflow-y-auto scroll-thin' : 'mx-5 mt-3 flex flex-col overflow-hidden rounded-surface border bg-card shadow-soft'}
      style={inPanel ? { borderColor: mode === 'control' && phase === 'connected' ? color : undefined } : undefined}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0">
          {/* fase design (DS4): «Schermo del bot» è il TITOLO del blocco, non
              un sopratitolo (prima: 10 px in maiuscoletto, e i maiuscoletti
              non esistono più). Lo stato sotto di lui è un metadato */}
          <p className="truncate text-body font-medium">
            <Trans>Schermo del bot</Trans>
          </p>
          {mode === 'control' && phase === 'connected' ? (
            <p className="truncate text-caption font-medium" style={{ color }}>
              <Trans>Stai controllando lo schermo di {agent?.name ?? ''}</Trans>
            </p>
          ) : (
            <p className="truncate text-caption text-muted-foreground">
              {phase === 'connected' || phase === 'connecting'
                ? t`Sola lettura — il bot non vede il tuo cursore`
                : t`Vista dal vivo del computer del bot`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* SV5: «Stacca» sta SEMPRE accanto ai comandi (anche a browser
              spento: la PiP allora dice che non c'è il browser) — tranne quando
              lo schermo è già nella finestra a parte */}
          {!pipForMe && (
            <Button
              variant="secondary"
              size="sm"
              data-testid="bot-screen-detach"
              title={t`Stacca in una finestra`}
              onClick={() => { void api.pipOpen(agentId).catch(() => undefined) }}
            >
              <PictureInPicture2 className="size-4" aria-hidden="true" />
              <Trans>Stacca</Trans>
            </Button>
          )}
          {/* U9 (fase prima-release): in controllo «Ho finito» sta QUI, nel
              posto di «Prendi il controllo», col colore del bot — col piede
              fuori vista non c'era più modo di chiudere. Fase design (DS4): è
              un bottone del pezzo (primary: l'azione principale, da 32) col
              colore del bot al posto del fondo, scritto in stile in linea
              perché vince sulla classe. Rettangolare come gli altri comandi
              della testata (shape «control»): qui è una riga di comandi, non
              l'azione di una pagina */}
          {mode === 'control' && (
            <button
              data-testid="bot-screen-done"
              className={buttonVariants({ size: 'sm', shape: 'control' })}
              style={{ background: color }}
              title={t`Chiude il controllo e torna alla vista`}
              onClick={() => { void release() }}
            >
              <Trans>Ho finito</Trans>
            </button>
          )}
          {phase === 'connected' && mode === 'view' && (
            busy ? (
              <Button
                variant="secondary"
                size="sm"
                title={t`Interrompe il turno del bot e apre il controllo`}
                onClick={() => {
                  void api.interrupt(agentId).catch(() => undefined).finally(() => void open('control'))
                }}
              >
                <Trans>Ferma e prendi il controllo</Trans>
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void open('control')}>
                <Trans>Prendi il controllo</Trans>
              </Button>
            )
          )}
          {!inPanel && (
            // fase design (DS4): un'icona lucide in un bottone tondo da 32 — il
            // ghost solo-icona di Button — al posto del carattere «✕»
            <Button variant="ghost" size="sm" icon title={t`Chiudi`} onClick={() => { destroy(); onClose?.() }}>
              <X className="size-4" />
            </Button>
          )}
        </div>
      </header>

      {/* il canvas di noVNC vive qui — SPARISCE mentre lo schermo è nella PiP */}
      {pipForMe ? (
        <div className="flex min-h-80 flex-1 flex-col items-center justify-center gap-3 bg-black/40 px-6 text-center">
          <p className="text-body text-muted-foreground">
            <Trans>Lo schermo è in una finestra a parte</Trans>
          </p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="bot-screen-restore"
            onClick={() => { void api.pipClose().catch(() => undefined) }}
          >
            <Trans>Riporta qui</Trans>
          </Button>
        </div>
      ) : (
        <div ref={holder} className="min-h-0 flex-1 bg-black/90" />
      )}

      {mode === 'control' && phase === 'connected' && (
        <footer className="space-y-2 border-t border-border px-4 py-3">
          <input
            className="h-control w-full rounded-control bg-muted px-3 text-body outline-none placeholder:text-muted-foreground"
            placeholder={t`Nota per il bot (facoltativa): cosa hai fatto…`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </footer>
      )}

      {(phase === 'opening' || phase === 'connecting') && (
        <p className="border-t border-border px-4 py-3 text-center text-caption text-muted-foreground">
          <Trans>Connessione allo schermo…</Trans>
        </p>
      )}
      {noScreen && (
        <div className="border-t border-border px-4 py-6 text-center">
          <p className="text-body text-muted-foreground"><Trans>Il bot non ha uno schermo aperto.</Trans></p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void open('view')}>
            <Trans>Apri</Trans>
          </Button>
        </div>
      )}
      {phase === 'error' && status?.browser !== 'stopped' && (
        <div className="border-t border-border px-4 py-6 text-center">
          <p className="text-body text-destructive/90">{error || t`Errore di connessione.`}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void open(mode)}>
            <Trans>Riprova</Trans>
          </Button>
        </div>
      )}
      {phase === 'connected' && status?.takeoverPending && (
        <p className="border-t border-border px-4 py-2 text-center text-caption text-muted-foreground">
          <Trans>Il bot ti sta chiedendo di intervenire sul suo schermo.</Trans>
        </p>
      )}
    </section>
  )
}
