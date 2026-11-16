// Fase impostazioni (I2.4): i loghi dei provider curati nel repo
// (src/renderer/src/assets/provider-logos, scaricati da
// scripts/aggiorna-loghi-provider.mjs — lo lanciamo noi a mano). La mappa si
// costruisce a bundle time con import.meta.glob: il nome del file è il KIND
// del provider («ollama.svg»). Finché un logo manca vale l'iniziale di oggi;
// nel tema scuro la piastrella è chiara come per i loghi delle app (il build
// che l'ha introdotto per i marchi neri trasparenti).
import type { ProviderKind } from '../../../shared/types'

const files = import.meta.glob('../assets/provider-logos/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
// U5 (fase prima-release): i loghi MONOCROMI (Simple Icons, CC0) si rendono
// INLINE — dentro un <img> un SVG non eredita currentColor dalla pagina
const raws = import.meta.glob('../assets/provider-logos/*.svg', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

const byKind: Partial<Record<ProviderKind, string>> = {}
for (const [path, url] of Object.entries(files)) {
  const stem = (path.split('/').pop() ?? '').replace(/\.(svg|png|webp)$/i, '')
  byKind[stem as ProviderKind] = url
}

const svgByKind: Partial<Record<ProviderKind, string>> = {}
for (const [path, raw] of Object.entries(raws)) {
  const stem = (path.split('/').pop() ?? '').replace(/\.svg$/i, '')
  svgByKind[stem as ProviderKind] = raw
}

/**
 * U5: i kind col logo MONOCROMO che segue il colore del testo
 * (fill="currentColor", fondo trasparente): Anthropic e OpenAI, i marchi
 * veri di Simple Icons 15.0.0 (CC0). Per loro NIENTE piastrella.
 */
export const MONOCHROME_LOGO_KINDS: ReadonlySet<string> = new Set(['anthropic', 'openai'])

/** L'URL del logo del provider, se il file è nel repo (altrimenti l'iniziale). */
export function providerLogoUrl(kind: ProviderKind): string | null {
  return byKind[kind] ?? null
}

/** U5: il contenuto SVG INLINE del logo monocromo (o null): per ereditare currentColor. */
export function providerLogoSvg(kind: ProviderKind): string | null {
  return MONOCHROME_LOGO_KINDS.has(kind) ? svgByKind[kind] ?? null : null
}
