// OB2 (fase onboarding-b): le righe dell'avanzamento della preparazione
// del computer del bot — la lista verticale che la GUIDA (passo Computer)
// e le IMPOSTAZIONI (scheda del motore) condividono. PURA: dalla fase
// dello stato (setting box.setup, evento box-setup) alle sei righe col
// loro stato, così la UI non decide niente da sola.
import type { BoxSetupPhase, BoxSetupState } from '../../../shared/types'

/** Le sei fasi in parole, nell'ordine della guida. */
export const BOX_SETUP_ROW_IDS = ['download', 'verify', 'installer', 'service', 'kernel', 'image'] as const

export type BoxSetupRowId = (typeof BOX_SETUP_ROW_IDS)[number]

/** Lo stato di una riga: da fare, in corso (barra o spinner), fatta ✓, errore; «action» è il bottone. */
export type BoxSetupRowState = 'todo' | 'running' | 'done' | 'error' | 'action'

export interface BoxSetupRow {
  id: BoxSetupRowId
  status: BoxSetupRowState
  /** i byte scaricati e il totale (solo la riga del download in corso) */
  bytes: number | null
  total: number | null
  /** la fase che dice il build, se c'è (solo la riga dell'immagine) */
  buildPhase: string | null
}

/** Le fasi della macchina a stati che si VEDONO nelle righe, nell'ordine. */
const ROW_PHASES: ReadonlyArray<{ phase: BoxSetupPhase; row: BoxSetupRowId }> = [
  { phase: 'downloading', row: 'download' },
  { phase: 'verifying', row: 'verify' },
  { phase: 'awaiting-installer', row: 'installer' },
  { phase: 'starting-service', row: 'service' },
  { phase: 'installing-kernel', row: 'kernel' },
  { phase: 'building-image', row: 'image' }
]

/**
 * Le sei righe (PURA): le fasi già passate sono fatte, la corrente è in
 * corso (o l'azione, sull'attesa dell'Installer), le altre da fare. Con
 * l'errore, la riga della fase di colpa è in errore e le fati PRIMA di lei
 * restano fatte (non si rifà quel che è riuscito). Annullato, mai partito
 * o controllo dello spazio: tutto da fare — la riga del download COMINCIA
 * col download.
 */
export function boxSetupRows(s: BoxSetupState): BoxSetupRow[] {
  const errorPhase = s.phase === 'error' ? s.error?.phase ?? null : null
  const current = s.phase !== 'idle' && s.phase !== 'cancelled' && s.phase !== 'error' && s.phase !== 'checking-space'
    ? s.phase
    : null
  const currentIdx = current ? ROW_PHASES.findIndex((p) => p.phase === current) : -1
  const errorIdx = errorPhase ? ROW_PHASES.findIndex((p) => p.phase === errorPhase) : -1

  return BOX_SETUP_ROW_IDS.map((id) => {
    const idx = ROW_PHASES.findIndex((p) => p.row === id)
    const rowPhase = ROW_PHASES[idx]!.phase
    let status: BoxSetupRowState = 'todo'
    if (s.phase === 'ready') status = 'done'
    else if (errorPhase === rowPhase) status = 'error'
    else if (idx < currentIdx || (errorIdx >= 0 && idx < errorIdx)) status = 'done'
    else if (current !== null && idx === currentIdx) status = s.phase === 'awaiting-installer' ? 'action' : 'running'
    const isDownload = id === 'download' && status === 'running'
    const isImage = id === 'image' && status === 'running'
    return {
      id,
      status,
      bytes: isDownload ? s.bytes : null,
      total: isDownload ? s.total : null,
      buildPhase: isImage ? s.buildPhase : null
    }
  })
}

/**
 * «Continua» può portare oltre mentre la preparazione corre SOLO nelle fasi
 * in background (download e immagine: l'utente non serve): negli altri
 * passi serve l'utente o la fine (PURa — la usano la guida e il riepilogo
 * di «Pronto»).
 */
export function boxSetupInBackground(phase: BoxSetupPhase): boolean {
  return phase === 'downloading' || phase === 'building-image'
}

/** «Annulla» c'è finché il download o l'immagine corrono (PURa). */
export function boxSetupCancellable(phase: BoxSetupPhase): boolean {
  return phase === 'downloading' || phase === 'building-image'
}

/** La preparazione CORRE adesso? (per la riga del pannello del bot, OB4) */
export function boxSetupActive(phase: BoxSetupPhase): boolean {
  return phase !== 'idle' && phase !== 'ready' && phase !== 'error' && phase !== 'cancelled'
}
