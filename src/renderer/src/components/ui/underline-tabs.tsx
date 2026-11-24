// PP4 (fase plugin-pulita): le schede come TESTO — l'attiva in primo piano con
// la sottolineatura di 2px, le altre grigie; niente pillola nera. È il pezzo
// riusabile con cui la pagina Plugin (i segmenti in testa) e la sua scheda
// (Panoramica · Autorizzazioni · Account e bot) tolgono un contenitore: la
// 0.3.2 lo userà nel resto dell'app. Tastiera: frecce sinistra e destra
// (stavano dentro il gruppo, da capo), con i ruoli tablist / tab e
// aria-selected; solo l'attiva entra nel giro di Tab (tabindex a scacchi).
// Solo token già usati dall'app (border, foreground, muted-foreground).
//
// Fase design (DS2): UNA RIGA SOLA, mai a capo. Nel vivo le categorie dei
// connettori andavano su due righe («Posta e / calendario»): il chiamante
// chiedeva flex-wrap. Ora, se le schede non ci stanno, la riga scorre in
// orizzontale — senza barra — e una SFUMATURA ai lati dice che c'è altro: a
// destra se si può ancora scorrere a destra, a sinistra se si è scorso; a
// riposo, quando tutto ci sta, nessuna.
//
// COM'È FATTA, in tre strati (e il perché di ciascuno):
//  - l'INVOLUCRO è la radice: relative, col filetto di base. È qui che va il
//    className del chiamante — la tablist è del pezzo, e nulla di ciò che le
//    passa il chiamante può farla andare a capo o toglierle lo scorrimento.
//    L'involucro non è un contenitore flex: «flex-wrap» non ha nulla da
//    avvolgere.
//  - la TABLIST è la riga che scorre. Il filetto di base NON sta su di lei:
//    chi scorre ritaglia al proprio riquadro, e prima la sottolineatura di
//    2px delle schede copriva il filetto SPORGENDO di un pixel (-mb-px sulla
//    scheda) — ritagliata a metà. Ora il filetto è dell'involucro, la tablist
//    lo copre (è lei a sporgere di un pixel, e l'involucro non ritaglia) e le
//    schede non sporgono più.
//  - i VELI: due span assoluti ai lati dell'involucro, ACCANTO alla tablist
//    (dentro scorrerebbero col contenuto). Stanno sempre nel DOM e si
//    accendono con `hidden`: le loro classi si leggono anche nel render
//    statico, e non si monta nulla a ogni evento di scroll.
//
// L'anello del fuoco: la tablist ritaglia ciò che sporge dai suoi figli, e un
// anello disegnato FUORI dal bordo — com'è quello nativo — in alto e ai lati
// sparirebbe. Sulle schede l'anello è esplicito e verso l'interno
// (focus-visible:outline-2 con -outline-offset-2), nel colore --ring
// dell'app come gli altri pezzi di components/ui: sta tutto dentro la
// scheda, dove niente lo ritaglia. Sotto il puntatore non scatta: la variante
// focus-visible è quella di B5.
//
// Dove stanno insieme una dimensione di testo e un colore si usa clsx, che
// concatena e basta: qui non c'è nulla da fondere. (cn, in lib/utils, conosce
// i token di DS1 dal commit 626750e2: il motivo era un cn che non li conosceva.)
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { cn } from '../../lib/utils'

/** Una scheda: { id, label }, oppure la coppia [id, label]. */
export type UnderlineTab<T extends string> = { id: T; label: ReactNode } | readonly [id: T, label: ReactNode]

const tabOf = <T extends string>(tab: UnderlineTab<T>): { id: T; label: ReactNode } => {
  // Array.isArray non restringe una tupla readonly: si legge per posizione
  if (Array.isArray(tab)) return { id: tab[0] as T, label: tab[1] as ReactNode }
  return tab as { id: T; label: ReactNode }
}

