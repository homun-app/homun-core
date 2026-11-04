// Fase catalogo app (P1/P7): i loghi del catalogo Composio curati nel repo
// (src/renderer/src/assets/app-logos, scaricati da
// scripts/aggiorna-catalogo-composio.mjs). La mappa si costruisce a bundle
// time con import.meta.glob: il nome del file («gmail.svg») diventa URL
// risolvibile in <img>, sia per riga sia per lo slug (la card in chat).
const files = import.meta.glob('../assets/app-logos/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

const byName: Record<string, string> = {}
const bySlug: Record<string, string> = {}
for (const [path, url] of Object.entries(files)) {
  const name = path.split('/').pop() ?? ''
  byName[name] = url
  const stem = name.replace(/\.(svg|png|webp)$/i, '')
  if (stem !== name) bySlug[stem.toLowerCase()] = url
}

/** L'URL del logo per nome file («gmail.svg»), se il file è nel repo. */
export function catalogLogoUrl(name: string | null | undefined): string | null {
  return (name && byName[name]) || null
}

/** L'URL del logo di uno slug Composio (per la card in chat, C5/P7). */
export function logoUrlForSlug(slug: string): string | null {
  return bySlug[slug.toLowerCase()] ?? null
}
