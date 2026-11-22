// A3 (fase centro-autorizzazioni) → A3 (fase approvazioni-chiare): il
// riquadro in cima alle chat. Difetto del 22/11: «la notifica in alto quasi
// non la vedo» — lontana da dove si guarda (ultimo messaggio e campo di
// scrittura). ORA in cima resta SOLO l'indicazione delle richieste di ALTRI
// bot o squadre, in forma ridotta («+N altrove · Apri "Da approvare"»); la
// richiesta del bot aperto sta sopra il campo di scrittura
// (ComposerApproval). Nella chat di squadra resta la barra di Q2.
import { useEffect } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { useStore } from '../store'
import type { ApprovalsCenterRow } from '../../../shared/types'
import { visibleApprovalsRows } from '../lib/approvals-center'

/**
 * il riquadro ridotto «+N altrove» — A3 (fase approvazioni-chiare): in cima
 * alle chat restano SOLO le richieste di ALTRI bot o squadre (nella chat del
 * bot si esclude quel bot: la SUA richiesta sta sopra il campo di scrittura;
 * nella chat di squadra si esclude la squadra aperta, che ha la barra sua).
 */
export function ApprovalsBannerElsewhere({ excludeBotId }: { excludeBotId?: string } = {}) {
  const { i18n } = useLingui()
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const openGroupId = useStore((s) => s.openGroupId)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  const elsewhere = visibleApprovalsRows(approvalsAll, approvalsSnoozed, Date.now())
    .filter((r) => r.squad?.id !== openGroupId)
    .filter((r) => r.botId !== excludeBotId)
  if (elsewhere.length === 0) return null
  return (
    <div className="mx-auto mb-1 w-full max-w-3xl px-6 pt-[60px]" data-testid="approvals-banner">
      <button
        className="flex w-full items-center gap-2 rounded-[14px] bg-card px-4 py-2 text-left text-sm shadow-soft transition hover:bg-card/80"
        onClick={() => setApprovalsOpen(true)}
      >
        <span className="font-semibold text-waiting">+{elsewhere.length} {i18n.t(msg`altrove`)}</span>
        <span className="text-muted-foreground">· <Trans>Apri «Da approvare»</Trans></span>
      </button>
    </div>
  )
}
