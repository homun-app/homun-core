// A3 (fase centro-autorizzazioni): il riquadro in cima alle chat (tavola 5)
// — «La chat principale: le richieste restano in cima». FISSO sopra i
// messaggi, non scorre con loro: mostra le 2 richieste più urgenti (prima
// l'insieme fisso, poi la più vecchia), ciascuna con categoria, bot
// (squadra) e frase breve e «Decidi» che apre il centro SU quella
// richiesta; sotto «e altre N: …» per tipo, più «Apri "Da approvare"» e
// «Riduci» (una riga sola, «N richieste aspettano te», per la sessione).
// Con 0 richieste sparisce. Nella chat di squadra resta la barra di Q2: il
// riquadro globale compare SOLO se ci sono richieste di ALTRE squadre o
// bot, in forma ridotta («+N altrove») per non avere due barre piene.
import { useEffect } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { ChevronUp } from 'lucide-react'
import { useStore } from '../store'
import type { ApprovalsCenterRow } from '../../../shared/types'
import { visibleApprovalsRows, byUrgency, CATEGORY_SHORT } from '../lib/approvals-center'

/** il riquadro ridotto della chat di squadra: «+N altrove» (tavola 5). */
export function ApprovalsBannerElsewhere() {
  const { i18n } = useLingui()
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const openGroupId = useStore((s) => s.openGroupId)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  const elsewhere = visibleApprovalsRows(approvalsAll, approvalsSnoozed, Date.now())
    .filter((r) => r.squad?.id !== openGroupId)
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

/** il riquadro pieno: le 2 più urgenti, il riepilogo per tipo, Apri e Riduci. */
export function ApprovalsBanner() {
  const { i18n } = useLingui()
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const collapsed = useStore((s) => s.approvalsBannerCollapsed)
  const setApprovalsBannerCollapsed = useStore((s) => s.setApprovalsBannerCollapsed)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  const rows = visibleApprovalsRows(approvalsAll, approvalsSnoozed, Date.now())
  // con 0 richieste il riquadro sparisce e «Riduci» torna esteso
  useEffect(() => {
    if (rows.length === 0 && collapsed) setApprovalsBannerCollapsed(false)
  }, [rows.length, collapsed, setApprovalsBannerCollapsed])
  if (rows.length === 0) return null
  const urgent = byUrgency(rows).slice(0, 2)
  const rest = byUrgency(rows).slice(2)
  // il riepilogo per tipo («2 siti interattivi, 1 login»), nell'ordine di comparsa
  const byCat = new Map<string, number>()
  for (const r of rest) byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1)
  const summary = [...byCat.entries()].map(([cat, n]) => `${n} ${i18n.t(CATEGORY_SHORT[cat as ApprovalsCenterRow['category']])}`).join(', ')

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-[60px]" data-testid="approvals-banner">
      <div className="rounded-[16px] bg-card px-4 py-3 shadow-soft" role="region" aria-label={i18n.t(msg`Richieste che aspettano te`)}>
        {collapsed ? (
          /* ridotto: UNA riga sola (tavola 5), che riapre il riquadro */
          <div className="flex items-center justify-between gap-3">
            <button
              className="text-left text-sm text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
              onClick={() => setApprovalsBannerCollapsed(false)}
            >
              <Trans>{rows.length} richieste aspettano te</Trans>
            </button>
            <button
              className="shrink-0 text-sm text-foreground underline-offset-2 transition hover:underline"
              onClick={() => setApprovalsOpen(true)}
            >
              <Trans>Apri «Da approvare»</Trans>
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold"><Trans>{rows.length} richieste aspettano te</Trans></p>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  className="text-sm text-foreground underline-offset-2 transition hover:underline"
                  onClick={() => setApprovalsOpen(true)}
                >
                  <Trans>Apri «Da approvare»</Trans>
                </button>
                <button
                  className="flex items-center gap-0.5 text-sm text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
                  data-testid="approvals-banner-collapse"
                  onClick={() => setApprovalsBannerCollapsed(true)}
                >
                  <Trans>Riduci</Trans> <ChevronUp className="size-3.5" />
                </button>
              </div>
            </div>
            <div className="mt-1.5 space-y-1">
              {urgent.map((r) => (
                <div key={`${r.agentId}:${r.approvalId}`} className="flex items-baseline gap-2 text-sm">
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-foreground/80">{i18n.t(CATEGORY_SHORT[r.category])}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{r.botName}</span>
                    {r.squad && <span className="text-muted-foreground"> ({r.squad.name})</span>}
                    <span className="text-muted-foreground"> {i18n.t(msg`vuole`)} {r.phrase}</span>
                  </span>
                  <button
                    className="shrink-0 text-sm text-foreground underline-offset-2 transition hover:underline"
                    onClick={() => setApprovalsOpen(true, r.approvalId)}
                  >
                    <Trans>Decidi</Trans>
                  </button>
                </div>
              ))}
            </div>
            {rest.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground"><Trans>e altre {rest.length}: {summary}</Trans></p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
