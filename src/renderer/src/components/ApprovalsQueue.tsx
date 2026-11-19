// Q2 (fase squadra): la tavola 2 del disegno — «Da approvare», una coda per
// tutta la squadra. Testi e struttura dalla tela E1UivWqEiuZqVjkkR9K5hx:
// «Solo tu puoi decidere» (le card coi chip di categoria, il perché e i tre
// bottoni — «Consenti per questa missione» solo per sito-interattivo e
// squadra), «Fatto da soli, senza chiederti» (i contatori) e «Lasciato
// passare dal revisore». Si decide con la resolveApproval di oggi: la card
// nella chat del singolo bot si chiude da sola.
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { api, useStore } from '../store'
import type { SquadPendingApprovalInfo } from '../../../shared/types'

/** Le etichette dei chip di categoria (tavola 2: «i tuoi dati», «sito nuovo, interattivo»…). */
const CATEGORY_LABEL: Record<SquadPendingApprovalInfo['category'], MessageDescriptor> = {
  'dati-tuoi': msg`i tuoi dati`,
  pagamento: msg`pagamento`,
  invio: msg`invio verso fuori`,
  'sito-interattivo': msg`sito nuovo, interattivo`,
  mac: msg`il tuo Mac`,
  squadra: msg`squadra`,
  altro: msg`altro`
}

/** «Consenti per questa missione» esiste solo per sito-interattivo e squadra. */
export function missionOffered(category: SquadPendingApprovalInfo['category']): boolean {
  return category === 'sito-interattivo' || category === 'squadra'
}

/** la riga breve di chi chiede, per la barra in cima alla chat (tavola 1). */
export function pendingWantsLine(r: SquadPendingApprovalInfo, i18n: ReturnType<typeof useLingui>['i18n']): string {
  const wants: Record<SquadPendingApprovalInfo['category'], MessageDescriptor> = {
    'dati-tuoi': msg`vuole compilare un modulo con i tuoi dati`,
    pagamento: msg`vuole pagare`,
    invio: msg`vuole inviare verso fuori`,
    'sito-interattivo': msg`vuole aprire un sito`,
    mac: msg`vuole usare il tuo Mac`,
    squadra: msg`chiede un'azione di squadra`,
    altro: msg`chiede un'azione`
  }
  return `${r.agentName} ${i18n.t(wants[r.category])}`
}

const ACTIVITY_LABEL: Record<string, MessageDescriptor> = {
  files: msg`file scritti nel computer`,
  commands: msg`comandi nel computer, senza rete`,
  pages: msg`pagine web lette`,
  'bot-messages': msg`messaggi tra bot della squadra`
}

const WHY_LABEL: Record<string, MessageDescriptor> = {
  contaminato: msg`contenuti non fidati nel turno`,
  revisore: msg`il revisore non è sicuro`,
  fisso: msg`sempre a te`
}

