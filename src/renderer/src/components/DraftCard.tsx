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
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const draft = meta.message as Draft | undefined
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(draft?.body ?? '')

  if (!draft) return null
  const status = meta.status ?? 'pending'
  const closed = status === 'sent' || status === 'discarded'
  // D1: senza canale di invio la bozza è solo testo; senza un argomento
  // mappato sul corpo la modifica non può restare coerente con via.args
  const noChannel = !draft.via
  const bodyLocked = draft.bodyLocked === true

  const startEdit = () => {
    setBody(draft.body)
    setEditing(true)
  }

  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-amber-700/40 bg-amber-950/10 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-amber-300/90">{CHANNEL_LABEL[draft.channel]}</span>
        <span className="text-[11px] text-neutral-500">
          {status === 'pending' ? 'bozza — si invia solo se confermi' : status === 'sent' ? 'inviata' : status === 'error' ? 'errore' : 'scartata'}
        </span>
      </div>
      <div className="mt-1 text-xs text-neutral-300">
        <span className="text-neutral-500">A:</span> {draft.to || '(nessun destinatario)'}
        {draft.subject && (<><br /><span className="text-neutral-500">Oggetto:</span> {draft.subject}</>)}
        {draft.via && (<><br /><span className="text-neutral-600 font-mono text-[10px]">via {draft.via.tool}</span></>)}
      </div>

      {/* D1: argomenti di via.args non coperti dai campi visibili (bcc, cc,
          thread_id, allegati…): sempre visibili, mai collassati */}
      {draft.extraArgs?.length ? (
        <div className="mt-2 rounded-lg bg-neutral-900/60 px-3 py-2">
          <div className="text-[11px] text-neutral-500">Altri parametri (verranno inviati così):</div>
          {draft.extraArgs.map((p) => (
            <div key={p.key} className="mt-0.5 font-mono text-[11px] text-neutral-300">
              <span className="text-neutral-500">{p.key}:</span> {p.value}
            </div>
          ))}
        </div>
      ) : null}

      {editing ? (
        <div className="mt-2">
          <textarea
            className="min-h-[80px] w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(10, body.split('\n').length)}
          />
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
              onClick={() => { update(entry.id, body); setEditing(false) }}
            >
              Salva
            </button>
            <button
              className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
              onClick={() => setEditing(false)}
            >
              Annulla
            </button>
          </div>
        </div>
      ) : bodyLocked ? null : (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-900/60 px-3 py-2 text-xs text-neutral-300">{draft.body}</pre>
      )}

      {closed ? (
        <div className={`mt-2 text-xs ${status === 'sent' ? 'text-emerald-400' : 'text-neutral-500'}`}>
          {status === 'sent' ? '✓ Inviata' : 'Scartata'}
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={noChannel}
              onClick={() => send(entry.id, editing ? body : undefined)}
            >
              Invia
            </button>
            <button
              className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
              onClick={() => discard(entry.id)}
            >
              Scarta
            </button>
            {!editing && !bodyLocked && (
              <button
                className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
                onClick={startEdit}
              >
                Modifica
              </button>
            )}
          </div>
          {noChannel && (
            <div className="mt-1 text-[11px] text-neutral-500">nessun canale di invio collegato</div>
          )}
        </>
      )}
    </div>
  )
}
