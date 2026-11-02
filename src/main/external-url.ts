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
