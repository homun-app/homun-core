// Fase impostazioni (I5): la riga «nome a sinistra, controllo a destra»,
// divisa dalle sorelle da un filetto sottile (border-t dalla seconda in poi).
// Sotto i 420 px di CONTENUTO (@container del dialogo Impostazioni) il
// controllo scende sotto il nome. `clickable` fa della riga un bottone (la
// riga del provider che si apre sul posto). Fase mcp-setup ritocchi (R3):
// `muted` attenua la riga (la via OAuth del modulo quando c'è un token);
// `stacked` tiene il controllo SOTTO il nome a ogni larghezza (le righe del
// modulo di configurazione, fatte per i campi larghi della card in chat).
import type { ReactNode } from 'react'

export function SettingsRow({ title, description, control, children, clickable, onClick, muted, stacked }: {
  title: ReactNode
  description?: ReactNode
  /** il controllo a destra (interruttore, selettore, campo…) */
  control?: ReactNode
  /** contenuto libero a tutta larghezza (la scheda del provider aperta) */
  children?: ReactNode
  clickable?: boolean
  onClick?(): void
  /** R3: la riga si attenua (via alternativa momentaneamente non in gioco) */
  muted?: boolean
  /** il controllo resta sotto il nome anche in un contenitore largo */
  stacked?: boolean
}) {
  const body = (
    <>
      <span className={`min-w-0 flex-1 ${clickable ? '' : 'text-[15px]'}`}>
        {/* stacked: il titolo va a CAPO (le etichette lunghe del modulo non si tagliano) */}
        <span className={`block ${stacked === true ? '' : 'truncate'}`}>{title}</span>
        {description !== undefined && (
          <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{description}</span>
        )}
      </span>
      {control !== undefined && (
        <span className="flex min-w-0 shrink-0 items-center justify-end gap-2 @[420px]:justify-end">
          {control}
        </span>
      )}
      {children}
    </>
  )
  const cls =
    'flex w-full flex-col gap-2 px-4 py-3 text-left ' +
    (stacked === true ? '' : '@[420px]:flex-row @[420px]:items-center @[420px]:gap-4 ') +
    '[&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/40 ' +
    (muted === true ? 'opacity-55 transition-opacity ' : '')
  if (clickable || onClick) {
    return (
      <button type="button" className={`${cls} transition hover:bg-muted/70 ${clickable ? '' : 'text-left'}`} onClick={onClick}>
        {body}
      </button>
    )
  }
  return <div className={cls}>{body}</div>
}
