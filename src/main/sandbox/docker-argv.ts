// Costruzione degli argv per la CLI docker — funzioni PURE (§5.2).
// Mai comandi docker assemblati come stringa e passati a una shell dell'host:
// ogni chiamata è spawn('docker', argv) con argv array. Path, comandi e opzioni
// restano singoli elementi argv: niente interpolazione, niente quoting da
// aggirare, niente escape possibile.
import { createHash } from 'node:crypto'

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

/**
 * `docker exec -i -w <home del bot> [-e …] <container> sh -c <command>` — il
 * comando del modello resta un unico elemento argv. Il default del `-w` è
 * BOX_MOUNT, che esiste SEMPRE (Q1, fase 14 correzioni 2: regola del modulo —
 * il workdir di un exec non è mai una cartella che può non esserci).
 */
export function dockerExecArgv(container: string, command: string, opts: DockerExecOptions = {}): string[] {
  const argv = ['exec', '-i', '-w', opts.workdir ?? BOX_MOUNT]
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
  /**
   * M4: il container ha il volume dei plugin montato /plugins:ro. false =
   * nato prima della correzione → ricreazione (solo il container, il volume
   * /box non si tocca MAI); undefined = inspect non riuscito → si tiene.
   */
  pluginsMountOk?: boolean
  /**
   * P2 (fase 14 correzioni): il container ha il volume del browser montato
   * /browser:rw. false = nato prima della correzione → ricreazione (solo il
   * container, i volumi non si toccano MAI); undefined = inspect non riuscito
   * → si tiene.
   */
  browserMountOk?: boolean
}

export type BoxEnsurePlan =
  | { kind: 'use' }
  | { kind: 'recreate'; reason: 'senza-init' | 'volume-di-root' | 'immagine-vecchia' | 'mount-plugin-mancante' | 'mount-browser-mancante' }
  | { kind: 'create' }

/**
 * H1 (puro): cosa fare del container del box. Non esiste → creazione (col
 * one-shot di init prima del create). Esiste senza --init (G2) → UNA
 * ricreazione. Esiste con init a posto → decide `test -w`: un volume
 * diventato di root (container nato prima di :nocopy) si riconquista con la
 * ricreazione, che ripassa dal one-shot di init (mkdir+chown) come oggi.
 * Punto 1: container nato con un'immagine DIVERSA (Dockerfile cambiato) →
 * stessa regola di G2/H1: si ricrea il SOLO container, il volume non si tocca.
 * M4: container nato SENZA il mount /plugins:ro (prima della correzione) →
 * stessa regola: si ricrea il SOLO container, il volume /box resta intatto.
 * P2 (fase 14 correzioni): container nato SENZA il mount /browser:rw (prima
 * della correzione) → stessa regola: si ricrea il SOLO container, i volumi
 * restano intatti (la ricreazione ripassa dal one-shot della radice di
 * /browser, che è idempotente).
 */
export function boxEnsurePlan(facts: BoxEnsureFacts): BoxEnsurePlan {
  if (!facts.exists) return { kind: 'create' }
  if (!facts.initOk) return { kind: 'recreate', reason: 'senza-init' }
  if (facts.imageOk === false) return { kind: 'recreate', reason: 'immagine-vecchia' }
  if (facts.pluginsMountOk === false) return { kind: 'recreate', reason: 'mount-plugin-mancante' }
  if (facts.browserMountOk === false) return { kind: 'recreate', reason: 'mount-browser-mancante' }
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
    error: `the box is not writable by the container user (${CONTAINER_USER}): docker exec ${BOX_CONTAINER} test -w ${BOX_MOUNT}/workspace failed — volume ${BOX_VOLUME} remains root's despite the init one-shot; the data inside was not touched`
  }
}

/**
 * Hardening del container condiviso a creazione (§5.2 + punto 1 + G2 + M4 +
 * P2 fase 14 correzioni): non-root, cap-drop, no-new-privs, limiti CONDIVISI e
 * configurabili (memoria 4g, cpu 2, pids 1024 di default). Volume unico montato
 * su /box. `--init` è tini di Docker (G2): PID 1 raccoglie i processi zombie —
 * con `sleep infinity` non lo farebbe, e gli zombie di un box a vita lunga
 * consumerebbero il tetto --pids-limit condiviso. H1: il volume è montato
 * `:nocopy` — alla prima mount di un volume VUOTO docker copia nel volume
 * contenuto E proprietà della cartella di destinazione dell'immagine, e `-w
 * /box` la fa nascere di root nel rootfs: il chown del one-shot verrebbe
 * sovrascritto e, non-root con --cap-drop ALL, nessuno scriverebbe più nulla
 * nel box. M4: il volume DEDICATO dei plugin è montato `/plugins:ro` — la sola
 * lettura la impone il KERNEL, non un chmod (che il bot, proprietario di
 * /box, potrebbe scavalcare riscrivendo workdir e codice dei server stdio).
 * P2: il volume DEDICATO del browser è montato `/browser` (rw) — TUTTO lo
 * stato del browser (profilo, output, pid) vive lì, di proprietà di 1001
 * (pwuser): la shell del bot (1000) non può né elencarlo né prepararne percorsi
 * in anticipo, e il cookie di sessione di un login non finisce in un file che
 * il bot può leggere.
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
    '-v', `${PLUGINS_VOLUME}:${PLUGINS_MOUNT}:ro`,
    '-v', `${BROWSER_VOLUME}:${BROWSER_MOUNT}`,
    '-w', BOX_MOUNT,
    '-i',
    image,
    'sleep', 'infinity'
  ]
}

// ---- M4: il volume DEDICATO dei plugin, in SOLA LETTURA dal kernel ----

/** Il volume persistente dei plugin di terzi (montato /plugins:ro nel box). */
export const PLUGINS_VOLUME = 'sandbot-plugins'

