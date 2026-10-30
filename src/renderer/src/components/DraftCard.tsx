// Card bozza (§3bis L5): anteprima di un invio esterno con pulsanti
// Invia / Scarta / Modifica (editing inline del body). L'invio vero avviene
// SOLO al click su Invia: il daemon esegue via.tool passando dal gate.
// Review fase 3 (D1): "ciò che l'utente vede è esattamente ciò che viene
// inviato" — gli argomenti non mappati sui campi visibili sono sempre
// mostrati in "Altri parametri", senza via la bozza è solo testo (Invia
// disabilitato), con nomi di argomento sconosciuti la modifica è bloccata.
import { useState } from 'react'
import { useStore } from '../store'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'

type Draft = Extract<SendMessagePayload, { type: 'draft' }>

const CHANNEL_LABEL: Record<Draft['channel'], string> = {
  email: '✉️ Email',
  slack: '💬 Slack',
  other: '📤 Invio esterno'
}

export function DraftCard({ entry }: { entry: TranscriptEntry }) {
  const send = useStore((s) => s.draftSend)
  const discard = useStore((s) => s.draftDiscard)
  const update = useStore((s) => s.draftUpdate)
  const proposeRule = useStore((s) => s.proposeRule)
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

  const startEdit = () => {
    setBody(draft.body)
    setEditing(true)
  }

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-destructive/40 bg-destructive/10 px-4 py-3 shadow-soft">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-destructive/90">{CHANNEL_LABEL[draft.channel]}</span>
        <span className="text-[11px] text-muted-foreground">
          {status === 'pending' ? 'bozza — si invia solo se confermi' : status === 'sent' ? 'inviata' : status === 'error' ? 'errore' : 'scartata'}
        </span>
      </div>
      <div className="mt-1 text-xs text-foreground">
        <span className="text-muted-foreground">A:</span> {draft.to || '(nessun destinatario)'}
        {draft.subject && (<><br /><span className="text-muted-foreground">Oggetto:</span> {draft.subject}</>)}
        {draft.via && (<><br /><span className="text-muted-foreground font-mono text-[10px]">via {draft.via.tool}</span></>)}
      </div>

      {/* D1: argomenti di via.args non coperti dai campi visibili (bcc, cc,
          thread_id, allegati…): sempre visibili, mai collassati */}
      {draft.extraArgs?.length ? (
        <div className="mt-2 rounded-lg bg-muted/50 px-3 py-2">
          <div className="text-[11px] text-muted-foreground">Altri parametri (verranno inviati così):</div>
          {draft.extraArgs.map((p) => (
            <div key={p.key} className="mt-0.5 font-mono text-[11px] text-foreground">
              <span className="text-muted-foreground">{p.key}:</span> {p.value}
            </div>
          ))}
        </div>
      ) : null}

      {editing ? (
        <div className="mt-2">
          <textarea
            className="min-h-[80px] w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(10, body.split('\n').length)}
          />
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-lg bg-chart-2 px-3 py-1.5 text-xs font-medium text-white hover:bg-chart-2/90"
              onClick={() => { update(entry.id, body); setEditing(false) }}
            >
              Salva
            </button>
            <button
              className="rounded-lg bg-muted px-3 py-1.5 text-xs text-foreground hover:bg-accent"
              onClick={() => setEditing(false)}
            >
              Annulla
            </button>
          </div>
        </div>
      ) : bodyLocked ? null : (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-xs text-foreground">{draft.body}</pre>
      )}

      {closed ? (
        <div className={`mt-2 text-xs ${status === 'sent' ? 'text-chart-2' : 'text-muted-foreground'}`}>
          {autoSent
            ? `⚡ Inviata automaticamente dalla regola: ${meta.ruleMatched ?? ''}`
            : status === 'sent'
              ? '✓ Inviata'
              : 'Scartata'}
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-lg bg-chart-2 px-3 py-1.5 text-xs font-medium text-white hover:bg-chart-2/90 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={noChannel}
              onClick={() => send(entry.id, editing ? body : undefined)}
            >
              Invia
            </button>
            <button
              className="rounded-lg bg-muted px-3 py-1.5 text-xs text-foreground hover:bg-accent"
              onClick={() => discard(entry.id)}
            >
              Scarta
            </button>
            {!editing && !bodyLocked && (
              <button
                className="rounded-lg bg-muted px-3 py-1.5 text-xs text-foreground hover:bg-accent"
                onClick={startEdit}
              >
                Modifica
              </button>
            )}
            {/* fase 8: crea una regola di auto-review per invii come questo */}
            <button
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
              title="Apri Impostazioni → Approvazione automatica con una regola precompilata"
              onClick={() =>
                proposeRule(
                  draft.channel === 'email'
                    ? `email in uscita verso ${draft.to || '(destinatario della bozza)'}`
                    : `invii ${draft.channel} verso ${draft.to || '(destinatario della bozza)'}`
                )
              }
            >
              Crea regola da questa azione
            </button>
          </div>
          {noChannel && (
            <div className="mt-1 text-[11px] text-muted-foreground">nessun canale di invio collegato</div>
          )}
        </>
      )}
    </div>
  )
}
