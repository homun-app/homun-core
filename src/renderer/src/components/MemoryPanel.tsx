// Sezione "Memoria" della vista dell'agente — fase memoria-engramma (M6):
// un'interfaccia sul motore Engramma (RPC memory:* del demone).
//   elenco    per bot e condiviso; filtri core/log e stato (attive, in attesa
//             di conferma);
//   ricerca   lo stesso motore del bot;
//   dettaglio «Perché lo so?»: fonte (link alla conversazione), affidabilità,
//             date di validità, storico delle versioni e, per un richiamo,
//             la spiegazione (explain);
//   in attesa di conferma: Conferma o Scarta;
//   Elimina  lapide, si ripristina dallo storico; il filtro «eliminate» le
//             mostra (correzioni C4) e Dimentica per sempre: purge (conferma
//             che spiega che non si torna indietro), anche dalla lapide;
//   modello  stato e download SOLO dal click (circa 400 MB), con avanzamento.
//
// Fase design (DS4): i testi ai token di DS1 — il corpo di una nota è
// text-body (è il contenuto che si legge), le righe attorno text-small
// grigie, i contrassegni (proprietario, livello, stato, date) text-caption —
// e le azioni sono i bottoni del sistema: le pillole scritte a mano, di 11 px
// e 20 px, diventano Button da 32. L'emoji del titolo diventa un'icona lucide
// e i due «✕» (che avevano per nome accessibile il solo segno) due bottoni
// d'icona con il loro nome. I colori fuori tema (ambra, rosso e bianco di
// Tailwind) tornano ai token: l'attesa è «waiting», il resto è destructive.
import { useEffect, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Brain, X } from 'lucide-react'
import { formatDate } from '../lib/i18n'

/** Le date del motore sono RFC 3339: formatDate vuole un istante. */
const fmt = (iso: string): string => formatDate(new Date(iso), { year: 'numeric', month: 'numeric', day: 'numeric' })
import { api, useStore } from '../store'
import type { MemoryNoteInfo, MemoryNoteDetail, MemorySearchHitInfo, MemoryOverview } from '../../../shared/types'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

/** Un contrassegno (proprietario, livello, stato): una pillola in text-caption, il colore la dà chi la usa. */
const TAG = 'rounded-full px-2 py-0.5'
/** Il campo di testo della memoria (ricerca, modifica): 32 px di altezza o le sue righe, l'anello solo da tastiera. */
const FIELD = 'rounded-control border border-border bg-background text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring'

type Owner = 'bot' | 'user'
type TierFilter = 'all' | 'core' | 'log'
type StatusFilter = 'active' | 'quarantined' | 'deleted'

function fmtBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)} MB`
  return `${Math.round(n / 1000)} kB`
}

export function MemoryPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { i18n, t } = useLingui()
  const memoryProgress = useStore((s) => s.memoryProgress)
  const select = useStore((s) => s.select)
  const [overview, setOverview] = useState<MemoryOverview | null>(null)
  const [owner, setOwner] = useState<Owner>('bot')
  const [tier, setTier] = useState<TierFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [notes, setNotes] = useState<MemoryNoteInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemorySearchHitInfo[] | null>(null)
  const [detail, setDetail] = useState<MemoryNoteDetail | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const reloadOverview = () => {
    void api.memoryOverview(agentId).then(setOverview).catch(() => setOverview(null))
  }
  const reload = () => {
    setLoading(true)
    void api
      .memoryList(agentId, { owner, ...(tier !== 'all' ? { tier } : {}), status, limit: 200 })
      .then((r) => setNotes(r.notes))
      .catch(() => setNotes([]))
      .finally(() => setLoading(false))
    reloadOverview()
  }
  useEffect(reload, [agentId, owner, tier, status])

  // fase chat-limiti (CL7): aperto SU UNA nota (la riga di sistema della
  // quarantena) → filtro «in attesa di conferma» e la nota in evidenza
  const memoryFocusId = useStore((s) => s.memoryFocusId)
  useEffect(() => {
    if (memoryFocusId) setStatus('quarantined')
  }, [memoryFocusId])
  useEffect(() => {
    if (!memoryFocusId || loading || !notes.length) return
    const el =
      document.querySelector(`[data-memory-id="${CSS.escape(memoryFocusId)}"]`) ??
      [...document.querySelectorAll('[data-memory-id]')].find((n) => {
        const id = n.getAttribute('data-memory-id') ?? ''
        return id.endsWith(memoryFocusId) || memoryFocusId.endsWith(id)
      })
    el?.scrollIntoView({ block: 'center' })
  }, [memoryFocusId, loading, notes])

  // quando il download del modello finisce (bene o male), si rilesce lo stato
  useEffect(() => {
    if (memoryProgress?.phase === 'model-pull' && memoryProgress.finished) reloadOverview()
    if (memoryProgress?.phase === 'story-backfill' && memoryProgress.finished) reloadOverview()
  }, [memoryProgress])

  const openDetail = (id: string) => {
    setDetailId(id)
    setDetail(null)
    void api.memoryNote(agentId, id).then(setDetail).catch(() => setDetail(null))
  }

  const after = () => {
    reload()
    if (detailId) openDetail(detailId)
  }

  const purge = (id: string) => {
    setConfirmPurge(null)
    void api.memoryPurge(agentId, id).then((r) => {
      if (r.scrubbed) setNotice(null)
      else setNotice('pending')
      setDetailId(null)
      setDetail(null)
      after()
    }).catch(() => setNotice('error'))
  }

  const save = (id: string) => {
    void api.memorySave(agentId, { id, body: draft, tier: editing === 'core' ? 'core' : 'log' }).then(() => {
      setEditing(null)
      after()
    })
  }

  const search = () => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    void api.memorySearch(agentId, q, { explain: true }).then(setHits).catch(() => setHits([]))
  }

  const modelPull = () => {
    void api.memoryModelPull().catch(() => undefined)
  }

  const goConversation = (noteAgentId: string | null) => {
    if (!noteAgentId) return
    void select(noteAgentId)
    onClose()
  }

  return (
    <div className="mx-6 mt-3 rounded-surface border border-border bg-muted/40 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-body font-medium text-foreground">
          <Brain className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Trans>Memoria di questo bot</Trans>
        </h2>
        <Button
          variant="ghost"
          size="sm"
          icon
          aria-label={i18n._(msg`Chiudi la memoria`)}
          title={i18n._(msg`Chiudi la memoria`)}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <p className="mt-1 text-small text-muted-foreground">
        <Trans>Fatti e regole che il bot ricorda tra i turni, sul motore Engramma. «Condivise» valgono per tutti i bot.</Trans>
      </p>

      {/* motore e modello */}
      {overview && !overview.engine.available && (
        <p className="mt-2 rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive">
          <Trans>Motore della memoria non disponibile: le memorie non si leggono né si scrivono finché non torna.</Trans>
        </p>
      )}
      {overview?.engine.available && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
          <span className={cn(TAG, 'bg-muted')}><Trans>motore {overview.engine.version}</Trans></span>
          {overview.model.present ? (
            <span className={cn(TAG, 'bg-primary/15 text-primary')}>
              <Trans>ricerca ibrida · modello {fmtBytes(overview.model.bytes ?? 0)}</Trans>
            </span>
          ) : memoryProgress?.phase === 'model-pull' && !memoryProgress.finished ? (
            <span className={cn(TAG, 'bg-muted')}>
              <Trans>download del modello… {Math.round((memoryProgress.done / Math.max(1, memoryProgress.total)) * 100)}%</Trans>
            </span>
          ) : (
            <>
              <span className={cn(TAG, 'bg-muted')}><Trans>ricerca testo+grafo</Trans></span>
              <Button variant="secondary" size="sm" onClick={modelPull}>
                <Trans>Migliora la ricerca: scarica il modello (circa 400 MB)</Trans>
              </Button>
            </>
          )}
          {!overview.storyIndexed && memoryProgress?.phase === 'story-backfill' && !memoryProgress.finished && (
            <span className={cn(TAG, 'bg-muted')}>
              <Trans>indicizzazione delle conversazioni: {memoryProgress.done}/{memoryProgress.total}</Trans>
            </span>
          )}
          {/* i due conteggi sono le vie brevi ai filtri sotto: gli stessi bottoni dei filtri */}
          {overview.counts.pending > 0 && (
            <Button variant="ghost" size="sm" shape="pill" onClick={() => setStatus('quarantined')}>
              <Trans>{overview.counts.pending} in attesa di conferma</Trans>
            </Button>
          )}
          {overview.counts.deleted > 0 && (
            <Button variant="ghost" size="sm" shape="pill" onClick={() => setStatus('deleted')}>
              <Trans>{overview.counts.deleted} eliminate</Trans>
            </Button>
          )}
        </div>
      )}
      {memoryProgress?.phase === 'model-pull' && memoryProgress.finished && memoryProgress.error && (
        <p className="mt-1 text-small text-destructive"><Trans>Download non riuscito: {memoryProgress.error}</Trans></p>
      )}

      {/* ricerca */}
      <div className="mt-2 flex gap-2">
        <input
          className={cn(FIELD, 'h-control-sm w-full min-w-0 px-3')}
          placeholder={i18n.t('Cerca nella memoria…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') search() }}
        />
        <Button variant="secondary" size="sm" onClick={search}>
          <Trans>Cerca</Trans>
        </Button>
        {hits !== null && (
          <Button variant="ghost" size="sm" onClick={() => { setHits(null); setQuery('') }}>
            <Trans>Azzera</Trans>
          </Button>
        )}
      </div>

      {hits !== null && (
        <div className="mt-2 flex flex-col gap-1.5">
          {hits.length === 0 && <p className="text-small text-muted-foreground"><Trans>Nessun risultato.</Trans></p>}
          {hits.map((h) => (
            <button
              key={h.id}
              type="button"
              className="block w-full cursor-pointer rounded-surface border border-border bg-muted px-3 py-2 text-left transition hover:border-muted-foreground/40"
              onClick={() => openDetail(h.id)}
            >
              <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                <span className={cn(TAG, 'bg-muted')}>{h.owner === 'user' ? <Trans>condivisa</Trans> : <Trans>agente</Trans>}</span>
                <span className={cn(TAG, h.tier === 'core' && 'bg-destructive/15 text-destructive')}>{h.tier}</span>
                <span><Trans>support {h.support ?? '—'}</Trans></span>
                <span className="flex-1" />
                <span>{fmt(h.updatedAt)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-body text-foreground">{h.body}</p>
              {h.explain && (
                <p className="mt-1 text-caption text-muted-foreground">
                  {h.explain.lists?.join(' + ') ?? ''}
                  {h.explain.matchedTerms?.length ? ` · ${h.explain.matchedTerms.join(', ')}` : ''}
                  {h.explain.cosine !== undefined ? ` · cos ${h.explain.cosine.toFixed(3)}` : ''}
                  {h.explain.graph ? ` · ${t`grafo`} ${h.explain.graph.weight}` : ''}
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* filtri */}
      {hits === null && (
        <>
          {/* i bottoni del sistema: la scelta «secondary», gli altri «ghost». Restano
              <button> col solo testo: le sonde di fase memoria li cercano per
              testo esatto fra i «button» («eliminate») */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Button variant={owner === 'bot' ? 'secondary' : 'ghost'} size="sm" shape="pill" onClick={() => setOwner('bot')}><Trans>del bot</Trans></Button>
            <Button variant={owner === 'user' ? 'secondary' : 'ghost'} size="sm" shape="pill" onClick={() => setOwner('user')}><Trans>condivise</Trans></Button>
            <span className="mx-1 text-border" aria-hidden="true">|</span>
            <Button variant={tier === 'all' ? 'secondary' : 'ghost'} size="sm" shape="pill" onClick={() => setTier('all')}><Trans>tutte</Trans></Button>
            <Button variant={tier === 'core' ? 'secondary' : 'ghost'} size="sm" shape="pill" onClick={() => setTier('core')}><Trans>core</Trans></Button>
            <Button variant={tier === 'log' ? 'secondary' : 'ghost'} size="sm" shape="pill" onClick={() => setTier('log')}><Trans>log</Trans></Button>
            <span className="mx-1 text-border" aria-hidden="true">|</span>
            <Button variant={status === 'active' ? 'secondary' : 'ghost'} size="sm" shape="pill" onClick={() => setStatus('active')}><Trans>attive</Trans></Button>
            <Button variant={status === 'quarantined' ? 'secondary' : 'ghost'} size="sm" shape="pill" onClick={() => setStatus('quarantined')}><Trans>in attesa di conferma</Trans></Button>
            {/* correzioni C4: le lapidi si vedono (e si dimenticano per davvero) */}
            <Button variant={status === 'deleted' ? 'secondary' : 'ghost'} size="sm" shape="pill" onClick={() => setStatus('deleted')}><Trans>eliminate</Trans></Button>
          </div>

          {notice === 'pending' && (
            <p className="mt-2 rounded-control bg-muted px-3 py-2 text-small text-muted-foreground">
              <Trans>Quasi dimenticato: alcuni byte restano nel registro delle scritture e vengono rimossi alla prossima scrittura del motore.</Trans>
            </p>
          )}
          {notice === 'error' && (
            <p className="mt-2 rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive"><Trans>Operazione non riuscita.</Trans></p>
          )}

          {loading && <p className="mt-2 text-small text-muted-foreground">…</p>}
          {!loading && notes.length === 0 && (
            <p className="mt-2 text-small text-muted-foreground">
              {status === 'quarantined'
                ? <Trans>Niente in attesa di conferma: ciò che il bot scrive leggendo il web arriva qui, finché non lo confermi.</Trans>
                : status === 'deleted'
                  ? <Trans>Nessuna memoria eliminata: quelle che elimini restano qui finché non le dimentichi per sempre.</Trans>
                  : <Trans>Nessuna memoria: chiedi al bot di ricordare una preferenza.</Trans>}
            </p>
          )}
          <div className="mt-2 flex flex-col gap-2">
            {notes.map((m) => (
              <div
                key={m.id}
                data-memory-id={m.id}
                className={cn(
                  'rounded-surface border border-border bg-muted px-3 py-2',
                  memoryFocusId && (m.id === memoryFocusId || m.id.endsWith(memoryFocusId) || memoryFocusId.endsWith(m.id)) && 'ring-1 ring-primary/60'
                )}
              >
                <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                  <span className={cn(TAG, m.owner === 'user' ? 'bg-primary/15 text-primary' : 'bg-muted text-foreground')}>
                    {m.owner === 'user' ? <Trans>condivisa</Trans> : <Trans>agente</Trans>}
                  </span>
                  <span className={cn(TAG, m.tier === 'core' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground')}>{m.tier}</span>
                  {m.status === 'quarantined' && <span className={cn(TAG, 'bg-waiting/15 text-waiting')}><Trans>in attesa di conferma</Trans></span>}
                  {m.status === 'deleted' && <span className={cn(TAG, 'bg-destructive/15 text-destructive')}><Trans>eliminata</Trans></span>}
                  <span className="flex-1" />
                  <span title={fmt(m.createdAt)}>{fmt(m.updatedAt)}</span>
                </div>
                {editing === m.id ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <textarea
                      className={cn(FIELD, 'min-h-16 w-full px-3 py-2')}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={Math.min(8, draft.split('\n').length)}
                    />
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" onClick={() => save(m.id)}><Trans>Salva</Trans></Button>
                      <Button variant="secondary" size="sm" onClick={() => setEditing(null)}><Trans>Annulla</Trans></Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1">
                    <p className="whitespace-pre-wrap text-body text-foreground">{m.body}</p>
                    {/* le azioni sono «testo» (ghost), su una riga che va a capo da sola;
                        -ml-3 sulla prima: la sua scritta fila col corpo della nota */}
                    <div className="flex flex-wrap gap-1">
                      {m.status === 'quarantined' ? (
                        <>
                          <Button variant="ghost" size="sm" className="-ml-3 text-foreground" onClick={() => { void api.memoryConfirm(agentId, m.id).then(after) }}><Trans>Conferma</Trans></Button>
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => { void api.memoryDiscard(agentId, m.id).then(after) }}><Trans>Scarta</Trans></Button>
                        </>
                      ) : m.status === 'deleted' ? (
                        /* correzioni C4: la lapide si ripristina o si dimentica per davvero */
                        <>
                          <Button variant="ghost" size="sm" className="-ml-3 text-foreground" onClick={() => { void api.memoryRestore(agentId, m.id).then(after) }}><Trans>Ripristina</Trans></Button>
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmPurge(m.id)}><Trans>Dimentica per sempre</Trans></Button>
                        </>
                      ) : (
                        <>
                          <Button variant="ghost" size="sm" className="-ml-3" onClick={() => { setEditing(m.tier); setDraft(m.body) }}>
                            <Trans>Modifica</Trans>
                          </Button>
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => { void api.memoryDelete(agentId, m.id).then(after) }}>
                            <Trans>Elimina</Trans>
                          </Button>
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmPurge(m.id)}>
                            <Trans>Dimentica per sempre</Trans>
                          </Button>
                        </>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => openDetail(m.id)}>
                        <Trans>Perché lo so?</Trans>
                      </Button>
                    </div>
                    {confirmPurge === m.id && (
                      <div className="mt-2 rounded-control bg-destructive/10 px-3 py-2">
                        <p className="text-small text-destructive">
                          <Trans>Dimenticare per sempre questa memoria? Il testo sparisce del tutto e non si torna indietro (l'eliminazione normale, invece, si può annullare).</Trans>
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Button variant="destructive" size="sm" onClick={() => purge(m.id)}>
                            <Trans>Dimentica per sempre</Trans>
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setConfirmPurge(null)}>
                            <Trans>Annulla</Trans>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* dettaglio: perché lo so? */}
      {detailId && (
        <div className="mt-3 rounded-surface border border-border bg-background px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-body font-medium text-foreground"><Trans>Perché lo so?</Trans></h3>
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label={i18n._(msg`Chiudi il dettaglio`)}
              title={i18n._(msg`Chiudi il dettaglio`)}
              onClick={() => { setDetailId(null); setDetail(null) }}
            >
              <X className="size-4" />
            </Button>
          </div>
          {!detail && <p className="mt-1 text-small text-muted-foreground">…</p>}
          {detail && (
            <div className="mt-2 flex flex-col gap-1.5 text-small text-muted-foreground">
              {detail.note ? (
                <>
                  <p className="whitespace-pre-wrap text-body text-foreground">{detail.note.body}</p>
                  <p>
                    <Trans>fonte: {detail.note.source}</Trans>
                    {detail.note.agentId && detail.note.entryId !== null && (
                      <button className="ml-2 rounded-control text-primary underline underline-offset-2 transition hover:text-foreground" onClick={() => goConversation(detail.note!.agentId)}>
                        <Trans>apri la conversazione</Trans>
                      </button>
                    )}
                  </p>
                  <p>
                    <Trans>affidabilità:</Trans>{' '}
                    {detail.note.confidence === 'stated' ? <Trans>detto dall'utente</Trans> : detail.note.confidence === 'external' ? <Trans>da contenuti esterni</Trans> : <Trans>dedotto dal bot</Trans>}
                    {' '}({detail.note.confidence})
                  </p>
                  <p>
                    {detail.state === 'active' ? <Trans>attiva</Trans> : detail.state === 'deleted' ? <Trans>eliminata</Trans> : <Trans>in attesa di conferma</Trans>}
                    {' · '}<Trans>versione {detail.note.version}</Trans>
                  </p>
                  <p><Trans>creata {fmt(detail.note.createdAt)} · aggiornata {fmt(detail.note.updatedAt)}</Trans></p>
                  {(detail.note.validFrom || detail.note.validTo) && (
                    <p><Trans>validità: {detail.note.validFrom ?? '…'} → {detail.note.validTo ?? '…'}</Trans></p>
                  )}
                </>
              ) : (
                <p className="text-small text-foreground"><Trans>Questa memoria è eliminata: puoi ripristinarla dall'ultima versione qui sotto.</Trans></p>
              )}
              {detail.state === 'deleted' && detail.history.length > 0 && (
                // flex w-fit: da solo in una colonna a blocchi un inline-flex
                // lascerebbe sotto di sé lo spazio della discesa del carattere
                <Button variant="secondary" size="sm" className="flex w-fit" onClick={() => { void api.memoryRestore(agentId, detailId).then(after) }}>
                  <Trans>Ripristina</Trans>
                </Button>
              )}
              {detail.history.length > 0 && (
                <div>
                  <p className="mt-1 text-body font-medium text-foreground"><Trans>Storico delle versioni</Trans></p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {detail.history.slice().reverse().map((v) => (
                      <li key={v.version} className="rounded-control bg-muted px-2 py-1">
                        <span className="text-muted-foreground">v{v.version} · {fmt(v.note.updatedAt)}</span>
                        <p className="line-clamp-2 text-small text-foreground">{v.note.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* correzioni C4: anche dalla lapide — un memoria eliminata si può dimenticare per davvero */}
              <Button variant="ghost" size="sm" className="-ml-3 flex w-fit text-destructive hover:text-destructive" onClick={() => setConfirmPurge(detailId)}>
                <Trans>Dimentica per sempre</Trans>
              </Button>
              {confirmPurge === detailId && (
                <div className="mt-2 rounded-control bg-destructive/10 px-3 py-2">
                  <p className="text-small text-destructive"><Trans>Il testo sparisce del tutto e non si torna indietro. Continuare?</Trans></p>
                  <div className="mt-2 flex gap-2">
                    <Button variant="destructive" size="sm" onClick={() => purge(detailId)}><Trans>Dimentica per sempre</Trans></Button>
                    <Button variant="secondary" size="sm" onClick={() => setConfirmPurge(null)}><Trans>Annulla</Trans></Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
