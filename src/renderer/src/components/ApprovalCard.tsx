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
//
// Fase design (DS4): ai token di DS1. Il titolo è quello grande di una card
// (text-title: è la frase che si legge prima di decidere), le righe sotto
// sono text-small grigie, i blocchi (comando, argomenti, dettagli) hanno il
// raggio di controllo su fondo card (CardBlock), i bottoni sono quelli del
// sistema: Consenti è la pillola, Rifiuta è secondario su fondo card, «Altre
// scelte» è testo. La riga compatta è la riga di sistema che apre (come
// quelle di DecidedRow). La logica NON cambia: stesse RPC, stessi testid.
//
// K3 (fase conversione-chat): la card non si disegna più. Il guscio è
// ChatCard (tone attesa, il TITOLO GRANDE: la frase da leggere prima di
// decidere, la riga delle azioni in fondo); le righe sono Text, i blocchi
// dentro la card CardBlock, il comando Code, i dettagli tecnici TechDetails;
// la riga compatta e la riga dopo la decisione sono Disclosure. Il ritmo è
// quello del guscio: i blocchi a 8 px, le azioni a 16. Stesse RPC, stessi
// testi, stessi testid.
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
import { DecidedRow } from './DecidedRow'
import { Button, buttonVariants } from './ui/button'
// K3 (fase conversione-chat): la card è LOGICA sopra il guscio (ChatCard) e i pezzi del catalogo
import { ChatCard, CardBlock } from './ui/chat-card'
import { Code } from './ui/code'
import { Disclosure } from './ui/disclosure'
import { TechDetails } from './ui/tech-details'
import { Text } from './ui/text'
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
  squad = false,
  testId
}: {
  entry: TranscriptEntry
  /** chi chiede: il bot della chat (card) o il bot PADRE della riga (riquadro) */
  agentName: string
  fromSubagent?: boolean
  readOnly?: boolean
  /** il riquadro lo sa dalla riga del centro (r.squad): vale come meta.squadId
   *  per le scelte del modello unico (la missione) */
  squad?: boolean
  /** K3: il testid del guscio (la card dei messaggi: «card-approvazione»; il riquadro: «composer-approval-card») */
  testId?: string
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
    <ChatCard
      tone="waiting"
      titoloGrande
      titolo={useApp?.kind === 'url' && useApp.host
        // U2: l'host in evidenza — «Aprire sora.chatgpt.com nel tuo browser»
        ? <Trans>Aprire <b>{useApp.host}</b> nel tuo browser</Trans>
        : useApp?.kind === 'app' && useApp.app
          ? <Trans>{agentName} vuole usare {useApp.app} sul tuo Mac</Trans>
          : (resolvedTitle ?? i18n.t(approvalAskTitle(tool, entry.meta, agentName, activeLang)))}
      testId={testId}
      azioni={!readOnly && status === 'pending'
        ? (isDraft
            // le bozze si decidono col campo della bozza: qui il rinvio al centro
            ? (
                <Button data-testid="approval-draft-open" onClick={() => setApprovalsOpen(true, approvalId)}>
                  <Trans>Decidi la bozza</Trans>
                </Button>
              )
            : (
                <>
                  <Button
                    data-testid="approval-allow"
                    onClick={() => { resolve(entry.agentId, approvalId!, 'allow', 'once', 'chat'); refreshSquadData({ forceBadges: true }) }}
                  >
                    <Trans>Consenti</Trans>
                  </Button>
                  // K3, difetto (e): una regola sola, quella del catalogo — «Rifiuta» è destructive
                  // (Button), come nel centro «Da approvare» e nella coda della squadra
                  <Button
                    variant="destructive"
                    onClick={() => { resolve(entry.agentId, approvalId!, 'deny', 'once', 'chat'); refreshSquadData({ forceBadges: true }) }}
                  >
                    <Trans>Rifiuta</Trans>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger data-testid="approval-altre-scelte" className={buttonVariants({ variant: 'ghost' })}>
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
              ))
        : undefined}
    >
      {(fromSubagent || composioAction || composioBatch) && (
        <div className="flex flex-col gap-1">
          {fromSubagent && <Text size="small" tone="muted"><Trans>tramite un sottoagente</Trans></Text>}
          {(composioAction || composioBatch) && <Text size="small" tone="muted"><Trans>tramite Composio</Trans></Text>}
        </div>
      )}
      {composioBatch && composioBatch.actions.length > 0 && (
        // C7 punto 1: per ogni azione gli argomenti BREVI prima (destinatari e
        // posti), i testi lunghi DOPO (argumentLines di Rakazo), l'account se c'è
        <CardBlock testId="composio-batch-actions" className="flex flex-col gap-1.5">
          {composioBatch.actions.map((a) => {
            const lines = approvalBatchArgumentLines(a.arguments ?? {})
            return (
              <div key={`${a.slug}-${a.app}`}>
                <div className="flex flex-wrap items-center gap-1">
                  <Text size="small" weight="medium">{a.app} · {a.action}</Text>
                  {a.account ? <Text size="small" tone="muted">({accountLabelOf(accountsOfApp(a.app), a.account)})</Text> : null}
                </div>
                {lines.first.map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <Text size="small" tone="muted" className="shrink-0">{k}:</Text>
                    <Text size="small" className="break-all">{v}</Text>
                  </div>
                ))}
              </div>
            )
          })}
          {composioBatch.actions.flatMap((a) =>
            approvalBatchArgumentLines(a.arguments ?? {}).last.map(([k, v]) => (
              <div key={`${a.slug}-${k}`} className="flex gap-2">
                <Text size="small" tone="muted" className="shrink-0">{a.action || a.slug} {k}:</Text>
                <Text size="small" className="whitespace-pre-wrap break-all">{v}</Text>
              </div>
            ))
          )}
          {composioBatch.incomplete && (
            <Text size="small" tone="muted"><Trans>…e una voce senza nome: chiede sempre l'approvazione</Trans></Text>
          )}
        </CardBlock>
      )}
      {composioArgs && composioArgs.length > 0 && (
        <CardBlock className="flex flex-col gap-0.5">
          {composioArgs.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <Text size="small" tone="muted" className="shrink-0">{k}:</Text>
              <Text size="small" className="break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</Text>
            </div>
          ))}
        </CardBlock>
      )}
      {command !== null && <Code tone="card">{command}</Code>}
      {filePath !== null && <Code tone="card">{filePath}</Code>}
      {/* R3: per Composio e MCP la frase umana; gli altri motivi del gate
          restano i testi di sempre (sono già umani). C7: per il blocco la
          frase nomina le app (e dice quando non si può annullare); il motivo
          SPECIFICO del gate (fiducia C4, voce senza nome) vince sulla frase */}
      {composioBatch && composioBatch.reason === 'trust' && reasonText && reasonText !== tool ? (
        <Text tone="muted">{reasonText}</Text>
      ) : humanReason ? (
        <Text tone="muted">{i18n.t(humanReason)}</Text>
      ) : reasonText && reasonText !== tool && (
        <Text tone="muted">{reasonText}</Text>
      )}
      {appInfo && <TechDetails testo={approvalTechnicalLine(appInfo, tool)} testId="approval-tech-details" />}
      {isRoutine && (
        <CardBlock className="flex flex-col gap-1">
          <div className="flex gap-1">
            <Text size="small" tone="muted" className="shrink-0">{t`Routine:`}</Text>
            <Text size="small">{st?.name ?? (st?.id !== undefined ? `#${st.id}` : '?')}</Text>
          </div>
          {st?.schedule && (
            <div className="flex flex-wrap items-center gap-1">
              <Text size="small" tone="muted" className="shrink-0">{t`Schedule:`}</Text>
              <Text size="small">{describeCron(st.schedule, activeLang)}{st.timezone ? <Trans>, fuso {st.timezone}</Trans> : ''}</Text>
              <Code inline>({st.schedule})</Code>
            </div>
          )}
          {st?.prompt && (
            <div className="flex gap-1">
              <Text size="small" tone="muted" className="shrink-0">{t`Prompt:`}</Text>
              <Text size="small" className="whitespace-pre-wrap">{st.prompt}</Text>
            </div>
          )}
          {isCreateActive && <Text size="small" weight="medium"><Trans>Approvata, la routine nasce attiva e partirà da sola.</Trans></Text>}
        </CardBlock>
      )}
      {secretRefs.length > 0 && (
        <Text size="small" tone="muted"><Trans>Credenziali usate: {secretRefs.join(', ')}</Trans></Text>
      )}
    </ChatCard>
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
    // DS4: la riga di sistema che apre — il bottone del sistema, ghost, 32, col
    // testo di una riga di sistema — la stessa delle righe decise (K3: Disclosure)
    <Disclosure
      segno={<ArrowDown className="size-4" aria-hidden="true" />}
      testo={<Trans>In attesa della tua scelta · qui sotto</Trans>}
      testId="approval-compact-row"
      onClick={focusComposerApproval}
    />
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
        {/* R3: anche qui il titolo umano per Composio/MCP, mai il nome tecnico nudo */}
        <ChatCard titolo={resolvedTitle ?? String(entry.meta?.tool)}>
          <Text size="small" tone="muted">
            {humanReason ? i18n.t(humanReason) : reasonText && reasonText !== entry.meta?.tool ? reasonText : ''}
          </Text>
        </ChatCard>
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
      testId="card-approvazione"
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
            : status === 'expired'
              // K3, difetto (c): la richiesta è scaduta senza risposta — la frase del catalogo (la stessa della presa di controllo scaduta)
              ? i18n.t(msg`Scaduta: il bot non aspetta più`)
              // uno stato che il catalogo non conosce non si mostra com'è: la richiesta è chiusa
              : i18n.t(msg`Chiusa`)
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
        {body}
      </DecidedRow>
    )
  }

  return body
}

/** R1: il dominio del grant di sito per la riga decisa (senza importare il modello della card). */
function siteGrantLabelOf(meta: Record<string, unknown> | null | undefined): string {
  return siteGrantOptionOf(meta)?.domain ?? ''
}
