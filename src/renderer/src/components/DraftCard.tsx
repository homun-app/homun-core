// Fase 16b (S6): la bozza da inviare, pulita. Icona del canale, destinatario,
// oggetto e corpo su fondo chiaro; Invia primario, Modifica, Scarta. Dopo la
// decisione: UNA riga («Inviata a x@y.it · 11:02» o «Scartata», col suo
// segno), riapribile in sola lettura. La logica NON cambia: l'invio vero
// resta al click, passando dal gate; gli argomenti non mappati restano
// visibili (D1).
// Fase design (DS4): ai token di DS1 (in DraftCard le misure di testo, i
// blocchi su fondo card e i bottoni del sistema).
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Mail, MessageSquare, Send as SendIcon } from 'lucide-react'
import { useStore } from '../store'
import { i18n } from '../lib/i18n'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
// K7 (ritocchi): la riga «<app> tramite Composio» quando la via è il blocco
import { composioViaInfo } from '../../../shared/composio-names'
// CA3: l'account della card si risolve negli account del gateway (alias + email)
import { accountLabelOf } from '../lib/apps-view'
import { DecidedRow, CardShell, CardBlock, SU_CARD } from './DecidedRow'
import { Button } from './ui/button'

type Draft = Extract<SendMessagePayload, { type: 'draft' }>

const CHANNEL_ICON = { email: Mail, slack: MessageSquare, other: SendIcon } as const
const CHANNEL_LABEL = { email: 'Email', slack: 'Slack', other: '' } as const

export function DraftCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const send = useStore((s) => s.draftSend)
  const gateway = useStore((s) => s.composioGateway)
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
  // CA3 (fase composio-account): il titolo della card dice QUALE account —
  // l'alias e l'email del gateway quando l'account (alias o id) si risolve
  const viaAccounts = composioVia?.slug ? (gateway?.connected.find((a) => a.slug === composioVia.slug)?.accounts ?? []) : []
  const accountLabel = composioVia?.account ? accountLabelOf(viaAccounts, composioVia.account) : ''

  const startEdit = (): void => {
    setBody(draft.body)
    setEditing(true)
  }

  const content = (
    <>
      {/* DS4, l'anatomia di una card della chat: il titolo (il canale) text-body
          in peso medio; l'account è un metadato (text-caption), lo stato una
          seconda riga (text-small); i blocchi su fondo card (CardBlock); le
          azioni sono i bottoni del sistema */}
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <span className="text-body font-medium text-foreground">{CHANNEL_LABEL[draft.channel] || t`invio esterno`}</span>
        {/* CA3: «Email · da lavoro (fabio@azienda.it)» — l'account in titolo */}
        {accountLabel && <span className="text-caption text-muted-foreground">{t`da ${accountLabel}`}</span>}
        <span className="text-small text-muted-foreground">
          {status === 'pending' ? t`bozza — si invia solo se confermi` : status === 'sent' ? t`inviata` : status === 'error' ? t`errore` : t`scartata`}
        </span>
      </div>
      {/* K7 (ritocchi): come la card d'approvazione, la riga dice da DOVE
          parte l'invio — app umana, e l'account quando c'è */}
      {composioVia && (
        <p className="mt-1 text-small text-muted-foreground">
          {composioVia.account
            ? t`${composioVia.app} tramite Composio (${composioVia.account})`
            : t`${composioVia.app} tramite Composio`}
        </p>
      )}
      <div className="mt-2 text-small text-muted-foreground wrap-anywhere">
        <Trans>A: {draft.to || t`(nessun destinatario)`}</Trans>
        {draft.subject && (<><br /><Trans>Oggetto: {draft.subject}</Trans></>)}
      </div>

      {/* D1: argomenti di via.args non coperti dai campi visibili: sempre visibili */}
      {draft.extraArgs?.length ? (
        <CardBlock className="mt-3">
          <div className="text-small text-muted-foreground"><Trans>Altri parametri (verranno inviati così):</Trans></div>
          {draft.extraArgs.map((p) => (
            <div key={p.key} className="mt-0.5 font-mono text-small">
              <span className="text-muted-foreground">{p.key}:</span> {p.value}
            </div>
          ))}
        </CardBlock>
      ) : null}

      {/* M1: la bozza non ha uno strumento d'invio — lo si vede SUBITO, non al clic */}
      {draft.sendHint && status === 'pending' && (
        <CardBlock className="mt-3 text-small text-muted-foreground">
          {draft.sendHint === 'no-tool' || draft.sendHint === 'missing-required' ? (
            <Trans>Nessuno strumento d'invio per questo canale: copia il testo</Trans>
          ) : (
            <Trans>Più strumenti d'invio per questo canale: chiedi al bot di sceglierne uno</Trans>
          )}
        </CardBlock>
      )}

      {/* R2 (fase app — ritocchi): l'esito dell'invio e il nome tecnico dello
          strumento vivono in un «Dettagli» CHIUSO — mai JSON grezzo in chat */}
      {(status === 'sent' || status === 'error') && (draft.via?.tool || typeof meta.sendResult === 'string') && (
        <details className="mt-3" data-testid="draft-details">
          <summary className="cursor-pointer text-small text-muted-foreground select-none"><Trans>Dettagli</Trans></summary>
          {draft.via?.tool && (
            <p className="mt-1.5 font-mono text-small wrap-anywhere text-muted-foreground">{draft.via.tool}</p>
          )}
          {typeof meta.sendResult === 'string' && meta.sendResult && (
            <pre className="mt-1.5 max-h-40 scroll-thin overflow-auto whitespace-pre-wrap wrap-anywhere rounded-control bg-muted p-3 font-mono text-small text-muted-foreground">{meta.sendResult}</pre>
          )}
        </details>
      )}

      {editing ? (
        <div className="mt-3">
          <textarea
            className="min-h-20 w-full rounded-control bg-card px-3 py-2 text-body outline-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(10, body.split('\n').length)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={() => { update(entry.id, body); setEditing(false) }}>
              <Trans>Salva</Trans>
            </Button>
            <Button variant="secondary" className={SU_CARD} onClick={() => setEditing(false)}>
              <Trans>Annulla</Trans>
            </Button>
          </div>
        </div>
      ) : bodyLocked ? null : (
        // il corpo della bozza: testo da leggere (text-body), che scorre dentro se è lungo
        <pre className="mt-3 max-h-64 scroll-thin overflow-auto whitespace-pre-wrap wrap-anywhere rounded-control bg-card p-3 font-sans text-body text-foreground">{draft.body}</pre>
      )}

      {!closed && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button disabled={noChannel} onClick={() => send(entry.id, editing ? body : undefined)}>
              <Trans>Invia</Trans>
            </Button>
            <Button variant="secondary" className={SU_CARD} onClick={() => discard(entry.id)}>
              <Trans>Scarta</Trans>
            </Button>
            {!editing && !bodyLocked && (
              <Button variant="secondary" className={SU_CARD} onClick={startEdit}>
                <Trans>Modifica</Trans>
              </Button>
            )}
          </div>
          {noChannel && (
            <div className="mt-2 text-small text-muted-foreground"><Trans>nessun canale di invio collegato</Trans></div>
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
            // RW: con autoBasis 'request' il motivo è il reason del revisore;
            // 'rule' (e le entry vecchie senza campo) la regola citata
            ? meta.autoBasis === 'request'
              ? i18n.t(msg`Inviata automaticamente: ${String(meta.reason ?? '')}`)
              : i18n.t(msg`Inviata automaticamente dalla regola: ${String(meta.ruleMatched ?? '')}`)
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
