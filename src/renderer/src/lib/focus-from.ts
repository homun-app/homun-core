// B5 (fase b20-bug): l'anello del fuoco SOLO da tastiera — il marcatore.
//
// MISURATO DAL VIVO (sonda CDP sull'app, Chromium di Electron 45, macOS con
// «Navigazione con tastiera» SPENTA). L'anello arancione è l'outline NATIVO
// di Chromium, quello che sta su `:focus-visible`, nel colore d'accento di
// sistema. Un clic VERO sulla riga di un bot NON lo mostra (:focus-visible è
// falso). Lo mostra il TASTO premuto subito dopo, qualunque sia: per
// l'euristica di Chromium, se l'utente usa la tastiera l'elemento che ha il
// fuoco diventa :focus-visible — anche se il fuoco glielo aveva dato il
// mouse. Così: clic sulla riga, poi Esc, ⌘K, uno Shift… e la riga cliccata
// si accende. L'utente lo vede come «l'anello compare al clic».
//
// Il CSS da solo non può rimediare: quando l'anello si vede l'elemento È
// :focus-visible, ed è l'unico segnale che il CSS riceve. Gli eventi, invece,
// dicono da dove ARRIVA IL FUOCO — e questo modulino lo scrive su <html>
// (data-focus-from), che styles.css legge in due punti:
//   - pointerdown viene PRIMA del fuoco del clic → 'pointer';
//   - un tasto che da tastiera sposta o attiva il fuoco viene PRIMA dello
//     spostamento → 'keyboard';
//   - qualunque ALTRO tasto (un modificatore, una scorciatoia, una lettera)
//     NON cambia la modalità: non ha spostato il fuoco.
// In styles.css, sullo stesso marcatore: la regola unica (in @layer base)
// toglie l'outline nativo ai controlli presi col puntatore — senza guardare
// :focus-visible, che dopo un clic scatta comunque — e la variante
// `focus-visible` di Tailwind è ridefinita, così le utility `focus-visible:…`
// seguono la stessa modalità. Da tastiera non cambia niente. I campi di testo
// restano fuori (ci si scrive: il loro fuoco preso col mouse è fuoco da
// tastiera): la lista sta in styles.css e nei due punti deve restare la
// stessa — lo impone la guardia __tests__/focus-ring-guard.test.ts.

export type FocusFrom = 'keyboard' | 'pointer'

/**
 * I tasti che, da tastiera, spostano o attivano il fuoco. Gli altri no: un
 * modificatore o una scorciatoia premuti dopo un clic non devono riaccendere
 * l'anello sull'elemento che ha preso il fuoco col mouse.
 */
const FOCUS_KEYS: ReadonlySet<string> = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' '
])

/** Il tasto sposta o attiva il fuoco da tastiera? Con Ctrl, Alt o ⌘ è una scorciatoia (⌘K, ⌥←, Ctrl+Invio): Shift sì (Shift+Tab). */
function movesFocusFromKeyboard(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false
  return FOCUS_KEYS.has(e.key)
}

/**
 * Installa il marcatore sul documento e restituisce la funzione che lo toglie.
 * Valore iniziale 'keyboard': finché l'utente non tocca il puntatore il fuoco
 * è da tastiera — il fuoco iniziale e l'autoFocus compresi (l'anello si vede,
 * come oggi).
 */
export function installFocusFrom(doc: Document): () => void {
  const root = doc.documentElement
  const set = (from: FocusFrom): void => {
    if (root.dataset.focusFrom !== from) root.dataset.focusFrom = from
  }
  set('keyboard')
  const onPointerDown = (): void => set('pointer')
  const onKeyDown = (e: KeyboardEvent): void => {
    if (movesFocusFromKeyboard(e)) set('keyboard')
  }
  // In CATTURA sul documento: l'evento arriva prima dei gestori dei
  // componenti (anche dove uno ferma la propagazione) e comunque prima che
  // il clic dia il fuoco o Tab lo sposti.
  doc.addEventListener('pointerdown', onPointerDown, { capture: true })
  doc.addEventListener('keydown', onKeyDown, { capture: true })
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, { capture: true })
    doc.removeEventListener('keydown', onKeyDown, { capture: true })
  }
}
