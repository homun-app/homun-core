// Fase 19b (T3.3): la scheda FILE del pannello «Computer» — la vista
// dell'utente sul box (o sulla cartella di lavoro in host). Percorso a
// briciole, elenco con icona/nome/dimensione/data, anteprima di testi e
// immagini, «Scarica» e «Carica qui» (le finestre del Mac le apre il main),
// trascinamento dal Finder, aggiornamento ogni 5 s e a ogni evento
// computer-activity di quel bot — senza perdere la selezione. Errori chiari,
// mai uno stack.
//
// Fase design (DS4): lo schema del pannello (RightPanel), ripetuto nella
// scheda. La barra (percorso + azioni) e le righe di messaggio stanno FERME,
// alla larghezza del contenuto (px-1.5 + PageColumn: 6 + 24 px per lato);
// l'ELENCO che scorre è largo quanto il pannello — la barra sta sul bordo —
// col margine DENTRO (PageColumn), come il corpo del pannello. Le righe sono
// FlatRow dentro un <button> (il clic, la tastiera e lo stato «scelto» sono
// del bottone). L'anteprima, quando sta sotto l'elenco, prende i due quinti
// dell'altezza e non più 224 px fissi: la scheda non ha più l'altezza minima
// di 420 px (vedi ComputerPanel) e in una finestra bassa 224 px fissi non
// lascerebbero all'elenco nemmeno una riga.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Download, RefreshCw, Upload, Eye, EyeOff, Folder, FileText, Link2, AlertCircle } from 'lucide-react'
import { api } from '../store'
import { ipcErrorMessage } from '../lib/ipc-error'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Notice } from './ui/notice'
import { PageColumn } from './ui/page-shell'
import { FlatList, FlatRow } from './ui/flat-list'
import type { FileEntry, FilesListResult, FilesReadResult } from '../../../shared/types'

/** L'aggiornamento automatico della cartella aperta (come Rakazo). */
const AUTO_REFRESH_MS = 5_000

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Il tetto di righe dell'anteprima testo (il DOM non regge 2 MB di <pre>). */
const PREVIEW_MAX_LINES = 5_000