/** Punto di montaggio del volume dei plugin nel container del box. */
export const PLUGINS_MOUNT = '/plugins'

/** Il volume dei plugin si crea se manca (volume create è idempotente). */
export function dockerPluginsVolumeCreateArgv(): string[] {
  return ['volume', 'create', PLUGINS_VOLUME]
}

/**
 * Un path del box (`/plugins/…`) visto da un one-shot col volume montato in
 * `/p` (puro).
 */
export function pluginsContainerPath(boxPath: string): string {
  return `/p${boxPath.slice(PLUGINS_MOUNT.length)}`
}

/** M4: il contenitore usa-e-getta della copia, col volume dei plugin rw in /p. */
export function dockerPluginCopyCreateArgv(helper: string, image: string): string[] {
  return ['create', '--name', helper, '-v', `${PLUGINS_VOLUME}:/p`, image, 'true']
}

/** M4: mkdir del PADRE della copia come ROOT (docker cp crea il figlio, non il padre). */
export function dockerPluginsMkdirArgv(image: string, parentBoxPath: string): string[] {
  return ['run', '--rm', '-u', '0', '-v', `${PLUGINS_VOLUME}:/p`, image, 'mkdir', '-p', '--', pluginsContainerPath(parentBoxPath)]
}

/** M4: docker cp della cartella del plugin nel contenitore usa-e-getta (volume rw). */
export function dockerPluginCpArgv(localDir: string, helper: string, boxPath: string): string[] {
  return ['cp', localDir, `${helper}:${pluginsContainerPath(boxPath)}`]
}

/** M4: chown root:root ricorsivo della copia, come ROOT (docker cp conserva l'uid del Mac). */
export function dockerPluginsChownArgv(image: string, boxPath: string): string[] {
  return ['run', '--rm', '-u', '0', '-v', `${PLUGINS_VOLUME}:/p`, image, 'chown', '-R', '0:0', '--', pluginsContainerPath(boxPath)]
}

/** M4: sola lettura per TUTTI (a+rX, a-w) come ROOT: la impone il volume :ro vista dal box. */
export function dockerPluginsChmodArgv(image: string, boxPath: string): string[] {
  return ['run', '--rm', '-u', '0', '-v', `${PLUGINS_VOLUME}:/p`, image, 'chmod', '-R', 'a+rX,a-w', '--', pluginsContainerPath(boxPath)]
}

/** M4: il contenitore usa-e-getta si rimuove SEMPRE, anche dopo un errore. */
export function dockerPluginsRmHelperArgv(helper: string): string[] {
  return ['rm', '-f', helper]
}

/**
 * M4: i mount del container del box (inspect -f, argv puro). N1 (fase 13
 * correzioni 3): si legge `.Mounts`, la vista EFFETTIVA dei mount — un
 * container creato con `-v volume:/path` (come dockerBoxCreateArgv) NON
 * compare in `.HostConfig.Mounts` (che elenca solo i `--mount`: output
 * sempre vuoto → ricreazione a OGNI comando), mentre `.Mounts` vale per
 * `-v` e `--mount` indistintamente. Sul box vero l'output è
 * `/box:rw /browser:rw /plugins:ro ` in un ORDINE che dipende da Docker
 * (Binds: `sandbot-box:/box:nocopy`, `sandbot-plugins:/plugins:ro`,
 * `sandbot-browser:/browser`) — i controlli non assumono l'ordine.
 */
export function dockerBoxMountsArgv(container: string): string[] {
  return ['inspect', '-f', '{{range .Mounts}}{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}} {{end}}', container]
}

/**
 * M4 (puro): il container ha il volume dei plugin montato `/plugins` in
 * SOLA LETTURA? L'output di dockerBoxMountsArgv è `/box:rw /plugins:ro …`;
 * qualunque altra cosa (vuoto, errore) NON ricrea (come G2: la ricreazione è
 * ottimale, non vitale — un inspect fallito non deve fermare i bot).
 */
export function boxHasPluginsMountRo(inspectOutput: string): boolean {
  return inspectOutput.trim().split(/\s+/).includes(`${PLUGINS_MOUNT}:ro`)
}

