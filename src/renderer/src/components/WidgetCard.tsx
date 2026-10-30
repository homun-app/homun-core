// Card widget ask_user (§3bis L10): domanda con scelte cliccabili, campo libero
// se allowCustom, multiSelect con conferma. La risposta torna come messaggio
// utente (meta.respondedTo) e la card mostra lo stato risposto/scartato.
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { useStore } from '../store'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'

type Widget = Extract<SendMessagePayload, { type: 'widget' }>

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

  const toggle = (value: string) => {
    setSelected((sel) => (sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value]))
  }

  const send = (value: string | string[]) => {
    setConfirming(true)
    respond(entry.id, value)
  }

  const labels = (v: string | string[]) =>
    (Array.isArray(v) ? v : [v]).map((x) => widget.options.find((o) => o.value === x)?.label ?? x).join(', ')

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <p className="text-sm font-medium text-foreground">{widget.prompt}</p>
      {widget.helpText && <p className="mt-1 text-xs text-muted-foreground">{widget.helpText}</p>}

      {responded || dismissed ? (
        <div className="mt-3 text-xs text-muted-foreground">
          {responded
            ? <Trans>✓ Hai risposto: {labels(meta.respondedValue as string | string[])}</Trans>
            : <Trans>— domanda scavalcata, hai proseguito senza rispondere</Trans>}
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {widget.options.map((o) => {
              const chosen = selected.includes(o.value)
              return (
                <button
                  key={o.value}
                  disabled={confirming}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                    widget.multiSelect
                      ? chosen
                        ? 'border-primary bg-primary/15 text-foreground'
                        : 'border-border bg-muted text-foreground hover:border-muted-foreground'
                      : o.style === 'primary'
                        ? 'border-primary bg-primary font-medium text-primary-foreground hover:bg-primary/90'
                        : 'border-border bg-muted text-foreground hover:border-muted-foreground'
                  }`}
                  title={o.description}
                  onClick={() => (widget.multiSelect ? toggle(o.value) : send(o.value))}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          {widget.multiSelect && (
            <button
              disabled={confirming || selected.length === 0}
              className="mt-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
              onClick={() => send(selected)}
            >
              <Trans>Conferma{selected.length ? ` (${selected.length})` : ''}</Trans>
            </button>
          )}
          {widget.allowCustom && (
            <div className="mt-2 flex gap-2">
              <input
                className="flex-1 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs text-foreground outline-none focus:border-ring"
                placeholder={t`Altro (testo libero)…`}
                value={custom}
                disabled={confirming}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && custom.trim()) send(custom.trim())
                }}
              />
              <button
                disabled={confirming || !custom.trim()}
                className="rounded-lg bg-muted px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-40"
                onClick={() => send(custom.trim())}
              >
                <Trans>Invia</Trans>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
