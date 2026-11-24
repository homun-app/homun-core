// Fase 19a (V5): la card della presa di controllo CHIESTA DAL BOT.
// Fase 16b (S6): resa pulita, tinta col colore del bot; dopo «Ho finito»
// diventa UNA riga («Hai finito · il bot riprende»). Il bottone apre il
// pannello Computer GIÀ in controllo sulla scheda Schermo.
// Fase design (DS4): ai token di DS1 — il titolo è quello grande di una card
// (text-title), le righe sotto text-small grigie, il bottone è del sistema.
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Monitor } from 'lucide-react'
import { useStore } from '../store'
import { useBotInfo } from '../bot/use-bot'
import { i18n } from '../lib/i18n'
import type { TranscriptEntry, SendMessageMeta } from '../../../shared/types'
import { DecidedRow, CardShell } from './DecidedRow'
import { Button } from './ui/button'

export function TakeoverCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const agents = useStore((s) => s.agents)
  const info = useBotInfo(activeId)
  const setComputerPanel = useStore((s) => s.setComputerPanel)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const message = meta.message as Extract<SendMessageMeta['message'], { type?: string }> | undefined
  const reason = (message as { reason?: string } | undefined)?.reason ?? ''
  const status = meta.takeover ?? 'pending'
  const agent = agents.find((a) => a.id === activeId)
  const color = info ? `var(--bot-${info.avatar.color})` : 'var(--foreground)'

  const content = (
    <>
      <p className="text-title font-semibold text-foreground">
        <Trans>{agent?.name ?? ''} ha bisogno di te sullo schermo</Trans>
      </p>
      {reason && <p className="mt-2 wrap-anywhere whitespace-pre-wrap text-body">{reason}</p>}
      <p className="mt-2 text-small text-muted-foreground">
        <Trans>Accedi tu sul suo schermo, poi premi «Ho finito». La password non passa dal bot.</Trans>
      </p>
      {status === 'pending' && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {/* il bottone del sistema, tinto col colore del bot: lo sfondo lo decide lo stile in linea */}
          <Button style={{ background: color }} onClick={() => setComputerPanel(true, 'screen', 'control')}>
            <Trans>Apri lo schermo</Trans>
          </Button>
          <span className="min-w-0 flex-1 text-small text-muted-foreground">{t`Il bot è in attesa: chiudi con «Ho finito» quando hai terminato.`}</span>
        </div>
      )}
    </>
  )

  if (status === 'done') {
    return (
      <DecidedRow ok label={i18n.t(msg`Hai finito · il bot riprende`)} at={entry.createdAt}>
        <CardShell>{content}</CardShell>
      </DecidedRow>
    )
  }
  if (status === 'expired') {
    return (
      <DecidedRow ok={false} label={i18n.t(msg`Scaduta: il bot non aspetta più`)} at={entry.createdAt}>
        <CardShell>{content}</CardShell>
      </DecidedRow>
    )
  }

  return (
    // la card della presa di controllo: tinta col colore del bot (S6)
    <div className="max-w-[85%] min-w-0 rounded-surface p-4 wrap-anywhere" style={{ background: `color-mix(in oklab, ${color} 10%, var(--muted))` }}>
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        <Monitor className="size-4" />
        <span><Trans>Presa di controllo dello schermo</Trans></span>
      </div>
      <div className="mt-2">{content}</div>
    </div>
  )
}
