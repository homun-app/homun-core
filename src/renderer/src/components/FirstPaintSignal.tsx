// P1 (fase primo-avvio): il primo segnale dal renderer al main. Montato
// accanto alla finestra vera (App, o la PiP: è la stessa pagina) dice al main
// «React ha montato, il frame è passato» con l'IPC locale app:first-paint: il
// main lo scrive nel registro come renderer-ready ms=…. Non rende nulla.
import { useEffect } from 'react'
import { api } from '../store'
import { signalFirstPaintAfterFrame } from '../lib/first-paint'

export function FirstPaintSignal(): null {
  useEffect(
    () =>
      signalFirstPaintAfterFrame(() => {
        void api.firstPaint().catch(() => undefined)
      }),
    []
  )
  return null
}
