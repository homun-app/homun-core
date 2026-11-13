// OB1 (fase onboarding-b): «l'app è impacchettata?» dove NON c'è Electron
// `app` — cioè nel daemon. È lo stesso criterio del fallback di
// daemon-context.ts: nel main di sviluppo (electron .) process.defaultApp è
// vero; nell'app impacchettata il binario parte senza defaultApp ma con
// process.versions.electron. Nei test nudi (vitest) è falso: gli override
// SANDBOT_TEST_* funzionano, come sempre.
/** L'app è impacchettata? (equivalente di app.isPackaged per il daemon) */
export function isPackagedRuntime(): boolean {
  return !process.defaultApp && !!process.versions.electron
}
