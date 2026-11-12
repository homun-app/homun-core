// Fase box-container (BX3): la sezione «Spazio su disco» delle Impostazioni ›
// Generali. Ogni riga dice QUANTO occupa una cosa e dà l'azione per toglierla:
// l'immagine del computer dei bot (si ricostruisce), i file dei bot
// (IRREVERSIBILE: la conferma dice la dimensione e la frase esatta), lo
// spazio recuperabile (cache di build e immagini vecchie: «Libera spazio»
// SENZA conferma, non toglie nulla di insostituibile), il modello locale (si
// riscarica) e il modello della memoria (la memoria torna alla ricerca per
// testo). Le azioni distruttive chiedono SEMPRE la conferma; i testi stanno
// nei cataloghi it/en.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { api } from '../../store'
import type { DiskSpaceInfo } from '../../../../shared/types'

/** I byte in parole: GB quando ci stanno, MB sotto. */
export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  return `${Math.round(bytes / 1_000)} kB`
}

type RowId = DiskSpaceInfo['rows'][number]['id']

/** L'etichetta della riga (id → testo del catalogo). */
function rowLabel(id: RowId): MessageDescriptor {
  switch (id) {
    case 'box-image': return msg`Computer dei bot: immagine`
    case 'box-files': return msg`Computer dei bot: file dei bot`
    case 'reclaimable': return msg`Spazio recuperabile`
    case 'model': return msg`Modello locale`
    case 'memory-model': return msg`Modello della memoria`
  }
}

/** L'azione della riga: etichetta del bottone e frase della conferma (o null). */
function rowAction(id: RowId, size: string): { label: MessageDescriptor; confirm: MessageDescriptor | null } {
  switch (id) {
    case 'box-image':
      return { label: msg`Rimuovi`, confirm: msg`Ferma il computer dei bot ed elimina la sua immagine (${size}). L'immagine si ricostruisce quando serve.` }
    case 'box-files':
      return {
        label: msg`Elimina i file dei bot`,
        confirm: msg`Eliminare ${size}? Verranno cancellati per sempre i file che i bot hanno creato nel loro computer. Questa azione non si può annullare.`
      }
    case 'reclaimable':
      // non toglie nulla di insostituibile: nessuna conferma
      return { label: msg`Libera spazio`, confirm: null }
    case 'model':
      return { label: msg`Rimuovi`, confirm: msg`Rimuovere il modello locale (${size})? Potrai riscaricarlo quando vuoi.` }
    case 'memory-model':
      return { label: msg`Rimuovi`, confirm: msg`Rimuovere il modello della memoria (${size})? La memoria torna alla ricerca per testo.` }
  }
}

export function DiskSpaceSection() {
  const { i18n } = useLingui()
  const [info, setInfo] = useState<DiskSpaceInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  const load = (): void => {
    void api.boxDiskSpace().then(setInfo).catch(() => undefined)
  }
  useEffect(load, [])

  const runAction = (id: RowId, destructive: boolean, size: string): void => {
    const action = rowAction(id, size)
    if (destructive && action.confirm && !window.confirm(i18n._(action.confirm))) return
    setBusy(id)
    setLastError(null)
    const done = (r: { ok: boolean; error?: string }): void => {
      if (!r.ok) setLastError(r.error ?? 'error')
      setBusy(null)
      load()
    }
    const gone = (): void => {
      setBusy(null)
      load()
    }
    if (id === 'box-image') void api.boxImageRemove().then(done).catch(gone)
    else if (id === 'box-files') void api.boxBoxFilesRemove().then(done).catch(gone)
    else if (id === 'reclaimable') void api.boxSpacePrune().then(done).catch(gone)
    else if (id === 'model') void api.localModelRemove().then(gone).catch(gone)
    else if (id === 'memory-model') void api.memoryModelRemove().then(gone).catch(gone)
  }

  const free = info?.freeBytes ?? null
  return (
    <section className="mt-6" data-testid="disk-space-section">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {i18n._(msg`Spazio su disco`)}
      </h3>
      <div className="rounded-2xl border bg-card p-1">
        {(info?.rows ?? []).map((row) => {
          const size = fmtBytes(row.bytes)
          const action = rowAction(row.id, size)
          return (
            <div
              key={row.id}
              className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-b-0"
              data-testid={`disk-space-${row.id}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{i18n._(rowLabel(row.id))}</p>
                <p className="text-xs text-muted-foreground">{size}</p>
              </div>
              <button
                className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs text-background outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
                disabled={busy !== null || row.bytes === null}
                onClick={() => runAction(row.id, row.destructive, size)}
              >
                {i18n._(action.label)}
              </button>
            </div>
          )
        })}
        {free !== null && (
          <p className="px-3 pb-2 pt-1 text-xs text-muted-foreground">
            <Trans>Spazio libero sul Mac: {fmtBytes(free)} — prima di costruire o scaricare ne restano sempre 5 GB.</Trans>
          </p>
        )}
        {lastError && (
          <p className="px-3 pb-2 pt-1 text-xs text-destructive" data-testid="disk-space-error">
            {lastError.slice(0, 200)}
          </p>
        )}
      </div>
    </section>
  )
}
