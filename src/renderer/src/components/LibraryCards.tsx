// Le card della fase 14 in chat: documento e grafico salvati in libreria (col
// bottone Apri), la card del fill di un login (Consenti per questo turno /
// Sempre per questo sito / Nega), il modulo SICURO (i campi sono di tipo
// password e salvano via RPC nel vault: mai in chat) e la card del contatto
// da salvare. UI minima: verrà ridisegnata.
import { useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
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
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-chart-2/40 bg-chart-2/10 px-4 py-3 shadow-soft">
      <p className="text-[10px] font-medium uppercase tracking-wide text-chart-2/80"><Trans>Documento in libreria</Trans></p>
      <p className="mt-1 text-sm text-foreground">{doc.title} <span className="text-muted-foreground">v{doc.version}</span></p>
      <button
        className="mt-2 rounded-lg border border-chart-2 bg-chart-2 px-3 py-1.5 text-xs font-medium text-white hover:bg-chart-2/90"
        onClick={() => openLibrary(doc.id)}
      >
        <Trans>Apri</Trans>
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
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-chart-2/40 bg-chart-2/10 px-4 py-3 shadow-soft">
      <p className="text-[10px] font-medium uppercase tracking-wide text-chart-2/80"><Trans>Grafico in libreria</Trans></p>
      <p className="mt-1 text-sm text-foreground">{chart.title}</p>
      <button
        className="mt-2 rounded-lg border border-chart-2 bg-chart-2 px-3 py-1.5 text-xs font-medium text-white hover:bg-chart-2/90"
        onClick={() => openLibrary(chart.id)}
      >
        <Trans>Apri</Trans>
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
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-destructive/40 bg-destructive/10 px-4 py-3 shadow-soft">
      <p className="text-[10px] font-medium uppercase tracking-wide text-destructive/80"><Trans>Compilazione login</Trans></p>
      <p className="mt-1 text-sm text-foreground">
        <Trans>Compilo il login «{fill.label}» su <span className="font-mono text-xs">{fill.origin}</span>?</Trans>
      </p>
      <p className="mt-1 text-xs text-muted-foreground"><Trans>Campi: {fill.fields.join(', ')}</Trans></p>
      {done ? (
        <p className="mt-2 text-xs text-muted-foreground">{m.status === 'allowed' ? <Trans>✓ consentito</Trans> : m.status === 'denied' ? <Trans>negato</Trans> : <Trans>scaduto</Trans>}</p>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-white hover:bg-destructive/90"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'turn')}
          >
            <Trans>Consenti</Trans>
          </button>
          <button
            className="rounded-lg border border-destructive/60 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'always')}
          >
            <Trans>Sempre per questo sito</Trans>
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => resolveApproval(m.approvalId!, 'deny', 'once')}
          >
            <Trans>Nega</Trans>
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
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <p className="text-[10px] font-medium uppercase tracking-wide text-primary/80"><Trans>Modulo sicuro — {card.kind === 'login' ? 'login' : 'secret'}</Trans></p>
      <p className="mt-1 text-sm text-foreground">{card.reason}</p>
      {/* P5 (fase 14 correzioni): la richiesta nasce dopo contenuti letti dal
          web — l'utente controlla l'origine PRIMA di compilare, ed è in evidenza */}
      {card.untrusted && (
        <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <Trans>⚠ Richiesta nata dopo contenuti letti dal web: controlla che l'origine sia davvero quella del sito.</Trans>
        </p>
      )}
      {done ? (
        <p className="mt-2 text-xs text-muted-foreground">{m.status === 'allowed' ? <Trans>✓ salvato nel vault</Trans> : <Trans>annullato</Trans>}</p>
      ) : (
        <div className="mt-3 space-y-2">
          {card.kind === 'login' ? (
            <>
              <input className="w-full rounded-lg bg-muted px-3 py-1.5 text-sm outline-none" placeholder={t`Etichetta (es. Portale ASPI)`} value={label} onChange={(e) => setLabel(e.target.value)} />
              <input
                className={`w-full rounded-lg px-3 py-1.5 text-sm outline-none ${card.untrusted ? 'border border-destructive bg-destructive/10 text-destructive' : 'bg-muted'}`}
                placeholder={t`Origine https://…`}
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              />
              <input type="password" autoComplete="off" className="w-full rounded-lg bg-muted px-3 py-1.5 text-sm outline-none" placeholder={t`Nome utente`} value={username} onChange={(e) => setUsername(e.target.value)} />
              <input type="password" autoComplete="new-password" className="w-full rounded-lg bg-muted px-3 py-1.5 text-sm outline-none" placeholder={t`Password`} value={password} onChange={(e) => setPassword(e.target.value)} />
              <input type="password" autoComplete="off" className="w-full rounded-lg bg-muted px-3 py-1.5 text-sm outline-none" placeholder={t`Segreto TOTP (opzionale)`} value={totp} onChange={(e) => setTotp(e.target.value)} />
            </>
          ) : (
            <>
              <input className="w-full rounded-lg bg-muted px-3 py-1.5 text-sm outline-none" placeholder={t`Nome (es. API_KEY)`} value={name} onChange={(e) => setName(e.target.value)} />
              <input type="password" autoComplete="new-password" className="w-full rounded-lg bg-muted px-3 py-1.5 text-sm outline-none" placeholder={t`Valore`} value={value} onChange={(e) => setValue(e.target.value)} />
            </>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex gap-2">
            <button
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
              disabled={busy || (card.kind === 'login' ? !origin || !username || !password : !name || !value)}
              onClick={() => void submit()}
            >
              <Trans>Salva nel vault</Trans>
            </button>
            <button
              className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => useStore.getState().resolveApproval(m.approvalId!, 'deny', 'once')}
            >
              <Trans>Annulla</Trans>
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
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <p className="text-[10px] font-medium uppercase tracking-wide text-chart-2"><Trans>Contatto da salvare nel vault</Trans></p>
      {card.untrusted && <p className="mt-1 text-xs text-destructive/90"><Trans>⚠ dati letti da una fonte esterna</Trans></p>}
      <p className="mt-1 text-sm text-foreground">{card.name}</p>
      {card.emails.length > 0 && <p className="text-xs text-muted-foreground">{card.emails.join(', ')}</p>}
      {card.phones.length > 0 && <p className="text-xs text-muted-foreground">{card.phones.join(', ')}</p>}
      {card.address && <p className="text-xs text-muted-foreground">{card.address}</p>}
      {card.notes && <p className="text-xs text-muted-foreground">{card.notes}</p>}
      {done ? (
        <p className="mt-2 text-xs text-muted-foreground">{m.status === 'allowed' ? <Trans>✓ salvato</Trans> : <Trans>non salvato</Trans>}</p>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'once')}
          >
            <Trans>Salva</Trans>
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => resolveApproval(m.approvalId!, 'deny', 'once')}
          >
            <Trans>Non salvare</Trans>
          </button>
        </div>
      )}
    </div>
  )
}
