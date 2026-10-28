// Costruzione degli argv per la CLI docker — funzioni PURE (§5.2).
// Mai comandi docker assemblati come stringa e passati a una shell dell'host:
// ogni chiamata è spawn('docker', argv) con argv array. Path, comandi e opzioni
// restano singoli elementi argv: niente interpolazione, niente quoting da
// aggirare, niente escape possibile.
import { createHash } from 'node:crypto'

export const BOX_WORKDIR = '/home/box'

/** Utente non-root del container (ubuntu:24.04 → uid/gid 1000). */
export const CONTAINER_USER = '1000:1000'

// ---- fase 11 (punto 1): il box CONDIVISO, un solo container per utente ----

/** Il container unico del box condiviso di tutti i bot. */
export const BOX_CONTAINER = 'sandbot-box'

/** Il volume persistente del box condiviso, montato su /box. */
export const BOX_VOLUME = 'sandbot-box'

/**
 * Fase 11b (0c + punto 1): l'immagine del box è NOSTRA, costruita dal
 * Dockerfile nel repo (base playwright ufficiale, Playwright MCP esatto): sul
 * Mac arm64 l'`ubuntu:24.04` di Docker è amd64 e il box girerebbe emulato.
 * Il tag deriva dal CONTENUTO del Dockerfile (primi 12 hex dello sha256): cambia
 * il Dockerfile, cambia il tag, il container si ricrea — mai tag "latest".
 */
export const BOX_IMAGE_REPO = 'sandbot-box'

/** Il tag dell'immagine del box dal contenuto del Dockerfile (PURO). */
export function boxImageTag(dockerfileContent: string): string {
  return `${BOX_IMAGE_REPO}:${createHash('sha256').update(dockerfileContent).digest('hex').slice(0, 12)}`
}

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

/**
 * H2: la home del bot DENTRO il container, prima di ogni exec. Il one-shot di
 * init crea /box/workspace e /box/home ma NON le home dei singoli bot, e gli
 * exec girano `-w /box/home/<agentId>`: senza home l'OCI runtime rifiuta il
 * chdir (rc 127) e il comando non parte. ARGV PURI: l'agentId è già validato
 * come id, mkdir -p è idempotente, nessuna shell.
 */
export function dockerEnsureHomeArgv(container: string, agentId: string): string[] {
  return ['exec', container, 'mkdir', '-p', boxHomePath(agentId)]
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
 * H1: controllo della scrivibilità del box dopo lo start — argv PURO, `test
 * -w` gira nel container CON l'utente del container: se fallisce, meglio un
 * errore chiaro qui che permessi negati sparsi a ogni write-file.
 */
export function dockerBoxWritableArgv(container: string): string[] {
  return ['exec', container, 'test', '-w', `${BOX_MOUNT}/workspace`]
}

export interface BoxEnsureFacts {
  exists: boolean
  /** l'inspect dell'init NON chiede la ricreazione (G2). */
  initOk: boolean
  /** esito di dockerBoxWritableArgv dopo lo start (H1); ignoto se initOk è falso. */
  writable?: boolean
  /**
   * fase 11b (punto 1): il container esistente è nato con l'immagine CORRENTE
   * (inspect -f {{.Config.Image}} = tag attuale). true = a posto; false =
   * immagine diversa → ricreazione; undefined = inspect non riuscito → si
   * tiene il container che funziona (come G2, la ricreazione è ottimale).
   */
  imageOk?: boolean
}

export type BoxEnsurePlan =
  | { kind: 'use' }
  | { kind: 'recreate'; reason: 'senza-init' | 'volume-di-root' | 'immagine-vecchia' }
  | { kind: 'create' }

/**
 * H1 (puro): cosa fare del container del box. Non esiste → creazione (col
 * one-shot di init prima del create). Esiste senza --init (G2) → UNA
 * ricreazione. Esiste con init a posto → decide `test -w`: un volume
 * diventato di root (container nato prima di :nocopy) si riconquista con la
 * ricreazione, che ripassa dal one-shot di init (mkdir+chown) come oggi.
 * Punto 1: container nato con un'immagine DIVERSA (Dockerfile cambiato) →
 * stessa regola di G2/H1: si ricrea il SOLO container, il volume non si tocca.
 */
export function boxEnsurePlan(facts: BoxEnsureFacts): BoxEnsurePlan {
  if (!facts.exists) return { kind: 'create' }
  if (!facts.initOk) return { kind: 'recreate', reason: 'senza-init' }
  if (facts.imageOk === false) return { kind: 'recreate', reason: 'immagine-vecchia' }
  return facts.writable ? { kind: 'use' } : { kind: 'recreate', reason: 'volume-di-root' }
}

/**
 * H1 (puro): esito del controllo `test -w` DOPO la (ri)creazione. Se il box
 * resta non scrivibile l'errore è CHIARO e non si riprova: la ricreazione è
 * UNA sola, i dati nel volume non sono stati toccati.
 */
export function boxCreateCheck(writable: boolean): { ok: true } | { ok: false; error: string } {
  if (writable) return { ok: true }
  return {
    ok: false,
    error: `il box non è scrivibile dall'utente del container (${CONTAINER_USER}): docker exec ${BOX_CONTAINER} test -w ${BOX_MOUNT}/workspace è fallito — il volume ${BOX_VOLUME} resta di root nonostante il one-shot di init; i dati dentro non sono stati toccati`
  }
}

/**
 * Hardening del container condiviso a creazione (§5.2 + punto 1 + G2):
 * non-root, cap-drop, no-new-privs, limiti CONDIVISI e configurabili (memoria
 * 4g, cpu 2, pids 1024 di default). Volume unico montato su /box. `--init` è
 * tini di Docker (G2): PID 1 raccoglie i processi zombie — con `sleep
 * infinity` non lo farebbe, e gli zombie di un box a vita lunga consumerebbero
 * il tetto --pids-limit condiviso. H1: il volume è montato `:nocopy` — alla
 * prima mount di un volume VUOTO docker copia nel volume contenuto E
 * proprietà della cartella di destinazione dell'immagine, e `-w /box` la fa
 * nascere di root nel rootfs: il chown del one-shot verrebbe sovrascritto e,
 * non-root con --cap-drop ALL, nessuno scriverebbe più nulla nel box.
 */
export function dockerBoxCreateArgv(container: string, volume: string, network: 'bridge' | 'none', limits: BoxLimits, image: string): string[] {
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
    '-v', `${volume}:${BOX_MOUNT}:nocopy`,
    '-w', BOX_MOUNT,
    '-i',
    image,
    'sleep', 'infinity'
  ]
}

