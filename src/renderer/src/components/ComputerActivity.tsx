// Fase 19b (T4.3): la scheda ATTIVITÀ del pannello «Computer» — il feed di
// ciò che il bot ha fatto sul suo computer, dal vivo e nello storico: ogni
// comando (dalla tabella shell_jobs) con lo stato e la coda dell'output, e
// ogni azione sui file. L'elenco si ricarica a ogni evento
// computer-activity di quel bot; la coda di un comando IN CORSO si rilesce
// ogni 1,5 s finché la voce è espansa e la scheda visibile.
//
// Fase design (DS4): lo schema del pannello (RightPanel), ripetuto nella
// scheda. Il FEED che scorre è largo quanto il pannello — la barra sta sul
// bordo — col margine DENTRO (PageColumn), come il corpo del pannello; la riga
// d'errore sta ferma sopra, alla larghezza del contenuto (px-1.5 + PageColumn).
// Ogni voce è FlatRow dentro un <button> (il clic che la apre è del bottone);
// lo stato è un'icona lucide (più il testo quando lo dice a parole: «exit 1»,
// «ucciso») e sta PRIMA dell'ora, così l'ora fila dritta sul bordo destro.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Terminal as TerminalIcon, FileEdit, ArrowDownToLine, ArrowUpFromLine, Upload, Download, Loader2, XCircle, Check } from 'lucide-react'
import { api } from '../store'
import { ipcErrorMessage } from '../lib/ipc-error'
import { Button } from './ui/button'
import { Notice } from './ui/notice'
import { PageColumn } from './ui/page-shell'
import { FlatList, FlatRow } from './ui/flat-list'
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
        return <FileEdit className="size-4 shrink-0 text-muted-foreground" />
      case 'copy_in':
        return <ArrowDownToLine className="size-4 shrink-0 text-muted-foreground" />
      case 'copy_out':
        return <ArrowUpFromLine className="size-4 shrink-0 text-muted-foreground" />
      case 'upload':
        return <Upload className="size-4 shrink-0 text-muted-foreground" />
      case 'download':
        return <Download className="size-4 shrink-0 text-muted-foreground" />
      default:
        return <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
    }
  }

  const statusBadge = (item: ActivityItem) => {
    if (item.status === 'running') {
      return <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
    }
    if (item.source === 'shell') {
      if (item.status === 'done') {
        return item.exitCode === 0 ? (
          // riuscito: il segno di spunta nel verde dello stato attivo (il pallino della card «Computer»)
          <Check className="size-4 shrink-0 text-chart-2" aria-hidden="true" />
        ) : (
          <span className="shrink-0 font-mono text-caption text-destructive">{t`exit ${item.exitCode ?? '?'}`}</span>
        )
      }
      if (item.status === 'killed') return <span className="shrink-0 text-caption text-muted-foreground">{t`ucciso`}</span>
      if (item.status === 'lost') return <span className="shrink-0 text-caption text-muted-foreground">{t`perso`}</span>
      if (item.status === 'expired') return <span className="shrink-0 text-caption text-muted-foreground">{t`scaduto`}</span>
      return null
    }
    if (item.status === 'error') return <XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
    return <Check className="size-4 shrink-0 text-chart-2" aria-hidden="true" />
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="shrink-0 border-b border-border/50 px-1.5">
          <PageColumn>
            <Notice
              tone="destructive"
              icon={<XCircle className="size-4" aria-hidden="true" />}
              action={<Button variant="ghost" size="sm" onClick={() => void load()}><Trans>Riprova</Trans></Button>}
            >
              {error}
            </Notice>
          </PageColumn>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin [scrollbar-gutter:stable_both-edges]">
        <PageColumn>
          {items.length === 0 && !error && (
            <p className="py-8 text-center text-small text-muted-foreground">
              <Trans>Il bot non ha ancora usato il suo computer.</Trans>
            </p>
          )}
          <FlatList>
            {items.map((item) => (
              <div key={item.id}>
                <button
                  type="button"
                  className="block w-full cursor-pointer text-left transition hover:bg-muted/50"
                  onClick={() => void toggle(item)}
                >
                  <FlatRow
                    leading={kindIcon(item)}
                    title={item.source === 'shell' ? (
                      <span className="font-mono">{item.text || '(comando)'}</span>
                    ) : (
                      <>
                        <span className="text-muted-foreground">{kindLabel(item)} · </span>
                        <span className="font-mono">{item.text}</span>
                        {item.bytes !== null && item.bytes > 0 && <span className="text-muted-foreground"> · {formatSize(item.bytes)}</span>}
                      </>
                    )}
                    trailing={(
                      <>
                        {item.agentId !== agentId && item.agentName && (
                          <span className="shrink-0 rounded-control bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">{item.agentName}</span>
                        )}
                        {statusBadge(item)}
                        <span className="w-14 shrink-0 text-right text-caption text-muted-foreground">
                          {new Date(item.startedAt).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </>
                    )}
                  />
                </button>
                {expanded === item.id && (
                  <div className="max-h-56 overflow-y-auto scroll-thin bg-muted/40 px-3 py-2">
                    {output[item.id] ? (
                      <pre className="whitespace-pre-wrap font-mono text-caption">{output[item.id]}</pre>
                    ) : item.source === 'shell' ? (
                      <p className="text-small text-muted-foreground">…</p>
                    ) : item.status === 'error' ? (
                      <p className="text-small text-muted-foreground">…</p>
                    ) : (
                      <p className="text-chart-2"><Check className="size-4 align-middle" aria-hidden="true" /></p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </FlatList>
        </PageColumn>
      </div>
    </div>
  )
}