/** La riga com'è nel DOM: quanto è scorsa, quanto è larga col suo contenuto, quanto se ne vede. */
export interface TabScroll {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

/** Quali veli servono. */
export interface TabEdges {
  left: boolean
  right: boolean
}

/** Quanto è largo ciascun velo (w-6). */
const VEIL = 24

/**
 * Sotto questo scorrimento la riga è «al bordo». PERCHÉ: le misure sono
 * frazioni di pixel (zoom, scala dello schermo) e a fine corsa Chromium si
 * ferma a 399,5 su 400 — senza tolleranza il velo resterebbe acceso su una
 * riga che non ha più nulla da mostrare.
 */
const TOLERANCE = 1

/**
 * PURA: quali veli servono. A riposo nessuno; a destra se oltre il bordo
 * destro c'è ancora contenuto, a sinistra se si è scorso. Senza DOM, così si
 * prova: è lei che il componente usa allo scroll e al cambio di misura.
 */
export function tabEdges({ scrollLeft, scrollWidth, clientWidth }: TabScroll): TabEdges {
  return {
    left: scrollLeft > TOLERANCE,
    right: scrollLeft + clientWidth < scrollWidth - TOLERANCE
  }
}

/**
 * PURA: lo scrollLeft che porta la scheda [start, end] (nelle coordinate del
 * contenuto della riga) tutta in vista, del minimo — «nearest», come
 * scrollIntoView — ma si muove SOLO la riga.
 *
 * PERCHÉ non scrollIntoView({ inline: 'nearest', block: 'nearest' }): quello
 * scorre TUTTI gli antenati scorrevoli, e «nearest» sul blocco significa
 * «non muoverti SOLO se sei già in vista». Le schede del catalogo delle skill
 * stanno sotto la piega quando la sezione si apre: al montaggio la pagina
 * sarebbe saltata giù da sola. Qui si scrive scrollLeft della tablist e
 * basta: la pagina non si muove mai.
 *
 * E si tiene fuori dai veli: «nearest» porta la scheda attaccata al bordo,
 * cioè sotto la sfumatura (24 px: la fine dell'etichetta e la sottolineatura
 * sfumerebbero appena la si sceglie). Dove c'è un velo, la finestra utile
 * comincia 24 px più dentro.
 */
export function tabReveal(tab: { start: number; end: number }, view: TabScroll): number {
  // non misurata (nascosta): niente da fare
  if (view.clientWidth <= 0) return view.scrollLeft
  const max = Math.max(0, view.scrollWidth - view.clientWidth)
  const clamp = (x: number): number => Math.min(Math.max(0, x), max)
  // lo scrollLeft che porta la scheda nella finestra [scrollLeft + from, scrollLeft + clientWidth - to];
  // se non ci sta tutta (più larga della riga) vince la testa
  const nearest = (from: number, to: number): number => {
    if (tab.start < view.scrollLeft + from) return tab.start - from
    if (tab.end > view.scrollLeft + view.clientWidth - to) return tab.end + to - view.clientWidth
    return view.scrollLeft
  }
  const bare = clamp(nearest(0, 0))
  // dove la scheda va a stare, quali veli ci saranno
  const edges = tabEdges({ scrollLeft: bare, scrollWidth: view.scrollWidth, clientWidth: view.clientWidth })
  return clamp(nearest(edges.left ? VEIL : 0, edges.right ? VEIL : 0))
}

/**
 * PURA: gli attributi di un velo. `on` è il suo lato in tabEdges(...). Il
 * gradiente va dal colore di fondo della pagina (al bordo) al trasparente
 * (verso l'interno), con la variabile del tema: chiaro e scuro seguono da
 * soli. Copre anche il filetto di base (-bottom-px): la sottolineatura di
 * una scheda che sparisce sotto il velo sfuma insieme a lei.
 */
export function tabVeil(side: 'left' | 'right', on: boolean): { 'aria-hidden': 'true'; hidden: boolean; className: string } {
  return {
    'aria-hidden': 'true',
    hidden: !on,
    className: `pointer-events-none absolute top-0 -bottom-px w-6 ${
      side === 'left'
        ? 'left-0 bg-[linear-gradient(to_right,var(--color-background),transparent)]'
        : 'right-0 bg-[linear-gradient(to_left,var(--color-background),transparent)]'
    }`
  }
}

/** A riposo, prima di misurare: nessun velo (se tutto ci sta, restano spenti). */
const NO_EDGES: TabEdges = { left: false, right: false }

export function UnderlineTabs<T extends string>({ tabs, value, onChange, label, testId, tabTestId, className }: {
  tabs: ReadonlyArray<UnderlineTab<T>>
  /** la scheda attiva */
  value: T
  onChange(id: T): void
  /** il nome accessibile del gruppo («Visualizza», «Schede del plugin»…) */
  label?: string
  testId?: string
  /** il testid di OGNI scheda, dal suo id (le sonde delle altre fasi cercano approvals-tab-<id> e simili) */
  tabTestId?: (id: T) => string
  /** le classi del chiamante: vanno sull'involucro (la radice), mai sulla tablist */
  className?: string
}): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<TabEdges>(NO_EDGES)

