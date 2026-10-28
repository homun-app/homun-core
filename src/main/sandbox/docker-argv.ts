// Costruzione degli argv per la CLI docker — funzioni PURE (§5.2).
// Mai comandi docker assemblati come stringa e passati a una shell dell'host:
// ogni chiamata è spawn('docker', argv) con argv array. Path, comandi e opzioni
// restano singoli elementi argv: niente interpolazione, niente quoting da
// aggirare, niente escape possibile.
export const BOX_WORKDIR = '/home/box'

/** Utente non-root del container (ubuntu:24.04 → uid/gid 1000). */
export const CONTAINER_USER = '1000:1000'

// ---- fase 11 (punto 1): il box CONDIVISO, un solo container per utente ----

/** Il container unico del box condiviso di tutti i bot. */
export const BOX_CONTAINER = 'sandbot-box'

/** Il volume persistente del box condiviso, montato su /box. */
export const BOX_VOLUME = 'sandbot-box'

/** Punto di montaggio del volume dentro il container. */
export const BOX_MOUNT = '/box'

/** La home di un bot dentro il box condiviso (/box/home/<agentId>). */
export function boxHomePath(agentId: string): string {
  return `${BOX_MOUNT}/home/${agentId}`
}

/** Limiti CONDIVISI del box (punto 1): configurabili nei settings sandbox.*. */
export interface BoxLimits {
  memory: string
  cpus: number
  pids: number
}

export const DEFAULT_BOX_LIMITS: BoxLimits = { memory: '4g', cpus: 2, pids: 1024 }

export interface DockerExecOptions {
  workdir?: string
  /** Variabili da iniettare nel container: chiave qui, VALORE nell'env del processo docker spawnato (`-e KEY` senza `=valore` eredita dall'ambiente). */
  env?: Record<string, string>
}

/** `docker exec -i -w <home del bot> [-e KEY …] <container> sh -c <command>` — il comando del modello resta un unico elemento argv. */
export function dockerExecArgv(container: string, command: string, opts: DockerExecOptions = {}): string[] {
  const argv = ['exec', '-i', '-w', opts.workdir ?? BOX_WORKDIR]
  for (const key of Object.keys(opts.env ?? {})) argv.push('-e', key)
  argv.push(container, 'sh', '-c', command)
  return argv
}

/** Lettura file: il path è un argomento di cat, mai shell. */
export function dockerReadFileArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_MOUNT, container, 'cat', '--', path]
}

/**
 * Scrittura byte-exact e ATOMICA (§5.2 + fase 11 punto 1): la stringa
 * `sh -c` è COSTANTE — il path entra come argomento posizionale ($1) e il
 * contenuto arriva via stdin. La scrittura avviene su un file temporaneo
 * NELLA STESSA cartella e poi rinomina: un altro bot non legge mai un file
 * a metà (il rename è atomico).
 */
export const DOCKER_WRITE_SH = 'mkdir -p "$(dirname "$1")" && cat > "$1.sandbot-tmp" && mv -f "$1.sandbot-tmp" "$1"'

export function dockerWriteFileArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_MOUNT, container, 'sh', '-c', DOCKER_WRITE_SH, 'sh', path]
}

export function dockerListDirArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_MOUNT, container, 'ls', '-la', '--', path]
}

/** Esistenza per nome esatto: filtro con anchor regex, niente `| grep` su stringhe. */
export function dockerPsArgv(container: string): string[] {
  return ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${container}$`]
}

/** Esistenza di un volume per nome esatto (migrazione dai vecchi volumi). */
export function dockerVolumeLsArgv(volume: string): string[] {
  return ['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^/${volume}$`]
}

export function dockerStartArgv(container: string): string[] {
  return ['start', container]
}

/**
 * Hardening del container condiviso a creazione (§5.2 + punto 1): non-root,
 * cap-drop, no-new-privs, limiti CONDIVISI e configurabili (memoria 4g,
 * cpu 2, pids 1024 di default). Volume unico montato su /box.
 */
