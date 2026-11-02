// Fase rilascio (A5, puro): lo schema dei permessi del browser. Tutto NEGATO
// salvo ciò che l'app usa davvero — la copia del testo negli appunti
// (navigator.clipboard.writeText dei bottoni «copia»). Il microfono e la
// camera non servono a nessuna funzione: negati; le notifiche passano dal
// Notification di Electron (processo main), non dal browser.
export type BrowserPermission =
  | 'clipboard-sanitized-write'
  | 'clipboard-write'
  | string

export function permissionAllowed(permission: BrowserPermission): boolean {
  return permission === 'clipboard-sanitized-write' || permission === 'clipboard-write'
}
