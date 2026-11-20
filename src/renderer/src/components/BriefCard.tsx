// P5 (fase uso-permessi): il compito dell'aiutante si legge come un compito,
// non come XML. Il messaggio di apertura del sottoagente era il brief grezzo
// `<brief titolo="…">…` in una bolla scura come se l'avesse scritto l'utente:
// qui è una card «Compito affidato da <bot>» — il nome del padre che l'ha
// lanciato, il TITOLO del compito, le prime righe e «mostra tutto» per il
// resto. Nessun tag visibile; la bola dell'utente resta solo per i messaggi
// dell'utente.
import { useState } from 'react'
import { useStore } from '../store'
import { Trans } from '@lingui/react/macro'
import { parseSubagentBrief } from '../../../shared/agent-message'
import type { TranscriptEntry } from '../../../shared/types'
import { CardShell } from './DecidedRow'

/** Le righe del compito mostrate prima di «mostra tutto». */
const PREVIEW_LINES = 3

export function BriefCard({ entry }: { entry: TranscriptEntry }) {
  const agents = useStore((s) => s.agents)
  // il figlio NON è nel roster (AH2): il padre si trova dai subagents e, in
  // mancanza, dalla riga dell'agente stessa
  const subagents = useStore((s) => s.subagents)
  const brief = parseSubagentBrief(entry.content)
  const [open, setOpen] = useState(false)
  if (!brief) return null
  // chi ha affidato il compito: il PADRE del sottoagente (il brief è testo del
  // padre, non dell'utente)
  const parentId = subagents.find((x) => x.id === entry.agentId)?.parentId
    ?? agents.find((a) => a.id === entry.agentId)?.parentId
  const parentName = agents.find((a) => a.id === parentId)?.name
  const lines = brief.body.split('\n')
  const shown = open ? lines : lines.slice(0, PREVIEW_LINES)
  return (
    <CardShell testid="card-compito-affidato">
      <span className="text-xs font-medium text-muted-foreground">
        {parentName ? <Trans>Compito affidato da {parentName}</Trans> : <Trans>Compito affidato</Trans>}
      </span>
      <p className="mt-1 text-sm font-semibold text-foreground">{brief.title}</p>
      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/85" data-testid="compito-righe">
        {shown.join('\n')}
      </p>
      {lines.length > PREVIEW_LINES && (
        <button
          className="mt-1 text-[13px] text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
          data-testid="compito-mostra-tutto"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <Trans>mostra meno</Trans> : <Trans>mostra tutto</Trans>}
        </button>
      )}
    </CardShell>
  )
}
