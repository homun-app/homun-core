// Fase 16b (S6): la card di approvazione, pulita. Fondo ambra tenue, titolo
// in parole («Contabile vuole eseguire un comando»), il dettaglio (comando in
// monospace su fondo chiaro) e la frase del rischio che la card ha già
// (reasonKind / i motivi del gate in meta.ui). Bottoni: Consenti primario,
// Rifiuta, e «Altre scelte ▾» col menu delle azioni di oggi (per questo
// turno, sempre, crea una regola). DOPO la decisione la card diventa UNA riga
// grigia cliccabile in sola lettura. La logica NON cambia: stesse RPC.
//
// R1 (fase ritocchi-beta18): il contenuto della richiesta in attesa è UN
// pezzo solo — ApprovalRequestContent, usato sia dalla card nei messaggi sia
// dal riquadro sopra il campo (ComposerApproval), stesso titolo, stessa
// frase, stessi bottoni e la STESSA etichetta «Altre scelte ▾». Il difetto
// del 22/11: due «Consenti» per una decisione sola, con la frase grezza
// dello strumento nel riquadro. Finché la richiesta è in attesa e il
// riquadro c'è, la card nei messaggi diventa UNA RIGA COMPATTA (icona lucide
// ArrowDown, «In attesa della tua scelta · qui sotto») che porta il fuoco
// sul riquadro; dopo la decisione (o la scadenza) torna la card con l'esito.
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { ArrowDown } from 'lucide-react'
import { useStore, api } from '../store'
import { describeCron } from '../../../shared/cron-human'
// fase 17c (C2): il motivo della card si ritraduce dal meta.ui
// P2 (fase pulizia): col nome dello strumento in parole (toolDisplayName)
import { uiTextOfMetaTools, toolCtxOfMeta } from '../lib/ui-text'
import { i18n } from '../lib/i18n'
// R3 (fase app — ritocchi): il modello puro della card per Composio e MCP
// fase Composio OAuth (C7): anche il modello del blocco
import { approvalAppOf, approvalTitleOf, approvalReasonPhrase, approvalTechnicalLine, approvalBatchArgumentLines, approvalAskTitle, approvalOptionFlags, approvalChoicesOf, useAppCardModel, useAppDecidedSummary, siteGrantOptionOf, type ComposioBatchActionMeta, type ApprovalChoice } from '../lib/approval-app'
import { accountLabelOf } from '../lib/apps-view'
import { toolDisplayName } from '../../../shared/tool-names'
import type { TranscriptEntry } from '../../../shared/types'
import { visibleApprovalsRows } from '../lib/approvals-center'
import { DecidedRow, CardShell } from './DecidedRow'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

/** Suggerimento di regola allow partendo dall'azione della card (fase 8). */
function suggestedRule(tool: string, input: Record<string, unknown> | undefined): string {
  if (tool === 'run-command' && typeof input?.command === 'string') {
    return `comandi ${input.command.trim().split(/\s+/)[0] ?? ''} dentro il computer del bot`
  }
  if (tool === 'write-file' && typeof input?.path === 'string') {
    return `scrivere file in ${String(input.path).split('/').slice(0, -1).join('/') || 'cartella del bot'}`
  }
  if (tool === 'read-file' && typeof input?.path === 'string') {
    return `leggere file in ${String(input.path).split('/').slice(0, -1).join('/') || 'cartella del bot'}`
  }
  if (tool.startsWith('mcp__')) return `il tool ${tool}`
  return `il tool ${tool}`
}

/** La sintesi breve della riga dopo la decisione («rm -rf …/vecchi-report»). */
export function approvalSummary(tool: string, input: Record<string, unknown> | undefined, meta?: Record<string, unknown> | null, lang: 'it' | 'en' = 'it'): string {
  if (typeof input?.command === 'string') {
    const cmd = input.command.trim()
    return cmd.length > 32 ? `${cmd.slice(0, 32)}…` : cmd
  }
  if (typeof input?.path === 'string') return input.path.split('/').pop() || input.path
  if (typeof input?.url === 'string') {
    try {
      return new URL(input.url).host
    } catch {
      return input.url.slice(0, 24)
    }
  }
  // P2: il ripiego è il nome umano dello strumento, mai il tecnico nudo
  return toolDisplayName(tool, toolCtxOfMeta(meta, lang))
}