/**
 * P2 (puro): il container ha il volume del browser montato `/browser` in
 * LETTURA/SCRITTURA? L'output di dockerBoxMountsArgv è `/box:rw /browser:rw
 * /plugins:ro ` e l'ORDINE delle voci dipende da Docker: il controllo non lo
 * assume. Qualunque altra cosa (vuoto, errore) NON ricrea (come M4/G2).
 */
export function boxHasBrowserMountRw(inspectOutput: string): boolean {
  return inspectOutput.trim().split(/\s+/).includes(`${BROWSER_MOUNT}:rw`)
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
 * P2 (fase 14 correzioni): il kill degli orfani del browser passa `user`
 * 1001:1001 — il server MCP del browser è di pwuser, e un kill come 1000
 * riceverebbe EPERM lasciando l'orfano col SingletonLock del profilo.
 */
export type DockerKillSignal = 'TERM' | 'KILL' | '0'

export function dockerKillGroupArgv(container: string, pgid: number, signal: DockerKillSignal, user: string = CONTAINER_USER): string[] {
  return ['exec', '-u', user, container, 'kill', `-${signal}`, '--', `-${pgid}`]
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

/**
 * Fase 13 (punto 2): l'argv del server MCP stdio di registro/plugin NEL BOX
 * (puro) — come il launcher del browser ma SENZA wrapper né setsid (lezione
 * I2: il processo di docker exec è già leader di sessione). Il comando è
 * `npx -y <identifier>@<version>` con la versione FISSATA a quella del
 * registro; le variabili d'ambiente passano come `-e NOME` col SOLO nome: il
 * valore viaggia nell'ambiente del processo figlio del client docker, MAI in
 * argv (regola dei segreti). L'aggiunta di fase 13 correzioni: anche
 * `-e HOME=<home del bot>` come execDocker — il valore non è un segreto e
 * senza HOME la cache di npx finisce nella home di sistema dell'utente 1000.
 */
export function dockerStdioMcpArgv(opts: { workdir: string; command: string; args?: string[]; envKeys?: string[]; home?: string }): string[] {
  const argv = ['exec', '-i', '-u', CONTAINER_USER, '-w', opts.workdir, '-e', `HOME=${opts.home ?? opts.workdir}`]
  for (const key of opts.envKeys ?? []) argv.push('-e', key)
  argv.push(BOX_CONTAINER, opts.command, ...(opts.args ?? []))
  return argv
}

/**
 * Fase 13 (punto 4) + M4: rimozione della NOSTRA copia del plugin alla
 * disinstallazione. I path NUOVI (`/plugins/…`) passano dal one-shot ROOT sul
 * volume dei plugin (il box lo ha montato :ro, non può cancellarceli da
 * solo); i path VECCHI (`/box/plugins/…`, record di prima della correzione)
 * restano sull'exec nel box rw — argv PURO sul path esatto in entrambi i
 * casi (mai volumi interi, mai dati utente).
 */
export function dockerRmDirArgv(boxPath: string, image: string): string[] {
  if (boxPath.startsWith(`${PLUGINS_MOUNT}/`)) {
    return ['run', '--rm', '-u', '0', '-v', `${PLUGINS_VOLUME}:/p`, image, 'rm', '-rf', '--', pluginsContainerPath(boxPath)]
  }
  return ['exec', BOX_CONTAINER, 'rm', '-rf', '--', boxPath]
}

// ---- fase 11b (punto 2) + fase 14 correzioni (P2): il browser del bot ----
//
// REGOLA DEL MODULO (P2): un one-shot di root non tocca MAI un percorso che
// il bot può scrivere. I one-shot di root (dockerBoxChownArgv, i helper dei
// plugin, dockerBrowserRootArgv) lavorano SOLO sulla radice di volumi interi
// o in contenitori usa-e-getta separati: chown -R / chmod -R / rm -rf di root
// su percorsi controllabili dal bot sarebbero attaccabili via symlink. Il box
// gira con --cap-drop ALL e no-new-privileges: root lì DENTRO non ha poteri,
// quindi nel container del box non c'è NESSUN exec di root.
//
// REGOLA DEL MODULO (Q1, fase 14 correzioni 2): il `-w` di un `docker exec` è
// SOLO un percorso che esiste SEMPRE — /box o /browser, i punti di mount —
// oppure una cartella che un passo PRECEDENTE ha già creato: la home del bot
// (dockerEnsureHomeArgv, H2) o la cartella di un plugin (l'installazione,
// fase 13). MAI una cartella che crea il processo stesso: l'OCI runtime fa
// chdir PRIMA di eseguire il comando, quindi un `-w` ancora inesistente
// fallisce con rc 127 (chdir to cwd … no such file or directory) prima che
// un mkdir del wrapper possa rimediare — è esattamente Q1: `-w
// /browser/<owner>`, dove /browser/<owner> lo crea il wrapper. Il test di
// guardia in docker-argv.test.ts scorre tutti gli argv esportati col `-w`.

/**
 * Chiusura per inattività: 10 minuti senza azioni, lato NOSTRO (il timer della
 * sessione). Fase 19a (V2): con lo schermo aperto la chiusura la decide il
 * daemon — il timer può essere SOSPESO (vista/controllo/presa di controllo in
 * corso, al massimo 30 minuti) — quindi il --idle-timeout del SERVER principale
 * sale a BROWSER_SERVER_IDLE_MS (rete di sicurezza); i FIGLI restano headless
 * con il tetto breve di qui.
 */
export const BROWSER_IDLE_MS = 10 * 60_000

/**
 * Fase 19a (V2): il --idle-timeout del server del browser PRINCIPALE, che con
 * il desktop ha la finestra aperta: 60 minuti di rete di sicurezza. La chiusura
 * vera la decide il timer nostro (sospeso mentre c'è una vista o un controllo).
 */
export const BROWSER_SERVER_IDLE_MS = 60 * 60_000

/** Al massimo 3 browser contemporanei per box (Chromium pesa e il box ha 4g). */
export const BROWSERS_PER_BOX_MAX = 3

/** Il volume persistente dello stato del browser (montato /browser rw nel box). */
export const BROWSER_VOLUME = 'sandbot-browser'

/** Punto di montaggio del volume del browser nel container del box. */
export const BROWSER_MOUNT = '/browser'

/** Il volume del browser si crea se manca (volume create è idempotente). */
export function dockerBrowserVolumeCreateArgv(): string[] {
  return ['volume', 'create', BROWSER_VOLUME]
}

/**
 * L'utente di TUTTI i processi del browser (P1+P2): pwuser, il non-root
 * 1001:1001 che l'immagine base Playwright prevede apposta per il browser
 * (il Dockerfile ne VERIFICA uid e gid a build time). La shell del bot resta
 * 1000 e NON vede niente di ciò che sta sotto /browser (0700 di 1001): nemmeno
 * il cookie di sessione di un login, e nemmeno le uscite del server MCP
 * (snapshot .yml con i campi compilati).
 */
export const BROWSER_USER = '1001:1001'

/** La cartella dello stato del browser di un proprietario: /browser/<owner>. */
export function browserStateDir(owner: string): string {
  return `${BROWSER_MOUNT}/${owner}`
}

/**
 * Il profilo del browser del PROPRIETARIO (principale): nel volume del
 * browser, MAI sotto /box/home — lo crea il wrapper stesso come 1001 con
 * mkdir -p (nessun root), e il bot (1000) non può né leggerlo né prepararlo.
 */
export function browserProfilePath(owner: string): string {
  return `${browserStateDir(owner)}/profile`
}

/**
 * Il one-shot ROOT della RADICE del volume del browser (P2), sul modello di
 * dockerBoxChownArgv: chown e chmod della SOLA radice /browser, stringa sh -c
 * COSTANTE, contenitore usa-e-getta separato (--rm), eseguito quando si crea
 * (o ricrea) il box — idempotente. Tutto ciò che sta sotto /browser lo crea
 * il wrapper del server come 1001: la regola del modulo (niente root su
 * percorsi del bot) resta intatta perché /browser NON è scrivibile dal bot.
 */
export const DOCKER_BROWSER_ROOT_SH = `chown ${BROWSER_USER} ${BROWSER_MOUNT} && chmod 0700 ${BROWSER_MOUNT}`

/** L'argv del one-shot della radice del volume del browser (P2). */
export function dockerBrowserRootArgv(image: string): string[] {
  return ['run', '--rm', '-v', `${BROWSER_VOLUME}:${BROWSER_MOUNT}`, image, 'sh', '-c', DOCKER_BROWSER_ROOT_SH]
}

/**
 * Il controllo del terreno del browser DOPO lo start, come 1001 (P2), sul
 * modello del controllo di scrivibilità di /box (H1): argv PURO, `test` con
 * `-a` (AND del test POSIX) dentro il container con l'utente GIUSTO — la
 * radice del volume è PROPRIETÀ di 1001 (-O) e scrivibile (-w).
 */
export function dockerBrowserWritableArgv(container: string): string[] {
  return ['exec', '-u', BROWSER_USER, container, 'test', '-O', BROWSER_MOUNT, '-a', '-w', BROWSER_MOUNT]
}

/**
 * La cancellazione del profilo VECCHIO (fase 14 7a) rimasto nella home del
 * bot dalle versioni precedenti (P2): file del BOT (1000), quindi via exec
 * come 1000 — nessun privilegio in gioco, nessun symlink da sfruttare, e un
 * rm di una cartella assente non costa nulla. Si esegue prima di ogni avvio
 * del browser PRINCIPALE: quel profilo non si migra, quei cookie li ha già
 * visti la shell del bot.
 */
export function dockerBrowserOldProfileRmArgv(container: string, owner: string): string[] {
  return ['exec', '-u', CONTAINER_USER, container, 'rm', '-rf', '--', `${boxHomePath(owner)}/.browser/profile`]
}

/**
 * Il pid file dell'istanza browser di un proprietario, nel volume del browser
 * (P2): per un FIGLIO il nome porta il suo id. È di 1001 e sta in 0700 di
 * 1001: la shell del bot NON può leggerlo né scriverlo (non può nemmeno
 * fingere un orfano da uccidere).
 */
export function browserPidFile(owner: string, child?: string): string {
  return `${browserStateDir(owner)}/${child ? `mcp-${child}.pid` : 'mcp.pid'}`
}

/**
 * Il wrapper COSTANTE del server browser (punto 2): il pid va nel file del
 * volume del browser (per uccidere gli orfani: se il daemon muore, il
 * processo nel container NON muore da solo), poi `exec playwright-mcp "$@"`.
 * NIENTE setsid (I2): il processo di docker exec è GIÀ leader di sessione e di
 * gruppo, setsid in quel caso forka e il padre esce subito CHIUDENDO lo stdio
 * del client MCP; il pid scritto è anche il pgid, quindi il kill di gruppo
 * (G1) resta valido. P2: gira come 1001 (pwuser) e la cartella del pid se la
 * crea LUI con mkdir -p — nessun root, nessun gruppo supplementare.
 * Q1 (fase 14 correzioni 2): il `-w` del exec è /browser (esiste sempre: è
 * il punto di mount); la cartella del proprietario la crea il wrapper STESSO
 * e poi ci ENTRA con cd — la cwd del server diventa /browser/<owner>, dove
 * finisce il `filename` RELATIVO dello screenshot, come assume
 * copyBrowserScreenshot. Se mkdir o cd falliscono il wrapper esce SUBITO
 * (`|| exit 1`): meglio un errore chiaro che un server vivo nella cartella
 * sbagliata (screenshot dispersi, pid file altrove).
 */
export const DOCKER_BROWSER_WRAPPER_SH = [
  'mkdir -p "$(dirname "$1")" && cd "$(dirname "$1")" || exit 1',
  'echo $$ >"$1"',
  'shift',
  'exec playwright-mcp "$@"'
].join('\n')

// ---- fase 19a (V2): il DESKTOP del bot — solo per il browser PRINCIPALE ----

/** Il socket VNC in sola lettura del desktop di un proprietario (fase 19a, V2.5). */
export function browserViewSocket(owner: string): string {
  return `${browserStateDir(owner)}/vnc-view.sock`
}

/** Il socket VNC di CONTROLLO del desktop di un proprietario (fase 19a, V3.1). */
export function browserControlSocket(owner: string): string {
  return `${browserStateDir(owner)}/vnc-control.sock`
}

/** Il pid file del x11vnc di controllo, nella cartella del proprietario (V3.1). */
export function browserControlPidFile(owner: string): string {
  return `${browserStateDir(owner)}/vnc-control.pid`
}

/**
 * Il wrapper COSTANTE del desktop del browser PRINCIPALE (fase 19a, V2) — i
 * FIGLI restano col wrapper headless di oggi. Gira come 1001 nella cartella del
 * proprietario e, in ordine: le righe di oggi (mkdir+cd con || exit 1, pid nel
 * file), il cookie MIT-MAGIC-COOKIE casuale di 32 hex VALIDO PER QUALUNQUE
 * display (trucco di xvfb-run: famiglia `ffff`, così non si può preparare un
 * display in anticipo cambiando numero), Xvfb SENZA listener tcp né unix
 * (resta solo il socket astratto di Linux: niente file in /tmp/.X11-unix che
 * la shell del bot potrebbe preparare o sostituire), l'attesa che il display
 * risponda (max 5 s), il visualizzatore x11vnc in SOLA LETTURA su socket unix
 * nella cartella 0700 di 1001 (nessuna porta TCP nel container: la shell del
 * bot, uid 1000 nello stesso namespace di rete, non può vedere né comandare
 * lo schermo), poi DISPLAY/XAUTHORITY ed exec playwright-mcp.
 * Xvfb e x11vnc restano nello STESSO gruppo di processi del wrapper: il kill
 * di gruppo di oggi (chiusura dopo inattività, orfani) li chiude insieme al
 * browser.
 */
export const DOCKER_BROWSER_DESKTOP_WRAPPER_SH = [
  'mkdir -p "$(dirname "$1")" && cd "$(dirname "$1")" || exit 1',
  'echo $$ >"$1"',
  'if command -v mcookie >/dev/null 2>&1; then cookie="$(mcookie)"; else cookie="$(od -An -N16 -tx1 /dev/urandom | tr -d \' \\n\')"; fi',
  'xauth -f ./Xauthority add ":0" . "$cookie" || exit 1',
  'xauth -f ./Xauthority nlist | sed -e \'s/^..../ffff/\' | xauth -f ./Xauthority nmerge -',
  'chmod 600 ./Xauthority',
  'Xvfb -displayfd 3 -auth ./Xauthority -nolisten tcp -nolisten unix -screen 0 1280x960x24 3>./display &',
  'ready=0; i=0',
  'while [ "$i" -lt 50 ]; do',
  '  if [ -s ./display ]; then',
  '    n=$(cat ./display)',
  '    case "$n" in \'\'|*[!0-9]*) ;; *)',
  '      if XAUTHORITY=./Xauthority xdpyinfo -display ":$n" >/dev/null 2>&1; then ready=1; break; fi',
  '    ;; esac',
  '  fi',
  '  i=$((i+1)); sleep 0.1',
  'done',
  '[ "$ready" = 1 ] || { echo "Xvfb did not start" >&2; exit 1; }',
  'n=$(cat ./display)',
  'x11vnc -display ":$n" -auth ./Xauthority -rfbport 0 -unixsockonly ./vnc-view.sock -viewonly -shared -forever -nopw -quiet &',
  'shift',
  'export DISPLAY=":$n"',
  'export XAUTHORITY="$PWD/Xauthority"',
  'exec playwright-mcp "$@"'
].join('\n')

/**
 * I flag del server Playwright MCP (puro): tutti quelli OBBLIGATORI e NESSUNO
 * dei vietati. --no-sandbox perché il container hardened non concede gli user
 * namespace (il confine è il container); --no-webmcp perché una pagina ostile
 * non può offrire tool al modello; --proxy-server è il confine di rete del
 * browser (punto 3); il profilo è persistente PER BOT (come in Grok);
 * --output-max-size è il tetto di spazio delle uscite del server nel box
 * condiviso (snapshot .yml e log di console a ogni azione, I8).
 * Fase 12 (0e): --config obbligatorio col file /etc/sandbot/playwright-mcp.json
 * del Dockerfile — spegne il traffico di fondo di Chromium (component update,
 * sync, telemetry): connessioni non richieste, rumore nel proxy e privacy.
 * P2 (fase 14 correzioni): TUTTI i browser — principale e FIGLI — girano come
 * 1001 con lo stato nel volume /browser/<owner> (profilo, output con anche le
 * uscite dei figli, pid): MAI un path del browser sotto /box/home, dove la
 * shell del bot potrebbe leggerlo (le uscite .yml contengono i campi compilati).
 * Il figlio resta --isolated (due Chromium sullo stesso profilo si bloccano).
 */
export function browserMcpFlags(agentId: string, proxyPort: number, opts: { child?: boolean; owner?: string } = {}): string[] {
  const owner = opts.owner ?? agentId
  return [
    // fase 19a (V2): il browser PRINCIPALE è HEADFUL sul suo display Xvfb (il
    // desktop del bot); solo i FIGLI restano --headless col wrapper di oggi
    ...(opts.child ? ['--headless'] : []),
    '--browser', 'chromium',
    '--no-sandbox',
    // fase 12 (punto 1): il figlio usa --isolated AL POSTO del profilo
    // persistente (due Chromium sullo stesso profilo si bloccano a vicenda)
    ...(opts.child ? ['--isolated'] : ['--user-data-dir', browserProfilePath(owner)]),
    '--output-dir', opts.child ? `${browserStateDir(owner)}/output-${agentId}` : `${browserStateDir(owner)}/output`,
    '--output-max-size', '52428800',
    '--no-webmcp',
    '--block-service-workers',
    '--proxy-server', `http://host.docker.internal:${proxyPort}`,
    '--timeout-navigation', '30000',
    '--viewport-size', '1280x800',
    '--image-responses', 'omit',
    // fase 19a (V2): col desktop aperto la chiusura la decide il daemon (il
    // timer nostro è SOSPESO con vista/controllo in corso): il server del
    // principale sale a 60 minuti di rete di sicurezza; i figli restano a 10
    '--idle-timeout', String(opts.child ? BROWSER_IDLE_MS : BROWSER_SERVER_IDLE_MS),
    '--config', PLAYWRIGHT_MCP_CONFIG
  ]
}

/** Flag VIETATI del server MCP (punto 2): mai accesso ai file senza limiti, mai CDP esterno, mai estensioni, mai devtools. */
export const BROWSER_MCP_FORBIDDEN_FLAGS = [
  '--allow-unrestricted-file-access', '--cdp-endpoint', '--extension', '--caps'
] as const

/**
 * Fase 12 (0e): il file di configurazione del server MCP creato dal Dockerfile
 * (di root, leggibile da tutti): launchOptions.args che spegne il traffico di
 * fondo di Chromium. Flag obbligatorio del launcher.
 */
export const PLAYWRIGHT_MCP_CONFIG = '/etc/sandbot/playwright-mcp.json'

/**
 * Le launchOptions del file (pure, per il test sul contenuto del Dockerfile).
 * Fase 15 (S9): in coda c'è `"--disable-blink-features="` — valore VUOTO,
 * nessuna funzione disattivata. Playwright MCP 0.0.83 aggiunge DA SÉ, nel suo
 * coreBundle, quel flag con valore "AutomationControlled" quando non ne trova
 * uno negli args:
 *
 *   if (browserName === "chromium") {
 *     browser.launchOptions.args = browser.launchOptions.args ?? [];
 *     if (!browser.launchOptions.args.some((a) => a.includes("--disable-blink-features")))
 *       browser.launchOptions.args.push(`--disable-blink-features=AutomationControlled`);
 *   }
 *
 * Quel valore nasconde ai siti l'automazione (navigator.webdriver): un agente
 * che agisce per conto dell'utente si presenta come browser automatizzato,
 * niente misure anti-rilevamento. Il controllo cerca SOLO la stringa
 * "--disable-blink-features": con il nostro arg vuoto la trova e non aggiunge
 * più AutomationControlled.
 */
export const PLAYWRIGHT_MCP_CONFIG_JSON =
  '{"browser":{"launchOptions":{"args":["--disable-background-networking","--disable-component-update","--disable-sync","--no-pings","--disable-domain-reliability","--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication","--disable-blink-features="]}}}'

/**
 * L'argv del launcher del browser di un bot (puro): `docker exec -i` col
 * wrapper COSTANTE (pid file come $1, assoluto in /browser/<owner>) e i flag
 * del server MCP. P2: il browser — PRINCIPALE e FIGLIO — gira come 1001:1001
 * (pwuser) e il bot non vede nulla del suo stato. Q1 (fase 14 correzioni 2):
 * `-w /browser` (BROWSER_MOUNT), NON /browser/<owner> — l'OCI runtime fa
 * chdir PRIMA di avviare il wrapper, e al primo avvio quella cartella non
 * esiste ancora (la crea il mkdir del wrapper): `-w /browser/<owner>` faceva
 * morire OGNI avvio con rc 127 e il daemon vedeva solo `MCP error -32000:
 * Connection closed`. Nella cartella del proprietario ci entra il wrapper
 * col cd.
 */
export function dockerBrowserMcpArgv(agentId: string, proxyPort: number, opts: { child?: boolean; owner?: string } = {}): string[] {
  const owner = opts.owner ?? agentId
  return [
    'exec', '-i',
    '-u', BROWSER_USER,
    '-w', BROWSER_MOUNT,
    BOX_CONTAINER,
    // fase 19a (V2): il PRINCIPALE parte col wrapper del DESKTOP (Xvfb +
    // x11vnc -viewonly, stesso gruppo di processi del server); i FIGLI restano
    // col wrapper headless di oggi
    'sh', '-c', opts.child ? DOCKER_BROWSER_WRAPPER_SH : DOCKER_BROWSER_DESKTOP_WRAPPER_SH, 'sh',
    browserPidFile(owner, opts.child === true ? agentId : undefined),
    ...browserMcpFlags(agentId, proxyPort, opts)
  ]
}

/**
 * Lettura di un file del volume del browser COME 1001 (P2): il pid file degli
 * orfani è di 1001 in una cartella 0700 di 1001 — la shell del bot (1000) non
 * può arrivarci, il daemon ci arriva col suo exec. Path come argomento di
 * cat, mai shell.
 */
export function dockerBrowserReadFileArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, '-w', BROWSER_MOUNT, container, 'cat', '--', path]
}