  // quali veli servono: si misura dal vivo (l'effect non gira nel render del
  // server, dove non c'è nulla da misurare e i veli restano spenti). Allo
  // scroll e quando la riga cambia misura.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = (): void => {
      const next = tabEdges(el)
      // lo scroll emette decine di eventi al secondo: se non è cambiato nulla non si ri-renderizza
      setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    // la riga cambia misura con la finestra o la colonna. E si guardano ANCHE
    // le schede, una per una: un'etichetta che cambia larghezza (un
    // contatore, «Collegati · 12») non ridimensiona la riga, ma può far
    // comparire o sparire l'overflow.
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(el)
      for (const tab of el.querySelectorAll('[role="tab"]')) observer.observe(tab)
    }
    return () => {
      el.removeEventListener('scroll', update)
      observer?.disconnect()
    }
    // il numero di schede: se cambia, cambiano anche i punti da osservare
  }, [tabs.length])

  // la scheda attiva si porta in vista quando cambia (e quando arriva). Si
  // muove solo lo scroll della tablist: il perché sta su tabReveal.
  useEffect(() => {
    const el = scroller.current
    const tab = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!el || !tab) return
    // la scheda nelle coordinate del contenuto della riga (lo scorrimento già fatto compreso)
    const row = el.getBoundingClientRect()
    const box = tab.getBoundingClientRect()
    const start = box.left - row.left - el.clientLeft + el.scrollLeft
    el.scrollLeft = tabReveal({ start, end: start + box.width }, el)
  }, [value, tabs.length])

  // freccia destra: la prossima (dall'ultima alla prima); sinistra: la precedente
  const onKey = (e: React.KeyboardEvent, i: number): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length
    onChange(tabOf(tabs[next]!).id)
    // il fuoco segue la scheda scelta
    const buttons = (e.currentTarget.parentElement ?? e.currentTarget).querySelectorAll<HTMLElement>('[role="tab"]')
    buttons[next]?.focus()
  }
  return (
    <div className={cn('relative border-b border-border/50', className)}>
      <div
        role="tablist"
        ref={scroller}
        className="flex -mb-px flex-nowrap items-center gap-5 overflow-x-auto [scrollbar-width:none]"
        {...(label ? { 'aria-label': label } : {})}
        {...(testId ? { 'data-testid': testId } : {})}
      >
        {tabs.map((tab, i) => {
          const { id, label: text } = tabOf(tab)
          const active = id === value
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              {...(tabTestId ? { 'data-testid': tabTestId(id) } : {})}
              // clsx e non cn: qui stanno insieme text-body e un colore (vedasi in testa)
              className={clsx(
                'shrink-0 whitespace-nowrap border-b-2 py-2 text-body transition focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                active ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onChange(id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {text}
            </button>
          )
        })}
      </div>
      <span {...tabVeil('left', edges.left)} />
      <span {...tabVeil('right', edges.right)} />
    </div>
  )
}
