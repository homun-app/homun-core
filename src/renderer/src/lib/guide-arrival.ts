// G6 (fase guida): l'arrivo in chat — la mascotte VOLA dalla scena della
// guida alla sua posizione nel pannello del bot, con un FLIP via Web
// Animations (~450 ms): si misura la mascotte della scena PRIMA che la
// guida chiuda, e quando la shell è in campo si anima un fantasma fisso
// fino al bersaglio. Con prefers-reduced-motion, o se il bersaglio non si
// trova, niente volo: la finestra cambia e basta (semplice dissolvenza).
const FLIGHT_MS = 450

/** L'ultimo volo parcheggiato (la scena misurata prima della chiusura). */
let stash: { rect: DOMRect; node: HTMLElement } | null = null

/** Misura la mascotte della scena della guida (da chiamare PRIMA dell'avanzare). */
export function stashMascotFlight(): void {
  const el = document.querySelector('[data-testid="guide-scene"] .bot')
  if (el instanceof HTMLElement) stash = { rect: el.getBoundingClientRect(), node: el }
}

/**
 * Il volo del fantasma fino alla mascotte del pannello del bot (o, se il
 * pannello è chiuso, alla prima mascotte della shell). Fa DA SÉ la pulizia.
 */
export function flyStashedMascotTo(): void {
  const s = stash
  stash = null
  if (!s) return
  if (typeof window === 'undefined') return
  // movimento ridotto: niente volo (la scena era già ferma)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const target =
    document.querySelector('[data-testid="bot-settings-trigger"] .bot') ??
    document.querySelector('.bot')
  if (!(target instanceof HTMLElement)) return
  const from = s.rect
  const to = target.getBoundingClientRect()
  if (to.width === 0 || to.height === 0) return
  const ghost = s.node.cloneNode(true) as HTMLElement
  ghost.style.position = 'fixed'
  ghost.style.left = `${from.left}px`
  ghost.style.top = `${from.top}px`
  ghost.style.width = `${from.width}px`
  ghost.style.height = `${from.height}px`
  ghost.style.margin = '0'
  ghost.style.zIndex = '80'
  ghost.style.pointerEvents = 'none'
  ghost.style.transformOrigin = 'top left'
  document.body.appendChild(ghost)
  const anim = ghost.animate(
    [
      { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1 },
      {
        transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`,
        opacity: 0.9
      }
    ],
    { duration: FLIGHT_MS, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' }
  )
  const done = (): void => ghost.remove()
  anim.onfinish = done
  anim.oncancel = done
}
