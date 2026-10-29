// Le card della fase 14 in chat: documento e grafico salvati in libreria (col
// bottone Apri), la card del fill di un login (Consenti per questo turno /
// Sempre per questo sito / Nega), il modulo SICURO (i campi sono di tipo
// password e salvano via RPC nel vault: mai in chat) e la card del contatto
// da salvare. UI minima: verrà ridisegnata.
import { useState } from 'react'
import { api, useStore } from '../store'
import type { TranscriptEntry, SendMessagePayload } from '../../../shared/types'

const metaOf = (entry: TranscriptEntry) => (entry.meta ?? {}) as { approvalId?: string; status?: string; message?: SendMessagePayload }

/** Card del documento in libreria: bottone Apri (apre la vista Libreria). */
export function DocumentCard({ entry }: { entry: TranscriptEntry }) {
  const openLibrary = useStore((s) => s.openLibrary)
  const m = metaOf(entry)
  const doc = m.message as Extract<SendMessagePayload, { type: 'document' }> | undefined
  if (!doc) return null
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-emerald-800/50 bg-emerald-950/20 px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-300/80">Documento in libreria</p>
      <p className="mt-1 text-sm text-neutral-100">{doc.title} <span className="text-neutral-500">v{doc.version}</span></p>
      <button
        className="mt-2 rounded-lg border border-emerald-500 bg-emerald-700/60 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
        onClick={() => openLibrary(doc.id)}
      >
        Apri
      </button>
    </div>
  )
}

/** Card del grafico in libreria: bottone Apri. */
export function ChartCard({ entry }: { entry: TranscriptEntry }) {
  const openLibrary = useStore((s) => s.openLibrary)
  const m = metaOf(entry)
  const chart = m.message as Extract<SendMessagePayload, { type: 'chart' }> | undefined
  if (!chart) return null
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-emerald-800/50 bg-emerald-950/20 px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-300/80">Grafico in libreria</p>
      <p className="mt-1 text-sm text-neutral-100">{chart.title}</p>
      <button
        className="mt-2 rounded-lg border border-emerald-500 bg-emerald-700/60 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
        onClick={() => openLibrary(chart.id)}
      >
        Apri
      </button>
    </div>
  )
}

/**
 * Card del fill (7d-3): "Compilo il login «label» su origin?" — Consenti vale
 * per il resto del turno; "Sempre per questo sito" crea la concessione
 * (loginId, origin) revocabile da Impostazioni → Vault.
 */
export function FillCard({ entry }: { entry: TranscriptEntry }) {
  const activeId = useStore((s) => s.activeId)
  const resolveApproval = useStore((s) => s.resolveApproval)
  const m = metaOf(entry)
  const fill = m.message as Extract<SendMessagePayload, { type: 'fill' }> | undefined
  if (!fill || !activeId) return null
  const done = m.status && m.status !== 'pending'
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-amber-800/50 bg-amber-950/20 px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-amber-300/80">Compilazione login</p>
      <p className="mt-1 text-sm text-neutral-100">
        Compilo il login «{fill.label}» su <span className="font-mono text-xs">{fill.origin}</span>?
      </p>
      <p className="mt-1 text-xs text-neutral-400">Campi: {fill.fields.join(', ')}</p>
      {done ? (
        <p className="mt-2 text-xs text-neutral-500">{m.status === 'allowed' ? '✓ consentito' : m.status === 'denied' ? 'negato' : 'scaduto'}</p>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'turn')}
          >
            Consenti
          </button>
          <button
            className="rounded-lg border border-amber-600 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-900/40"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'always')}
          >
            Sempre per questo sito
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            onClick={() => resolveApproval(m.approvalId!, 'deny', 'once')}
          >
            Nega
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Il modulo SICURO (7e): i campi sono di tipo password, salvano nel vault via
 * RPC e NON passano mai dalla chat. Il modello riceve solo l'esito.
 */