// ---- P2: la copia dello screenshot (volume privato → home del bot) ----

/**
 * Lettura dei byte di un file del volume del browser come base64 (P2): il
 * daemon legge COME 1001 (il file è suo) e i byte PNG attraversano il canale
 * stdout CODIFICATI — un `cat` nudo finirebbe in una stringa JS UTF-8 e i
 * byte binari si corromperebbero. `-w 0`: niente a capo ogni 76 colonne.
 */
export function dockerBrowserReadB64Argv(container: string, path: string): string[] {
  return ['exec', '-u', BROWSER_USER, container, 'base64', '-w', '0', '--', path]
}

/**
 * La scrittura atomica dei byte decodificati, COME 1000, nella home del bot
 * (P2): la STESSA forma di DOCKER_WRITE_SH (temporaneo nella STESSA cartella,
 * poi rename atomico) ma stdin è base64 che `base64 -d` decodifica — così il
 * PNG attraversa il canale testale senza corrompersi e il file finale è di
 * 1000, leggibile dal bot come prima.
 */
export const DOCKER_WRITE_B64_SH = 'mkdir -p "$(dirname "$1")" && base64 -d >"$1.sandbot-tmp" && mv -f "$1.sandbot-tmp" "$1"'

export function dockerBrowserWriteB64Argv(container: string, path: string): string[] {
  return ['exec', '-i', '-u', CONTAINER_USER, '-w', BOX_MOUNT, container, 'sh', '-c', DOCKER_WRITE_B64_SH, 'sh', path]
}

