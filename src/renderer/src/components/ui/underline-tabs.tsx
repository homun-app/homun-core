// PP4 (fase plugin-pulita): le schede come TESTO — l'attiva in primo piano con
// la sottolineatura di 2px, le altre grigie; niente pillola nera. È il pezzo
// riusabile con cui la pagina Plugin (i segmenti in testa) e la sua scheda
// (Panoramica · Autorizzazioni · Account e bot) tolgono un contenitore: la
// 0.3.2 lo userà nel resto dell'app. Tastiera: frecce sinistra e destra
// (stavano dentro il gruppo, da capo), con i ruoli tablist / tab e
// aria-selected; solo l'attiva entra nel giro di Tab (tabindex a scacchi).
// Solo token già usati dall'app (border, foreground, muted-foreground).
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/** Una scheda: { id, label }, oppure la coppia [id, label]. */
export type UnderlineTab<T extends string> = { id: T; label: ReactNode } | readonly [id: T, label: ReactNode]

const tabOf = <T extends string>(tab: UnderlineTab<T>): { id: T; label: ReactNode } => {
  // Array.isArray non restringe una tupla readonly: si legge per posizione
  if (Array.isArray(tab)) return { id: tab[0] as T, label: tab[1] as ReactNode }
  return tab as { id: T; label: ReactNode }
}

export function UnderlineTabs<T extends string>({ tabs, value, onChange, label, testId, className }: {
  tabs: ReadonlyArray<UnderlineTab<T>>
  /** la scheda attiva */
  value: T
  onChange(id: T): void
  /** il nome accessibile del gruppo («Visualizza», «Schede del plugin»…) */
  label?: string
  testId?: string
  className?: string
}): ReactNode {
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
    <div
      role="tablist"
      className={cn('flex items-center gap-5 border-b border-border/50', className)}
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
            className={cn(
              '-mb-px border-b-2 py-2 text-[13px] transition',
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
  )
}