export function ComputerFiles({ agentId, active }: { agentId: string; active: boolean }) {
  const { t, i18n } = useLingui()
  const [path, setPath] = useState('')
  const [home, setHome] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ name: string; result: FilesReadResult } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [narrow, setNarrow] = useState(false)
  const holder = useRef<HTMLDivElement | null>(null)
  // l'owner del bot del pannello (per gli eventi computer-activity)
  const owner = useRef<string | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const load = useCallback(
    async (target: string) => {
      try {
        const r: FilesListResult = await api.filesList(agentId, target)
        setError('')
        setEntries(r.entries)
        setTruncated(r.truncated)
        if (r.home !== undefined && home === null) {
          setHome(r.home)
          owner.current = r.home.startsWith('home/') ? r.home.slice(5) : null
        }
        // la selezione sopravvive all'aggiornamento (se il file c'è ancora)
        const keep = selectedRef.current
        if (keep && !r.entries.some((e) => e.name === keep)) {
          setSelected(null)
          setPreview(null)
        }
        return r
      } catch (e) {
        setError(ipcErrorMessage(e))
        return null
      }
    },
    [agentId, home]
  )

  // alla prima apertura: la radice, che risponde anche la HOME del bot
  useEffect(() => {
    void (async () => {
      const root = await load('')
      if (root?.home) {
        setPath(root.home)
        await load(root.home)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  // aggiornamento automatico: ogni 5 s e a ogni evento del bot, SOLO mentre
  // la scheda è visibile; la selezione non si perde (come Rakazo)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => void load(pathRef.current), AUTO_REFRESH_MS)
    const off = api.onEvent((e) => {
      if (e.type === 'computer-activity' && owner.current !== null && e.ownerId === owner.current) {
        void load(pathRef.current)
      }
    })
    return () => {
      clearInterval(timer)
      off()
    }
  }, [active, load])

  // pannello stretto: l'anteprima va SOTTO l'elenco
  useEffect(() => {
    const el = holder.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.offsetWidth < 620))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const crumbs = useMemo(() => (path === '' ? [] : path.split('/')), [path])

  const openDir = (dir: string) => {
    const next = path === '' ? dir : `${path}/${dir}`
    setPath(next)
    setSelected(null)
    setPreview(null)
    void load(next)
  }

  const openFile = async (entry: FileEntry) => {
    setSelected(entry.name)
    setPreview(null)
    setPreviewError('')
    const p = path === '' ? entry.name : `${path}/${entry.name}`
    try {
      const result = await api.filesRead(agentId, p)
      setPreview({ name: entry.name, result })
    } catch (e) {
      setPreviewError(ipcErrorMessage(e))
    }
  }

  const download = async () => {
    if (!selected) return
    setBusy(true)
    setToast('')
    try {
      const p = path === '' ? selected : `${path}/${selected}`
      const r = await api.filesDownload(agentId, p)
      if (r?.ok) setToast(t`Scaricato: ${r.name ?? selected}`)
    } catch (e) {
      setToast(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const upload = async () => {
    setBusy(true)
    setToast('')
    try {
      const results = await api.filesUpload(agentId, path)
      const ok = results.filter((r) => r.ok).length
      const skipped = results.filter((r) => r.skipped).length
      if (ok) setToast(skipped > 0 ? t`Caricati ${ok} file, ${skipped} saltati.` : t`Caricati ${ok} file.`)
      else if (results.length) setToast(t`Nessun file caricato.`)
      await load(pathRef.current)
    } catch (e) {
      setToast(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // il trascinamento dal Finder (correzioni U1): si passano al preload i
  // File dell'evento drop — è IL PRELOAD a ricavarne il path col webUtils,
  // la UI non lo vede né lo conosce mai (per i messaggi usa file.name); il
  // «Sostituire?» si chiede qui, con la seconda chiamata overwrite
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer?.files ?? [])
    if (!dropped.length) return
    setBusy(true)
    setToast('')
    try {
      for (const file of dropped) {
        // per i messaggi si usa il NOME, mai il path del Mac (che la UI non
        // conosce); la variabile locale tiene il placeholder {name} stabile
        const name = file.name
        let r = await api.filesImportDropped(agentId, path, file)
        if (!r.ok && r.reason === 'exists') {
          if (window.confirm(t`Sostituire «${name}»?`)) {
            r = await api.filesImportDropped(agentId, path, file, true)
          } else {
            continue
          }
        }
        if (r.ok) setToast(t`Caricato: ${r.name}`)
      }
      await load(pathRef.current)
    } catch (err) {
      setToast(ipcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const visible = entries.filter((e) => showHidden || !e.name.startsWith('.'))

  const entryIcon = (kind: FileEntry['kind']) =>
    kind === 'dir' ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : kind === 'link' ? <Link2 className="size-4 shrink-0 text-muted-foreground" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />

  const previewPane = (
    <div className={cn('flex min-h-0 flex-col', narrow ? 'h-2/5 border-t border-border/50' : 'w-1/2 border-l border-border/50')}>
      <div className="shrink-0 border-b border-border/50 px-1.5">
        <PageColumn className="flex min-h-10 items-center truncate text-body font-medium">
          {preview?.name ?? selected ?? <Trans>Anteprima</Trans>}
        </PageColumn>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scroll-thin [scrollbar-gutter:stable_both-edges]">
        <PageColumn className="py-2">
          {previewError && <Notice tone="destructive">{previewError}</Notice>}
          {!previewError && preview === null && (
            <Notice>
              <Trans>Seleziona un file per vederne il contenuto.</Trans>
            </Notice>
          )}
          {preview?.result.kind === 'text' && (
            <pre className="py-1 font-mono text-caption">
              {preview.result.content
                .split('\n')
                .slice(0, PREVIEW_MAX_LINES)
                .map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap">
                    <span className="mr-2 inline-block w-8 select-none text-right text-muted-foreground/60">{i + 1}</span>
                    {line || ' '}
                  </div>
                ))}
              {preview.result.content.split('\n').length > PREVIEW_MAX_LINES && (
                <div className="text-muted-foreground">…</div>
              )}
            </pre>
          )}
          {preview?.result.kind === 'image' && (
            <div className="flex items-center justify-center p-3">
              <img src={`data:${preview.result.mime};base64,${preview.result.base64}`} alt={preview.name} className="max-h-full max-w-full object-contain" />
            </div>
          )}
          {preview?.result.kind === 'binary' && (
            <Notice>
              <Trans>File binario ({formatSize(preview.result.size)})</Trans>
            </Notice>
          )}
          {preview?.result.kind === 'too-large' && (
            <Notice>
              <Trans>Troppo grande per l'anteprima ({formatSize(preview.result.size)})</Trans>
            </Notice>
          )}
        </PageColumn>
      </div>
    </div>
  )

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDrop(e)}
    >
      {/* la barra (percorso + azioni): ferma, alta 40, alla larghezza del
          contenuto del pannello — la stessa ascissa delle righe che scorrono sotto */}
      <div className="shrink-0 border-b border-border/50 px-1.5">
        <PageColumn className="flex items-center gap-2 py-1">
          {/* percorso a briciole */}
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-body">
            <button className="text-muted-foreground transition hover:text-foreground" onClick={() => { setPath(''); setSelected(null); setPreview(null); void load('') }}>
              /
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-muted-foreground/60">›</span>
                <button
                  className="max-w-40 truncate text-muted-foreground transition hover:text-foreground"
                  onClick={() => {
                    const next = crumbs.slice(0, i + 1).join('/')
                    setPath(next)
                    setSelected(null)
                    setPreview(null)
                    void load(next)
                  }}
                >
                  {c}
                </button>
              </span>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-1">
            {/* l'interruttore dei nascosti: «premuto» = secondary, come le voci scelte */}
            <Button
              variant={showHidden ? 'secondary' : 'ghost'}
              size="sm"
              icon
              title={showHidden ? t`Nascondi i file nascosti` : t`Mostra i file nascosti`}
              onClick={() => setShowHidden(!showHidden)}
            >
              {showHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
            <Button variant="ghost" size="sm" icon title={t`Aggiorna`} onClick={() => void load(path)}>
              <RefreshCw className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" icon title={t`Scarica sul Mac`} disabled={!selected || busy} onClick={() => void download()}>
              <Download className="size-4" />
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void upload()}>
              <Upload className="size-4" />
              <Trans>Carica qui</Trans>
            </Button>
          </div>
        </PageColumn>
      </div>

      {/* le righe di messaggio: ferme, sotto la barra */}
      {error && (
        <div className="shrink-0 border-b border-border/50 px-1.5">
          <PageColumn>
            <Notice
              tone="destructive"
              icon={<AlertCircle className="size-4" aria-hidden="true" />}
              action={<Button variant="ghost" size="sm" onClick={() => void load(path)}><Trans>Riprova</Trans></Button>}
            >
              {error}
            </Notice>
          </PageColumn>
        </div>
      )}
      {toast && (
        <div className="shrink-0 border-b border-border/50 px-1.5 py-1">
          <PageColumn>
            <Notice>{toast}</Notice>
          </PageColumn>
        </div>
      )}
      {truncated && (
        <div className="shrink-0 border-b border-border/50 px-1.5 py-1">
          <PageColumn>
            <Notice>
              <Trans>Elencazione troncata a {entries.length} voci.</Trans>
            </Notice>
          </PageColumn>
        </div>
      )}

      <div ref={holder} className={cn('flex min-h-0 flex-1', narrow ? 'flex-col' : 'flex-row')}>
        {/* l'elenco che scorre: largo quanto il pannello, la barra sul bordo,
            il margine DENTRO (PageColumn) — lo schema del corpo del pannello */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-thin [scrollbar-gutter:stable_both-edges]">
          <PageColumn>
            {visible.length === 0 && !error && (
              <p className="py-6 text-center text-small text-muted-foreground">
                <Trans>Cartella vuota.</Trans>
              </p>
            )}
            <FlatList>
              {visible.map((e) => (
                // il file scelto ha il fondo pieno (non quello del passaggio)
                <button
                  key={e.name}
                  type="button"
                  className={cn('block w-full cursor-pointer text-left transition', selected === e.name ? 'bg-muted' : 'hover:bg-muted/50')}
                  onClick={() => (e.kind === 'dir' ? openDir(e.name) : void openFile(e))}
                >
                  <FlatRow
                    leading={entryIcon(e.kind)}
                    title={<span className="font-mono">{e.name}</span>}
                    trailing={(
                      <>
                        <span className="shrink-0 text-caption text-muted-foreground">{e.kind === 'dir' ? '—' : formatSize(e.size)}</span>
                        <span className="w-32 shrink-0 truncate text-right text-caption text-muted-foreground">
                          {e.mtime ? new Date(e.mtime).toLocaleString(i18n.locale) : ''}
                        </span>
                      </>
                    )}
                  />
                </button>
              ))}
            </FlatList>
          </PageColumn>
        </div>
        {(selected !== null || preview !== null || previewError !== '') && previewPane}
      </div>
    </div>
  )
}
