// OBD2 (fase onboarding-b-dettagli): il PIANO della preparazione del
// computer del bot — i passi che succederanno DAVVERO, calcolati dagli
// stessi fatti (stato Apple, immagine presente) che decidono la partenza:
// boxSetupStartFrom USA boxSetupPlan, così piano e partenza non possono
// divergere. Vive in shared perché lo usa il daemon (la RPC box:setup-plan)
// e la UI (il consenso del passo Computer elenca solo i passi in piano).
// PURA e senza moduli di Node: le stime dei byte per passo derivano dalle
// costanti VERE (pacchetto firmato, kernel, immagine) — mai numeri a mano.
import { APPLE_CONTAINER_PKG_BYTES } from '../main/sandbox/apple-container-release'
// type-only: chi importa questo modulo dal renderer non tira dentro engine.js
import type { AppleEngineState } from '../main/sandbox/engine'
import type { BoxSetupPhase } from './types'

/** Le sei righe della preparazione, nell'ordine della guida (piano e stato le condividono). */
export const BOX_SETUP_ROW_IDS = ['download', 'verify', 'installer', 'service', 'kernel', 'image'] as const

export type BoxSetupRowId = (typeof BOX_SETUP_ROW_IDS)[number]

/**
 * La stima del kernel (PURa): ~1 GB, come dice il testo del consenso del
 * kernel di BX4 («Verrà scaricato da Apple (circa 1 GB)»). Vive qui (e il
 * daemon la re-esporta) perché la usa anche la stima del PIANO in shared.
 */
export const KERNEL_ESTIMATED_BYTES = 1_000_000_000

/**
 * La stima dell'immagine con la sua cache di build (1,5 GB: immagine ~1,18 GB
 * + cache ~1,15 GB — i numeri del df della CLI finta nel REPORT di
 * box-container). Il valore è QUELLO di sempre (disk-space lo re-esporta):
 * qui ci sta la COPIA per la stima del piano, mai un secondo numero.
 */
export const BOX_BUILD_ESTIMATED_BYTES = 1_500_000_000

/**
 * Il piano (PURa): i passi che la preparazione FARÀ da qui alla fine, nello
 * ordine della guida. `ready` con immagine → piano vuoto (già pronti);
 * `unsupported` → piano vuoto (niente passo Computer). Gli stessi fatti di
 * boxSetupStartFrom, la stessa decisione.
 */
export function boxSetupPlan(appleState: AppleEngineState, hasImage: boolean): BoxSetupRowId[] {
  switch (appleState) {
    case 'not-installed': return [...BOX_SETUP_ROW_IDS]
    case 'stopped': return ['service', 'kernel', 'image']
    case 'kernel-missing': return ['kernel', 'image']
    case 'ready': return hasImage ? [] : ['image']
    default: return []
  }
}

/**
 * La stima dei byte del PIANO (PURa): solo i passi che succederanno — il
 * consenso dice «circa N GB» col numero del piano, mai la stima intera
 * quando servirà solo l'immagine. Il pacchetto conta DUE volte (si scarica E
 * si installa), come nella stima di sempre.
 */
export function boxSetupPlanBytes(steps: readonly BoxSetupRowId[]): number {
  const per: Record<BoxSetupRowId, number> = {
    download: APPLE_CONTAINER_PKG_BYTES,
    verify: 0,
    installer: APPLE_CONTAINER_PKG_BYTES,
    service: 0,
    kernel: KERNEL_ESTIMATED_BYTES,
    image: BOX_BUILD_ESTIMATED_BYTES
  }
  return steps.reduce((n, s) => n + per[s], 0)
}

/**
 * Le righe PRIMA della fase di partenza sono SALTATE, non fatte (PURa): con
 * lo strumento già installato non è che download e verifica «sono andati» —
 * non servivano. OBD2 le mostra col segno neutro e il loro testo.
 */
export function boxSetupSkippedRows(startPhase: BoxSetupPhase): BoxSetupRowId[] {
  switch (startPhase) {
    case 'checking-space':
    case 'downloading':
    case 'verifying':
      return []
    case 'starting-service': return ['download', 'verify', 'installer']
    case 'installing-kernel': return ['download', 'verify', 'installer', 'service']
    case 'building-image': return ['download', 'verify', 'installer', 'service', 'kernel']
    default: return []
  }
}
