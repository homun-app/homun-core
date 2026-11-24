// Le card della fase 14 in chat, rese pulite (fase 16b, S6): la card PAGINA
// del documento (fase pagine G1: il clic apre la pagina), il grafico salvato
// in libreria (icona, titolo, sottotituto, Apri), la card del fill di un login
// (ambra, con la riga dopo la decisione), il modulo SICURO (i campi sono
// password e salvano via RPC nel vault: mai in chat) e la card del contatto da
// salvare. CardShell (DecidedRow) dà il fondo tenue delle card di approvazione.
//
// Fase design (DS4) — le schede in chat passano al sistema:
//  · la card del documento È la scheda della Libreria (le righe di DOC_CARD,
//    da LibraryPanel): rounded-surface col bordo, il titolo in due righe,
//    l'anteprima su quattro, l'etichetta in fondo. Prima era una scheda a
//    parte — titolo grande, l'indice in piccolo, la sfumatura, angoli di 18 px
//    e una max-w-3xl scritti qui —: una scheda sola in tutto l'app, e la
//    larghezza la decide la colonna della chat.
//  · i «⚠» degli avvisi (la richiesta nata dopo letture dal web, i dati di
//    una fonte esterna) sono un'icona lucide in una riga del sistema (Notice:
//    icona · testo text-small).
//  · i campi sono il campo di DS1 (36 px, il raggio dei campi, text-body), le
//    azioni sono Button: la principale è una pillola.
import { useEffect, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { BarChart3, FileText, KeyRound, TriangleAlert, UserRound } from 'lucide-react'
import { api, useStore } from '../store'
import { fillFieldLabel } from '../lib/fill-fields'
import { i18n } from '../lib/i18n'
// fase pagine (G1): l'anteprima della card è la funzione pura della pagina
import { pagePreview, type PagePreview } from '../lib/page-view'
import { cn } from '../lib/utils'
import type { TranscriptEntry, SendMessagePayload } from '../../../shared/types'
import { DecidedRow, CardShell } from './DecidedRow'
import { DOC_CARD } from './LibraryPanel'
import { Button } from './ui/button'
import { Notice } from './ui/notice'

const metaOf = (entry: TranscriptEntry) => (entry.meta ?? {}) as { approvalId?: string; status?: string; message?: SendMessagePayload }

/** Il campo delle card: il campo di DS1 (36 px, il raggio dei campi, text-body), con l'anello del fuoco solo da tastiera. */
const FIELD = 'h-control w-full rounded-control px-3 text-body outline-none transition focus-visible:ring-2 focus-visible:ring-ring'

/** La riga d'avviso dentro una card (la richiesta nata dopo letture dal web): la riga del sistema, in rosso e con il suo fondo tenue. */
function WarnRow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Notice tone="destructive" icon={<TriangleAlert className="size-4" aria-hidden="true" />} className={className}>
      {children}
    </Notice>
  )
}

/**
 * Fase pagine (G1): la card del documento diventa la CARD DELLA PAGINA — il
 * clic APRE LA PAGINA (G2), non più la libreria globale. L'anteprima viene
 * dalla funzione pura pagePreview sul contenuto della versione corrente (il
 * primo paragrafo, mai markdown grezzo: R2).
 * Fase design (DS4): è la scheda della Libreria (DOC_CARD) — titolo, anteprima
 * su quattro righe, etichetta «Pagina» («Pagina · versione N» se N > 1) in
 * fondo, con l'icona del documento.
 */
