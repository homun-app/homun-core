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
//
// K3 (fase conversione-chat): la coda non si disegna più. Il guscio è
// PageShell e la testata PageHeader (com'era); le tre parti del disegno sono
// ListGroup (il titolo di sezione e le righe a filo); una richiesta è
// ProposalCard — lo stesso guscio delle card in chat (ChatCard, tone attesa):
// il nome del bot, l'etichetta della categoria (Tag), la riga grigia del
// quando e del perché, la frase e i tre bottoni; i contatori e ciò che il
// revisore ha lasciato passare sono ListRow; i bottoni sono Button. Stesse
// sezioni, stesse azioni (compreso «Consenti per questa missione»), stessi
// testi e testid: li cercano la sonda della fase squadra e i test
// (approvals-queue, ds4-approvazioni).
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ShieldCheck } from 'lucide-react'
import { api, useStore } from '../store'
import type { SquadPendingApprovalInfo } from '../../../shared/types'
import { Button } from './ui/button'
import { ListGroup } from './ui/list-group'
import { ListRow } from './ui/list-row'
import { PageHeader } from './ui/page-header'
import { PageShell } from './ui/page-shell'
import { ProposalCard } from './ui/proposal-card'
import { Stack } from './ui/stack'
import { Tag } from './ui/tag'
import { Text } from './ui/text'

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

/**
 * K3, difetto (d): il conteggio di «Fatto da soli, senza chiederti» col
 * PLURALE di Lingui — prima «{count} {etichetta}» diceva «1 comandi nel
 * computer». Le stringhe sono fisse, una voce per attività (il plurale si
 * decide nel catalogo, non si costruisce).
 */
function Conteggio({ id, count }: { id: 'files' | 'commands' | 'pages' | 'bot-messages'; count: number }) {
  switch (id) {
    case 'files': return <Plural value={count} one="# file scritto nel computer" other="# file scritti nel computer" />
    case 'commands': return <Plural value={count} one="# comando nel computer, senza rete" other="# comandi nel computer, senza rete" />
    case 'pages': return <Plural value={count} one="# pagina web letta" other="# pagine web lette" />
    case 'bot-messages': return <Plural value={count} one="# messaggio tra bot del team" other="# messaggi tra bot del team" />
  }
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
        width="wide"
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
        <ListGroup titolo={<Trans>Solo tu puoi decidere</Trans>}>
          {/* le card in una colonna sola: il filetto del gruppo divide le RIGHE, non le card */}
          <Stack>
            {groupPending.length === 0 && (
              <Text size="small" tone="muted"><Trans>Nessuna richiesta in attesa.</Trans></Text>
            )}
            {groupPending.map((r) => {
              // la riga grigia sotto il nome: quando, da chi (un aiutante) e perché arriva a te
              const note = [timeAgo(r.when, now), r.fromSubagent ? i18n.t(msg`aiutante`) : null, r.why ? i18n.t(WHY_LABEL[r.why]) : null].filter((x): x is string => x !== null)
              return (
                <ProposalCard
                  key={`${r.agentId}:${r.approvalId}`}
                  tone="waiting"
                  className="max-w-full"
                  testId="approval-row"
                  titolo={r.agentName}
                  nota={<Tag>{i18n.t(CATEGORY_LABEL[r.category])}</Tag>}
                  righe={<Text size="small" tone="muted">{note.join(' · ')}</Text>}
                  perché={r.phrase}
                  azioni={
                    <>
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
                    </>
                  }
                />
              )
            })}
          </Stack>
        </ListGroup>

        {/* ——— Fatto da soli, senza chiederti ——— */}
        <ListGroup titolo={<Trans>Fatto da soli, senza chiederti</Trans>}>
          {groupActivity.map((a) => (
            // il conteggio è il titolo; chi l'ha fatto è la riga grigia (i nomi possono essere molti: si tronca)
            <ListRow
              key={a.id}
              titolo={<Conteggio id={a.id} count={a.count} />}
              sottotitolo={a.who.length > 0 ? a.who.join(', ') : '—'}
            />
          ))}
        </ListGroup>

        {/* ——— Lasciato passare dal revisore ——— */}
        {groupReviewerPassed.length > 0 && (
          <ListGroup titolo={<Trans>Lasciato passare dal revisore</Trans>}>
            {groupReviewerPassed.map((r, i) => (
              <ListRow
                key={i}
                titolo={<Trans>{r.agentName} · {r.reason ?? r.tool}</Trans>}
                azione={r.grantId !== null ? (
                  <Button variant="secondary" size="sm" onClick={() => { void api.grantRevoke(r.grantId!).then(() => refreshSquadData({ forceBadges: true })) }}>
                    <Trans>Annulla la concessione</Trans>
                  </Button>
                ) : undefined}
              />
            ))}
          </ListGroup>
        )}
      </PageShell>
    </section>
  )
}
