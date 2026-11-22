// A3 (fase approvazioni-chiare): il NUMERO sull'icona del Dock — quante
// richieste d'approvazione aspettano l'utente (app.dock.setBadge). Puro,
// testato: 0 → NESSUN badge (stringa vuota), il conteggio → il numero, e
// oltre 99 si ferma a «99+».
/** Il testo del badge per un conteggio di richieste in attesa. */
export function dockBadgeOf(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  if (count > 99) return '99+'
  return String(Math.floor(count))
}
