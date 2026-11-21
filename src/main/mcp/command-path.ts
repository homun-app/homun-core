// E1 (fase mcp-env): il PERCORSO del comando di un server stdio MANUALE.
// Un'app aperta dal Finder ha un PATH ridotto: npx/node installati con fnm,
// nvm o Homebrew spesso non si trovano e il server non parte con un errore
// criptico. Se il comando non è un percorso assoluto (né relativo) si cerca
// nel PATH e ANCHE nei posti noti; se non c'è, l'errore lo dice in chiaro.
// Nessuna esecuzione di shell di login, mai. PURA (fs iniettabile).
// U4 (fase mcp-ui): il ritorno porta anche la CARTELLA trovata (dir) e
// serverCommandEnv mette quella cartella IN TESTA al PATH del processo
// figlio: npx è uno script «#!/usr/bin/env node» e col solo PATH ridotto
// del Finder il figlio muore con «env: node: No such file or directory».
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { uiText } from '../ui-language'
import { UI } from '../../shared/ui-messages'

export interface CommandLookupDeps {
  existsSync(path: string): boolean
  readdirSync(path: string): string[]
  /** la home dell'utente (default os.homedir()) */
  home: string
  /** il PATH da guardare prima dei posti noti (default process.env.PATH) */
  envPath: string
}

/**
 * I posti noti dei gestori di versioni di node (PURO, nell'ordine):
 * fnm (alias default), nvm (OGNI versione, la più alta prima), Homebrew
 * arm (/opt/homebrew/bin) e Intel (/usr/local/bin).
 */
export function knownCommandDirs(home: string, readdir: (p: string) => string[] = (p) => readdirSync(p)): string[] {
  const nvmRoot = join(home, '.nvm', 'versions', 'node')
  let versions: string[] = []
  try {
    versions = readdir(nvmRoot).filter((v) => /^v?\d/.test(v)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  } catch {
    versions = [] // nvm non c'è: si va avanti
  }
  return [
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    ...versions.map((v) => join(nvmRoot, v, 'bin')),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
}

const defaultDeps = (): CommandLookupDeps => ({
  existsSync,
  readdirSync,
  home: homedir(),
  envPath: process.env.PATH ?? ''
})

/** Il risultato della risoluzione: il percorso COMPLETO e la sua CARTELLA (U4). */
export type ResolvedServerCommand = { command: string; dir?: string }

/**
 * Risolve il comando di un server stdio manuale: percorso assoluto o
 * relativo resta così com'è; un nome semplice si cerca nel PATH e poi nei
 * posti noti (fnm, nvm, Homebrew) e torna il PERCORSO COMPLETO trovato con
 * la sua CARTELLA (dir: serve al PATH del figlio, U4); se non c'è, l'errore
 * in chiaro col nome del comando (per il foglio del server).
 */
export function resolveServerCommand(
  command: string,
  deps: Partial<CommandLookupDeps> = {}
): ResolvedServerCommand | { error: string } {
  const d = { ...defaultDeps(), ...deps }
  const name = command.trim()
  if (!name) return { error: uiText(UI.mcpCommandNotFound, { command }) }
  // assoluto o relativo: nessuna risoluzione (la cartella resta quella del
  // percorso: anche un eseguibile risolto a mano può avere un node accanto)
  if (name.startsWith('/') || name.startsWith('./') || name.startsWith('../')) return { command: name, dir: dirname(name) }
  const candidates = [
    ...d.envPath.split(':').filter(Boolean),
    ...knownCommandDirs(d.home, d.readdirSync)
  ]
  for (const dir of candidates) {
    const full = join(dir, name)
    if (d.existsSync(full)) return { command: full, dir }
  }
  return { error: uiText(UI.mcpCommandNotFound, { command: name }) }
}

/**
 * U4: l'env del processo figlio di un server stdio manuale. La cartella
 * dove il comando è stato risolto va IN TESTA al PATH — npx/uvx/python sono
 * spesso script «#!/usr/bin/env node» (o simili) che cercano l'interprete
 * nel PATH del FIGLIO, ridotto per un'app aperta dal Finder. Il PATH
 * dell'utente (nelle variabili del server) si rispetta, con la cartella
 * risolta comunque PRIMA. PURA.
 */
export function serverCommandEnv(
  dir: string | undefined,
  userEnv: Record<string, string> | undefined,
  baseEnvPath: string = process.env.PATH ?? ''
): Record<string, string> | undefined {
  if (!dir && !userEnv) return undefined
  const basePath = userEnv?.PATH ?? baseEnvPath
  const path = dir ? [dir, basePath].filter(Boolean).join(':') : basePath
  return { ...userEnv, ...(path ? { PATH: path } : {}) }
}

/**
 * Il lookup usato da connect() (injectable nei test: la corsa del processo
 * deve poter provare PATH finti senza toccare la home vera).
 */
let commandLookup: ((command: string) => ResolvedServerCommand | { error: string }) | null = null

/** Solo per i test: sostituisce (o ripristina) il lookup dei comandi. */
export function setCommandLookupForTests(fn: ((command: string) => ResolvedServerCommand | { error: string }) | null): void {
  commandLookup = fn
}

/** Il lookup di connect(): quello vero, o quello dei test. */
export function lookupServerCommand(command: string): ResolvedServerCommand | { error: string } {
  return commandLookup ? commandLookup(command) : resolveServerCommand(command)
}
