// Risoluzione dei tool esterni (fase rilascio, A7): le app aperte dal Finder
// e i servizi di launchd hanno il PATH minimo /usr/bin:/bin:/usr/sbin:/sbin.
// Docker Desktop mette `docker` in /usr/local/bin, /opt/homebrew/bin,
// ~/.docker/bin o dentro Docker.app: con spawn('docker', …) il box NON
// partirebbe nell'app installata. Qui si sceglie il percorso (parte PURA,
// testabile con un filesystem finto) e si tiene una cache invalidabile dal
// bottone «Riprova» della UI.
import { existsSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ToolName = 'docker' | 'git'

/** Sonda di un percorso (default: file esistente ed eseguibile); iniettabile nei test. */
export type FsProbe = (path: string) => boolean

export const executableFile: FsProbe = (path) => {
  try {
    accessSync(path, constants.X_OK)
    return existsSync(path)
  } catch {
    return false
  }
}

/** I percorsi possibili di docker, in ordine (purA): env esplicita → PATH → i posti noti. */
export function dockerCandidatePaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = []
  if (env.HOMUN_DOCKER_PATH) out.push(env.HOMUN_DOCKER_PATH)
  if (env.PATH) out.push(...env.PATH.split(':').filter(Boolean).map((p) => join(p, 'docker')))
  out.push(
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    join(home, '.docker', 'bin', 'docker'),
    '/Applications/Docker.app/Contents/Resources/bin/docker'
  )
  return [...new Set(out)]
}

/** I percorsi possibili di git, in ordine (puro): env esplicita → PATH → /usr/bin → homebrew. */
export function gitCandidatePaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = []
  if (env.HOMUN_GIT_PATH) out.push(env.HOMUN_GIT_PATH)
  if (env.PATH) out.push(...env.PATH.split(':').filter(Boolean).map((p) => join(p, 'git')))
  out.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git')
  return [...new Set(out)]
}

/** Il primo percorso eseguibile (puro: la sonda si inietta). */
export function pickExecutable(candidates: string[], probe: FsProbe = executableFile): string | null {
  return candidates.find((p) => probe(p)) ?? null
}

const cache = new Map<ToolName, string | null>()

/** Azzera la cache dei percorsi (bottone «Riprova» della UI). */
export function invalidateToolCache(): void {
  cache.clear()
}

/**
 * Il percorso di docker/git per spawn/execFile. Sync perché i punti d'uso
 * sono spawn sincroni; la cache evita le stat a ripetizione. Se NON si trova
 * (Docker Desktop assente), si torna il nome semplice: lo spawn fallirà con
 * ENOENT e la UI lo dice in parole (toolMissingMessage) — il comportamento
 * di oggi resta il limite inferiore.
 */
export function resolveTool(tool: ToolName): string {
  const hit = cache.get(tool)
  if (hit !== undefined) return hit ?? tool
  const home = homedir()
  const candidates = tool === 'docker' ? dockerCandidatePaths(process.env, home) : gitCandidatePaths(process.env, home)
  const found = pickExecutable(candidates)
  cache.set(tool, found)
  return found ?? tool
}

/** True se il tool è stato TROVATO (per lo stato mostrato dalla UI). */
export function isToolResolved(tool: ToolName): boolean {
  return resolveTool(tool) !== tool
}

/** Il link di installazione di Docker Desktop (fase rilascio A7: lo mostra la UI). */
export const DOCKER_INSTALL_URL = 'https://www.docker.com/products/docker-desktop/'

/**
 * Fase rilascio (A7, puro): DOCKER_HOST per i FIGLI docker. Il CLI recente
 * trova da solo il socket di Docker Desktop tramite il contesto in
 * ~/.docker/config.json; quando il contesto NON c'è, DOCKER_HOST manca
 * nell'env e il socket standard manca, si passa quello di Docker Desktop
 * (~/.docker/run/docker.sock) se esiste.
 */
export function dockerHostDefault(
  env: { DOCKER_HOST?: string },
  home: string,
  standardSocketExists: boolean,
  desktopSocketExists: boolean
): string | undefined {
  if (env.DOCKER_HOST) return undefined // già deciso dall'utente
  if (standardSocketExists) return undefined // /var/run/docker.sock: il default del CLI
  if (desktopSocketExists) return `unix://${join(home, '.docker', 'run', 'docker.sock')}`
  return undefined
}

/**
 * L'env dei processi docker figli: quella del daemon + DOCKER_HOST se serve
 * (A7 punto 3). I segreti SANDBOT_SECRET_* NON passano da qui — di quello se
 * ne occupa dockerClientEnv del sandbox dove serve.
 */
export function dockerChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v
  }
  const host = dockerHostDefault(
    env,
    homedir(),
    existsSync('/var/run/docker.sock'),
    existsSync(join(homedir(), '.docker', 'run', 'docker.sock'))
  )
  if (host) out.DOCKER_HOST = host
  return out
}
