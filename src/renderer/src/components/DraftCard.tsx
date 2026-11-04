// Fase 16b (S6): la bozza da inviare, pulita. Icona del canale, destinatario,
// oggetto e corpo su fondo chiaro; Invia primario, Modifica, Scarta. Dopo la
// decisione: UNA riga («✓ Inviata a x@y.it · 11:02» o «✗ Scartata»),
// riapribile in sola lettura. La logica NON cambia: l'invio vero resta al
// click, passando dal gate; gli argomenti non mappati restano visibili (D1).
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Mail, MessageSquare, Send as SendIcon } from 'lucide-react'
import { useStore } from '../store'
import { i18n } from '../lib/i18n'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
// K7 (ritocchi): la riga «<app> tramite Composio» quando la via è il blocco
import { composioViaInfo } from '../../../shared/composio-names'
import { DecidedRow, CardShell } from './DecidedRow'

type Draft = Extract<SendMessagePayload, { type: 'draft' }>

const CHANNEL_ICON = { email: Mail, slack: MessageSquare, other: SendIcon } as const
const CHANNEL_LABEL = { email: 'Email', slack: 'Slack', other: '' } as const

export function DraftCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const send = useStore((s) => s.draftSend)
  const discard = useStore((s) => s.draftDiscard)
  const update = useStore((s) => s.draftUpdate)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const draft = meta.message as Draft | undefined
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(draft?.body ?? '')

  if (!draft) return null
  const status = meta.status ?? 'pending'
  const closed = status === 'sent' || status === 'discarded'
  // fase 8: inviata dall'auto-review con una regola dell'utente
  const autoSent = status === 'sent' && meta.autoApproved === true
  const noChannel = !draft.via
  const bodyLocked = draft.bodyLocked === true
  const Icon = CHANNEL_ICON[draft.channel]
  // K7 (ritocchi): se l'invio passa da Composio (il blocco o un composio__),
  // la regola A7 vuole l'etichetta su OGNI superficie — anche sulla bozza
  const composioVia = composioViaInfo(draft.via)

  const startEdit = (): void => {
    setBody(draft.body)
    setEditing(true)
  }

  const content = (
    <>
      <div className="flex items-center gap-2 text-sm">
        <Icon className="size-4 text-muted-foreground" />
        <span className="font-medium">{CHANNEL_LABEL[draft.channel] || t`invio esterno`}</span>
        <span className="text-xs text-muted-foreground">
          {status === 'pending' ? t`bozza — si invia solo se confermi` : status === 'sent' ? t`inviata` : status === 'error' ? t`errore` : t`scartata`}
        </span>
      </div>
      {/* K7 (ritocchi): come la card d'approvazione, la riga dice da DOVE
          parte l'invio — app umana, e l'account quando c'è */}
      {composioVia && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {composioVia.account
            ? t`${composioVia.app} tramite Composio (${composioVia.account})`
            : t`${composioVia.app} tramite Composio`}
        </p>
      )}
      <div className="mt-1 text-xs text-muted-foreground">
        <Trans>A: {draft.to || t`(nessun destinatario)`}</Trans>
        {draft.subject && (<><br /><Trans>Oggetto: {draft.subject}</Trans></>)}
      </div>

      {/* D1: argomenti di via.args non coperti dai campi visibili: sempre visibili */}
      {draft.extraArgs?.length ? (
        <div className="mt-2 rounded-[10px] bg-card px-3 py-2">
          <div className="text-[11px] text-muted-foreground"><Trans>Altri parametri (verranno inviati così):</Trans></div>
          {draft.extraArgs.map((p) => (
            <div key={p.key} className="mt-0.5 font-mono text-[11px]">
              <span className="text-muted-foreground">{p.key}:</span> {p.value}
            </div>
          ))}
        </div>
      ) : null}

      {/* M1: la bozza non ha uno strumento d'invio — lo si vede SUBITO, non al clic */}
      {draft.sendHint && status === 'pending' && (
        <div className="mt-2 rounded-[10px] bg-card px-3 py-2 text-[11px] text-muted-foreground">
          {draft.sendHint === 'no-tool' || draft.sendHint === 'missing-required' ? (
            <Trans>Nessuno strumento d'invio per questo canale: copia il testo</Trans>
          ) : (
            <Trans>Più strumenti d'invio per questo canale: chiedi al bot di sceglierne uno</Trans>
          )}
        </div>
      )}

      {/* R2 (fase app — ritocchi): l'esito dell'invio e il nome tecnico dello
          strumento vivono in un «Dettagli» CHIUSO — mai JSON grezzo in chat */}
      {(status === 'sent' || status === 'error') && (draft.via?.tool || typeof meta.sendResult === 'string') && (
        <details className="mt-2 rounded-[10px] bg-card px-3 py-1.5" data-testid="draft-details">
          <summary className="cursor-pointer select-none text-[11px] text-muted-foreground"><Trans>Dettagli</Trans></summary>
          {draft.via?.tool && (
            <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{draft.via.tool}</p>
          )}
          {typeof meta.sendResult === 'string' && meta.sendResult && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{meta.sendResult}</pre>
          )}
        </details>
      )}

      {editing ? (
        <div className="mt-2">
          <textarea
            className="min-h-20 w-full rounded-[10px] bg-card px-3 py-2 text-sm outline-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(10, body.split('\n').length)}
          />
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-full bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
              onClick={() => { update(entry.id, body); setEditing(false) }}
            >
              <Trans>Salva</Trans>
            </button>
            <button
              className="rounded-full bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
              onClick={() => setEditing(false)}
            >
              <Trans>Annulla</Trans>
            </button>
          </div>
        </div>
      ) : bodyLocked ? null : (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-[10px] bg-card px-3 py-2 text-xs leading-relaxed">{draft.body}</pre>
      )}

      {!closed && (
        <>
          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={noChannel}
              onClick={() => send(entry.id, editing ? body : undefined)}
            >
              <Trans>Invia</Trans>
            </button>
            <button
              className="rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
              onClick={() => discard(entry.id)}
            >
              <Trans>Scarta</Trans>
            </button>
            {!editing && !bodyLocked && (
              <button
                className="rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
                onClick={startEdit}
              >
                <Trans>Modifica</Trans>
              </button>
            )}
          </div>
          {noChannel && (
            <div className="mt-1 text-[11px] text-muted-foreground"><Trans>nessun canale di invio collegato</Trans></div>
          )}
        </>
      )}
    </>
  )

  // dopo la decisione: UNA riga (S6)
  if (closed) {
    return (
      <DecidedRow
        ok={status === 'sent'}
        label={
          autoSent
            ? i18n.t(msg`Inviata automaticamente dalla regola: ${String(meta.ruleMatched ?? '')}`)
            : status === 'sent'
              ? i18n.t(msg`Inviata a ${draft.to || '?'}`)
              : i18n.t(msg`Scartata`)
        }
        at={entry.createdAt}
      >
        <CardShell testid="draft-card">{content}</CardShell>
      </DecidedRow>
    )
  }

  return <CardShell testid="draft-card">{content}</CardShell>
}
