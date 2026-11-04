// Fase impostazioni (I2.4): i loghi dei provider curati nel repo
// (src/renderer/src/assets/provider-logos, scaricati da
// scripts/aggiorna-loghi-provider.mjs — lo lanciamo noi a mano). La mappa si
// costruisce a bundle time con import.meta.glob: il nome del file è il KIND
// del provider («ollama.svg»). Finché un logo manca vale l'iniziale di oggi;
// nel tema scuro la piastrella è chiara come per i loghi delle app (il build
// che l'ha introdotto per i marchi neri trasparenti).
import type { ProviderKind } from '../../../shared/types'

const files = import.meta.glob('../assets/provider-logos/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

const byKind: Partial<Record<ProviderKind, string>> = {}
for (const [path, url] of Object.entries(files)) {
  const stem = (path.split('/').pop() ?? '').replace(/\.(svg|png|webp)$/i, '')
  byKind[stem as ProviderKind] = url
}

/** L'URL del logo del provider, se il file è nel repo (altrimenti l'iniziale). */
export function providerLogoUrl(kind: ProviderKind): string | null {
  return byKind[kind] ?? null
}
