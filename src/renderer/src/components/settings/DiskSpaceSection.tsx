// Fase box-container (BX3): la sezione «Spazio su disco» delle Impostazioni ›
// Generali. Ogni riga dice QUANTO occupa una cosa e dà l'azione per toglierla:
// l'immagine del computer dei bot (si ricostruisce), i file dei bot
// (IRREVERSIBILE: la conferma dice la dimensione e la frase esatta), lo
// spazio recuperabile (cache di build e immagini vecchie: «Libera spazio»
// SENZA conferma, non toglie nulla di insostituibile), il modello locale (si
// riscarica) e il modello della memoria (la memoria torna alla ricerca per
// testo). Le azioni distruttive chiedono SEMPRE la conferma; i testi stanno
// nei cataloghi it/en.
//
// Fase design (DS4, Impostazioni): la sezione era fatta a mano — etichetta in
// MAIUSCOLETTO, scheda bordata col respiro di 4, pillole da 12 px — con le
// sue regole. Ora è un gruppo come gli altri di Generali (SettingsGroup:
// etichetta text-caption grigia 500, scheda tenue rounded-surface), le righe
// hanno la misura delle righe di DS1 (alte almeno 52) e l'azione è Button da
// 32. Ciò che le sonde e i test leggono non cambia: il testid della sezione e
// quello di ogni riga, i due <p> (il nome, la misura) e UN bottone per riga.
// `initial` sono i dati di partenza, per i test senza effect (nel prodotto si
// carica dall'api, come prima).
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Loader2 } from 'lucide-react'
import { api } from '../../store'
import type { DiskSpaceInfo } from '../../../../shared/types'
import { Button } from '../ui/button'
import { SettingsGroup } from './SettingsGroup'
import { CARD_ROW_CLS, SettingsNote } from './SettingsRow'

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

/**
 * U4 (fase prima-release): l'esito di «Libera spazio» — i byte liberati
 * DAVVERO (misurati sul disco) oppure niente, quando il guadagno sta sotto
 * la soglia. PURA, con i test.
 */
export const PRUNE_NOTHING_THRESHOLD_BYTES = 50_000_000

/** L'esito della pulizia (pura): vedi pruneOutcome. */
export type PruneOutcome = { kind: 'freed'; bytes: number } | { kind: 'nothing' } | null

/** U4: dai byte liberati misurati all'esito da mostrare (soglia: 50 MB). */
export function pruneOutcome(freedBytes: number | null): PruneOutcome {
  if (freedBytes === null || !Number.isFinite(freedBytes)) return null
  return freedBytes >= PRUNE_NOTHING_THRESHOLD_BYTES ? { kind: 'freed', bytes: freedBytes } : { kind: 'nothing' }
}

/**
 * U4: la riga del lavoro e dell'esito di «Libera spazio», sotto la sezione:
 * spinner e «Libero spazio…» mentre lavora, poi «Liberati X» con i byte
 * misurati sul disco, o «Non c'era niente da liberare.» sotto la soglia.
 */
export function PruneFeedback({ working, outcome }: { working: boolean; outcome: PruneOutcome }) {
  const { i18n } = useLingui()
  if (working) {
    return (
      <SettingsNote testId="disk-space-prune-working" className="flex items-center gap-row-gap">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {i18n._(msg`Libero spazio…`)}
      </SettingsNote>
    )
  }
  if (outcome?.kind === 'freed') {
    return (
      <SettingsNote testId="disk-space-freed">
        <Trans>Liberati {fmtBytes(outcome.bytes)}</Trans>
      </SettingsNote>
    )
  }
  if (outcome?.kind === 'nothing') {
    return (
      <SettingsNote testId="disk-space-nothing">
        <Trans>Non c'era niente da liberare.</Trans>
      </SettingsNote>
    )
  }
  return null
}

export function DiskSpaceSection({ initial }: { initial?: DiskSpaceInfo | null }) {
  const { i18n } = useLingui()
  const [info, setInfo] = useState<DiskSpaceInfo | null>(initial ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  // U4: il lavoro e l'esito di «Libera spazio» si vedono (spinner, byte liberati)
  const [prune, setPrune] = useState<{ working: boolean; outcome: PruneOutcome }>({ working: false, outcome: null })

  const load = (): void => {
    void api.boxDiskSpace().then(setInfo).catch(() => undefined)
  }
  useEffect(load, [])

  const runAction = (id: RowId, destructive: boolean, size: string): void => {
    const action = rowAction(id, size)
    if (destructive && action.confirm && !window.confirm(i18n._(action.confirm))) return
    setBusy(id)
    setLastError(null)
    const done = (r: { ok: boolean; error?: string; freedBytes?: number | null }): void => {
      // U4: a build in corso l'errore ha le sue parole; gli altri restano come oggi
      if (!r.ok) setLastError(r.error === 'build-in-progress' ? i18n._(msg`Il computer dei bot si sta costruendo: riprova quando ha finito`) : r.error ?? 'error')
      if (id === 'reclaimable') setPrune({ working: false, outcome: r.ok ? pruneOutcome(r.freedBytes ?? null) : null })
      setBusy(null)
      load()
    }
    const gone = (): void => {
      setBusy(null)
      load()
    }
    if (id === 'box-image') void api.boxImageRemove().then(done).catch(gone)
    else if (id === 'box-files') void api.boxBoxFilesRemove().then(done).catch(gone)
    else if (id === 'reclaimable') {
      // U4: il clic si VEDE — spinner e «Libero spazio…» finché la pulizia non finisce
      setPrune({ working: true, outcome: null })
      void api.boxSpacePrune().then(done).catch(gone)
    } else if (id === 'model') void api.localModelRemove().then(gone).catch(gone)
    else if (id === 'memory-model') void api.memoryModelRemove().then(gone).catch(gone)
  }

  const free = info?.freeBytes ?? null
  return (
    // il testid sta su un involucro: la sezione è il gruppo (è lui che fa l'etichetta e la scheda),
    // e le sonde di box-container contano i SUOI discendenti col testid disk-space-*
    <div data-testid="disk-space-section">
      <SettingsGroup
        label={i18n._(msg`Spazio su disco`)}
        // la frase sullo spazio libero sta SOTTO la scheda: è il footer del gruppo
        footer={free !== null ? <Trans>Spazio libero sul Mac: {fmtBytes(free)} — prima di costruire o scaricare ne restano sempre 5 GB.</Trans> : undefined}
      >
        {(info?.rows ?? []).map((row) => {
          const size = fmtBytes(row.bytes)
          const action = rowAction(row.id, size)
          return (
            // DUE <p> (il nome, la misura) e UN bottone: è così che la sonda di box-container legge la riga
            <div key={row.id} className={CARD_ROW_CLS} data-testid={`disk-space-${row.id}`}>
              <div className="min-w-0">
                <p className="truncate text-body font-medium">{i18n._(rowLabel(row.id))}</p>
                <p className="text-small text-muted-foreground">{size}</p>
              </div>
              <Button size="sm" disabled={busy !== null || row.bytes === null} onClick={() => runAction(row.id, row.destructive, size)}>
                {busy === 'reclaimable' && row.id === 'reclaimable' ? i18n._(msg`Libero spazio…`) : i18n._(action.label)}
              </Button>
            </div>
          )
        })}
        <PruneFeedback working={prune.working} outcome={prune.outcome} />
        {lastError && (
          <SettingsNote tone="destructive" testId="disk-space-error">
            {lastError.slice(0, 200)}
          </SettingsNote>
        )}
      </SettingsGroup>
    </div>
  )
}
