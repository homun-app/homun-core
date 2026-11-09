// Sezione "Memoria" della vista dell'agente — fase memoria-engramma (M6):
// un'interfaccia sul motore Engramma (RPC memory:* del demone).
//   elenco    per bot e condiviso; filtri core/log e stato (attive, in attesa
//             di conferma);
//   ricerca   lo stesso motore del bot;
//   dettaglio «Perché lo so?»: fonte (link alla conversazione), affidabilità,
//             date di validità, storico delle versioni e, per un richiamo,
//             la spiegazione (explain);
//   in attesa di conferma: Conferma o Scarta;
//   Elimina  lapide, si ripristina dallo storico; Dimentica per sempre: purge
//             (conferma che spiega che non si torna indietro);
//   modello  stato e download SOLO dal click (circa 400 MB), con avanzamento.
import { useEffect, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { formatDate } from '../lib/i18n'

/** Le date del motore sono RFC 3339: formatDate vuole un istante. */
const fmt = (iso: string): string => formatDate(new Date(iso), { year: 'numeric', month: 'numeric', day: 'numeric' })
import { api, useStore } from '../store'
import type { MemoryNoteInfo, MemoryNoteDetail, MemorySearchHitInfo, MemoryOverview } from '../../../shared/types'

type Owner = 'bot' | 'user'
type TierFilter = 'all' | 'core' | 'log'
type StatusFilter = 'active' | 'quarantined'

function fmtBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)} MB`
  return `${Math.round(n / 1000)} kB`
}

export function MemoryPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { i18n } = useLingui()
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

  const pill = (active: boolean) =>
    `rounded px-1.5 py-0.5 text-[11px] transition ${active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground hover:text-foreground'}`

  return (
    <div className="mx-6 mt-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground"><Trans>🗂 Memoria di questo bot</Trans></h2>
        <button className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>✕</button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>Fatti e regole che il bot ricorda tra i turni, sul motore Engramma. «Condivise» valgono per tutti i bot.</Trans>
      </p>

      {/* motore e modello */}
      {overview && !overview.engine.available && (
        <p className="mt-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <Trans>Motore della memoria non disponibile: le memorie non si leggono né si scrivono finché non torna.</Trans>
        </p>
      )}
      {overview?.engine.available && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5"><Trans>motore {overview.engine.version}</Trans></span>
          {overview.model.present ? (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">
              <Trans>ricerca ibrida · modello {fmtBytes(overview.model.bytes ?? 0)}</Trans>
            </span>
          ) : memoryProgress?.phase === 'model-pull' && !memoryProgress.finished ? (
            <span className="rounded bg-muted px-1.5 py-0.5">
              <Trans>download del modello… {Math.round((memoryProgress.done / Math.max(1, memoryProgress.total)) * 100)}%</Trans>
            </span>
          ) : (
            <>
              <span className="rounded bg-muted px-1.5 py-0.5"><Trans>ricerca testo+grafo</Trans></span>
              <button className="rounded-md bg-accent px-2 py-0.5 text-foreground hover:bg-muted-foreground/30" onClick={modelPull}>
                <Trans>Migliora la ricerca: scarica il modello (circa 400 MB)</Trans>
              </button>
            </>
          )}
          {!overview.storyIndexed && memoryProgress?.phase === 'story-backfill' && !memoryProgress.finished && (
            <span className="rounded bg-muted px-1.5 py-0.5">
              <Trans>indicizzazione delle conversazioni: {memoryProgress.done}/{memoryProgress.total}</Trans>
            </span>
          )}
          {overview.counts.pending > 0 && (
            <button className="rounded bg-muted px-1.5 py-0.5 hover:text-foreground" onClick={() => setStatus('quarantined')}>
              <Trans>{overview.counts.pending} in attesa di conferma</Trans>
            </button>
          )}
        </div>
      )}
      {memoryProgress?.phase === 'model-pull' && memoryProgress.finished && memoryProgress.error && (
        <p className="mt-1 text-xs text-destructive"><Trans>Download non riuscito: {memoryProgress.error}</Trans></p>
      )}

      {/* ricerca */}
      <div className="mt-2 flex gap-2">
        <input
          className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground outline-none"
          placeholder={i18n.t('Cerca nella memoria…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') search() }}
        />
        <button className="rounded-lg bg-accent px-2.5 py-1 text-xs text-foreground hover:bg-muted-foreground/30" onClick={search}>
          <Trans>Cerca</Trans>
        </button>
        {hits !== null && (
          <button className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setHits(null); setQuery('') }}>
            <Trans>Azzera</Trans>
          </button>
        )}
      </div>

      {hits !== null && (
        <div className="mt-2 space-y-1.5">
          {hits.length === 0 && <p className="text-xs text-muted-foreground"><Trans>Nessun risultato.</Trans></p>}
          {hits.map((h) => (
            <button key={h.id} className="block w-full rounded-lg border border-border bg-muted px-3 py-2 text-left" onClick={() => openDetail(h.id)}>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5">{h.owner === 'user' ? <Trans>condivisa</Trans> : <Trans>agente</Trans>}</span>
                <span className={h.tier === 'core' ? 'rounded bg-destructive/15 px-1.5 py-0.5 text-destructive' : 'rounded bg-muted px-1.5 py-0.5'}>{h.tier}</span>
                <span><Trans>support {h.support ?? '—'}</Trans></span>
                <span className="flex-1" />
                <span>{fmt(h.updatedAt)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-foreground">{h.body}</p>
              {h.explain && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {h.explain.lists?.join(' + ') ?? ''}
                  {h.explain.matchedTerms?.length ? ` · ${h.explain.matchedTerms.join(', ')}` : ''}
                  {h.explain.cosine !== undefined ? ` · cos ${h.explain.cosine.toFixed(3)}` : ''}
                  {h.explain.graph ? ` · ${i18n.t('grafo')} ${h.explain.graph.weight}` : ''}
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* filtri */}
      {hits === null && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
            <button className={pill(owner === 'bot')} onClick={() => setOwner('bot')}><Trans>del bot</Trans></button>
            <button className={pill(owner === 'user')} onClick={() => setOwner('user')}><Trans>condivise</Trans></button>
            <span className="mx-1 text-border">|</span>
            <button className={pill(tier === 'all')} onClick={() => setTier('all')}><Trans>tutte</Trans></button>
            <button className={pill(tier === 'core')} onClick={() => setTier('core')}><Trans>core</Trans></button>
            <button className={pill(tier === 'log')} onClick={() => setTier('log')}><Trans>log</Trans></button>
            <span className="mx-1 text-border">|</span>
            <button className={pill(status === 'active')} onClick={() => setStatus('active')}><Trans>attive</Trans></button>
            <button className={pill(status === 'quarantined')} onClick={() => setStatus('quarantined')}><Trans>in attesa di conferma</Trans></button>
          </div>

          {notice === 'pending' && (
            <p className="mt-2 rounded-lg bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              <Trans>Quasi dimenticato: alcuni byte restano nel registro delle scritture e vengono rimossi alla prossima scrittura del motore.</Trans>
            </p>
          )}
          {notice === 'error' && (
            <p className="mt-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs text-destructive"><Trans>Operazione non riuscita.</Trans></p>
          )}

          {loading && <p className="mt-2 text-xs text-muted-foreground">…</p>}
          {!loading && notes.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {status === 'quarantined'
                ? <Trans>Niente in attesa di conferma: ciò che il bot scrive leggendo il web arriva qui, finché non lo confermi.</Trans>
                : <Trans>Nessuna memoria: chiedi al bot di ricordare una preferenza.</Trans>}
            </p>
          )}
          <div className="mt-2 space-y-2">
            {notes.map((m) => (
              <div key={m.id} className="rounded-lg border border-border bg-muted px-3 py-2">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className={`rounded px-1.5 py-0.5 ${m.owner === 'user' ? 'bg-primary/15 text-primary' : 'bg-muted text-foreground'}`}>
                    {m.owner === 'user' ? <Trans>condivisa</Trans> : <Trans>agente</Trans>}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 ${m.tier === 'core' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'}`}>{m.tier}</span>
                  {m.status === 'quarantined' && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600"><Trans>in attesa di conferma</Trans></span>}
                  <span className="flex-1" />
                  <span title={fmt(m.createdAt)}>{fmt(m.updatedAt)}</span>
                </div>
                {editing === m.id ? (
                  <div className="mt-2 space-y-2">
                    <textarea
                      className="min-h-[60px] w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={Math.min(8, draft.split('\n').length)}
                    />
                    <div className="flex gap-2">
                      <button className="rounded-lg bg-primary px-2.5 py-1 text-xs text-white hover:bg-primary/90" onClick={() => save(m.id)}><Trans>Salva</Trans></button>
                      <button className="rounded-lg bg-accent px-2.5 py-1 text-xs text-foreground hover:bg-muted-foreground/40" onClick={() => setEditing(null)}><Trans>Annulla</Trans></button>
                    </div>
                  </div>
                ) : (
                  <div className="group mt-1">
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{m.body}</p>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] group-hover:flex">
                      {m.status === 'quarantined' ? (
                        <>
                          <button className="text-primary underline-offset-2 hover:underline" onClick={() => { void api.memoryConfirm(agentId, m.id).then(after) }}><Trans>Conferma</Trans></button>
                          <button className="text-destructive/80 underline-offset-2 hover:text-red-300 hover:underline" onClick={() => { void api.memoryDiscard(agentId, m.id).then(after) }}><Trans>Scarta</Trans></button>
                        </>
                      ) : (
                        <>
                          <button className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => { setEditing(m.tier); setDraft(m.body) }}>
                            <Trans>Modifica</Trans>
                          </button>
                          <button className="text-destructive/80 underline-offset-2 hover:text-red-300 hover:underline" onClick={() => { void api.memoryDelete(agentId, m.id).then(after) }}>
                            <Trans>Elimina</Trans>
                          </button>
                          <button className="text-destructive/80 underline-offset-2 hover:text-red-300 hover:underline" onClick={() => setConfirmPurge(m.id)}>
                            <Trans>Dimentica per sempre</Trans>
                          </button>
                        </>
                      )}
                      <button className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => openDetail(m.id)}>
                        <Trans>Perché lo so?</Trans>
                      </button>
                    </div>
                    {confirmPurge === m.id && (
                      <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2">
                        <p className="text-xs text-destructive">
                          <Trans>Dimenticare per sempre questa memoria? Il testo sparisce del tutto e non si torna indietro (l'eliminazione normale, invece, si può annullare).</Trans>
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button className="rounded-lg bg-destructive px-2.5 py-1 text-xs text-white hover:bg-destructive/90" onClick={() => purge(m.id)}>
                            <Trans>Dimentica per sempre</Trans>
                          </button>
                          <button className="rounded-lg bg-accent px-2.5 py-1 text-xs text-foreground hover:bg-muted-foreground/40" onClick={() => setConfirmPurge(null)}>
                            <Trans>Annulla</Trans>
                          </button>
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
        <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-foreground"><Trans>Perché lo so?</Trans></h3>
            <button className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setDetailId(null); setDetail(null) }}>✕</button>
          </div>
          {!detail && <p className="mt-1 text-xs text-muted-foreground">…</p>}
          {detail && (
            <div className="mt-1 space-y-1.5 text-[11px] text-muted-foreground">
              {detail.note ? (
                <>
                  <p className="whitespace-pre-wrap text-xs text-foreground">{detail.note.body}</p>
                  <p>
                    <Trans>fonte: {detail.note.source}</Trans>
                    {detail.note.agentId && detail.note.entryId !== null && (
                      <button className="ml-2 underline underline-offset-2 hover:text-foreground" onClick={() => goConversation(detail.note!.agentId)}>
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
                    {detail.state === 'active' ? <Trans>attiva</Trans> : <Trans>in attesa di conferma</Trans>}
                    {' · '}<Trans>versione {detail.note.version}</Trans>
                  </p>
                  <p><Trans>creata {fmt(detail.note.createdAt)} · aggiornata {fmt(detail.note.updatedAt)}</Trans></p>
                  {(detail.note.validFrom || detail.note.validTo) && (
                    <p><Trans>validità: {detail.note.validFrom ?? '…'} → {detail.note.validTo ?? '…'}</Trans></p>
                  )}
                </>
              ) : (
                <p className="text-xs text-foreground"><Trans>Questa memoria è eliminata: puoi ripristinarla dall'ultima versione qui sotto.</Trans></p>
              )}
              {detail.state === 'deleted' && detail.history.length > 0 && (
                <button className="rounded-lg bg-accent px-2.5 py-1 text-xs text-foreground hover:bg-muted-foreground/40" onClick={() => { void api.memoryRestore(agentId, detailId).then(after) }}>
                  <Trans>Ripristina</Trans>
                </button>
              )}
              {detail.history.length > 0 && (
                <div>
                  <p className="mt-1 font-medium text-foreground"><Trans>Storico delle versioni</Trans></p>
                  <ul className="mt-1 space-y-1">
                    {detail.history.slice().reverse().map((v) => (
                      <li key={v.version} className="rounded bg-muted px-2 py-1">
                        <span className="text-muted-foreground">v{v.version} · {fmt(v.note.updatedAt)}</span>
                        <p className="line-clamp-2 text-xs text-foreground">{v.note.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.state !== 'deleted' && (
                <button className="text-destructive/80 underline-offset-2 hover:text-red-300 hover:underline" onClick={() => setConfirmPurge(detailId)}>
                  <Trans>Dimentica per sempre</Trans>
                </button>
              )}
              {confirmPurge === detailId && (
                <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2">
                  <p className="text-xs text-destructive"><Trans>Il testo sparisce del tutto e non si torna indietro. Continuare?</Trans></p>
                  <div className="mt-2 flex gap-2">
                    <button className="rounded-lg bg-destructive px-2.5 py-1 text-xs text-white hover:bg-destructive/90" onClick={() => purge(detailId)}><Trans>Dimentica per sempre</Trans></button>
                    <button className="rounded-lg bg-accent px-2.5 py-1 text-xs text-foreground hover:bg-muted-foreground/40" onClick={() => setConfirmPurge(null)}><Trans>Annulla</Trans></button>
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
