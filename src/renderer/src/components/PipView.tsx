// SV4 (fase schermo-vivo) — LA FINESTRA PiP: la vista dal vivo dello schermo
// del bot in una finestra del Mac che resta sopra le altre app. È un gesto
// ESPLICITO dell'utente: la sua connessione è una vista NORMALE che tiene
// vivo il browser come la scheda Computer (stesso tetto di 30 minuti), MAI
// un'avvio: con il browser spento mostra «Il bot non ha il browser aperto» e
// si collega da sola quando si accende (evento `screen`), aprendo la vista
// con { noLaunch: true }. Nessun controllo del mouse o della tastiera qui:
// per prendere il controllo c'è la scheda Computer («Apri in Homun»).
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { X, SquareArrowOutUpRight } from 'lucide-react'
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
 * La finestra si trascina ovunque (-webkit-app-region: drag sul fondo), tranne
 * sui bottoni; al passaggio del mouse compaiono il nome del bot con la
 * mascotte (in alto a sinistra) e «Apri in Homun» / «Chiudi» (in alto a destra).
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
    <div
      data-testid="pip-view"
      // trascinabile ovunque tranne i bottoni (no-drag) — la finestra non ha cornice
      className="group relative h-screen w-screen overflow-hidden bg-black"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* il canvas di noVNC: NESSUN input (pointer-events: none, aria-hidden) */}
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
      {/* al passaggio del mouse: in alto a sinistra il bot, in alto a destra i comandi */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2 opacity-0 transition group-hover:opacity-100">
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-black/50 px-2 py-1 text-white/90 backdrop-blur-sm">
          {info ? <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={20} label={undefined} /> : null}
          <span className="truncate text-xs font-medium">{info?.agent.name ?? ''}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            type="button"
            data-testid="pip-open-in-homun"
            className="flex items-center gap-1 rounded-lg bg-black/50 px-2 py-1 text-xs font-medium text-white/90 backdrop-blur-sm transition hover:bg-black/70"
            title={t`Apri in Homun`}
            onClick={() => { void api.pipFocusMain(agentId).catch(() => undefined) }}
          >
            <SquareArrowOutUpRight className="size-3.5" aria-hidden="true" />
            <Trans>Apri in Homun</Trans>
          </button>
          <button
            type="button"
            data-testid="pip-close"
            aria-label={t`Chiudi`}
            className="grid size-7 place-items-center rounded-lg bg-black/50 text-white/90 backdrop-blur-sm transition hover:bg-black/70"
            title={t`Chiudi`}
            onClick={() => { void api.pipClose().catch(() => undefined) }}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