export function DocumentCard({ entry }: { entry: TranscriptEntry }) {
  const openPage = useStore((s) => s.openPage)
  const m = metaOf(entry)
  const doc = m.message as Extract<SendMessagePayload, { type: 'document' }> | undefined
  const [preview, setPreview] = useState<PagePreview | null>(null)
  useEffect(() => {
    if (!doc) return
    let alive = true
    setPreview(null)
    void api.libraryGet(doc.id)
      .then((c) => { if (alive) setPreview(pagePreview(c.content ?? '')) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [doc?.id, doc?.version]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!doc) return null
  return (
    <div data-testid="page-card" className="w-full">
      <button
        type="button"
        className={cn('flex w-full flex-col gap-2 rounded-surface border bg-card p-4 text-left transition hover:bg-muted/50', DOC_CARD.focus)}
        onClick={() => openPage(doc.id, 'chat')}
      >
        {/* il titolo: quello del primo `# ` del documento, se c'è */}
        <span className={DOC_CARD.title}>{preview?.title ?? doc.title}</span>
        {/* l'anteprima: il primo paragrafo, quattro righe al massimo */}
        <span data-testid="page-card-preview" className={DOC_CARD.preview}>{preview?.intro}</span>
        <span data-testid="page-card-label" className={cn(DOC_CARD.meta, 'flex items-center gap-1.5')}>
          <FileText className="size-4 shrink-0" aria-hidden="true" />
          {doc.version > 1
            ? <Trans>Pagina · versione {doc.version}</Trans>
            : <Trans>Pagina</Trans>}
        </span>
      </button>
    </div>
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
      {/* la riga a filo del sistema (il respiro lo dà già CardShell): icona nello slot da 32, titolo, seconda riga grigia */}
      <div className="flex items-center gap-row-gap">
        <span className="grid size-8 shrink-0 place-items-center text-muted-foreground">
          <BarChart3 className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium">{chart.title}</span>
          <span className="mt-0.5 block truncate text-small text-muted-foreground"><Trans>Grafico · in Libreria</Trans></span>
        </span>
        <Button variant="secondary" size="sm" onClick={() => openLibrary(chart.id)}>
          <Trans>Apri</Trans>
        </Button>
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
      <p className="text-body font-medium">
        <Trans>Compilo il login «{fill.label}» su <span className="font-mono text-small">{fill.origin}</span>?</Trans>
      </p>
      <p className="mt-1 text-small text-muted-foreground"><Trans>Campi: {fill.fields.map(fieldText).join(', ')}</Trans></p>
      {!done && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            onClick={() => resolveApproval(entry.agentId, m.approvalId!, 'allow', 'turn')}
          >
            <Trans>Consenti</Trans>
          </Button>
          <Button
            variant="secondary"
            onClick={() => resolveApproval(entry.agentId, m.approvalId!, 'allow', 'always')}
          >
            <Trans>Sempre per questo sito</Trans>
          </Button>
          <Button
            variant="ghost"
            onClick={() => resolveApproval(entry.agentId, m.approvalId!, 'deny', 'once')}
          >
            <Trans>Rifiuta</Trans>
          </Button>
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
      <div className="flex items-center gap-2 text-body">
        <KeyRound className="size-4 text-muted-foreground" />
        <span className="font-medium"><Trans>Modulo sicuro — {card.kind === 'login' ? 'login' : 'secret'}</Trans></span>
      </div>
      <p className="mt-1 text-body">{card.reason}</p>
      {/* P5: la richiesta nata dopo contenuti letti dal web — origine in evidenza */}
      {card.untrusted && (
        <WarnRow className="mt-2 rounded-control bg-destructive/10 px-3 py-2">
          <Trans>Richiesta nata dopo contenuti letti dal web: controlla che l'origine sia davvero quella del sito.</Trans>
        </WarnRow>
      )}
      {!done && (
        <div className="mt-3 flex flex-col gap-2">
          {card.kind === 'login' ? (
            <>
              <input className={cn(FIELD, 'bg-card')} placeholder={t`Etichetta (es. Portale ASPI)`} value={label} onChange={(e) => setLabel(e.target.value)} />
              <input
                // l'origine di una richiesta nata dal web si nota: lo stesso rosso dell'avviso
                className={cn(FIELD, card.untrusted ? 'bg-destructive/10 text-destructive' : 'bg-card')}
                placeholder={t`Origine https://…`}
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              />
              <input type="password" autoComplete="off" className={cn(FIELD, 'bg-card')} placeholder={t`Nome utente`} value={username} onChange={(e) => setUsername(e.target.value)} />
              <input type="password" autoComplete="new-password" className={cn(FIELD, 'bg-card')} placeholder={t`Password`} value={password} onChange={(e) => setPassword(e.target.value)} />
              <input type="password" autoComplete="off" className={cn(FIELD, 'bg-card')} placeholder={t`Segreto TOTP (opzionale)`} value={totp} onChange={(e) => setTotp(e.target.value)} />
            </>
          ) : (
            <>
              <input className={cn(FIELD, 'bg-card')} placeholder={t`Nome (es. API_KEY)`} value={name} onChange={(e) => setName(e.target.value)} />
              <input type="password" autoComplete="new-password" className={cn(FIELD, 'bg-card')} placeholder={t`Valore`} value={value} onChange={(e) => setValue(e.target.value)} />
            </>
          )}
          {err && <p className="text-small text-destructive">{err}</p>}
          <div className="flex gap-2">
            <Button
              disabled={busy || (card.kind === 'login' ? !origin || !username || !password : !name || !value)}
              onClick={() => void submit()}
            >
              <Trans>Salva nel vault</Trans>
            </Button>
            <Button
              variant="ghost"
              onClick={() => useStore.getState().resolveApproval(entry.agentId, m.approvalId!, 'deny', 'once')}
            >
              <Trans>Annulla</Trans>
            </Button>
          </div>
          <p className="text-caption text-muted-foreground"><Trans>Cifrato sul Mac. Il bot non vedrà mai la password.</Trans></p>
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
      <div className="flex items-center gap-2 text-body">
        <UserRound className="size-4 text-muted-foreground" />
        <span className="font-medium"><Trans>Contatto da salvare nel vault</Trans></span>
      </div>
      {card.untrusted && (
        <WarnRow className="mt-1">
          <Trans>dati letti da una fonte esterna</Trans>
        </WarnRow>
      )}
      <p className="mt-1.5 text-body font-medium">{card.name}</p>
      {card.emails.length > 0 && <p className="text-small text-muted-foreground">{card.emails.join(', ')}</p>}
      {card.phones.length > 0 && <p className="text-small text-muted-foreground">{card.phones.join(', ')}</p>}
      {card.address && <p className="text-small text-muted-foreground">{card.address}</p>}
      {card.notes && <p className="text-small text-muted-foreground">{card.notes}</p>}
      {!done && (
        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => resolveApproval(entry.agentId, m.approvalId!, 'allow', 'once')}
          >
            <Trans>Salva</Trans>
          </Button>
          <Button
            variant="ghost"
            onClick={() => resolveApproval(entry.agentId, m.approvalId!, 'deny', 'once')}
          >
            <Trans>Non salvare</Trans>
          </Button>
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
