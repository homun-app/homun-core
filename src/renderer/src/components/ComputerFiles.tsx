// Fase 19b (T3.3): la scheda FILE del pannello «Computer» — la vista
// dell'utente sul box (o sulla cartella di lavoro in host). Percorso a
// briciole, elenco con icona/nome/dimensione/data, anteprima di testi e
// immagini, «Scarica» e «Carica qui» (le finestre del Mac le apre il main),
// trascinamento dal Finder, aggiornamento ogni 5 s e a ogni evento
// computer-activity di quel bot — senza perdere la selezione. Errori chiari,
// mai uno stack.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Download, RefreshCw, Upload, Eye, EyeOff, Folder, FileText, Link2, AlertCircle } from 'lucide-react'
import { api } from '../store'
import { ipcErrorMessage } from '../lib/ipc-error'
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

  // il trascinamento dal Finder: il path arriva dal drop (preload) e il
  // «Sostituire?» si chiede qui, con la seconda chiamata overwrite
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer?.files ?? [])
    const paths = dropped.map((f) => api.pathForFile(f)).filter((p): p is string => !!p)
    if (!paths.length) return
    setBusy(true)
    setToast('')
    try {
      for (const macPath of paths) {
        const name = macPath.split('/').pop() ?? ''
        let r = await api.filesImportDropped(agentId, path, macPath)
        if (!r.ok && r.reason === 'exists') {
          if (window.confirm(t`Sostituire «${name}»?`)) {
            r = await api.filesImportDropped(agentId, path, macPath, true)
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
    kind === 'dir' ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : kind === 'link' ? <Link2 className="size-3.5 shrink-0 text-muted-foreground" /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" />

  const previewPane = (
    <div className={`flex min-h-0 flex-col ${narrow ? 'h-56 border-t border-border' : 'w-1/2 border-l border-border'}`}>
      <p className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-medium">
        {preview?.name ?? selected ?? <Trans>Anteprima</Trans>}
      </p>
      <div className="min-h-0 flex-1 overflow-auto scroll-thin">
        {previewError && <p className="px-3 py-2 text-xs text-destructive/90">{previewError}</p>}
        {!previewError && preview === null && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            <Trans>Seleziona un file per vederne il contenuto.</Trans>
          </p>
        )}
        {preview?.result.kind === 'text' && (
          <pre className="px-2 py-1 font-mono text-[11px] leading-relaxed">
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
          <p className="px-3 py-2 text-xs text-muted-foreground">
            <Trans>File binario ({formatSize(preview.result.size)})</Trans>
          </p>
        )}
        {preview?.result.kind === 'too-large' && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            <Trans>Troppo grande per l'anteprima ({formatSize(preview.result.size)})</Trans>
          </p>
        )}
      </div>
    </div>
  )

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {/* percorso a briciole */}
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs">
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
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className={`rounded-md p-1.5 transition ${showHidden ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            title={showHidden ? t`Nascondi i file nascosti` : t`Mostra i file nascosti`}
            onClick={() => setShowHidden(!showHidden)}
          >
            {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title={t`Aggiorna`}
            onClick={() => void load(path)}
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
            title={t`Scarica sul Mac`}
            disabled={!selected || busy}
            onClick={() => void download()}
          >
            <Download className="size-3.5" />
          </button>
          <button
            className="flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-40"
            disabled={busy}
            onClick={() => void upload()}
          >
            <Upload className="size-3" />
            <Trans>Carica qui</Trans>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-destructive/90">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button className="shrink-0 underline" onClick={() => void load(path)}>
            <Trans>Riprova</Trans>
          </button>
        </div>
      )}
      {toast && <p className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">{toast}</p>}
      {truncated && (
        <p className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
          <Trans>Elencazione troncata a {entries.length} voci.</Trans>
        </p>
      )}

      <div ref={holder} className={`flex min-h-0 flex-1 ${narrow ? 'flex-col' : 'flex-row'}`}>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-thin">
          {visible.length === 0 && !error && (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              <Trans>Cartella vuota.</Trans>
            </p>
          )}
          {visible.map((e) => (
            <button
              key={e.name}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-muted ${selected === e.name ? 'bg-muted' : ''}`}
              onClick={() => (e.kind === 'dir' ? openDir(e.name) : void openFile(e))}
            >
              {entryIcon(e.kind)}
              <span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
              <span className="shrink-0 text-muted-foreground">{e.kind === 'dir' ? '—' : formatSize(e.size)}</span>
              <span className="w-32 shrink-0 truncate text-right text-muted-foreground">
                {e.mtime ? new Date(e.mtime).toLocaleString(i18n.locale) : ''}
              </span>
            </button>
          ))}
        </div>
        {(selected !== null || preview !== null || previewError !== '') && previewPane}
      </div>
    </div>
  )
}
