// Fase 16 (U1): hook e listener globali per il movimento della mascotte.
import { useEffect, useState } from 'react'

/** true se l'utente ha chiesto il movimento ridotto (matchMedia). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

type VisibilityListener = (hidden: boolean) => void

const visibilityListeners = new Set<VisibilityListener>()
let visibilityInstalled = false

/**
 * Fase 16 (U1): con document.hidden (finestra minimizzata o in un altro
 * spazio) le animazioni si fermano — classe 'bots-paused' su <html> per le
 * animazioni CSS, un avviso ai componenti per pauseAnimations() dello SMIL.
 * Un'app che resta aperta tutto il giorno non deve consumare CPU per
 * animare cose che nessuno vede.
 */
export function onBotsVisibility(fn: VisibilityListener): () => void {
  visibilityListeners.add(fn)
  if (!visibilityInstalled && typeof document !== 'undefined') {
    visibilityInstalled = true
    document.addEventListener('visibilitychange', () => {
      const hidden = document.hidden
      document.documentElement.classList.toggle('bots-paused', hidden)
      for (const l of visibilityListeners) l(hidden)
    })
  }
  return () => {
    visibilityListeners.delete(fn)
  }
}
