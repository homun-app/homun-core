// Fase catalogo app (P1/P7): i loghi del catalogo Composio curati nel repo
// (src/renderer/src/assets/app-logos, scaricati da
// scripts/aggiorna-catalogo-composio.mjs). La mappa si costruisce a bundle
// time con import.meta.glob: il nome del file («gmail.svg») diventa URL
// risolvibile in <img>, sia per riga sia per lo slug (la card in chat).
//
// Fase design (DS1): qui sta anche COME SI MOSTRA un logo — il raggio è
// uno, scritto in un posto solo. Prima ogni file che rendeva un logo scriveva
// la misura a mano (rounded-[11px] sul 40, rounded-[9px] sul 32,
// rounded-[5px] sul 20): tre raggi per la stessa cosa. Ora la MISURA la dà
// chi rende (size-8 nelle righe, size-10 nelle testate di scheda) e il raggio
// è quello dei controlli, 8 px. PERCHÉ 8 e non il 14 delle superfici: il
// raggio RITAGLIA il disegno del marchio, e i marchi a quadrato hanno angoli
// già arrotondati di circa un quinto del lato (7 px sul 32, 9 sul 40) — 8 px
// toglie appena gli angoli trasparenti senza mordere il disegno, 14 li
// taglierebbe via. La piastrella di ripiego (l'iniziale) segue lo stesso
// raggio: lo stesso plugin ha lo stesso profilo nella riga e nella scheda.
// Nel tema scuro una piastrella chiara dietro il logo: i marchi neri su
// fondo trasparente altrimenti spariscono (vedi AppLogo).
const files = import.meta.glob('../assets/app-logos/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

/**
 * Le classi di un file di logo: il raggio e il fondo chiaro del tema scuro.
 * La misura NO: la scrive chi rende (DS1: size-8 nelle righe, size-10 nelle
 * testate di scheda), così è leggibile nel posto dove si sceglie.
 */
export const LOGO_CLASS = 'shrink-0 rounded-control object-cover dark:bg-white'

/**
 * Le classi della PIASTRELLA di ripiego (nessun file per quell'app): il
 * fondo tenue con l'iniziale. Come LOGO_CLASS, senza ciò che è di un'<img>
 * (object-cover non ha senso su un riquadro, e il fondo chiaro lo mette già
 * bg-muted).
 */
export const LOGO_TILE_CLASS = 'shrink-0 rounded-control bg-muted font-semibold text-foreground/70'

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

/**
 * K4 (fase team-bot): lo stem con cui un NOME umano si cerca tra i file dei
 * loghi — «Mattermost» → mattermost, «DeepWiki MCP» → deepwiki_mcp. Pura,
 * testabile senza la mappa di vite.
 */
export function logoStemForName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * K4: l'URL del logo per il NOME di un server o di un'app, quando il file è
 * tra quelli del repo (altrimenti null: chi chiama resta sull'iniziale).
 */
export function logoUrlForName(name: string | null | undefined): string | null {
  if (!name) return null
  return bySlug[logoStemForName(name)] ?? null
}
