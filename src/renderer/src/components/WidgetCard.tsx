// Fase 16b (S6): la domanda del bot, pulita. Ogni opzione porta la sua
// lettera (A/B/C) in un quadratino; «Scrivi tu…» è tratteggiato. Dopo la
// risposta la card diventa UNA riga («Hai scelto: B · Preparare le fatture»),
// riapribile in sola lettura. La logica non cambia: stessa RPC widget:respond.
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { useStore, api } from '../store'
import { i18n } from '../lib/i18n'
import { widgetDecidedLabel } from '../lib/widget-decision'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
import { DecidedRow, CardShell, SU_CARD } from './DecidedRow'
import { Button } from './ui/button'

type Widget = Extract<SendMessagePayload, { type: 'widget' }>

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

export function WidgetCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const respond = useStore((s) => s.widgetRespond)
  // OA4 (fase onboarding-a): la card del focus si può CHIUDERE senza scegliere
  const focus = ((entry.meta ?? {}) as Record<string, unknown>).onboardingFocus === true
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

  const toggle = (value: string): void => {
    setSelected((sel) => (sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value]))
  }

  const letterOf = (value: string): string => LETTERS[widget.options.findIndex((o) => o.value === value)] ?? '·'

  const body = (
    <>
      {/* DS4: la domanda è il titolo grande della card (text-title); «Chiudi» è
          un bottone secondario — su fondo card, perché la card è già muted */}
      <div className="flex w-full items-start justify-between gap-3">
        <p className="text-title font-semibold text-foreground">{widget.prompt}</p>
        {focus && !responded && !dismissed && (
          <Button variant="secondary" size="sm" className={SU_CARD} data-testid="focus-dismiss" onClick={() => { void api.onboardingFocusDismiss(entry.id) }}>
            <Trans>Chiudi</Trans>
          </Button>
        )}
      </div>
      {widget.helpText && <p className="mt-1.5 text-small text-muted-foreground">{widget.helpText}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {widget.options.map((o) => {
          const chosen = selected.includes(o.value)
          return (
            // una riga-scelta: alta quanto un controllo (36), raggio di controllo, su
            // fondo card. La scelta si vede da un filetto; l'anello del fuoco è
            // quello del sistema, solo da tastiera, staccato della larghezza dell'offset
            <button
              key={o.value}
              data-testid={`widget-option-${o.value}`}
              disabled={confirming}
              className={`flex min-h-control w-full cursor-pointer items-center gap-3 rounded-control px-3 py-2 text-left text-body transition-colors outline-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted ${
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
              <span className={`grid size-5 shrink-0 place-items-center rounded-control text-caption font-semibold ${o.style === 'primary' && !widget.multiSelect ? 'bg-background/20' : 'bg-muted'}`}>
                {letterOf(o.value)}
              </span>
              {o.label}
            </button>
          )
        })}
        {widget.allowCustom && !dismissed && (
          <div className="flex gap-2">
            <input
              className="h-control min-w-0 flex-1 rounded-control border border-dashed border-border bg-transparent px-3 text-body outline-none placeholder:text-muted-foreground focus:border-foreground/40"
              data-testid="widget-custom-input"
              placeholder={t`Scrivi tu…`}
              value={custom}
              disabled={confirming}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && custom.trim()) send(custom.trim())
              }}
            />
            <Button variant="secondary" className={SU_CARD} disabled={confirming || !custom.trim()} onClick={() => send(custom.trim())}>
              <Trans>Invia</Trans>
            </Button>
          </div>
        )}
      </div>
      {widget.multiSelect && selected.length > 0 && !confirming && (
        <Button className="mt-4" onClick={() => send(selected)}>
          <Trans>Conferma ({selected.length})</Trans>
        </Button>
      )}
    </>
  )

  // dopo: UNA riga («Hai scelto: B · Preparare le fatture»), riapribile (S6)
  // B3 (fase beta.4): la risposta LIBERA dice «Hai scritto: Alle 8» — niente
  // lettera né «·» vuoti; con un'opzione resta «Hai scelto: B · …»
  if (responded) {
    const values = meta.respondedValue as string | string[]
    return (
      <DecidedRow ok label={i18n.t(widgetDecidedLabel(values, widget.options))} at={entry.createdAt}>
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
