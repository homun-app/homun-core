// Fase 19b (T4.3): la scheda ATTIVITÀ del pannello «Computer» — il feed di
// ciò che il bot ha fatto sul suo computer, dal vivo e nello storico: ogni
// comando (dalla tabella shell_jobs) con lo stato e la coda dell'output, e
// ogni azione sui file. L'elenco si ricarica a ogni evento
// computer-activity di quel bot; la coda di un comando IN CORSO si rilesce
// ogni 1,5 s finché la voce è espansa e la scheda visibile.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Terminal as TerminalIcon, FileEdit, ArrowDownToLine, ArrowUpFromLine, Upload, Download, Loader2, XCircle } from 'lucide-react'
import { api } from '../store'
import { ipcErrorMessage } from '../lib/ipc-error'
import type { ActivityItem } from '../../../shared/types'

/** La coda di un comando in corso si rilegge ogni 1,5 s (voce espansa + tab visibile). */
const LIVE_REFRESH_MS = 1_500

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ComputerActivity({ agentId, active }: { agentId: string; active: boolean }) {
  const { t, i18n } = useLingui()
  const [items, setItems] = useState<ActivityItem[]>([])
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [output, setOutput] = useState<Record<string, string>>({})
  // l'owner del bot del pannello (per gli eventi computer-activity)
  const ownerRef = useRef<string | null>(null)
  const expandedRef = useRef<string | null>(null)
  expandedRef.current = expanded
  const itemsRef = useRef<ActivityItem[]>([])
  itemsRef.current = items

  const load = useCallback(async () => {
    try {
      const r = await api.activityList(agentId)
      setError('')
      setItems(r.items)
      if (r.owner) ownerRef.current = r.owner
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }, [agentId])

  useEffect(() => {
    void load()
  }, [load])

  // l'elenco si ricarica a ogni evento computer-activity di quel bot
  useEffect(() => {
    const off = api.onEvent((e) => {
      if (e.type === 'computer-activity' && ownerRef.current !== null && e.ownerId === ownerRef.current) void load()
    })
    return off
  }, [load])

  // la coda di un comando IN CORSO, espanso e con la scheda visibile, si
  // rilegge ogni 1,5 s; appena la voce finisce (o si chiude), si ferma
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      const id = expandedRef.current
      if (!id) return
      const item = itemsRef.current.find((x) => x.id === id)
      if (item?.source !== 'shell' || item.status !== 'running') return
      void api
        .activityOutput(agentId, id)
        .then((r) => setOutput((o) => ({ ...o, [id]: r.text })))
        .catch(() => undefined)
      void load() // lo stato può essere cambiato
    }, LIVE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [active, agentId, load])

  const toggle = async (item: ActivityItem) => {
    if (expanded === item.id) {
      setExpanded(null)
      return
    }
    setExpanded(item.id)
    // la coda (o l'errore) si legge SU RICHIESTA, al click
    try {
      const r = await api.activityOutput(agentId, item.id)
      setOutput((o) => ({ ...o, [item.id]: r.text }))
    } catch (e) {
      setOutput((o) => ({ ...o, [item.id]: ipcErrorMessage(e) }))
    }
  }

  const kindLabel = (item: ActivityItem): string => {
    switch (item.kind) {
      case 'write_file':
        return t`Ha scritto file`
      case 'copy_in':
        return t`Copiato dal Mac`
      case 'copy_out':
        return t`Copiato sul Mac`
      case 'upload':
        return t`Hai caricato`
      case 'download':
        return t`Hai scaricato`
      default:
        return ''
    }
  }

  const kindIcon = (item: ActivityItem) => {
    switch (item.kind) {
      case 'write_file':
        return <FileEdit className="size-3.5 shrink-0 text-muted-foreground" />
      case 'copy_in':
        return <ArrowDownToLine className="size-3.5 shrink-0 text-muted-foreground" />
      case 'copy_out':
        return <ArrowUpFromLine className="size-3.5 shrink-0 text-muted-foreground" />
      case 'upload':
        return <Upload className="size-3.5 shrink-0 text-muted-foreground" />
      case 'download':
        return <Download className="size-3.5 shrink-0 text-muted-foreground" />
      default:
        return <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
    }
  }

  const statusBadge = (item: ActivityItem) => {
    if (item.status === 'running') {
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
    }
    if (item.source === 'shell') {
      if (item.status === 'done') {
        return item.exitCode === 0 ? (
          <span className="shrink-0 text-xs text-green-600 dark:text-green-400">✓</span>
        ) : (
          <span className="shrink-0 font-mono text-xs text-destructive">{t`exit ${item.exitCode ?? '?'}`}</span>
        )
      }
      if (item.status === 'killed') return <span className="shrink-0 text-xs text-muted-foreground">{t`ucciso`}</span>
      if (item.status === 'lost') return <span className="shrink-0 text-xs text-muted-foreground">{t`perso`}</span>
      if (item.status === 'expired') return <span className="shrink-0 text-xs text-muted-foreground">{t`scaduto`}</span>
      return null
    }
    if (item.status === 'error') return <XCircle className="size-3.5 shrink-0 text-destructive/80" />
    return <span className="shrink-0 text-xs text-green-600 dark:text-green-400">✓</span>
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-destructive/90">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button className="shrink-0 underline" onClick={() => void load()}>
            <Trans>Riprova</Trans>
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {items.length === 0 && !error && (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            <Trans>Il bot non ha ancora usato il suo computer.</Trans>
          </p>
        )}
        {items.map((item) => (
          <div key={item.id} className="border-b border-border/60 last:border-0">
            <button
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs transition hover:bg-muted/60"
              onClick={() => void toggle(item)}
            >
              {kindIcon(item)}
              {item.source === 'shell' ? (
                <span className="min-w-0 flex-1 truncate font-mono">{item.text || '(comando)'}</span>
              ) : (
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{kindLabel(item)} · </span>
                  <span className="font-mono">{item.text}</span>
                  {item.bytes !== null && item.bytes > 0 && <span className="text-muted-foreground"> · {formatSize(item.bytes)}</span>}
                </span>
              )}
              {item.agentId !== agentId && item.agentName && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.agentName}</span>
              )}
              <span className="w-14 shrink-0 text-right text-[10px] text-muted-foreground">
                {new Date(item.startedAt).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' })}
              </span>
              {statusBadge(item)}
            </button>
            {expanded === item.id && (
              <div className="max-h-56 overflow-y-auto scroll-thin bg-muted/40 px-4 py-2">
                {output[item.id] ? (
                  <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{output[item.id]}</pre>
                ) : item.source === 'shell' ? (
                  <p className="text-xs text-muted-foreground">…</p>
                ) : item.status === 'error' ? (
                  <p className="text-xs text-muted-foreground">…</p>
                ) : (
                  <p className="text-xs text-green-600 dark:text-green-400">✓</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
