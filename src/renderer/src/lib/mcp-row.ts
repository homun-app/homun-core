import type { McpServerInfo } from '../../../shared/types'

/**
 * La riga del comando di un server: stdio sul Mac (command + args), stdio nel
 * computer isolato (box.command + box.args, i server npm di E4) o l'indirizzo.
 * Mai «undefined» quando il comando vive solo nel box.
 */
export function serverCommandLine(s: Pick<McpServerInfo, 'transport' | 'command' | 'args' | 'url' | 'box'>): string {
  if (s.transport !== 'stdio') return s.url ?? ''
  const command = s.command ?? s.box?.command ?? ''
  const args = s.args ?? s.box?.args ?? []
  return [command, ...args].filter((p) => p !== '').join(' ')
}
