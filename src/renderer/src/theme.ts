// Fase 16 (U0): il tema si sceglie col setting 'ui.theme' (predefinito
// 'system'): classe 'dark' su <html>, aggiornata su matchMedia quando è
// 'system'. color-scheme la decide styles.css (:root/.dark).
export type UiTheme = 'system' | 'light' | 'dark'

/** Applica il tema alla pagina (classe dark su <html>). */
export function applyTheme(theme: UiTheme): void {
  if (typeof document === 'undefined') return
  const dark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

/** Riascolta i cambiamenti di sistema finché la funzione ritornata non si toglie. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = (): void => onChange()
  mq.addEventListener('change', listener)
  return () => mq.removeEventListener('change', listener)
}
