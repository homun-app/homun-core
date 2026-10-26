// Card widget ask_user (§3bis L10): domanda con scelte cliccabili, campo libero
// se allowCustom, multiSelect con conferma. La risposta torna come messaggio
// utente (meta.respondedTo) e la card mostra lo stato risposto/scartato.
import { useState } from 'react'
import { useStore } from '../store'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'

type Widget = Extract<SendMessagePayload, { type: 'widget' }>

export function WidgetCard({ entry }: { entry: TranscriptEntry }) {
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
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-sky-800/50 bg-sky-950/20 px-4 py-3">
      <p className="text-sm font-medium text-neutral-100">{widget.prompt}</p>
      {widget.helpText && <p className="mt-1 text-xs text-neutral-400">{widget.helpText}</p>}

      {responded || dismissed ? (
        <div className="mt-3 text-xs text-neutral-500">
          {responded
            ? `✓ Hai risposto: ${labels(meta.respondedValue as string | string[])}`
            : '— domanda scavalcata, hai proseguito senza rispondere'}
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
                        ? 'border-sky-500 bg-sky-800/60 text-neutral-100'
                        : 'border-neutral-700 bg-neutral-800/60 text-neutral-300 hover:border-neutral-500'
                      : o.style === 'primary'
                        ? 'border-sky-500 bg-sky-700/70 font-medium text-white hover:bg-sky-600'
                        : 'border-neutral-700 bg-neutral-800/60 text-neutral-200 hover:border-neutral-500'
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
              className="mt-2 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              onClick={() => send(selected)}
            >
              Conferma{selected.length ? ` (${selected.length})` : ''}
            </button>
          )}
          {widget.allowCustom && (
            <div className="mt-2 flex gap-2">
              <input
                className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-500"
                placeholder="Altro (testo libero)…"
                value={custom}
                disabled={confirming}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && custom.trim()) send(custom.trim())
                }}
              />
              <button
                disabled={confirming || !custom.trim()}
                className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                onClick={() => send(custom.trim())}
              >
                Invia
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