/**
 * Init del volume alla prima creazione: il volume appena montato è di root,
 * ma il container gira non-root con --cap-drop ALL (root senza CAP_CHOWN non
 * può chownare). Un one-shot con la stessa immagine, root e senza hardening,
 * sistema la proprietà una volta sola. H1: la stringa `sh -c` è COSTANTE e
 * crea workspace e home PRIMA del chown — il volume non è più VUOTO e il
 * copy-up di docker non ha più niente da sovrascrivere alla prima mount
 * (il create monta comunque :nocopy: due difese indipendenti).
 */
export const DOCKER_BOX_INIT_SH = `mkdir -p ${BOX_MOUNT}/workspace ${BOX_MOUNT}/home && chown -R ${CONTAINER_USER} ${BOX_MOUNT}`

export function dockerBoxChownArgv(volume: string, image: string): string[] {
  return ['run', '--rm', '-v', `${volume}:${BOX_MOUNT}`, image, 'sh', '-c', DOCKER_BOX_INIT_SH]
}

/**
 * Migrazione docker (punto 1): copia il contenuto del VECCHIO volume
 * `sandbot-<agentId>-box` nella home del bot dentro il box condiviso, con un
 * container one-shot. La stringa `sh -c` è COSTANTE (l'agentId viaggia come
 * $1); gli originali restano dove sono (la cancellazione la decide l'utente).
 * H1: il one-shot gira COME ROOT e non usa -w /box — senza il chown finale
 * la home del bot appena creata (e la copia) resterebbero di root e il bot
 * non potrebbe scriverci. Il marker toccato da root nella radice va bene,
 * la home e il workspace no.
 */
export const DOCKER_BOX_MIGRATE_SH = `mkdir -p "${BOX_MOUNT}/home/$1" && cp -a /from/. "${BOX_MOUNT}/home/$1/" && chown -R ${CONTAINER_USER} "${BOX_MOUNT}/home/$1"`

export function dockerBoxMigrateArgv(oldVolume: string, agentId: string, image: string): string[] {
  return [
    'run', '--rm',
    '-v', `${oldVolume}:/from:ro`,
    '-v', `${BOX_VOLUME}:${BOX_MOUNT}`,
    image, 'sh', '-c', DOCKER_BOX_MIGRATE_SH, 'sh', agentId
  ]
}

/** Marker della migrazione dentro il box (idempotenza): esistenza e scrittura. */
export const BOX_MIGRATION_MARKER = `${BOX_MOUNT}/.migrated-v1`

export function dockerBoxMarkerCheckArgv(image: string): string[] {
  return ['run', '--rm', '-v', `${BOX_VOLUME}:${BOX_MOUNT}`, image, 'test', '-f', BOX_MIGRATION_MARKER]
}

export function dockerBoxMarkerWriteArgv(image: string): string[] {
  return ['run', '--rm', '-v', `${BOX_VOLUME}:${BOX_MOUNT}`, image, 'touch', BOX_MIGRATION_MARKER]
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

// ---- fase 11b (punto 1): l'immagine NOSTRA del box, costruita da noi ----

/** Timeout della build dell'immagine del box (base playwright + Chromium). */
export const BOX_IMAGE_BUILD_TIMEOUT_MS = 20 * 60_000

/** Esistenza dell'immagine del box per tag esatto. */
export function dockerImageInspectArgv(tag: string): string[] {
  return ['image', 'inspect', tag]
}

/** Con quale immagine è nato il container esistente (inspect -f, argv puro). */
export function dockerContainerImageArgv(container: string): string[] {
  return ['inspect', '-f', '{{.Config.Image}}', container]
}

/**
 * La build dell'immagine del box (punto 1): argv PURO, niente --platform —
 * la build è NATIVA per l'host (arm64 sul Mac arm64). Il contesto è la
 * cartella del Dockerfile (nessuna COPY serve: tutto arriva dalla base).
 */
export function dockerBuildArgv(tag: string, dockerfilePath: string, contextDir: string): string[] {
  return ['build', '-t', tag, '-f', dockerfilePath, contextDir]
}

