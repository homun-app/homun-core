// Contesto d'avvio dell'app per il client del daemon (fase rilascio A1/A2).
// daemon-client.ts NON importa Electron (deve girare anche in vitest): il
// main gli registra qui isPackaged/appPath/versione/build, e il fallback
// vale per lo sviluppo nudo (electron .) e i test.
export interface DaemonSpawnContext {
  isPackaged: boolean
  appPath: string
  version: string
  buildId: string
}

let ctx: DaemonSpawnContext | null = null

/** Registra il contesto (chiamato dal main all'avvio della UI). */
export function setDaemonSpawnContext(c: DaemonSpawnContext): void {
  ctx = c
}

export function resetDaemonSpawnContext(): void {
  ctx = null
}

/** Il contesto attivo; il default vale per electron . a mano e i test. */
export function daemonSpawnContext(): DaemonSpawnContext {
  return (
    ctx ?? {
      isPackaged: !process.defaultApp && !!process.versions.electron,
      appPath: process.cwd(),
      version: 'dev',
      buildId: 'test'
    }
  )
}
