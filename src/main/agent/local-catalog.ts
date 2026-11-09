// Fase locale (L3.2/L3.3): il catalogo IN CODICE del modello integrato e
// l'idoneità della macchina. È la struttura per i livelli futuri (un modello
// da 8–9B a ≥ 24 GB dopo una misura dell'utente), ma oggi ha UNA SOLA voce:
// Qwen3.5-4B Q4_K_M, lo stesso file misurato in L0/L1 (13–22 tok/s, ~44 s a
// caso, 4,3 GB di RAM, Apache-2.0). LFM3 resta fuori: esegue l'istruzione
// nascosta del caso 2b e la licenza non è Apache.
//
// L'URL del download usa SEMPRE la revisione fissata, mai main: si scarica
// esattamente il file misurato e hashato.
export interface LocalCatalogEntry {
  /** l'id del modello (per il provider e la UI) */
  id: string
  label: string
  /** repo Hugging Face */
  repo: string
  /** la revisione fissata: l'URL non usa MAI main */
  revision: string
  file: string
  sizeBytes: number
  sha256: string
  license: string
  /** RAM minima perché la macchina sia idonea senza avvisi */
  minRamGb: number
  /** quanto RAM usa il processo a regime (per l'avviso onesto della UI) */
  ramUseGb: number
}

/** L'unica voce di oggi: Qwen3.5-4B Q4_K_M (misura L0/L1, M4 24 GB). */
export const QWEN_35_4B: LocalCatalogEntry = {
  id: 'qwen3.5-4b',
  label: 'Qwen3.5 4B (Q4_K_M)',
  repo: 'lmstudio-community/Qwen3.5-4B-GGUF',
  revision: 'f9f88ac3e234be915e23811a6d28ea287bdb927e',
  file: 'Qwen3.5-4B-Q4_K_M.gguf',
  sizeBytes: 2_707_513_696,
  sha256: '25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c',
  license: 'apache-2.0',
  minRamGb: 16,
  ramUseGb: 4.5
}

/** Il catalogo del modello integrato (una voce oggi). */
export const LOCAL_MODEL_CATALOG: readonly LocalCatalogEntry[] = [QWEN_35_4B]

/** L'id del modello installabile (l'unica voce del catalogo). */
export const LOCAL_MODEL_ID = QWEN_35_4B.id

/** L'URL di download della voce: la REVISIONE, mai main. */
export function downloadUrlOf(e: LocalCatalogEntry): string {
  return `https://huggingface.co/${e.repo}/resolve/${e.revision}/${e.file}`
}

/** Il percorso del file installato: <modelsDir>/<file>. */
export function localModelInstalledPath(e: LocalCatalogEntry, modelsDir: string): string {
  return `${modelsDir}/${e.file}`
}

/**
 * L'idoneità della macchina al modello integrato (pura):
 * - Intel → unsupported (il bundle è arm64 e la misura non esiste);
 * - arm64 con RAM < minRamGb → discouraged: si può installare, con l'avviso
 *   forte «sarà lento e potrebbe bloccare il Mac»;
 * - disco < dimensione + 2 GB → no-space, con quanti GB servono (freeDiskBytes
 *   null = non noto: non decide);
 * - altrimenti ok.
 */
export type LocalEligibility =
  | { status: 'ok' }
  | { status: 'discouraged' }
  | { status: 'unsupported' }
  | { status: 'no-space'; neededGb: number; freeGb: number }

export function localEligibility(
  facts: { arch: string; ramGb: number; freeDiskBytes: number | null },
  entry: LocalCatalogEntry = QWEN_35_4B
): LocalEligibility {
  if (facts.arch !== 'arm64') {
    // il testo per l'utente lo possiede la UI (catalogo Lingui): qui solo lo stato
    return { status: 'unsupported' }
  }
  const G = 1024 ** 3
  if (facts.freeDiskBytes !== null && facts.freeDiskBytes < entry.sizeBytes + 2 * G) {
    return {
      status: 'no-space',
      neededGb: Math.round(((entry.sizeBytes + 2 * G) / G) * 10) / 10,
      freeGb: Math.round((facts.freeDiskBytes / G) * 10) / 10
    }
  }
  if (facts.ramGb < entry.minRamGb) return { status: 'discouraged' }
  return { status: 'ok' }
}