/** «2 min fa»: il tempo relativo breve della coda. */
function timeAgo(when: number, now: number): string {
  const s = Math.max(0, Math.round((now - when) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  return `${Math.round(h / 24)} g`
}

export function ApprovalsQueue() {
  const { i18n } = useLingui()
  const groups = useStore((s) => s.groups)
  const openGroupId = useStore((s) => s.openGroupId)
  const groupPending = useStore((s) => s.groupPending)
  const groupActivity = useStore((s) => s.groupActivity)
  const groupReviewerPassed = useStore((s) => s.groupReviewerPassed)
  const resolveGroupApproval = useStore((s) => s.resolveGroupApproval)
  const setApprovalsQueueOpen = useStore((s) => s.setApprovalsQueueOpen)
  const refreshSquadData = useStore((s) => s.refreshSquadData)
  const group = groups.find((g) => g.id === openGroupId)
  if (openGroupId === null || !group) return null
  const now = Date.now()
  return (
    <section className="absolute inset-0 z-20 flex flex-col bg-background" aria-label={i18n.t(msg`Da approvare`)} data-testid="approvals-queue">
      <div className="px-8 pb-2 pt-10">
        <div className="mx-auto flex max-w-3xl items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 font-display text-2xl"><ShieldCheck className="size-5 text-muted-foreground" /><Trans>Da approvare</Trans></h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans>{group.name} · tutte le richieste della squadra, in un posto</Trans>
            </p>
          </div>
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-3.5 py-2 text-sm transition hover:bg-accent"
            data-testid="approvals-back"
            onClick={() => setApprovalsQueueOpen(false)}
          >
            <ArrowLeft className="size-4" /> <Trans>Torna alla squadra</Trans>
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scroll-thin px-8 pb-6">
        <div className="mx-auto max-w-3xl space-y-8">
          {/* ——— Solo tu puoi decidere ——— */}
          <section>
            <h2 className="font-display text-lg"><Trans>Solo tu puoi decidere</Trans></h2>
            {groupPending.length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground"><Trans>Nessuna richiesta in attesa.</Trans></p>
            )}
            <div className="mt-3 space-y-3">
              {groupPending.map((r) => (
                <article key={`${r.agentId}:${r.approvalId}`} className="rounded-[18px] bg-card p-4 shadow-soft" data-testid="approval-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-foreground/80">{i18n.t(CATEGORY_LABEL[r.category])}</span>
                    <span className="text-sm font-medium">{r.agentName}</span>
                    <span className="text-xs text-muted-foreground">· {timeAgo(r.when, now)}</span>
                    {r.fromSubagent && <span className="text-xs text-muted-foreground">· <Trans>aiutante</Trans></span>}
                    {r.why && <span className="text-xs text-muted-foreground">· {i18n.t(WHY_LABEL[r.why])}</span>}
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed">{r.phrase}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="rounded-full bg-foreground px-4 py-2 text-sm text-background transition hover:opacity-90"
                      onClick={() => resolveGroupApproval(r.agentId, r.approvalId, 'allow', 'once')}
                    >
                      <Trans>Consenti una volta</Trans>
                    </button>
                    {missionOffered(r.category) && (
                      <button
                        className="rounded-full bg-muted px-4 py-2 text-sm transition hover:bg-accent"
                        data-testid="approval-mission"
                        title={i18n.t(msg`Un consenso di 8 ore per tutta la squadra, solo per questo`)}
                        onClick={() => resolveGroupApproval(r.agentId, r.approvalId, 'allow', 'mission')}
                      >
                        <Trans>Consenti per questa missione</Trans>
                      </button>
                    )}
                    <button
                      className="rounded-full px-4 py-2 text-sm text-muted-foreground transition hover:text-destructive"
                      onClick={() => resolveGroupApproval(r.agentId, r.approvalId, 'deny', 'once')}
                    >
                      <Trans>Rifiuta</Trans>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          {/* ——— Fatto da soli, senza chiederti ——— */}
          <section>
            <h2 className="font-display text-lg"><Trans>Fatto da soli, senza chiederti</Trans></h2>
            <div className="mt-3 space-y-1.5">
              {groupActivity.map((a) => (
                <div key={a.id} className="flex items-baseline justify-between gap-3 rounded-[14px] bg-muted/50 px-3.5 py-2">
                  <span className="text-sm"><Trans>{a.count} {i18n.t(ACTIVITY_LABEL[a.id]!)}</Trans></span>
                  <span className="truncate text-xs text-muted-foreground">{a.who.length > 0 ? a.who.join(', ') : '—'}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ——— Lasciato passare dal revisore ——— */}
          {groupReviewerPassed.length > 0 && (
            <section>
              <h2 className="font-display text-lg"><Trans>Lasciato passare dal revisore</Trans></h2>
              <div className="mt-3 space-y-1.5">
                {groupReviewerPassed.map((r, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-3 rounded-[14px] bg-muted/50 px-3.5 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <Trans>{r.agentName} · {r.reason ?? r.tool}</Trans>
                    </span>
                    {r.grantId !== null && (
                      <button
                        className="shrink-0 text-xs text-muted-foreground underline-offset-2 transition hover:text-destructive hover:underline"
                        onClick={() => { void api.grantRevoke(r.grantId!).then(() => refreshSquadData({ forceBadges: true })) }}
                      >
                        <Trans>Annulla la concessione</Trans>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  )
}
