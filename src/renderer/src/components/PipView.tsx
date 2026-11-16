// SV4 (fase schermo-vivo) — LA FINESTRA PiP: la vista dal vivo dello schermo
// del bot in una finestra del Mac che resta sopra le altre app. È un gesto
// ESPLICITO dell'utente: la sua connessione è una vista NORMALE che tiene
// vivo il browser come la scheda Computer (stesso tetto di 30 minuti), MAI
// un'avvio: con il browser spento mostra «Il bot non ha il browser aperto» e
// si collega da sola quando si accende (evento `screen`), aprendo la vista
// con { noLaunch: true }. Nessun controllo del mouse o della tastiera qui:
// per prendere il controllo c'è la scheda Computer («Riporta in Homun»).
//
// U3 (fase prima-release): la barra in alto è SEMPRE visibile (stile
// mini-player) con mascotte+nome a sinistra e «Riporta in Homun»/«Chiudi» a
// destra — i comandi sotto l'hover non scattavano mai: su macOS un'area di
// trascinamento non riceve gli eventi del mouse. Solo la barra trascina la
// finestra; i bottoni sono no-drag e lo schermo sotto è no-drag e senza input.
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { X, CornerUpLeft } from 'lucide-react'
import type RFB from '@novnc/novnc'
import { api, useStore } from '../store'
import { useBotInfo } from '../bot/use-bot'
import { Bot } from '../bot/Bot'
import type { ScreenStatus } from '../../../shared/types'

/** La qualità della vista PiP: bilanciata (la finestra arriva a 960 px). */
export const PIP_QUALITY_LEVEL = 6

/** La compressione della vista PiP: bilanciata (default noVNC). */
export const PIP_COMPRESSION_LEVEL = 2

/**
 * La vista della finestra PiP (rotta #/pip/<agentId>, si rende SOLO lei).
 * La finestra si trascina dalla BARRA in alto (unica area drag); «Riporta in
 * Homun» è un gesto solo: chiude la PiP, porta la finestra principale in
 * primo piano (la ricrea se chiusa) e apre la scheda Computer del bot, dove
 * lo schermo torna da solo (SV5).
 */
export function PipView({ agentId }: { agentId: string }) {
  const { t } = useLingui()
  const info = useBotInfo(agentId)
  const [status, setStatus] = useState<ScreenStatus | null>(null)
  const holder = useRef<HTMLDivElement | null>(null)
  const rfb = useRef<RFB | null>(null)

  // i bot dello store (la finestra PiP ha il suo: qui si caricano per nome e
  // mascotte, nient'altro)
  useEffect(() => {
    if (useStore.getState().agents.length === 0) {
      void api.listAgents().then((agents) => { useStore.setState({ agents }) }).catch(() => undefined)
    }
    void api.screenStatus(agentId).then(setStatus).catch(() => undefined)
  }, [agentId])

  // lo stato del browser cambia (evento `screen`): la PiP si collega da sola
  // quando il browser si accende
  useEffect(() => {
    const off = api.onEvent((e) => {
      if (e.type === 'screen' && e.agentId === agentId) setStatus(e.status)
    })
    return off
  }, [agentId])

  // SV5: l'utente prende il CONTROLLO nella scheda Computer — il controllo ha
  // bisogno della vista grande e dello stesso schermo non servono due viste:
  // la PiP si chiude da sé appena il suo schermo risulta controllato
  useEffect(() => {
    if (status?.control) void api.pipClose().catch(() => undefined)
  }, [status?.control])

  // la connessione: SOLO se il browser è GIÀ acceso (noLaunch — la PiP non lo
  // avvia mai). Vista NORMALE in sola lettura: tiene vivo il timer come la
  // scheda Computer
  const browserRunning = status?.browser === 'running'
  // un contatore di ricollegamento: lo fa salire la caduta della connessione
  // con il browser ancora acceso (il caso raro: socket caduto, non spento)
  const [reconnect, setReconnect] = useState(0)
  useEffect(() => {
    if (!browserRunning) return
    let dead = false
    ;(async () => {
      const opened = await api.screenOpen(agentId, 'view', { noLaunch: true })
      if (dead || !opened) return // spento nel frattempo: aspetta l'evento
      const { default: RFBCls } = await import('@novnc/novnc')
      const el = holder.current
      if (dead || !el) return
      const client = new RFBCls(el, opened.url, { wsProtocols: ['binary'] })
      client.viewOnly = true // NESSUN controllo dal PiP
      client.scaleViewport = true // tutta la finestra
      client.clipViewport = false
      client.focusOnClick = false
      client.qualityLevel = PIP_QUALITY_LEVEL
      client.compressionLevel = PIP_COMPRESSION_LEVEL
      client.addEventListener('disconnect', () => {
        if (rfb.current === client) rfb.current = null
        // caduta con il browser ancora acceso: UN ritento tra un secondo
        // (se invece si è spento, riaprirà l'evento `screen`)
        setTimeout(() => { if (!dead) setReconnect((n) => n + 1) }, 1_000)
      })
      rfb.current = client
    })().catch(() => undefined)
    return () => {
      dead = true
      rfb.current?.disconnect()
      rfb.current = null
    }
  }, [agentId, browserRunning, reconnect])

  return (
    <div data-testid="pip-view" className="flex h-screen w-screen flex-col overflow-hidden bg-black">
      {/* la barra SEMPRE visibile (~28 px, stile mini-player): l'UNICA area di
          trascinamento — i bottoni sono no-drag, lo schermo sotto è no-drag */}
      <div
        data-testid="pip-bar"
        className="flex h-7 shrink-0 select-none items-center justify-between gap-2 bg-black/60 px-2 text-white/90"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {info ? <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={16} label={undefined} /> : null}
          <span className="truncate text-xs font-medium">{info?.agent.name ?? ''}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            type="button"
            data-testid="pip-bring-back"
            className="flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-white/90 transition hover:bg-white/20"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={t`Riporta in Homun`}
            onClick={() => { void api.pipFocusMain(agentId).catch(() => undefined) }}
          >
            <CornerUpLeft className="size-3.5" aria-hidden="true" />
            <Trans>Riporta in Homun</Trans>
          </button>
          <button
            type="button"
            data-testid="pip-close"
            aria-label={t`Chiudi`}
            className="grid size-6 place-items-center rounded-lg text-white/90 transition hover:bg-white/20"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={t`Chiudi`}
            onClick={() => { void api.pipClose().catch(() => undefined) }}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {/* lo schermo: NESSUN input e NESSUN trascinamento (pointer-events none, aria-hidden) */}
      <div className="relative min-h-0 flex-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div ref={holder} aria-hidden="true" className="absolute inset-0" style={{ pointerEvents: 'none' }} />
        {!browserRunning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
            {info ? (
              <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={64} label={info.agent.name} />
            ) : (
              <div className="h-16 w-16" aria-hidden="true" />
            )}
            <p className="text-sm text-muted-foreground">
              <Trans>Il bot non ha il browser aperto</Trans>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
