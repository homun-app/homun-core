// Fase rilascio (A5, puro): un URL esterno si può aprire nel browser di
// sistema SOLO se è http/https (o mailto). Mai file:, javascript:, schemi
// personalizzati: sarebbero un salto fuori dalle protezioni della pagina.
export function canOpenExternally(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:'
  } catch {
    return false
  }
}

/**
 * D6 (fase deleghe, puro): difesa in profondità del will-navigate — l'app è
 * una SPA e non naviga MAI da sé (il routing è tutto a hash #/…): una
 * navigazione DENTRO l'origine dell'app verso un percorso che non è la
 * radice si BLOCCA. Così un link relativo scritto in un documento della
 * Libreria ([x](y.md) → homun://app/y.md) non può più ricaricare l'app o
 * lasciare la finestra su un «Not found» bianco. Fuori origine: false (non
 * è affar suo — la regola di A5 decide).
 */
export function isSpaNavigationBlocked(url: string, appOrigin: string): boolean {
  if (!url.startsWith(appOrigin)) return false
  return url !== appOrigin && url !== appOrigin + 'index.html'
}