/** Cancellazione dell'originale nella copia dello screenshot, COME 1001 (P2). */
export function dockerBrowserRmFileArgv(container: string, path: string): string[] {
  return ['exec', '-u', BROWSER_USER, container, 'rm', '-f', '--', path]
}

// ---- fase 19a (V2-V6): il desktop del bot — x11vnc di controllo, xdotool, cattura ----

/**
 * Il secondo x11vnc, quello di CONTROLLO (senza -viewonly), avviato SOLO durante
 * la presa di controllo (V3.1) con docker exec -d come 1001 nella cartella del
 * proprietario. Il pid va nel file (per ucciderlo a fine controllo col kill di
 * gruppo): il processo di docker exec è già leader di sessione, quindi il pid
 * scritto è anche il pgid. Il display number viaggia come $1 (il file display
 * lo scrive il wrapper del desktop). Stessa forma di socket unix della vista:
 * NESSUNA porta TCP nel container.
 */
export const DOCKER_SCREEN_CONTROL_VNC_SH = [
  'echo $$ >./vnc-control.pid',
  'exec x11vnc -display ":$1" -auth ./Xauthority -rfbport 0 -unixsockonly ./vnc-control.sock -shared -forever -nopw -quiet'
].join('\n')

/** L'argv dell'avvio del x11vnc di controllo (V3.1), come 1001, via docker exec -d. */
export function dockerScreenControlVncArgv(owner: string, display: string): string[] {
  return [
    'exec', '-d',
    '-u', BROWSER_USER,
    '-w', browserStateDir(owner),
    BOX_CONTAINER,
    'sh', '-c', DOCKER_SCREEN_CONTROL_VNC_SH, 'sh',
    display
  ]
}

