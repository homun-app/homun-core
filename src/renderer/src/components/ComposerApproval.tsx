// A3 (fase approvazioni-chiare): la richiesta si vede DOVE guardi — nella
// chat del bot, la richiesta in attesa di QUEL bot sta SOPRA il campo di
// scrittura, agganciata in basso come le richieste di permesso degli
// strumenti per sviluppatori (il difetto del 22/11: «la notifica in alto
// quasi non la vedo»). Finché c'è una richiesta in attesa il campo resta
// usabile e il riquadro resta visibile anche scorrendo (vive nel footer,
// fuori dal contenitore dei messaggi). Le decisioni passano da
// resolveApproval con via 'chat'.
//
// R1 (fase ritocchi-beta18): il riquadro mostra il PEZZO UNICO della
// richiesta (ApprovalRequestContent) — lo stesso titolo, la stessa frase, gli
// stessi bottoni e la STESSA etichetta «Altre scelte ▾» della card: un solo
// «Consenti» per decisione (la card nei messaggi diventa una riga compatta
// che porta qui). Più richieste dello stesso bot: la più urgente (byUrgency)
// con «1 di N» e le frecce lucide per passare alle altre. Il contenitore è
// focalizzabile (tabIndex -1): il clic sulla riga compatta porta il fuoco qui.
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useStore } from '../store'
import { visibleApprovalsRows, byUrgency } from '../lib/approvals-center'
// R1: il pezzo unico della richiesta — lo stesso della card nei messaggi
import { ApprovalRequestContent } from './ApprovalCard'
import { CardShell } from './DecidedRow'
import type { TranscriptEntry } from '../../../shared/types'

/** Il riquadro della richiesta in attesa del bot aperto, sopra il campo. */
export function ComposerApproval({ botId }: { botId: string }): React.ReactNode {
  const { i18n } = useLingui()
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const index = useStore((s) => s.composerApprovalIndex)
  const setIndex = useStore((s) => s.setComposerApprovalIndex)
  const rows = visibleApprovalsRows(approvalsAll, approvalsSnoozed, Date.now()).filter((r) => r.botId === botId)
  if (rows.length === 0) return null
  // la più urgente prima (l'insieme fisso, poi la più vecchia — byUrgency);
  // l'indice scelto segue le richieste che restano (decisa la prima, si mostra
  // la successiva)
  const ordered = byUrgency(rows)
  const i = Math.min(Math.max(0, index), ordered.length - 1)
  const r = ordered[i]!
  // il pezzo unico legge l'entry: la riga del centro ne ha già meta, frase e
  // ora; approvalId, status e il tool delle BOZZE stanno nella riga di sicuro
  // — si integrano qui, una volta sola
  const entry: TranscriptEntry = {
    id: r.entryId,
    agentId: r.agentId,
    kind: 'approval',
    role: 'system',
    content: r.phrase,
    meta: {
      ...r.meta,
      tool: String(r.meta?.tool ?? r.tool),
      approvalId: r.approvalId,
      status: (r.meta?.status as string | undefined) ?? 'pending'
    },
    createdAt: r.when
  }
  return (
    <div
      className="mx-auto mb-2 max-w-3xl outline-none"
      data-testid="composer-approval"
      tabIndex={-1}
    >
      {ordered.length > 1 && (
        <div className="mb-1 flex items-center justify-center gap-1.5" data-testid="composer-approval-count">
          <button
            data-testid="composer-approval-prev"
            aria-label={i18n.t(msg`Richiesta precedente`)}
            className="grid size-6 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={() => setIndex((i - 1 + ordered.length) % ordered.length)}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <span className="text-xs text-muted-foreground" data-testid="composer-approval-step">
            {i18n.t(msg`${i + 1} di ${ordered.length}`)}
          </span>
          <button
            data-testid="composer-approval-next"
            aria-label={i18n.t(msg`Richiesta successiva`)}
            className="grid size-6 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={() => setIndex((i + 1) % ordered.length)}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
      <CardShell tone="waiting" testid="composer-approval-card">
        <ApprovalRequestContent entry={entry} agentName={r.botName} fromSubagent={r.fromSubagent} squad={r.squad !== null} />
      </CardShell>
    </div>
  )
}
