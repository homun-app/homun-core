// Logica pura dei permessi, separata da store/db (che importa Electron)
// per essere testabile in nodo puro con vitest.

/** Chiave target per tool: comando shell → prima parola+prefisso, file → path normalizzato. */
export function targetKey(tool: string, input: Record<string, unknown>): string {
  if (tool === 'run-command') {
    const cmd = String(input.command ?? '')
    const first = cmd.trim().split(/\s+/)[0] ?? ''
    return first
  }
  if (tool === 'read-file' || tool === 'write-file' || tool === 'list-directory') {
    return String(input.path ?? '')
  }
  if (tool === 'use-app') {
    return String(input.action ?? '') // scope per azione, come l'originale
  }
  return '*'
}
