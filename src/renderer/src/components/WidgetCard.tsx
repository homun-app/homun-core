// Fase 16b (S6): la domanda del bot, pulita. Ogni opzione porta la sua
// lettera (A/B/C) in un quadratino; «Scrivi tu…» è tratteggiato. Dopo la
// risposta la card diventa UNA riga («Hai scelto: B · Preparare le fatture»),
// riapribile in sola lettura. La logica non cambia: stessa RPC widget:respond.
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { useStore } from '../store'
import { i18n } from '../lib/i18n'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
import { DecidedRow, CardShell } from './DecidedRow'

type Widget = Extract<SendMessagePayload, { type: 'widget' }>

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

export function WidgetCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const respond = useStore((s) => s.widgetRespond)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const widget = meta.message as Widget | undefined
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [confirming, setConfirming] = useState(false)

  if (!widget) return null
  const responded = meta.respondedValue !== undefined
  const dismissed = !!meta.widgetDismissed

  const send = (value: string | string[]): void => {
    setConfirming(true)
    respond(entry.id, value)
  }

  const labels = (v: string | string[]): string =>
    (Array.isArray(v) ? v : [v]).map((x) => widget.options.find((o) => o.value === x)?.label ?? x).join(', ')

  const toggle = (value: string): void => {
    setSelected((sel) => (sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value]))
  }

  const letterOf = (value: string): string => LETTERS[widget.options.findIndex((o) => o.value === value)] ?? '·'

  const body = (
    <>
      <p className="text-[15px] font-semibold text-foreground">{widget.prompt}</p>
      {widget.helpText && <p className="mt-1 text-xs text-muted-foreground">{widget.helpText}</p>}
      <div className="mt-2.5 space-y-1.5">
        {widget.options.map((o) => {
          const chosen = selected.includes(o.value)
          return (
            <button
              key={o.value}
              disabled={confirming}
              className={`flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm transition-colors disabled:opacity-40 ${
                widget.multiSelect
                  ? chosen
                    ? 'bg-card ring-1 ring-foreground/30'
                    : 'bg-card hover:ring-1 hover:ring-foreground/20'
                  : o.style === 'primary'
                    ? 'bg-foreground text-background hover:opacity-90'
                    : 'bg-card hover:ring-1 hover:ring-foreground/20'
              }`}
              title={o.description}
              onClick={() => (widget.multiSelect ? toggle(o.value) : send(o.value))}
            >
              <span className={`grid size-5.5 shrink-0 place-items-center rounded-[6px] text-[11px] font-semibold ${o.style === 'primary' && !widget.multiSelect ? 'bg-background/20' : 'bg-muted'}`}>
                {letterOf(o.value)}
              </span>
              {o.label}
            </button>
          )
        })}
        {widget.allowCustom && !dismissed && (
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-[10px] border border-dashed border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground/40"
              placeholder={t`Scrivi tu…`}
              value={custom}
              disabled={confirming}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && custom.trim()) send(custom.trim())
              }}
            />
            <button
              disabled={confirming || !custom.trim()}
              className="shrink-0 rounded-[10px] bg-card px-3 py-2 text-sm transition hover:ring-1 hover:ring-foreground/20 disabled:opacity-40"
              onClick={() => send(custom.trim())}
            >
              <Trans>Invia</Trans>
            </button>
          </div>
        )}
      </div>
      {widget.multiSelect && selected.length > 0 && !confirming && (
        <button
          className="mt-2 rounded-full bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
          onClick={() => send(selected)}
        >
          <Trans>Conferma ({selected.length})</Trans>
        </button>
      )}
    </>
  )

  // dopo: UNA riga («Hai scelto: B · Preparare le fatture»), riapribile (S6)
  if (responded) {
    const values = meta.respondedValue as string | string[]
    const first = Array.isArray(values) ? values[0] : values
    return (
      <DecidedRow ok label={i18n.t(msg`Hai scelto: ${letterOf(String(first))} · ${labels(values)}`)} at={entry.createdAt}>
        <CardShell>{body}</CardShell>
      </DecidedRow>
    )
  }
  if (dismissed) {
    return (
      <DecidedRow ok={false} label={i18n.t(msg`domanda scavalcata, hai proseguito senza rispondere`)} at={entry.createdAt}>
        <CardShell>{body}</CardShell>
      </DecidedRow>
    )
  }

  return <CardShell>{body}</CardShell>
}
