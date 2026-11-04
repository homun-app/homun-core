// Fase 16b (S6): la riga UNA che resta dopo la decisione — «✓ Consentito una
// volta · <sintesi> · 10:44». Un clic la riapre in sola lettura (i bottoni
// non tornano). Vale per approvazioni, domande, bozze, presa di controllo e
// salvataggi nel vault.
import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { formatTime } from '../lib/i18n'

export function DecidedRow({
  ok,
  label,
  summary,
  at,
  children
}: {
  /** true = ✓ (consentito/inviato/salvato), false = ✗ (rifiutato/scartato) */
  ok: boolean
  /** l'esito in parole: «Consentito una volta», «Inviata a x@y.it»… */
  label: string
  /** la sintesi dell'azione (comando, destinatario, scelta…) */
  summary?: string
  at?: number
  /** la card in sola lettura, mostrata quando la riga è aperta */
  children?: React.ReactNode
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        className="flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-muted/60"
        onClick={() => children && setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={ok ? 'text-chart-2' : 'text-muted-foreground'}>{ok ? '✓' : '✗'}</span>
        <span className="min-w-0 flex-1 truncate">
          {label}
          {summary ? ` · ${summary}` : ''}
        </span>
        {at !== undefined && <span className="shrink-0 text-xs">{formatTime(at)}</span>}
        {children && <span aria-hidden="true" className="shrink-0 text-xs">{open ? '▾' : '▸'}</span>}
      </button>
      {open && <div className="mt-1">{children}</div>}
      {!open && <span className="sr-only">{t`riapri in sola lettura`}</span>}
    </div>
  )
}

/** Il contenitore pulito di tutte le card: bg-muted, angoli 18, padding 16 (S6). */
export function CardShell({
  tone = 'muted',
  className = '',
  testid,
  children
}: {
  tone?: 'muted' | 'waiting' | 'error' | 'bot'
  className?: string
  /** K1 (ritocchi): ancora stabile per la sonda (la card dev'essere VISIBILE in cima) */
  testid?: string
  children: React.ReactNode
}) {
  const toneCls =
    tone === 'waiting'
      ? 'bg-waiting/10'
      : tone === 'error'
        ? 'bg-destructive/10'
        : 'bg-muted'
  return (
    <div className={`max-w-[85%] rounded-[18px] p-4 ${toneCls} ${className}`} {...(testid ? { 'data-testid': testid } : {})}>
      {children}
    </div>
  )
}
