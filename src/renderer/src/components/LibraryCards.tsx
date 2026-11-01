// Le card della fase 14 in chat, rese pulite (fase 16b, S6): documento e
// grafico salvati in libreria (icona, titolo, sottotitolo, Apri), la card del
// fill di un login (ambra, con la riga dopo la decisione), il modulo SICURO
// (i campi sono password e salvano via RPC nel vault: mai in chat) e la card
// del contatto da salvare. Niente bordi: fondi tenui, angoli 18 px.
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { FileText, BarChart3, KeyRound, UserRound } from 'lucide-react'
import { api, useStore } from '../store'
import { fillFieldLabel } from '../lib/fill-fields'
import { i18n } from '../lib/i18n'
import type { TranscriptEntry, SendMessagePayload } from '../../../shared/types'
import { DecidedRow, CardShell } from './DecidedRow'

const metaOf = (entry: TranscriptEntry) => (entry.meta ?? {}) as { approvalId?: string; status?: string; message?: SendMessagePayload }

/** Card del documento in libreria: icona, titolo, sottotitolo, Apri (S6). */
export function DocumentCard({ entry }: { entry: TranscriptEntry }) {
  const openLibrary = useStore((s) => s.openLibrary)
  const m = metaOf(entry)
  const doc = m.message as Extract<SendMessagePayload, { type: 'document' }> | undefined
  if (!doc) return null
  return (
    <CardShell>
      <div className="flex items-center gap-3.5">
        <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-card">
          <FileText className="size-5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{doc.title}</span>
          <span className="block text-[13px] text-muted-foreground">
            <Trans>Documento · versione {doc.version}</Trans>
          </span>
        </span>
        <button
          className="shrink-0 rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
          onClick={() => openLibrary(doc.id)}
        >
          <Trans>Apri</Trans>
        </button>
      </div>
    </CardShell>
  )
}

/** Card del grafico in libreria: icona, titolo, sottotitolo, Apri. */
export function ChartCard({ entry }: { entry: TranscriptEntry }) {
  const openLibrary = useStore((s) => s.openLibrary)
  const m = metaOf(entry)
  const chart = m.message as Extract<SendMessagePayload, { type: 'chart' }> | undefined
  if (!chart) return null
  return (
    <CardShell>
      <div className="flex items-center gap-3.5">
        <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-card">
          <BarChart3 className="size-5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{chart.title}</span>
          <span className="block text-[13px] text-muted-foreground"><Trans>Grafico · in Libreria</Trans></span>
        </span>
        <button
          className="shrink-0 rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
          onClick={() => openLibrary(chart.id)}
        >
          <Trans>Apri</Trans>
        </button>
      </div>
    </CardShell>
  )
}

/**
 * Card del fill (7d-3): «Compilo il login «label» su origin?» — dopo la
 * decisione UNA riga (S6). Consenti vale per il resto del turno; «Sempre per
 * questo sito» crea la concessione (loginId, origin).
 */
export function FillCard({ entry }: { entry: TranscriptEntry }) {
  const { i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const resolveApproval = useStore((s) => s.resolveApproval)
  const m = metaOf(entry)
  const fill = m.message as Extract<SendMessagePayload, { type: 'fill' }> | undefined
  if (!fill || !activeId) return null
  const done = m.status && m.status !== 'pending'
  // fase 17c correzioni (D3): i campi sono codici — si traducono qui
  const fieldText = (code: string): string => {
    const label = fillFieldLabel(code)
    return typeof label === 'string' ? label : i18n.t(label)
  }
  const content = (
    <>
      <p className="text-[15px] font-semibold">
        <Trans>Compilo il login «{fill.label}» su <span className="font-mono text-[13px]">{fill.origin}</span>?</Trans>
      </p>
      <p className="mt-1 text-xs text-muted-foreground"><Trans>Campi: {fill.fields.map(fieldText).join(', ')}</Trans></p>
      {!done && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'turn')}
          >
            <Trans>Consenti</Trans>
          </button>
          <button
            className="rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'always')}
          >
            <Trans>Sempre per questo sito</Trans>
          </button>
          <button
            className="rounded-[10px] px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-card hover:text-foreground"
            onClick={() => resolveApproval(m.approvalId!, 'deny', 'once')}
          >
            <Trans>Rifiuta</Trans>
          </button>
        </div>
      )}
    </>
  )
  if (done) {
    return (
      <DecidedRow
        ok={m.status === 'allowed'}
        label={m.status === 'allowed' ? i18n.t(msg`Consentito`) : m.status === 'denied' ? i18n.t(msg`Rifiutato`) : i18n.t(msg`Scaduto`)}
        summary={fill.label}
        at={entry.createdAt}
      >
        <CardShell tone="waiting">{content}</CardShell>
      </DecidedRow>
    )
  }
  return <CardShell tone="waiting">{content}</CardShell>
}

/**
 * Il modulo SICURO (7e): i campi sono di tipo password, salvano nel vault via
 * RPC e NON passano mai dalla chat. Il modello riceve solo l'esito. Dopo la
 * decisione: UNA riga («✓ salvato nel vault» / «annullato»).
 */
