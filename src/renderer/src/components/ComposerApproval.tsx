// A3 (fase approvazioni-chiare): la richiesta si vede DOVE guardi — nella
// chat del bot, la richiesta in attesa di QUEL bot sta SOPRA il campo di
// scrittura, agganciata in basso come le richieste di permesso degli
// strumenti per sviluppatori (il difetto del 22/11: «la notifica in alto
// quasi non la vedo»). Mostra la frase e le SCELTE del modello unico A1 con
// la stessa grafica della card (CardShell waiting); finché c'è una richiesta
// in attesa il campo resta usabile e il riquadro resta visibile anche
// scorrendo (vive nel footer, fuori dal contenitore dei messaggi). Le
// decisioni passano da resolveApproval con via 'chat'.
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { useStore, api } from '../store'
import { visibleApprovalsRows, byUrgency } from '../lib/approvals-center'
// A1: le scelte dal modello UNICO (le stesse della card e del centro)
import { approvalChoicesOf, type ApprovalChoice } from '../lib/approval-app'
import { CardShell } from './DecidedRow'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

/** Il riquadro della richiesta in attesa del bot aperto, sopra il campo. */
export function ComposerApproval({ botId }: { botId: string }): React.ReactNode {
  const { i18n } = useLingui()
  const { t } = useLingui()
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const resolveApproval = useStore((s) => s.resolveApproval)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  const rows = visibleApprovalsRows(approvalsAll, approvalsSnoozed, Date.now()).filter((r) => r.botId === botId)
  if (rows.length === 0) return null
  // la più urgente prima (l'insieme fisso, poi la più vecchia — byUrgency)
  const [first, ...rest] = byUrgency(rows)
  const r = first!
  // A1: le scelte del modello unico; il why 'fisso' vale come il marcatore
  const choices = approvalChoicesOf(
    r.tool,
    { ...(r.meta ?? {}), ...(r.why === 'fisso' ? { squadAlwaysAsk: true } : {}) },
    { isDraft: r.isDraft, squad: r.squad !== null, category: r.category }
  )
  const choiceLabelOf = (c: ApprovalChoice): string => {
    switch (c.kind) {
      case 'turn': return t`Per questo turno`
      case 'minutes10': return t`Consenti per 10 minuti a ${c.app ?? ''}`
      case 'always': return t`Consenti sempre a ${r.botName}`
      case 'server-reads': return t`Consenti sempre le letture di ${c.name ?? c.slug ?? ''}`
      case 'site': return t`Consenti sempre su ${c.domain ?? ''}`
      case 'mission': return t`Consenti per questa missione`
    }
  }
  const decideChoice = (c: ApprovalChoice): void => {
    if (c.kind === 'server-reads') {
      void api.grantServerReads(c.slug!).catch(() => undefined)
      resolveApproval(r.agentId, r.approvalId, 'allow', 'server-reads', 'chat')
      return
    }
    resolveApproval(r.agentId, r.approvalId, 'allow', c.kind, 'chat')
  }
  return (
    <div className="mx-auto mb-2 max-w-3xl" data-testid="composer-approval">
      <CardShell tone="waiting" testid="composer-approval-card">
        <p className="break-all text-[15px] font-semibold">
          <span className="font-medium">{r.botName}</span>
          {r.fromSubagent && <span className="text-muted-foreground"> · <Trans>tramite un sottoagente</Trans></span>}
          <span className="text-muted-foreground"> {i18n.t(msg`vuole`)} {r.phrase}</span>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!r.isDraft ? (
            <>
              <button
                className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
                data-testid="composer-approval-allow"
                onClick={() => resolveApproval(r.agentId, r.approvalId, 'allow', 'once', 'chat')}
              >
                <Trans>Consenti</Trans>
              </button>
              <button
                className="rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
                onClick={() => resolveApproval(r.agentId, r.approvalId, 'deny', 'once', 'chat')}
              >
                <Trans>Rifiuta</Trans>
              </button>
              {choices.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    data-testid="composer-altre-scelte"
                    className="rounded-[10px] px-2.5 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
                  >
                    <Trans>Altre scelte ▾</Trans>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {choices.map((c) => (
                      <DropdownMenuItem
                        key={c.kind}
                        data-testid={`approval-choice-${c.kind}`}
                        disabled={c.disabled === true}
                        onClick={() => decideChoice(c)}
                      >
                        {choiceLabelOf(c)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          ) : (
            // le bozze si decidono col campo della bozza: qui il rinvio al centro
            <button
              className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
              onClick={() => setApprovalsOpen(true, r.approvalId)}
            >
              <Trans>Decidi la bozza</Trans>
            </button>
          )}
          {rest.length > 0 && (
            <button
              className="text-sm text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
              onClick={() => setApprovalsOpen(true)}
            >
              <Trans>+{rest.length} altre</Trans>
            </button>
          )}
        </div>
      </CardShell>
    </div>
  )
}