export function dockerBoxCreateArgv(container: string, volume: string, network: 'bridge' | 'none', limits: BoxLimits): string[] {
  return [
    'create',
    '--name', container,
    '--user', CONTAINER_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(limits.pids),
    '--memory', limits.memory,
    '--cpus', String(limits.cpus),
    '--network', network,
    '-v', `${volume}:${BOX_MOUNT}`,
    '-w', BOX_MOUNT,
    '-i',
    'ubuntu:24.04',
    'sleep', 'infinity'
  ]
}

/**
 * Init del volume alla prima creazione: il volume appena montato è di root,
 * ma il container gira non-root con --cap-drop ALL (root senza CAP_CHOWN non
 * può chownare). Un one-shot con la stessa immagine, root e senza hardening,
 * sistema la proprietà una volta sola.
 */
export function dockerBoxChownArgv(volume: string): string[] {
  return ['run', '--rm', '-v', `${volume}:${BOX_MOUNT}`, 'ubuntu:24.04', 'chown', '-R', CONTAINER_USER, BOX_MOUNT]
}

/**
 * Migrazione docker (punto 1): copia il contenuto del VECCHIO volume
 * `sandbot-<agentId>-box` nella home del bot dentro il box condiviso, con un
 * container one-shot. La stringa `sh -c` è COSTANTE (l'agentId viaggia come
 * $1); gli originali restano dove sono (la cancellazione la decide l'utente).
 */
export const DOCKER_BOX_MIGRATE_SH = 'mkdir -p "/box/home/$1" && cp -a /from/. "/box/home/$1/"'

export function dockerBoxMigrateArgv(oldVolume: string, agentId: string): string[] {
  return [
    'run', '--rm',
    '-v', `${oldVolume}:/from:ro`,
    '-v', `${BOX_VOLUME}:${BOX_MOUNT}`,
    'ubuntu:24.04', 'sh', '-c', DOCKER_BOX_MIGRATE_SH, 'sh', agentId
  ]
}

/** Marker della migrazione dentro il box (idempotenza): esistenza e scrittura. */
export const BOX_MIGRATION_MARKER = `${BOX_MOUNT}/.migrated-v1`

export function dockerBoxMarkerCheckArgv(): string[] {
  return ['run', '--rm', '-v', `${BOX_VOLUME}:${BOX_MOUNT}`, 'ubuntu:24.04', 'test', '-f', BOX_MIGRATION_MARKER]
}

export function dockerBoxMarkerWriteArgv(): string[] {
  return ['run', '--rm', '-v', `${BOX_VOLUME}:${BOX_MOUNT}`, 'ubuntu:24.04', 'touch', BOX_MIGRATION_MARKER]
}

// ---- fase 11 (punto 3): comandi in background con docker exec -d ----

/**
 * Il wrapper COSTANTE del comando in background (puro): il comando, il log,
 * l'exit code e il pid entrano come argomenti posizionali ($1..$4) — il
 * wrapper scrive il pid, riversa lo stdout/stderr sul log e poi l'exit code
 * negli stessi path usati dalla modalità host, dentro il box.
 */
export const DOCKER_BG_WRAPPER_SH = 'echo $$ > "$4"; "$1" > "$2" 2>&1; echo $? > "$3"'

export function dockerExecBackgroundArgv(
  container: string,
  command: string,
  opts: DockerExecOptions,
  paths: { log: string; exit: string; pid: string }
): string[] {
  const argv = ['exec', '-d', '-w', opts.workdir ?? BOX_MOUNT]
  for (const key of Object.keys(opts.env ?? {})) argv.push('-e', key)
  argv.push(container, 'sh', '-c', DOCKER_BG_WRAPPER_SH, 'sh', command, paths.log, paths.exit, paths.pid)
  return argv
}

/** Kill di un processo nel container leggendo il pid dal file dentro il box. */
export const DOCKER_KILL_SH = 'kill "$(cat "$1")" 2>/dev/null'

export function dockerKillArgv(container: string, pidFile: string): string[] {
  return ['exec', container, 'sh', '-c', DOCKER_KILL_SH, 'sh', pidFile]
}