export function SecureInputCard({ entry }: { entry: TranscriptEntry }) {
  const activeId = useStore((s) => s.activeId)
  const m = metaOf(entry)
  const card = m.message as Extract<SendMessagePayload, { type: 'secure-input' }> | undefined
  const [origin, setOrigin] = useState(card?.origin ?? '')
  const [label, setLabel] = useState(card?.label ?? '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [name, setName] = useState(card?.name ?? '')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!card || !activeId) return null
  const done = m.status && m.status !== 'pending'
  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await api.secureInputSubmit(
        activeId,
        m.approvalId!,
        card.kind === 'login'
          ? { origin, label, username, password, ...(totp ? { totp } : {}) }
          : { name, value }
      )
      setUsername(''); setPassword(''); setTotp(''); setValue('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-sky-800/50 bg-sky-950/20 px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-sky-300/80">Modulo sicuro — {card.kind === 'login' ? 'login' : 'secret'}</p>
      <p className="mt-1 text-sm text-neutral-100">{card.reason}</p>
      {/* P5 (fase 14 correzioni): la richiesta nasce dopo contenuti letti dal
          web — l'utente controlla l'origine PRIMA di compilare, ed è in evidenza */}
      {card.untrusted && (
        <p className="mt-2 rounded-lg border border-amber-700/60 bg-amber-950/30 px-2 py-1.5 text-xs text-amber-300">
          ⚠ Richiesta nata dopo contenuti letti dal web: controlla che l'origine sia davvero quella del sito.
        </p>
      )}
      {done ? (
        <p className="mt-2 text-xs text-neutral-500">{m.status === 'allowed' ? '✓ salvato nel vault' : 'annullato'}</p>
      ) : (
        <div className="mt-3 space-y-2">
          {card.kind === 'login' ? (
            <>
              <input className="w-full rounded-lg bg-neutral-900 px-3 py-1.5 text-sm outline-none" placeholder="Etichetta (es. Portale ASPI)" value={label} onChange={(e) => setLabel(e.target.value)} />
              <input
                className={`w-full rounded-lg px-3 py-1.5 text-sm outline-none ${card.untrusted ? 'border border-amber-600 bg-amber-950/20 text-amber-200' : 'bg-neutral-900'}`}
                placeholder="Origine https://…"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              />
              <input type="password" autoComplete="off" className="w-full rounded-lg bg-neutral-900 px-3 py-1.5 text-sm outline-none" placeholder="Nome utente" value={username} onChange={(e) => setUsername(e.target.value)} />
              <input type="password" autoComplete="new-password" className="w-full rounded-lg bg-neutral-900 px-3 py-1.5 text-sm outline-none" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <input type="password" autoComplete="off" className="w-full rounded-lg bg-neutral-900 px-3 py-1.5 text-sm outline-none" placeholder="Segreto TOTP (opzionale)" value={totp} onChange={(e) => setTotp(e.target.value)} />
            </>
          ) : (
            <>
              <input className="w-full rounded-lg bg-neutral-900 px-3 py-1.5 text-sm outline-none" placeholder="Nome (es. API_KEY)" value={name} onChange={(e) => setName(e.target.value)} />
              <input type="password" autoComplete="new-password" className="w-full rounded-lg bg-neutral-900 px-3 py-1.5 text-sm outline-none" placeholder="Valore" value={value} onChange={(e) => setValue(e.target.value)} />
            </>
          )}
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex gap-2">
            <button
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              disabled={busy || (card.kind === 'login' ? !origin || !username || !password : !name || !value)}
              onClick={() => void submit()}
            >
              Salva nel vault
            </button>
            <button
              className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              onClick={() => useStore.getState().resolveApproval(m.approvalId!, 'deny', 'once')}
            >
              Annulla
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Card del contatto proposto dal bot (7f): "Salva" crea la voce nel vault;
 * una proposta nata da un turno contaminato porta l'avviso in cima.
 */
export function ContactCard({ entry }: { entry: TranscriptEntry }) {
  const activeId = useStore((s) => s.activeId)
  const resolveApproval = useStore((s) => s.resolveApproval)
  const m = metaOf(entry)
  const card = m.message as Extract<SendMessagePayload, { type: 'contact' }> | undefined
  if (!card || !activeId) return null
  const done = m.status && m.status !== 'pending'
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-teal-800/50 bg-teal-950/20 px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-teal-300/80">Contatto da salvare nel vault</p>
      {card.untrusted && <p className="mt-1 text-xs text-amber-400/90">⚠ dati letti da una fonte esterna</p>}
      <p className="mt-1 text-sm text-neutral-100">{card.name}</p>
      {card.emails.length > 0 && <p className="text-xs text-neutral-400">{card.emails.join(', ')}</p>}
      {card.phones.length > 0 && <p className="text-xs text-neutral-400">{card.phones.join(', ')}</p>}
      {card.address && <p className="text-xs text-neutral-400">{card.address}</p>}
      {card.notes && <p className="text-xs text-neutral-500">{card.notes}</p>}
      {done ? (
        <p className="mt-2 text-xs text-neutral-500">{m.status === 'allowed' ? '✓ salvato' : 'non salvato'}</p>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-500"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'once')}
          >
            Salva
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            onClick={() => resolveApproval(m.approvalId!, 'deny', 'once')}
          >
            Non salvare
          </button>
        </div>
      )}
    </div>
  )
}