/** Il pid file del x11vnc di controllo è letto COME 1001 (path come argomento di cat). */
export function dockerScreenControlPidReadArgv(container: string, owner: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, '-w', BROWSER_MOUNT, container, 'cat', '--', browserControlPidFile(owner)]
}

/** Attesa di un socket unix del desktop: test -S COME 1001 (argv puro). */
export function dockerScreenSocketReadyArgv(container: string, socketPath: string): string[] {
  return ['exec', '-u', BROWSER_USER, container, 'test', '-S', '--', socketPath]
}

/** Lettura del numero di display scelto da -displayfd (file display del wrapper). */
export function dockerScreenDisplayReadArgv(container: string, owner: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, '-w', BROWSER_MOUNT, container, 'cat', '--', `${browserStateDir(owner)}/display`]
}

/**
 * Il PONTE del desktop (V3.2): script node COSTANTE di poche righe che collega
 * il socket unix dello schermo allo stdio del `docker exec -i` — net.connect +
 * pipe nei due sensi, exit alla chiusura. ARGV puri, nessuna shell; `<socket>`
 * viaggia come argv[1] dello script.
 */
export const SCREEN_BRIDGE_NODE_JS = [
  "const s = require('node:net').connect(process.argv[1]);",
  's.on(\'error\', () => process.exit(1));',
  's.on(\'close\', () => process.exit(0));',
  "s.on('connect', () => { process.stdin.pipe(s); s.pipe(process.stdout); });",
  "process.stdin.on('end', () => s.end());",
  "process.stdin.on('error', () => process.exit(1));"
].join('\n')

