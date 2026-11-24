// A3 (fase centro-autorizzazioni) → A3 (fase approvazioni-chiare): il
// riquadro in cima alle chat. Difetto del 22/11: «la notifica in alto quasi
// non la vedo» — lontana da dove si guarda (ultimo messaggio e campo di
// scrittura). ORA in cima resta SOLO l'indicazione delle richieste di ALTRI
// bot o squadre, in forma ridotta («+N altrove · Apri "Da approvare"»); la
// richiesta del bot aperto sta sopra il campo di scrittura
// (ComposerApproval). Nella chat di squadra resta la barra di Q2.
//
// Fase design (DS4): il riquadro è una riga compatta ai token: un Notice (il
// pezzo delle righe di sistema della chat) dentro una scheda
// (rounded-surface), in text-body, con «Apri «Da approvare»» per azione — un
// Button. Prima TUTTO il riquadro era un bottone largo quanto la colonna.
// Sta alla larghezza della colonna di lettura (PageColumn: 720, col margine
// della pagina) e si riserva da solo lo spazio in cima: la testata della chat
// è ASSOLUTA in cima alla colonna e il riquadro è il primo del flusso, perciò
// pt-16 — come i messaggi sotto (prima era pt-[60px], scritto a mano).
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { ShieldAlert } from 'lucide-react'
import { useStore } from '../store'
import type { ApprovalsCenterRow } from '../../../shared/types'
import { visibleApprovalsRows } from '../lib/approvals-center'
import { Button } from './ui/button'
import { Notice } from './ui/notice'
import { PageColumn } from './ui/page-shell'

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
    // il testid sta sul contenitore e DENTRO c'è il bottone: la sonda del
    // centro apre il riquadro con `[data-testid="approvals-banner"] button`
    <PageColumn width="reading" testId="approvals-banner" className="mb-2 pt-16">
      <Notice
        // il tono dell'attesa (text-waiting): è un invito a decidere, non un avviso grigio
        tone="warning"
        icon={<ShieldAlert className="size-4" />}
        action={
          <Button variant="secondary" size="sm" onClick={() => setApprovalsOpen(true)}>
            <Trans>Apri «Da approvare»</Trans>
          </Button>
        }
        className="rounded-surface border border-border bg-card p-3 text-body"
      >
        <span className="font-semibold">+{elsewhere.length} {i18n.t(msg`altrove`)}</span>
      </Notice>
    </PageColumn>
  )
}