export function SecureInputCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
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
  const submit = async (): Promise<void> => {
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
  const content = (
    <>
      <div className="flex items-center gap-2 text-sm">
        <KeyRound className="size-4 text-muted-foreground" />
        <span className="font-medium"><Trans>Modulo sicuro — {card.kind === 'login' ? 'login' : 'secret'}</Trans></span>
      </div>
      <p className="mt-1 text-sm">{card.reason}</p>
      {/* P5: la richiesta nata dopo contenuti letti dal web — origine in evidenza */}
      {card.untrusted && (
        <p className="mt-2 rounded-[10px] bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <Trans>⚠ Richiesta nata dopo contenuti letti dal web: controlla che l'origine sia davvero quella del sito.</Trans>
        </p>
      )}
      {!done && (
        <div className="mt-3 space-y-2">
          {card.kind === 'login' ? (
            <>
              <input className="w-full rounded-[10px] bg-card px-3 py-1.5 text-sm outline-none" placeholder={t`Etichetta (es. Portale ASPI)`} value={label} onChange={(e) => setLabel(e.target.value)} />
              <input
                className={`w-full rounded-[10px] px-3 py-1.5 text-sm outline-none ${card.untrusted ? 'bg-destructive/10 text-destructive' : 'bg-card'}`}
                placeholder={t`Origine https://…`}
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              />
              <input type="password" autoComplete="off" className="w-full rounded-[10px] bg-card px-3 py-1.5 text-sm outline-none" placeholder={t`Nome utente`} value={username} onChange={(e) => setUsername(e.target.value)} />
              <input type="password" autoComplete="new-password" className="w-full rounded-[10px] bg-card px-3 py-1.5 text-sm outline-none" placeholder={t`Password`} value={password} onChange={(e) => setPassword(e.target.value)} />
              <input type="password" autoComplete="off" className="w-full rounded-[10px] bg-card px-3 py-1.5 text-sm outline-none" placeholder={t`Segreto TOTP (opzionale)`} value={totp} onChange={(e) => setTotp(e.target.value)} />
            </>
          ) : (
            <>
              <input className="w-full rounded-[10px] bg-card px-3 py-1.5 text-sm outline-none" placeholder={t`Nome (es. API_KEY)`} value={name} onChange={(e) => setName(e.target.value)} />
              <input type="password" autoComplete="new-password" className="w-full rounded-[10px] bg-card px-3 py-1.5 text-sm outline-none" placeholder={t`Valore`} value={value} onChange={(e) => setValue(e.target.value)} />
            </>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex gap-2">
            <button
              className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
              disabled={busy || (card.kind === 'login' ? !origin || !username || !password : !name || !value)}
              onClick={() => void submit()}
            >
              <Trans>Salva nel vault</Trans>
            </button>
            <button
              className="rounded-[10px] px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-card hover:text-foreground"
              onClick={() => useStore.getState().resolveApproval(m.approvalId!, 'deny', 'once')}
            >
              <Trans>Annulla</Trans>
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground"><Trans>Cifrato sul Mac. Il bot non vedrà mai la password.</Trans></p>
        </div>
      )}
    </>
  )
  if (done) {
    return (
      <DecidedRow ok={m.status === 'allowed'} label={m.status === 'allowed' ? i18n.t(msg`Salvato nel vault`) : i18n.t(msg`Annullato`)} at={entry.createdAt}>
        <CardShell>{content}</CardShell>
      </DecidedRow>
    )
  }
  return <CardShell>{content}</CardShell>
}

/**
 * Card del contatto proposto dal bot (7f): icona, nome, dettagli; «Salva»
 * crea la voce nel vault. Dopo: UNA riga («✓ salvato» / «non salvato»).
 */
export function ContactCard({ entry }: { entry: TranscriptEntry }) {
  const activeId = useStore((s) => s.activeId)
  const resolveApproval = useStore((s) => s.resolveApproval)
  const m = metaOf(entry)
  const card = m.message as Extract<SendMessagePayload, { type: 'contact' }> | undefined
  if (!card || !activeId) return null
  const done = m.status && m.status !== 'pending'
  const content = (
    <>
      <div className="flex items-center gap-2 text-sm">
        <UserRound className="size-4 text-muted-foreground" />
        <span className="font-medium"><Trans>Contatto da salvare nel vault</Trans></span>
      </div>
      {card.untrusted && <p className="mt-1 text-xs text-destructive/90"><Trans>⚠ dati letti da una fonte esterna</Trans></p>}
      <p className="mt-1.5 text-[15px] font-medium">{card.name}</p>
      {card.emails.length > 0 && <p className="text-xs text-muted-foreground">{card.emails.join(', ')}</p>}
      {card.phones.length > 0 && <p className="text-xs text-muted-foreground">{card.phones.join(', ')}</p>}
      {card.address && <p className="text-xs text-muted-foreground">{card.address}</p>}
      {card.notes && <p className="text-xs text-muted-foreground">{card.notes}</p>}
      {!done && (
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
            onClick={() => resolveApproval(m.approvalId!, 'allow', 'once')}
          >
            <Trans>Salva</Trans>
          </button>
          <button
            className="rounded-[10px] px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-card hover:text-foreground"
            onClick={() => resolveApproval(m.approvalId!, 'deny', 'once')}
          >
            <Trans>Non salvare</Trans>
          </button>
        </div>
      )}
    </>
  )
  if (done) {
    return (
      <DecidedRow ok={m.status === 'allowed'} label={m.status === 'allowed' ? i18n.t(msg`Salvato nel vault`) : i18n.t(msg`Non salvato`)} at={entry.createdAt}>
        <CardShell>{content}</CardShell>
      </DecidedRow>
    )
  }
  return <CardShell>{content}</CardShell>
}
