// P1 (fase primo-avvio): il primo segnale dal renderer al main. Montato
// accanto alla finestra vera (App, o la PiP: è la stessa pagina) dice al main
// «React ha montato, il frame è passato» con l'IPC locale app:first-paint: il
// main lo scrive nel registro come renderer-ready ms=….
// P3.4: a pagina NASCOSTA (finestra coperta o mai mostrata) il frame non
// arriva: dopo 2 s il segnale parte lo stesso, con framed=false (nel registro
// renderer-ready … frame=0) — così si sa che React ha montato anche lì.
// Non rende nulla.
import { useEffect } from 'react'
import { api } from '../store'
import { signalFirstPaintAfterFrame } from '../lib/first-paint'

export function FirstPaintSignal(): null {
  useEffect(
    () =>
      signalFirstPaintAfterFrame(
        () => {
          void api.firstPaint(true).catch(() => undefined)
        },
        undefined,
        undefined,
        {
          isHidden: () => document.visibilityState === 'hidden',
          onFallback: () => {
            void api.firstPaint(false).catch(() => undefined)
          }
        }
      ),
    []
  )
  return null
}
