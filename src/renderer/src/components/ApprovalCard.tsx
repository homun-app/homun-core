// Fase 16b (S6): la card di approvazione, pulita. Fondo ambra tenue, titolo
// in parole («Contabile vuole eseguire un comando»), il dettaglio (comando in
// monospace su fondo chiaro) e la frase del rischio che la card ha già
// (reasonKind / i motivi del gate in meta.ui). Bottoni: Consenti primario,
// Rifiuta, e «Altre opzioni ▾» col menu delle azioni di oggi (per questo
// turno, sempre, crea una regola). DOPO la decisione la card diventa UNA riga
// grigia cliccabile in sola lettura. La logica NON cambia: stesse RPC.
import { useState } from 'react'
import { useStore } from '../store'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { describeCron } from '../../../shared/cron-human'
// fase 17c (C2): il motivo della card si ritraduce dal meta.ui
import { uiTextOfMeta } from '../lib/ui-text'
import { i18n } from '../lib/i18n'
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
export function approvalSummary(tool: string, input: Record<string, unknown> | undefined): string {
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
  return tool
}

/** Il titolo in parole: cosa vuole fare il bot con questo tool. */
function askTitle(tool: string, name: string): string {
  switch (tool) {
    case 'run-command':
    case 'run_command':
      return i18n.t(msgTitleCommand(name))
    case 'write-file':
    case 'write_file':
    case 'edit-file':
      return i18n.t(msgTitleWrite(name))
    case 'read-file':
      return i18n.t(msgTitleRead(name))
    case 'update_state':
      return i18n.t(msgTitleAutomation(name))
    default:
      return i18n.t(msgTitleGeneric(name, tool))
  }
}
const msgTitleCommand = (name: string) => msg`${name} vuole eseguire un comando`
const msgTitleWrite = (name: string) => msg`${name} vuole scrivere un file`
const msgTitleRead = (name: string) => msg`${name} vuole leggere un file`
const msgTitleAutomation = (name: string) => msg`${name} vuole cambiare un'automazione`
const msgTitleGeneric = (name: string, tool: string) => msg`${name} vuole usare ${tool}`

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

  // fase 17c (C2): il testo del motivo nella lingua attiva (meta.ui)
  const reasonText = uiTextOfMeta(entry.meta) ?? entry.content

  // fase 8: auto-approvata dall'auto-review — riga compressa, espandibile
  if (entry.meta?.autoApproved) {
    return (
      <DecidedRow ok label={i18n.t(msg`Approvato automaticamente: ${String(entry.meta?.ruleMatched ?? '')}`)} at={entry.createdAt}>
        <CardShell>
          <p className="text-sm">{tool}</p>
          <p className="mt-1 text-xs text-muted-foreground">{reasonText && reasonText !== tool ? reasonText : ''}</p>
        </CardShell>
      </DecidedRow>
    )
  }

  if (!approvalId) return null
  // C4: nomi dei segreti usati dal comando (meta.secretRefs sull'entry approval)
  const secretRefs = Array.isArray(entry.meta?.secretRefs) ? (entry.meta!.secretRefs as string[]) : []
  // fase 4: input di update_state su routine (nome/schedule/prompt per la card)
  const st = entry.meta?.input as
    | { target?: string; action?: string; name?: string; schedule?: string; prompt?: string; id?: number }
    | undefined
  const isRoutine = tool === 'update_state' && st?.target === 'routine'
  // fase 5 (M1)/fase 8: update_state non offre «sempre»; i comandi never-auto
  // nemmeno «per questo turno»
  const noAlways = tool === 'update_state'
  const noTurn = noAlways || entry.meta?.neverAuto === true
  const command = typeof input?.command === 'string' ? input.command : null
  const filePath = typeof input?.path === 'string' ? input.path : null

  const body = (
    <>
      <p className="text-[15px] font-semibold">{askTitle(tool, agentName)}</p>
      {command !== null && (
        <code className="mt-2 block overflow-hidden rounded-[10px] bg-card px-3 py-2 font-mono text-[13px]">{command}</code>
      )}
      {filePath !== null && (
        <code className="mt-2 block overflow-hidden rounded-[10px] bg-card px-3 py-2 font-mono text-[13px]">{filePath}</code>
      )}
      {reasonText && reasonText !== tool && (
        <p className="mt-2 text-sm leading-relaxed text-foreground/80">{reasonText}</p>
      )}
      {isRoutine && (
        <div className="mt-2 space-y-1 rounded-[10px] bg-card px-3 py-2 text-xs">
          <div><span className="text-muted-foreground">{t`Routine:`} </span>{st?.name ?? (st?.id !== undefined ? `#${st.id}` : '?')}</div>
          {st?.schedule && (
            <div>
              <span className="text-muted-foreground">{t`Schedule:`} </span>{describeCron(st.schedule, activeLang)}{' '}
              <span className="font-mono text-muted-foreground">({st.schedule})</span>
            </div>
          )}
          {st?.prompt && <div className="whitespace-pre-wrap"><span className="text-muted-foreground">{t`Prompt:`} </span>{st.prompt}</div>}
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
              <DropdownMenuItem
                disabled={noAlways}
                title={noAlways ? t`Le modifiche di automazione chiedono ogni volta` : undefined}
                onClick={() => resolve(approvalId, 'allow', 'always')}
              >
                <Trans>Sempre</Trans>
              </DropdownMenuItem>
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
            : mode === 'always'
              ? i18n.t(msg`Consentito sempre`)
              : i18n.t(msg`Consentito una volta`))
        : status === 'denied'
          ? i18n.t(msg`Rifiutato`)
          : status === 'cancelled'
            ? i18n.t(msg`Annullato (interrupt)`)
            : status
    return (
      <DecidedRow ok={status === 'allowed'} label={rowLabel} summary={approvalSummary(tool, input)} at={entry.createdAt}>
        <CardShell tone="waiting">{body}</CardShell>
      </DecidedRow>
    )
  }

  return <CardShell tone="waiting">{body}</CardShell>
}
