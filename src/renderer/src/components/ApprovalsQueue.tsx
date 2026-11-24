// Q2 (fase squadra): la tavola 2 del disegno — «Da approvare», una coda per
// tutta la squadra. Testi e struttura dalla tela E1UivWqEiuZqVjkkR9K5hx:
// «Solo tu puoi decidere» (le card coi chip di categoria, il perché e i tre
// bottoni — «Consenti per questa missione» solo per sito-interattivo e
// squadra), «Fatto da soli, senza chiederti» (i contatori) e «Lasciato
// passare dal revisore». Si decide con la resolveApproval di oggi: la card
// nella chat del singolo bot si chiude da sola.
//
// Fase design (DS4): la coda è fatta coi PEZZI di DS2, non più con classi
// scritte a mano. Il guscio è PageShell (una pagina: 880), la testata è
// PageHeader (indietro «Torna al team», l'icona, il titolo, sotto la
// descrizione); le tre parti del disegno sono Section; le richieste sono
// schede come le card del centro; i contatori e ciò che il revisore ha
// lasciato passare sono righe a filo (FlatList / FlatRow); i bottoni sono
// Button. Testid e testi restano quelli di oggi: li cercano la sonda della
// fase squadra e i test (approvals-queue, ds4-approvazioni).
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ShieldCheck } from 'lucide-react'
import { api, useStore } from '../store'
import type { SquadPendingApprovalInfo } from '../../../shared/types'
import { Button } from './ui/button'
import { FlatList, FlatRow } from './ui/flat-list'
import { PageHeader } from './ui/page-header'
import { PageShell } from './ui/page-shell'
import { Section } from './ui/section'

/** Le etichette dei chip di categoria (tavola 2: «i tuoi dati», «sito nuovo, interattivo»…). */
const CATEGORY_LABEL: Record<SquadPendingApprovalInfo['category'], MessageDescriptor> = {
  'dati-tuoi': msg`i tuoi dati`,
  pagamento: msg`pagamento`,
  invio: msg`invio verso fuori`,
  'sito-interattivo': msg`sito nuovo, interattivo`,
  mac: msg`il tuo Mac`,
  squadra: msg`team`,
  altro: msg`altro`
}

/** «Consenti per questa missione» esiste solo per sito-interattivo e squadra.
 *  S3 (fase squadra-sicurezza-2): mai per create_agent/create_group — quei
 *  turni li protegge l'origine (forcedOriginAsk), la card vale «una volta». */
export function missionOffered(category: SquadPendingApprovalInfo['category'], tool: string): boolean {
  if (tool === 'create_agent' || tool === 'create_group') return false
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
    squadra: msg`chiede un'azione di team`,
    altro: msg`chiede un'azione`
  }
  return `${r.agentName} ${i18n.t(wants[r.category])}`
}

const ACTIVITY_LABEL: Record<string, MessageDescriptor> = {
  files: msg`file scritti nel computer`,
  commands: msg`comandi nel computer, senza rete`,
  pages: msg`pagine web lette`,
  'bot-messages': msg`messaggi tra bot del team`
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
  const { i18n, t } = useLingui()
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
    // la regione «Da approvare» (il nome accessibile di oggi) avvolge il guscio
    <section aria-label={i18n.t(msg`Da approvare`)}>
      <PageShell
        width="page"
        z={20}
        testId="approvals-queue"
        header={
          <PageHeader
            title={i18n.t(msg`Da approvare`)}
            icon={<ShieldCheck className="size-5" />}
            back={{ onClick: () => setApprovalsQueueOpen(false), label: t`Torna al team`, testId: 'approvals-back' }}
            description={<Trans>{group.name} · tutte le richieste del team, in un posto</Trans>}
          />
        }
        contentClassName="flex flex-col gap-section pt-4 pb-6"
      >
        {/* ——— Solo tu puoi decidere ——— */}
        <Section size="title" title={<Trans>Solo tu puoi decidere</Trans>}>
          {groupPending.length === 0 && (
            <p className="text-small text-muted-foreground"><Trans>Nessuna richiesta in attesa.</Trans></p>
          )}
          {groupPending.map((r) => (
            // la scheda della richiesta: la stessa del centro (rounded-surface, bordo, p-4)
            <article key={`${r.agentId}:${r.approvalId}`} className="rounded-surface border border-border bg-card p-4" data-testid="approval-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-muted px-2 py-0.5 text-caption">{i18n.t(CATEGORY_LABEL[r.category])}</span>
                <span className="text-body font-medium">{r.agentName}</span>
                <span className="text-small text-muted-foreground">· {timeAgo(r.when, now)}</span>
                {r.fromSubagent && <span className="text-small text-muted-foreground">· <Trans>aiutante</Trans></span>}
                {r.why && <span className="text-small text-muted-foreground">· {i18n.t(WHY_LABEL[r.why])}</span>}
              </div>
              <p className="mt-2 text-body">{r.phrase}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  onClick={() => resolveGroupApproval(r.agentId, r.approvalId, 'allow', 'once')}
                >
                  <Trans>Consenti una volta</Trans>
                </Button>
                {missionOffered(r.category, r.tool) && (
                  <Button
                    variant="secondary"
                    data-testid="approval-mission"
                    title={i18n.t(msg`Un consenso di 8 ore per tutto il team, solo per questo`)}
                    onClick={() => resolveGroupApproval(r.agentId, r.approvalId, 'allow', 'mission')}
                  >
                    <Trans>Consenti per questa missione</Trans>
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() => resolveGroupApproval(r.agentId, r.approvalId, 'deny', 'once')}
                >
                  <Trans>Rifiuta</Trans>
                </Button>
              </div>
            </article>
          ))}
        </Section>

        {/* ——— Fatto da soli, senza chiederti ——— */}
        <Section size="title" title={<Trans>Fatto da soli, senza chiederti</Trans>}>
          <FlatList>
            {groupActivity.map((a) => (
              // UNA riga sola: il conteggio, poi chi l'ha fatto in grigio (i nomi possono essere molti: con lui tronca il resto)
              <FlatRow
                key={a.id}
                title={
                  <>
                    <Trans>{a.count} {i18n.t(ACTIVITY_LABEL[a.id]!)}</Trans>
                    <span className="font-normal text-muted-foreground"> · {a.who.length > 0 ? a.who.join(', ') : '—'}</span>
                  </>
                }
              />
            ))}
          </FlatList>
        </Section>

        {/* ——— Lasciato passare dal revisore ——— */}
        {groupReviewerPassed.length > 0 && (
          <Section size="title" title={<Trans>Lasciato passare dal revisore</Trans>}>
            <FlatList>
              {groupReviewerPassed.map((r, i) => (
                <FlatRow
                  key={i}
                  title={<Trans>{r.agentName} · {r.reason ?? r.tool}</Trans>}
                  trailing={r.grantId !== null ? (
                    <Button variant="ghost" size="sm" onClick={() => { void api.grantRevoke(r.grantId!).then(() => refreshSquadData({ forceBadges: true })) }}>
                      <Trans>Annulla la concessione</Trans>
                    </Button>
                  ) : undefined}
                />
              ))}
            </FlatList>
          </Section>
        )}
      </PageShell>
    </section>
  )
}
