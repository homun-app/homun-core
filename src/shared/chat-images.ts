// Fase chat-limiti (CL3): le immagini mostrate in chat dal tool show_images.
// Puro e condiviso (main + renderer + test): il nome dei file è deciso
// DALL'HASH del contenuto (sha256 + estensione), il renderer le carica SOLO
// dal protocollo dell'app (homun://app/media/<hash>.<ext>) — MAI dall'URL
// remoto del sito, che vedrebbe l'IP dell'utente e potrebbe tracciarlo.
export type ChatGalleryImage = {
  /** nome del file in <dataDir>/chat-images: <sha256>.<png|jpg|gif|webp> */
  file: string
  /** il dominio di provenienza (mostrato sotto la miniatura) */
  domain: string
  /** la pagina del web_fetch dove l'immagine è stata vista (link sotto la miniatura) */
  pageUrl: string
  mime: string
}

/** Il nome di un'immagine della chat: sha256 esadecimale + estensione immagine nota. */
export const CHAT_IMAGE_NAME_RE = /^[a-f0-9]{64}\.(png|jpe?g|gif|webp)$/

/**
 * L'URL homun:// di un'immagine della chat, o null se il nome non è nella
 * forma decisa dal daemon (hash + estensione). Nessun percorso arbitrario
 * può entrare: il protocollo dell'app rifiuta tutto il resto.
 */
export function homunMediaUrl(file: string): string | null {
  return CHAT_IMAGE_NAME_RE.test(file) ? `homun://app/media/${file}` : null
}

export interface GalleryRow {
  /** il src del <img>: SEMPRE homun://, mai http(s) */
  src: string
  domain: string
  pageUrl: string
  alt: string
}

/**
 * Le righe della galleria (puro): il src di ogni immagine è l'URL del
 * protocollo dell'app. Un nome fuori forma (mai prodotto dal daemon) non
 * dà un src http di ripiego: la riga si scarta.
 */
export function galleryCardRows(images: readonly ChatGalleryImage[]): GalleryRow[] {
  const rows: GalleryRow[] = []
  for (const img of images) {
    const src = homunMediaUrl(img.file)
    if (!src) continue
    rows.push({ src, domain: img.domain, pageUrl: img.pageUrl, alt: `${img.domain}` })
  }
  return rows
}
