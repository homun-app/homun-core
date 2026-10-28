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
  /**
   * Variabili per il container: le chiavi NON segrete (es. HOME del bot)
   * viaggiano col VALORE nell'argv (`-e KEY=VALORE` — il valore non è un
   * segreto); le chiavi SANDBOT_SECRET_* passano come `-e KEY` SENZA valore,
   * letto dall'ambiente del processo docker (F2: il client docker del Mac
   * continua a usare la SUA HOME per trovare ~/.docker).
   */
  env?: Record<string, string>
}

/** Una chiave env è un SEGRETO (valore solo nell'env del processo, mai in argv)? */
export function isSecretEnvKey(key: string): boolean {
  return key.startsWith('SANDBOT_SECRET_')
}

/**
 * L'env del processo docker sull'HOST (F2): quello del daemon + i SOLI
 * segreti. HOME del bot e le altre variabili non segrete non ci entrano più:
 * il client docker legge ~/.docker (contesti, socket di Docker Desktop,
 * Colima, OrbStack) dalla HOME del daemon, non dalla home del bot nel box.
 */
export function dockerClientEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => isSecretEnvKey(key)))
}

/** Aggiunge all'argv i `-e`: i segreti col solo NOME, le altre KEY=VALORE. */
function pushEnvArgv(argv: string[], env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    argv.push('-e', isSecretEnvKey(key) ? key : `${key}=${value}`)
  }
}

/** `docker exec -i -w <home del bot> [-e …] <container> sh -c <command>` — il comando del modello resta un unico elemento argv. */
export function dockerExecArgv(container: string, command: string, opts: DockerExecOptions = {}): string[] {
  const argv = ['exec', '-i', '-w', opts.workdir ?? BOX_WORKDIR]
  pushEnvArgv(argv, opts.env ?? {})
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

/** G2: l'init (tini) del container esistente — `inspect -f` stampa true/false, argv puro. */
export function dockerBoxInitCheckArgv(container: string): string[] {
  return ['inspect', '-f', '{{.HostConfig.Init}}', container]
}

/** G2: rimozione del SOLO container da ricreare (il volume non si tocca MAI). */
export function dockerBoxRmArgv(container: string): string[] {
  return ['rm', '-f', container]
}

/**
 * G2 (puro): il container esistente va RICREATO perché è nato senza --init?
 * L'output di dockerBoxInitCheckArgv è `true`/`false`; qualunque altra cosa
 * (vuoto, errore, testo inatteso) NON ricrea: si tiene il container che
 * funziona, la ricreazione è ottimale non vitale.
 */
export function boxNeedsRecreateForInit(inspectOutput: string): boolean {
  return inspectOutput.trim() === 'false'
}

/**
 * Hardening del container condiviso a creazione (§5.2 + punto 1 + G2):
 * non-root, cap-drop, no-new-privs, limiti CONDIVISI e configurabili (memoria
 * 4g, cpu 2, pids 1024 di default). Volume unico montato su /box. `--init` è
 * tini di Docker (G2): PID 1 raccoglie i processi zombie — con `sleep
 * infinity` non lo farebbe, e gli zombie di un box a vita lunga consumerebbero
 * il tetto --pids-limit condiviso.
 */
export function dockerBoxCreateArgv(container: string, volume: string, network: 'bridge' | 'none', limits: BoxLimits): string[] {
  return [
    'create',
    '--name', container,
    '--user', CONTAINER_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--init',
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
 * l'exit code e il pid entrano come argomenti posizionali ($1..$4). Il
 * comando gira con `sh -c "$1"` (un comando con spazi e && è un COMANDO, non
 * un nome di programma) dentro un GRUPPO DI PROCESSI suo: con setsid (c'è in
 * ubuntu:24.04) il pid scritto è quello del GRUPPO, così il kill termina
 * anche i figli (es. npm run build → node); senza setsid (macOS host) il
 * gruppo è quello del wrapper, che la modalità host avvia già detached. Il
 * wrapper crea la cartella dei file e scrive pid ed exit file LUI: la fine
 * del comando non dipende dal daemon (sopravvive al riavvio, F3).
 */
export const DOCKER_BG_WRAPPER_SH = [
  'mkdir -p "$(dirname "$2")"',
  'if command -v setsid >/dev/null 2>&1; then',
  '  setsid sh -c "$1" >"$2" 2>&1 &',
  '  cmd=$!',
  '  echo "$cmd" >"$4"',
  'else',
  '  sh -c "$1" >"$2" 2>&1 &',
  '  cmd=$!',
  '  echo "$$" >"$4"',
  'fi',
  'wait "$cmd"',
  'echo "$?" >"$3"'
].join('\n')

export function dockerExecBackgroundArgv(
  container: string,
  command: string,
  opts: DockerExecOptions,
  paths: { log: string; exit: string; pid: string }
): string[] {
  const argv = ['exec', '-d', '-w', opts.workdir ?? BOX_MOUNT]
  pushEnvArgv(argv, opts.env ?? {})
  argv.push(container, 'sh', '-c', DOCKER_BG_WRAPPER_SH, 'sh', command, paths.log, paths.exit, paths.pid)
  return argv
}

/**
 * Kill del GRUPPO di processi del comando nel container (F1 + G1): ARGV PURI,
 * niente `sh -c` — in ubuntu:24.04 /bin/sh è dash e il suo kill INTERNO non
 * accetta `--` (`sh: 1: kill: Illegal number: -`). Senza shell docker exec
 * esegue il /usr/bin/kill di procps, che lo accetta: il pid del file è il
 * pgid (setsid), l'operando negativo termina tutto il gruppo. '0' è il segnale
 * di sola ESISTENZA (il controllo dopo la grazia), TERM e KILL come in host.
 */
export type DockerKillSignal = 'TERM' | 'KILL' | '0'

export function dockerKillGroupArgv(container: string, pgid: number, signal: DockerKillSignal): string[] {
  return ['exec', container, 'kill', `-${signal}`, '--', `-${pgid}`]
}

/**
 * Dimensione di un file nel box (F6): argv PURO — il path del modello è un
 * argomento di stat, MAI una shell (`wc -c < "${path}"` eseguiva comandi
 * nascosti nel path prima della card).
 */
export function dockerStatSizeArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_MOUNT, container, 'stat', '-c', '%s', '--', path]
}

