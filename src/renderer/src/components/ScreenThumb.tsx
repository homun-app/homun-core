// SV2 (fase schermo-vivo) — L'ANTEPRIMA DAL VIVO dello schermo del bot nella
// card «Computer»: la stessa RFB di noVNC della scheda Computer, PICCOLA e in
// sola lettura assoluta. Qui solo la vista: i fatti (browser acceso, scheda
// Attività visibile, finestra visibile, scheda Computer e PiP chiuse) si
// decidono nella funzione PURA thumbShouldConnect (screen-thumb.ts) e la
// connessione vive nel controller. Nessun input arriva MAI al box: il client
// è viewOnly, senza focus al clic, e il contenitore del canvas ha
// pointer-events: none — né mouse né tastiera. Il clic sulla card apre la
// scheda Computer (come oggi); il bottone «Stacca» apre la finestra PiP (SV4).
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { PictureInPicture2 } from 'lucide-react'
import { api, useStore } from '../store'
import { ScreenThumbController, type ThumbPhase, type ThumbRfb } from './screen-thumb'

/**
 * L'anteprima nella card «Computer». La zona è 16:10 della larghezza SOLO con
 * lo schermo collegato (o in collegamento); spenta resta il riquadro di oggi,
 * alto 96 px: niente salti di layout mentre il bot non usa il browser. Quando
 * il browser si chiude o la connessione cade, l'ultima immagine resta VELATA
 * con l'etichetta «Ultima immagine» per 60 s (mai un'immagine vecchia spacciata
 * per dal vivo); al riavvio dell'app non c'è nessuna immagine salvata.
 */
export function ScreenThumb({
  agentId,
  browserRunning,
  onDetach
}: {
  agentId: string
  browserRunning: boolean
  /** «Stacca»: apre la finestra PiP (SV4); il clic NON apre anche la scheda */
  onDetach?: () => void
}) {
  const { t } = useLingui()
  const holder = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<ThumbPhase>('idle')
  const [lastImage, setLastImage] = useState<string | null>(null)
  const [windowVisible, setWindowVisible] = useState(true)
  const panelTab = useStore((s) => s.panelTab)
  const pipAgentId = useStore((s) => s.pipAgentId)
  const controller = useRef<ScreenThumbController | null>(null)

  // la visibilità della finestra: nascosta = scollegato (il costo resta basso).
  // Il valore vero si legge NELL'EFFETTO: il render statico dei test non ha document
  useEffect(() => {
    const onVis = () => setWindowVisible(document.visibilityState === 'visible')
    setWindowVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // il controller vive quanto il componente (lo SMONTAGGIO della scheda
  // Attività, quando non è più quella visibile, scollega da solo)
  useEffect(() => {
    const c = new ScreenThumbController({
      openScreen: () => api.screenOpen(agentId, 'view', { peek: true }),
      createRfb: async (el, url, wsProtocols) => {
        const { default: RFB } = await import('@novnc/novnc')
        return new RFB(el as HTMLElement, url, { wsProtocols }) as unknown as ThumbRfb
      },
      captureImage: (el) => {
        const canvas = (el as HTMLElement | null)?.querySelector('canvas')
        try {
          return canvas ? canvas.toDataURL('image/png') : null
        } catch {
          return null
        }
      },
      element: () => holder.current,
      schedule: (fn, ms) => {
        const id = setTimeout(fn, ms)
        return () => clearTimeout(id)
      },
      onPhase: (p, img) => {
        setPhase(p)
        setLastImage(img)
      }
    })
    controller.current = c
    return () => {
      controller.current = null
      c.destroy()
    }
  }, [agentId])

  // i fatti cambiano → il controller collega o scollega (funzione pura)
  useEffect(() => {
    controller.current?.onFacts({
      browserRunning,
      // il componente è montato SOLO nella scheda Attività visibile
      activityTabVisible: true,
      windowVisible,
      computerTabOpen: panelTab === 'computer',
      pipOpen: pipAgentId === agentId
    })
  }, [browserRunning, windowVisible, panelTab, pipAgentId, agentId])

  const live = phase === 'connecting' || phase === 'connected'

  return (
    <div
      data-testid="bot-computer-thumb"
      className={`relative w-full ${live ? 'bg-black' : 'bg-black/85'}`}
      style={live ? { aspectRatio: '16 / 10' } : undefined}
    >
      {/* il canvas di noVNC vive qui — NESSUN input: niente puntatore, niente focus */}
      <div
        ref={holder}
        aria-hidden="true"
        className={live ? 'absolute inset-0 [&_canvas]:h-full [&_canvas]:w-full [&_canvas]:object-contain' : 'hidden'}
        style={{ pointerEvents: 'none' }}
      />
      {phase === 'idle' && (
        /* il riquadro di oggi: tre righe grigie, alto 96 px */
        <span className="block h-24 w-full px-3 pb-3 pt-2" aria-hidden="true">
          <span className="flex h-full flex-col justify-end gap-1.5 rounded-[8px] bg-white/5 p-2">
            <span className="h-1.5 w-3/5 rounded-full bg-white/20" />
            <span className="h-1.5 w-4/5 rounded-full bg-white/10" />
            <span className="h-1.5 w-2/5 rounded-full bg-white/10" />
          </span>
        </span>
      )}
      {phase === 'last' && lastImage && (
        /* l'ultima immagine, VELATA, con l'etichetta: mai come se fosse dal vivo */
        <span className="relative block h-24 w-full px-3 pb-3 pt-2">
          <img src={lastImage} alt="" className="h-full w-full rounded-[8px] object-cover opacity-40 grayscale" />
          <span className="absolute bottom-4 left-5 text-[10px] font-medium text-white/70">
            <Trans>Ultima immagine</Trans>
          </span>
        </span>
      )}
      {/* «Stacca»: apre la finestra PiP (SV4). Visibile al passaggio del mouse
          e da tastiera; il clic NON apre anche la scheda Computer */}
      <button
        type="button"
        data-testid="bot-computer-thumb-detach"
        aria-label={t`Stacca`}
        title={t`Stacca in una finestra`}
        className="absolute right-2 top-2 grid size-7 place-items-center rounded-lg bg-black/50 text-white opacity-0 transition focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation()
          onDetach?.()
        }}
      >
        <PictureInPicture2 className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}
