// Fase impostazioni (I1): le funzioni PURE del ModelSelect — raggruppamento
// per provider, filtro della ricerca, i tipi ancora da collegare e il primo
// modello «adatto» dopo un collegamento. Nessun componente qui: si testano
// senza montare niente.
import type { ModelInfo, ProviderKind, ProviderPublic } from '../../../shared/types'

/** Una voce del popover: provider + modello, con la chiave stabile `pid::mid`. */
export interface ModelEntry {
  key: string
  providerId: string
  providerName: string
  model: ModelInfo
}

/** Le voci dei modelli pronti, raggruppate per provider (l'ordine dei provider). */
export function modelEntries(
  providers: ProviderPublic[],
  byProvider: Record<string, ModelInfo[]>
): ModelEntry[] {
  return providers.flatMap((p) =>
    (byProvider[p.id] ?? []).map((m) => ({
      key: `${p.id}::${m.id}`,
      providerId: p.id,
      providerName: p.name,
      model: m
    }))
  )
}

/** Il filtro della ricerca: id o etichetta contengono la query (case-insensitive). */
export function filterModelEntries(entries: ModelEntry[], query: string): ModelEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter(
    (e) => e.model.id.toLowerCase().includes(q) || (e.model.label ?? '').toLowerCase().includes(q)
  )
}

/** I tipi di provider che si possono collegare, col gruppo del foglio di collegamento. */
export const CONNECTABLE_KINDS: ReadonlyArray<{ kind: ProviderKind; group: 'mac' | 'key' | 'server' }> = [
  { kind: 'ollama', group: 'mac' },
  { kind: 'lmstudio', group: 'mac' },
  { kind: 'anthropic', group: 'key' },
  { kind: 'openai', group: 'key' },
  { kind: 'mistral', group: 'key' },
  { kind: 'zai', group: 'key' },
  { kind: 'openrouter', group: 'key' },
  { kind: 'xai', group: 'key' },
  { kind: 'deepseek', group: 'key' },
  { kind: 'groq', group: 'key' },
  { kind: 'openai-compatible', group: 'server' }
]

/**
 * I tipi NON ancora collegati (I1.2): una riga per tipo assente — la lista
 * che il popover mostra sotto i modelli pronti, e da cui parte «Collega».
 */
export function connectableKinds(
  connected: ReadonlyArray<{ kind: ProviderKind }>
): ReadonlyArray<{ kind: ProviderKind; group: 'mac' | 'key' | 'server' }> {
  const present = new Set(connected.map((p) => p.kind))
  return CONNECTABLE_KINDS.filter((c) => !present.has(c.kind))
}

/**
 * Il primo modello «adatto» di un elenco (I1.2): quello che dichiara di usare
 * i tool (tools !== false); a parità di dichiarazione vince il predefinito
 * del kind quando c'è. Serve all'evidenziazione dopo un collegamento riuscito.
 */
export function firstSuitableModel(models: ModelInfo[], preferred?: string | null): number {
  if (models.length === 0) return -1
  if (preferred) {
    const idx = models.findIndex((m) => m.id === preferred)
    if (idx >= 0 && models[idx]!.tools !== false) return idx
  }
  const withTools = models.findIndex((m) => m.tools !== false)
  return withTools >= 0 ? withTools : 0
}