/**
 * R1 (fase ritocchi-beta18): il contenuto UNICO della richiesta in attesa —
 * titolo, frase, dettagli, bottoni e menu. Lo usano la card nei messaggi e
 * il riquadro sopra il campo: UNA decisione, UNA grafica, UN'etichetta
 * («Altre scelte ▾»). Le decisioni passano dalle RPC di sempre con
 * decided_via 'chat'. `readOnly` riapre il pezzo senza bottoni (la riga
 * decisa); `fromSubagent` aggiunge «tramite un sottoagente» (il riquadro
 * parla del bot PADRE, come il centro).
 */
export function ApprovalRequestContent({
  entry,
  agentName,
  fromSubagent = false,
  readOnly = false,
  squad = false
}: {
  entry: TranscriptEntry
  /** chi chiede: il bot della chat (card) o il bot PADRE della riga (riquadro) */
  agentName: string
  fromSubagent?: boolean
  readOnly?: boolean
  /** il riquadro lo sa dalla riga del centro (r.squad): vale come meta.squadId
   *  per le scelte del modello unico (la missione) */
  squad?: boolean
}) {
  const { t } = useLingui()
  // fase 17c (C6): la schedule in linguaggio naturale nella lingua attiva
  const activeLang = i18n.locale === 'en' ? 'en' : 'it'
  const resolve = useStore((s) => s.resolveApproval)
  const proposeRule = useStore((s) => s.proposeRule)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  // R1 (fase ritocchi-beta18): il riquadro è l'UNICO posto dove si decide
  // nella chat del bot — dopo la decisione la lista delle richieste si
  // rilegge SUBITO (come fa il centro), mai una riga già decisa a schermo
  const refreshSquadData = useStore((s) => s.refreshSquadData)
  const approvalId = entry.meta?.approvalId as string | undefined
  const status = (entry.meta?.status as string | undefined) ?? 'pending'
  const tool = String(entry.meta?.tool)
  const input = entry.meta?.input as Record<string, unknown> | undefined

  // R3 (fase app — ritocchi): per gli strumenti Composio e MCP il motivo è
  // una frase umana e il nome tecnico vive nei «Dettagli tecnici» chiusi
  const appInfo = approvalAppOf(tool, entry.meta)
  const humanTitle = approvalTitleOf(appInfo, agentName, activeLang)
  const resolvedTitle = typeof humanTitle === 'string' ? humanTitle : humanTitle ? i18n.t(humanTitle) : null
  const humanReason = appInfo ? approvalReasonPhrase(appInfo) : null

  // fase 17c (C2): il testo del motivo nella lingua attiva (meta.ui);
  // P2 (fase pulizia): il valore {tool} in parole, mai il nome tecnico
  const reasonText = uiTextOfMetaTools(entry.meta, activeLang) ?? entry.content

  // M4 (fase 0.3.1001): tool MCP readOnly di un server manuale — la scelta
  // «Consenti sempre le letture di <server>» vive nel modello unico A1
  // (approvalChoicesOf legge meta.mcpServerRead): grant scope readOnly,
  // controllata sulle annotazioni a ogni chiamata; dopo il click QUESTA
  // chiamata passa once

  // P3 (fase uso-permessi): «Consenti sempre su <dominio registrabile>» — la
  // card di un'azione del browser «sito interattivo» che il grant copre (mai
  // su conferme, invii del modulo o campi probe); dopo il click le navigazioni
  // e i clic non di conferma su quel dominio non chiedono più, revocabile in
  // Impostazioni › Approvazioni
  const siteGrant = siteGrantOptionOf(entry.meta)

  // fase use-app (U3): la card parla di APP o di HOST — «Vuole aprire
  // sora.chatgpt.com nel tuo browser», «Consenti per 10 minuti a Safari». I
  // tasti di invio in posta/chat (approval.useAppSend) chiedono sempre: niente «Sempre»
  const useApp = tool === 'use-app' ? useAppCardModel(input) : null
  const useAppSend = (entry.meta?.ui as { id?: string } | undefined)?.id === 'approval.useAppSend'

  // C4: nomi dei segreti usati dal comando (meta.secretRefs sull'entry approval)
  const secretRefs = Array.isArray(entry.meta?.secretRefs) ? (entry.meta!.secretRefs as string[]) : []
  // fase 4: input di update_state su routine (nome/schedule/prompt per la card)
  const st = entry.meta?.input as
    | { target?: string; action?: string; name?: string; schedule?: string; prompt?: string; id?: number; timezone?: string; activate?: boolean }
    | undefined
  const isRoutine = tool === 'update_state' && st?.target === 'routine'
  // M3 (fase 0.3.1001): create activate — la routine nascerà ATTIVA con
  // quest'unico consenso: la card lo dice e mostra anche il fuso della schedule
  const isCreateActive = isRoutine && st?.action === 'create' && st?.activate === true
  // fase 5 (M1)/fase 8: update_state non offre «sempre»; i comandi never-auto
  // nemmeno «per questo turno»; fase app (A6): le azioni Composio DISTRUTTIVE
  // non offrono «Sempre» (come le installazioni)
  const composioAction = entry.meta?.composioAction as { app?: string; action?: string } | undefined
  // fase Composio OAuth (C7): le azioni del blocco (o le voci di
  // MANAGE_CONNECTIONS / PROXY_EXECUTE) — il titolo viene da loro
  const composioBatch = entry.meta?.composioBatch as { actions: ComposioBatchActionMeta[]; incomplete: boolean; reason?: 'action' | 'incomplete' | 'trust' | 'rule' } | undefined
  // CA3 (fase composio-account): l'account di un'azione si risolve negli
  // account del gateway — «lavoro (fabio@azienda.it)» invece del solo ref
  const gatewayCA = useStore((st) => st.composioGateway)
  const accountsOfApp = (appName: string): ReadonlyArray<{ accountId: string | null; alias?: string; email?: string }> => {
    const hit = gatewayCA?.connected.find((a) => a.name === appName)
    return hit?.accounts ?? []
  }
  // RW: le opzioni in un modello puro — per la LETTURA grezza del PROXY
  // «Per questo turno» è attivo anche se «Sempre» resta disattivato
  const { noAlways, noTurn } = approvalOptionFlags(tool, entry.meta)
  const command = typeof input?.command === 'string' ? input.command : null
  const filePath = typeof input?.path === 'string' ? input.path : null
  // fase app (A6/A7): gli argomenti dell'azione, TUTTI visibili (come D1:
  // nessun campo nascosto) + la riga piccola «tramite Composio»
  const composioArgs = !composioBatch && composioAction && input && typeof input === 'object'
    ? Object.entries(input).filter(([, v]) => v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v)))
    : null

  // A1 (fase approvazioni-chiare): le scelte dal modello UNICO — le stesse
  // del centro «Da approvare» (il difetto del 22/11: «In Da approvare ho
  // sempre e solo una volta»). La card sa della squadra dal meta del turno;
  // il riquadro anche dalla riga del centro (prop squad).
  const choices = approvalChoicesOf(tool, entry.meta, {
    squad: squad || typeof entry.meta?.squadId === 'number' || typeof entry.meta?.squadId === 'string'
  })
  const choiceLabelOf = (c: ApprovalChoice): string => {
    switch (c.kind) {
      case 'turn': return t`Per questo turno`
      case 'minutes10': return t`Consenti per 10 minuti a ${c.app ?? ''}`
      case 'always':
        // U7 (fase prima-release): la concessione vale per il BOT — il nome
        // lo dice (per un aiutante: il bot che l'ha lanciato)
        return useApp?.kind === 'app' && useApp.app && !useAppSend
          ? t`Consenti sempre a ${useApp.app} (per ${agentName})`
          : t`Consenti sempre a ${agentName}`
      case 'server-reads': return t`Consenti sempre le letture di ${c.name ?? c.slug ?? ''}`
      case 'site': return t`Consenti sempre su ${c.domain ?? ''}`
      case 'mission': return t`Consenti per questa missione`
    }
  }
  const choiceTitleOf = (c: ApprovalChoice): string | undefined => {
    switch (c.kind) {
      case 'turn': return noTurn ? t`Questa azione chiede sempre l'approvazione` : t`Vale per lo stesso tool fino alla fine di questo turno`
      case 'minutes10': return t`Le azioni su ${c.app ?? ''} non chiederanno per 10 minuti`
      case 'always':
        return noAlways
          ? (useAppSend || entry.meta?.composioDestructive === true
              ? t`Questa azione chiede sempre l'approvazione`
              : t`Le modifiche di automazione chiedono ogni volta`)
          : undefined
      case 'server-reads': return t`Le letture di questo server non chiederanno più (solo i tool dichiarati in sola lettura)`
      case 'site':
        return t`Navigare, aprire link e cliccare controlli non di conferma su ${c.domain ?? ''} non chiederanno più; le conferme, i pagamenti e i dati tuoi sì. Revocabile in Impostazioni › Approvazioni.`
      case 'mission': return t`Un consenso di 8 ore per tutto il team, solo per questo`
    }
  }
  const decideChoice = (c: ApprovalChoice): void => {
    if (c.kind === 'server-reads') {
      void api.grantServerReads(c.slug!).catch(() => undefined)
      // A2: mode 'server-reads' — la chiamata passa, il registro ricorda il modo
      resolve(entry.agentId, approvalId!, 'allow', 'server-reads', 'chat')
      refreshSquadData({ forceBadges: true })
      return
    }
    resolve(entry.agentId, approvalId!, 'allow', c.kind, 'chat')
    refreshSquadData({ forceBadges: true })
  }

  // R1: le BOZZE si decidono col campo della bozza (come il centro): qui il
  // rinvio, mai Consenti/Rifiuta che non saprebbero cosa fare
  const isDraft = ((entry.meta?.message as { type?: string } | null)?.type) === 'draft'

  return (
    <>
      {useApp?.kind === 'url' && useApp.host ? (
        // U2: l'host in evidenza — «Aprire sora.chatgpt.com nel tuo browser»
        <p className="text-[15px] font-semibold">
          <Trans>Aprire <b>{useApp.host}</b> nel tuo browser</Trans>
        </p>
      ) : useApp?.kind === 'app' && useApp.app ? (
        <p className="text-[15px] font-semibold">
          <Trans>{agentName} vuole usare {useApp.app} sul tuo Mac</Trans>
        </p>
      ) : (
        <p className="break-all text-[15px] font-semibold">
          {resolvedTitle ?? i18n.t(approvalAskTitle(tool, entry.meta, agentName, activeLang))}
        </p>
      )}
      {fromSubagent && (
        <p className="mt-0.5 text-[11px] text-muted-foreground"><Trans>tramite un sottoagente</Trans></p>
      )}
      {(composioAction || composioBatch) && (
        <p className="mt-0.5 text-[11px] text-muted-foreground"><Trans>tramite Composio</Trans></p>
      )}
      {composioBatch && composioBatch.actions.length > 0 && (
        // C7 punto 1: per ogni azione gli argomenti BREVI prima (destinatari e
        // posti), i testi lunghi DOPO (argumentLines di Rakazo), l'account se c'è
        <div className="mt-2 space-y-1.5 rounded-[10px] bg-card px-3 py-2 text-xs" data-testid="composio-batch-actions">
          {composioBatch.actions.map((a) => {
            const lines = approvalBatchArgumentLines(a.arguments ?? {})
            return (
              <div key={`${a.slug}-${a.app}`}>
                <div className="font-medium">
                  {a.app} · {a.action}
                  {a.account ? <span className="ml-1 text-muted-foreground">({accountLabelOf(accountsOfApp(a.app), a.account)})</span> : null}
                </div>
                {lines.first.map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">{k}:</span>
                    <span className="min-w-0 break-all">{v}</span>
                  </div>
                ))}
              </div>
            )
          })}
          {composioBatch.actions.flatMap((a) =>
            approvalBatchArgumentLines(a.arguments ?? {}).last.map(([k, v]) => (
              <div key={`${a.slug}-${k}`} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">{a.action || a.slug} {k}:</span>
                <span className="min-w-0 whitespace-pre-wrap break-all">{v}</span>
              </div>
            ))
          )}
          {composioBatch.incomplete && (
            <div className="text-muted-foreground"><Trans>…e una voce senza nome: chiede sempre l'approvazione</Trans></div>
          )}
        </div>
      )}
      {composioArgs && composioArgs.length > 0 && (
        <div className="mt-2 space-y-0.5 rounded-[10px] bg-card px-3 py-2 text-xs">
          {composioArgs.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">{k}:</span>
              <span className="min-w-0 break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      )}
      {command !== null && (
        <code className="mt-2 block overflow-hidden rounded-[10px] bg-card px-3 py-2 font-mono text-[13px]">{command}</code>
      )}
      {filePath !== null && (
        <code className="mt-2 block overflow-hidden rounded-[10px] bg-card px-3 py-2 font-mono text-[13px]">{filePath}</code>
      )}
      {/* R3: per Composio e MCP la frase umana; gli altri motivi del gate
          restano i testi di sempre (sono già umani). C7: per il blocco la
          frase nomina le app (e dice quando non si può annullare); il motivo
          SPECIFICO del gate (fiducia C4, voce senza nome) vince sulla frase */}
      {composioBatch && composioBatch.reason === 'trust' && reasonText && reasonText !== tool ? (
        <p className="mt-2 text-sm leading-relaxed text-foreground/80">{reasonText}</p>
      ) : humanReason ? (
        <p className="mt-2 text-sm leading-relaxed text-foreground/80">{i18n.t(humanReason)}</p>
      ) : reasonText && reasonText !== tool && (
        <p className="mt-2 text-sm leading-relaxed text-foreground/80">{reasonText}</p>
      )}
      {appInfo && (
        <details className="mt-2 rounded-[10px] bg-card px-3 py-1.5" data-testid="approval-tech-details">
          <summary className="cursor-pointer select-none text-[11px] text-muted-foreground"><Trans>Dettagli tecnici</Trans></summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
            {approvalTechnicalLine(appInfo, tool)}
          </pre>
        </details>
      )}
      {isRoutine && (
        <div className="mt-2 space-y-1 rounded-[10px] bg-card px-3 py-2 text-xs">
          <div><span className="text-muted-foreground">{t`Routine:`} </span>{st?.name ?? (st?.id !== undefined ? `#${st.id}` : '?')}</div>
          {st?.schedule && (
            <div>
              <span className="text-muted-foreground">{t`Schedule:`} </span>{describeCron(st.schedule, activeLang)}
              {st.timezone ? <Trans>, fuso {st.timezone}</Trans> : ''}{' '}
              <span className="font-mono text-muted-foreground">({st.schedule})</span>
            </div>
          )}
          {st?.prompt && <div className="whitespace-pre-wrap"><span className="text-muted-foreground">{t`Prompt:`} </span>{st.prompt}</div>}
          {isCreateActive && (
            <div className="pt-1 font-medium"><Trans>Approvata, la routine nasce attiva e partirà da sola.</Trans></div>
          )}
        </div>
      )}
      {secretRefs.length > 0 && (
        <div className="mt-1 text-xs text-foreground/70"><Trans>Credenziali usate: {secretRefs.join(', ')}</Trans></div>
      )}
      {!readOnly && status === 'pending' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isDraft ? (
            // le bozze si decidono col campo della bozza: qui il rinvio al centro
            <button
              data-testid="approval-draft-open"
              className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
              onClick={() => setApprovalsOpen(true, approvalId)}
            >
              <Trans>Decidi la bozza</Trans>
            </button>
          ) : (
            <>
              <button
                data-testid="approval-allow"
                className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
                onClick={() => { resolve(entry.agentId, approvalId!, 'allow', 'once', 'chat'); refreshSquadData({ forceBadges: true }) }}
              >
                <Trans>Consenti</Trans>
              </button>
              <button
                className="rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
                onClick={() => { resolve(entry.agentId, approvalId!, 'deny', 'once', 'chat'); refreshSquadData({ forceBadges: true }) }}
              >
                <Trans>Rifiuta</Trans>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger data-testid="approval-altre-scelte" className="rounded-[10px] px-2.5 py-1.5 text-sm text-muted-foreground transition hover:text-foreground">
                  <Trans>Altre scelte ▾</Trans>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {/* A1 (fase approvazioni-chiare): le scelte vengono dal modello
                      UNICO approvalChoicesOf — le stesse del centro «Da approvare» */}
                  {choices.map((c) => (
                    <DropdownMenuItem
                      key={c.kind}
                      data-testid={`approval-choice-${c.kind}`}
                      disabled={c.disabled === true}
                      title={choiceTitleOf(c)}
                      onClick={() => decideChoice(c)}
                    >
                      {choiceLabelOf(c)}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    title={t`Apri Impostazioni → Approvazione automatica con una regola precompilata`}
                    onClick={() => proposeRule(suggestedRule(tool, input))}
                  >
                    <Trans>Crea una regola</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      )}
    </>
  )
}

/**
 * R1 (fase ritocchi-beta18): porta il fuoco sul riquadro della richiesta
 * sopra il campo di scrittura — il clic sulla riga compatta nei messaggi.
 */
export function focusComposerApproval(): void {
  if (typeof document === 'undefined') return
  const el = document.querySelector('[data-testid="composer-approval"]') as HTMLElement | null
  el?.scrollIntoView({ block: 'center' })
  el?.focus()
}

/** La riga compatta che prende il posto della card nei messaggi finché la richiesta è in attesa (R1). */
function CompactApprovalRow() {
  return (
    <div className="flex w-full">
      <button
        data-testid="approval-compact-row"
        className="flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-muted/60"
        onClick={focusComposerApproval}
      >
        <ArrowDown className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate"><Trans>In attesa della tua scelta · qui sotto</Trans></span>
      </button>
    </div>
  )
}

export function ApprovalCard({ entry, readOnly = false, ownerName }: { entry: TranscriptEntry; readOnly?: boolean; ownerName?: string }) {
  // fase 17c (C6): la schedule in linguaggio naturale nella lingua attiva
  const activeLang = i18n.locale === 'en' ? 'en' : 'it'
  const agents = useStore((s) => s.agents)
  const activeId = useStore((s) => s.activeId)
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const approvalId = entry.meta?.approvalId as string | undefined
  const status = (entry.meta?.status as string | undefined) ?? 'pending'
  // AH2 (fase aiutanti): la card del figlio nella chat del padre porta il
  // TITOLO dell'aiutante, non il nome del bot attivo (il figlio non è in roster)
  const agentName = ownerName ?? agents.find((a) => a.id === activeId)?.name ?? ''

  // R3 (fase app — ritocchi): per gli strumenti Composio e MCP il motivo è
  // una frase umana e il nome tecnico vive nei «Dettagli tecnici» chiusi
  const appInfo = approvalAppOf(String(entry.meta?.tool), entry.meta)
  const humanTitle = approvalTitleOf(appInfo, agentName, activeLang)
  const resolvedTitle = typeof humanTitle === 'string' ? humanTitle : humanTitle ? i18n.t(humanTitle) : null
  const humanReason = appInfo ? approvalReasonPhrase(appInfo) : null
  const reasonText = uiTextOfMetaTools(entry.meta, activeLang) ?? entry.content

  // fase 8: auto-approvata dall'auto-review — riga compressa, espandibile.
  // fase impostazioni (I4.3): nel modo «Non chiedere» non c'è regola — la
  // riga dice QUALE impostazione ha fatto passare l'azione.
  // RW (fase revisore sulla richiesta): autoBasis 'request' → il reason del
  // revisore; 'rule' (e le entry vecchie senza campo) → la regola citata
  if (entry.meta?.autoApproved) {
    const autoLabel = entry.meta?.autoNever
      ? i18n.t(msg`Eseguito senza chiedere (Approvazioni: non chiedere)`)
      : entry.meta?.autoBasis === 'request'
        ? i18n.t(msg`Approvato automaticamente: ${String(entry.meta?.reason ?? '')}`)
        : i18n.t(msg`Approvato automaticamente dalla regola: ${String(entry.meta?.ruleMatched ?? '')}`)
    return (
      <DecidedRow ok label={autoLabel} at={entry.createdAt}>
        <CardShell>
          {/* R3: anche qui il titolo umano per Composio/MCP, mai il nome tecnico nudo */}
          <p className="text-sm">
            {resolvedTitle ?? String(entry.meta?.tool)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {humanReason ? i18n.t(humanReason) : reasonText && reasonText !== entry.meta?.tool ? reasonText : ''}
          </p>
        </CardShell>
      </DecidedRow>
    )
  }

  if (!approvalId) return null

  // R1 (fase ritocchi-beta18): finché la richiesta è in attesa e il riquadro
  // sopra il campo c'è (il bot aperto ha richieste visibili — le sue o dei
  // suoi sottoagenti), la card nei messaggi è UNA RIGA COMPATTA: si decide
  // dal riquadro, un «Consenti» solo
  const composerVisible = visibleApprovalsRows(approvalsAll, approvalsSnoozed, Date.now())
    .some((r) => r.botId === activeId)
  if (status === 'pending' && !readOnly && composerVisible) {
    return <CompactApprovalRow />
  }

  const body = (
    <ApprovalRequestContent
      entry={entry}
      agentName={agentName}
      readOnly={readOnly || status !== 'pending'}
    />
  )

  // DOPO la decisione: UNA riga grigia; un clic riapre in sola lettura (S6)
  if (status !== 'pending') {
    const tool = String(entry.meta?.tool)
    const input = entry.meta?.input as Record<string, unknown> | undefined
    const mode = entry.meta?.resolutionMode as string | undefined
    const rowLabel =
      status === 'allowed'
        ? (mode === 'turn'
            ? i18n.t(msg`Consentito per il turno`)
            : mode === 'minutes10'
              ? i18n.t(msg`Consentito per 10 minuti`)
              : mode === 'always'
                ? i18n.t(msg`Consentito sempre`)
                : mode === 'site'
                  ? i18n.t(msg`Consentito sempre su ${siteGrantLabelOf(entry.meta)}`)
                  : i18n.t(msg`Consentito una volta`))
        : status === 'denied'
          ? i18n.t(msg`Rifiutato`)
          : status === 'cancelled'
            ? i18n.t(msg`Annullato (interrupt)`)
            : status
    // R6 (use-app · ritocchi): la riga decisa dice l'APP o l'HOST, col modello
    // puro della card — «Consentito una volta · Safari», non «· Computer e schermo»
    const useAppSummary = tool === 'use-app' ? useAppDecidedSummary(input) : null
    return (
      <DecidedRow
        ok={status === 'allowed'}
        label={rowLabel}
        // R3: anche la riga dopo la decisione è umana per Composio e MCP
        // («Slack · Crea promemoria»), mai il nome tecnico dello strumento
        summary={appInfo ? (appInfo.kind === 'composio' && resolvedTitle ? resolvedTitle : appInfo.app) : useAppSummary ?? approvalSummary(tool, input, entry.meta, activeLang)}
        at={entry.createdAt}
      >
        <CardShell tone="waiting" testid="card-approvazione">{body}</CardShell>
      </DecidedRow>
    )
  }

  return <CardShell tone="waiting" testid="card-approvazione">{body}</CardShell>
}

/** R1: il dominio del grant di sito per la riga decisa (senza importare il modello della card). */
function siteGrantLabelOf(meta: Record<string, unknown> | null | undefined): string {
  return siteGrantOptionOf(meta)?.domain ?? ''
}
