// U2 (fase mcp-ui): l'elenco di «Importa da Cursor, Claude o ZCode» si
// RAGGRUPPA per origine e unisce i DOPPIONI ESATTI. PURA: qui la forma
// dell'elenco (gruppi nell'ordine fisso, righe con origine, ancheIn, conteggio
// segreti, già collegato), l'impaginazione sta in McpWindow e la sonda la
// prova sul DOM vero.
export type ImportSource = 'cursor' | 'claude' | 'zcode'

/** Una riga della scansione (dal main: nome e tipo, MAI valori segreti). */
export interface ImportScanRow {
  source: ImportSource
  name: string
  transport: 'stdio' | 'http'
  envNames: string[]
  secretNames: string[]
  commandLine?: string
  url?: string
  sourcePath: string
}

/** L'ordine fisso dei gruppi (lo stesso dei tre file in import-sources). */
export const IMPORT_SOURCE_ORDER: readonly ImportSource[] = ['cursor', 'claude', 'zcode']

/** Una riga dell'elenco raggruppato, pronta per la UI. */
export interface ImportRowUi {
  source: ImportSource
  sourcePath: string
  /** le altre origini con la STESSA voce (nome e stesso comando/URL) */
  alsoIn: ImportSource[]
  name: string
  transport: 'stdio' | 'http'
  /** il sottotitolo: comando (stdio) o host (http) */
  detail: string
  secretCount: number
  /** già presente in Homun: riga spenta, non selezionabile */
  existing: boolean
}

/** Un gruppo per origine (i vuoti non arrivano alla UI). */
export interface ImportGroupUi {
  source: ImportSource
  sourcePath: string
  rows: ImportRowUi[]
}

/** La chiave della riga per le spunte: l'origine PRIMARIA e il nome. */
export function importRowKey(r: Pick<ImportRowUi, 'source' | 'name'>): string {
  return `${r.source}:${r.name}`
}

/** L'host di un URL (best-effort: senza schema resta la stringa intera). */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** L'identità di una voce: nome E configurazione (comando o URL) — per i doppioni esatti. */
function identityOf(r: ImportScanRow): string {
  return `${r.transport}|${r.name}|${r.transport === 'stdio' ? r.commandLine ?? '' : r.url ?? ''}`
}

/**
 * L'elenco raggruppato (PURA): un gruppo per origine nell'ordine fisso, i
 * gruppi vuoti nascosti; lo stesso server (stesso nome E stesso comando o
 * URL) presente in più origini compare UNA volta col suo «anche in…»
 * (l'origine prima nell'ordine vince); lo stesso nome con configurazione
 * diversa resta su righe separate; i nomi già in Homun si spengono.
 */
export function groupImportRows(rows: readonly ImportScanRow[], existingNames: readonly string[]): ImportGroupUi[] {
  const existing = new Set(existingNames)
  const byIdentity = new Map<string, ImportRowUi>()
  for (const r of rows) {
    const id = identityOf(r)
    const hit = byIdentity.get(id)
    if (hit) {
      if (!hit.alsoIn.includes(r.source)) hit.alsoIn.push(r.source)
      continue
    }
    byIdentity.set(id, {
      source: r.source,
      sourcePath: r.sourcePath,
      alsoIn: [],
      name: r.name,
      transport: r.transport,
      detail: r.transport === 'stdio' ? (r.commandLine ?? '') : (r.url ? hostOfUrl(r.url) : ''),
      secretCount: r.secretNames.length,
      existing: existing.has(r.name)
    })
  }
  const all = [...byIdentity.values()]
  const groups: ImportGroupUi[] = []
  for (const source of IMPORT_SOURCE_ORDER) {
    const src = all.filter((r) => r.source === source)
    if (src.length) groups.push({ source, sourcePath: src[0]!.sourcePath, rows: src })
  }
  return groups
}