/**
 * L'argv del ponte (V3.2): docker exec -i COME 1001:1001, node -e <PONTE>
 * <socket>. Lo stdio del processo è il canale binario WebSocket ↔ socket unix
 * (vnc-view.sock o vnc-control.sock, secondo la capability).
 */
export function dockerScreenBridgeArgv(socketPath: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, BOX_CONTAINER, 'node', '-e', SCREEN_BRIDGE_NODE_JS, socketPath]
}

/**
 * Il comando di un'azione del computer use nel box (V6): xdotool con
 * DISPLAY/XAUTHORITY del desktop, argv PURI (nessuna shell). `args` è la coda
 * dell'argv DOPO xdotool, costruita da computerActionXdotoolArgs (pura).
 */
export function dockerXdotoolArgv(display: string, xauthority: string, args: string[]): string[] {
  return [
    'exec', '-u', BROWSER_USER,
    '-e', `DISPLAY=${display}`,
    '-e', `XAUTHORITY=${xauthority}`,
    BOX_CONTAINER,
    'xdotool', ...args
  ]
}

/**
 * La cattura dello schermo del bot (V6): `import -window root png:-` di
 * ImageMagick scrive su un file nella cartella di 1001 (il PNG binario nel
 * canale stdout di una stringa JS si corromperebbe: si legge poi in base64 con
 * dockerBrowserReadB64Argv e si cancella, come copyBrowserScreenshot).
 */
export function dockerScreenCaptureArgv(display: string, xauthority: string, owner: string, name: string): string[] {
  return [
    'exec', '-u', BROWSER_USER,
    '-e', `DISPLAY=${display}`,
    '-e', `XAUTHORITY=${xauthority}`,
    BOX_CONTAINER,
    'import', '-window', 'root', `png:${browserStateDir(owner)}/${name}`
  ]
}

/** La geometria dello schermo del bot (xdotool getdisplaygeometry → "1280 960"). */
export function dockerScreenGeometryArgv(display: string, xauthority: string): string[] {
  return [
    'exec', '-u', BROWSER_USER,
    '-e', `DISPLAY=${display}`,
    '-e', `XAUTHORITY=${xauthority}`,
    BOX_CONTAINER,
    'xdotool', 'getdisplaygeometry'
  ]
}

