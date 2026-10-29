// Bridge dei deps d'installazione (fase 13): il daemon registra qui i deps
// veri (store cifrato, marketplace, docker, UI); il loop li legge quando il
// modello propone un server o un plugin. Iniettato per non creare il ciclo
// loop → daemon.
import type { InstallDeps } from './install'

let deps: InstallDeps | null = null

/** Il daemon chiama questa al wiring (o i test con deps finti). */
export function setInstallDeps(d: InstallDeps | null): void {
  deps = d
}

/** I deps registrati; senza wiring (es. tool base nei test) la proposta rifiuta con errore chiaro. */
export function getInstallDeps(): InstallDeps {
  if (!deps) throw new Error('installazione dei connettori non disponibile in questo contesto')
  return deps
}
