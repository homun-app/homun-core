// Fase 16b (S6): la card di approvazione, pulita. Fondo ambra tenue, titolo
// in parole («Contabile vuole eseguire un comando»), il dettaglio (comando in
// monospace su fondo chiaro) e la frase del rischio che la card ha già
// (reasonKind / i motivi del gate in meta.ui). Bottoni: Consenti primario,
// Rifiuta, e «Altre opzioni ▾» col menu delle azioni di oggi (per questo
// turno, sempre, crea una regola). DOPO la decisione la card diventa UNA riga
// grigia cliccabile in sola lettura. La logica NON cambia: stesse RPC.
import { useState } from 'react'
import { useStore, api } from '../store'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { describeCron } from '../../../shared/cron-human'
// fase 17c (C2): il motivo della card si ritraduce dal meta.ui
// P2 (fase pulizia): col nome dello strumento in parole (toolDisplayName)
import { uiTextOfMetaTools, toolCtxOfMeta } from '../lib/ui-text'
import { i18n } from '../lib/i18n'
// R3 (fase app — ritocchi): il modello puro della card per Composio e MCP
// fase Composio OAuth (C7): anche il modello del blocco
import { approvalAppOf, approvalTitleOf, approvalReasonPhrase, approvalTechnicalLine, approvalBatchArgumentLines, approvalAskTitle, approvalOptionFlags, useAppCardModel, useAppDecidedSummary, type ComposioBatchActionMeta } from '../lib/approval-app'
import { toolDisplayName } from '../../../shared/tool-names'
import type { TranscriptEntry } from '../../../shared/types'
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

/** Il titolo in parole: cosa vuole fare il bot con questo tool (P2: modello puro in approval-app). */
function askTitle(tool: string, meta: Record<string, unknown> | null | undefined, name: string, lang: 'it' | 'en'): string {
  return i18n.t(approvalAskTitle(tool, meta, name, lang))
}

export function ApprovalCard({ entry, readOnly = false }: { entry: TranscriptEntry; readOnly?: boolean }) {
  const { t } = useLingui()
  // fase 17c (C6): la schedule in linguaggio naturale nella lingua attiva
  const activeLang = i18n.locale === 'en' ? 'en' : 'it'
  const agents = useStore((s) => s.agents)
  const activeId = useStore((s) => s.activeId)
  const resolve = useStore((s) => s.resolveApproval)
  const proposeRule = useStore((s) => s.proposeRule)
  const approvalId = entry.meta?.approvalId as string | undefined
  const status = (entry.meta?.status as string | undefined) ?? 'pending'
  const tool = String(entry.meta?.tool)
  const agentName = agents.find((a) => a.id === activeId)?.name ?? ''
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

  // M4 (fase 0.3.1001): tool MCP readOnly di un server manuale — la card offre
  // «Consenti sempre le letture di <server>» (grant scope readOnly, controllata
  // sulle annotazioni a ogni chiamata); dopo il click QUESTA chiamata passa once
  const mcpServerRead = entry.meta?.mcpServerRead as { slug?: string; name?: string } | undefined

  // fase use-app (U3): la card parla di APP o di HOST — «Vuole aprire
  // sora.chatgpt.com nel tuo browser», «Consenti per 10 minuti a Safari». I
  // tasti di invio in posta/chat (approval.useAppSend) chiedono sempre: niente «Sempre»
  const useApp = tool === 'use-app' ? useAppCardModel(input) : null
  const useAppSend = (entry.meta?.ui as { id?: string } | undefined)?.id === 'approval.useAppSend'

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
            {resolvedTitle ?? tool}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {humanReason ? i18n.t(humanReason) : reasonText && reasonText !== tool ? reasonText : ''}
          </p>
        </CardShell>
      </DecidedRow>
    )
  }

  if (!approvalId) return null
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

  const body = (
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
        <p className="text-[15px] font-semibold">
          {resolvedTitle ?? askTitle(tool, entry.meta, agentName, activeLang)}
        </p>
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
                  {a.account ? <span className="ml-1 text-muted-foreground">({a.account})</span> : null}
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
          <button
            className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
            onClick={() => resolve(approvalId, 'allow', 'once')}
          >
            <Trans>Consenti</Trans>
          </button>
          <button
            className="rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
            onClick={() => resolve(approvalId, 'deny', 'once')}
          >
            <Trans>Rifiuta</Trans>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded-[10px] px-2.5 py-1.5 text-sm text-muted-foreground transition hover:text-foreground">
              <Trans>Altre opzioni ▾</Trans>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                disabled={noTurn}
                title={noTurn ? t`Questa azione chiede sempre l'approvazione` : t`Vale per lo stesso tool fino alla fine di questo turno`}
                onClick={() => resolve(approvalId, 'allow', 'turn')}
              >
                <Trans>Per questo turno</Trans>
              </DropdownMenuItem>
              {useApp?.kind === 'app' && useApp.app && !useAppSend && (
                <DropdownMenuItem
                  title={t`Le azioni su ${useApp.app} non chiederanno per 10 minuti`}
                  onClick={() => resolve(approvalId, 'allow', 'minutes10')}
                >
                  <Trans>Consenti per 10 minuti a {useApp.app}</Trans>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={noAlways}
                title={noAlways ? (useAppSend ? t`Questa azione chiede sempre l'approvazione` : entry.meta?.composioDestructive === true ? t`Questa azione chiede sempre l'approvazione` : t`Le modifiche di automazione chiedono ogni volta`) : undefined}
                onClick={() => resolve(approvalId, 'allow', 'always')}
              >
                {useApp?.kind === 'app' && useApp.app && !useAppSend ? (
                  <Trans>Consenti sempre a {useApp.app}</Trans>
                ) : (
                  <Trans>Sempre</Trans>
                )}
              </DropdownMenuItem>
              {mcpServerRead?.slug && (
                <DropdownMenuItem
                  title={t`Le letture di questo server non chiederanno più (solo i tool dichiarati in sola lettura)`}
                  onClick={() => {
                    void api.grantServerReads(mcpServerRead.slug!).catch(() => undefined)
                    resolve(approvalId, 'allow', 'once')
                  }}
                >
                  <Trans>Consenti sempre le letture di {mcpServerRead.name ?? mcpServerRead.slug}</Trans>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                title={t`Apri Impostazioni → Approvazione automatica con una regola precompilata`}
                onClick={() => proposeRule(suggestedRule(tool, input))}
              >
                <Trans>Crea una regola</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </>
  )

  // DOPO la decisione: UNA riga grigia; un clic riapre in sola lettura (S6)
  if (status !== 'pending') {
    const mode = entry.meta?.resolutionMode as string | undefined
    const rowLabel =
      status === 'allowed'
        ? (mode === 'turn'
            ? i18n.t(msg`Consentito per il turno`)
            : mode === 'minutes10'
              ? i18n.t(msg`Consentito per 10 minuti`)
              : mode === 'always'
                ? i18n.t(msg`Consentito sempre`)
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
        <CardShell tone="waiting">{body}</CardShell>
      </DecidedRow>
    )
  }

  return <CardShell tone="waiting">{body}</CardShell>
}
