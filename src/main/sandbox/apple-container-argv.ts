// Fase box-container (BX1/BX2): gli argv della CLI Apple `container` —
// funzioni PURE, come docker-argv per Docker. Il manuale dei comandi (v1.7,
// docs/command-reference.md) è quasi uno a uno con Docker: `run` con --rm -d
// --name -v -p -e -c -m -u -w --read-only --tmpfs --shm-size; `exec` con -i
// -t -u -w -e -d; cp, build, inspect, delete/rm, start, stop, ls; volume
// create/ls/delete/prune; network create --internal; system start/stop/status,
// system df --format json, image prune/delete, prune.
//
// Le DIFFERENZE contano (BX2): niente --cap-drop né --security-opt né --init
// né --pids-limit — il confine è la macchina virtuale leggera di OGNI
// container, più forte di un container Docker che condivide il kernel della
// VM di Docker Desktop. La rete è una network DEDICATA --internal (host-only):
// il box parla solo col Mac; il browser esce SOLO dal proxy che gira sul Mac,
// raggiunto al gateway della rete (niente host.docker.internal).
//
// Gli script COSTANTI (wrapper del browser, del terminale, init dei volumi)
// sono quelli di docker-argv: dentro il box gira Linux uguale.
import {
  CONTAINER_USER,
  BROWSER_USER,
  BOX_MOUNT,
  PLUGINS_VOLUME,
  PLUGINS_MOUNT,
  BROWSER_VOLUME,
  BROWSER_MOUNT,
  boxHomePath,
  browserStateDir,
  browserPidFile,
  browserProfilePath,
  DOCKER_WRITE_SH,
  DOCKER_WRITE_B64_SH,
  DOCKER_BG_WRAPPER_SH,
  DOCKER_BROWSER_WRAPPER_SH,
  DOCKER_BROWSER_DESKTOP_WRAPPER_SH,
  DOCKER_SCREEN_CONTROL_VNC_SH,
  SCREEN_BRIDGE_NODE_JS,
  TERMINAL_PROGRAM_PY,
  DOCKER_BOX_INIT_SH,
  DOCKER_BOX_MIGRATE_SH,
  BOX_MIGRATION_MARKER,
  browserMcpFlags,
  FIND_LIST_PRINTF,
  terminalPidDir,
  type BoxLimits,
  type DockerExecOptions,
  type DockerKillSignal
} from './docker-argv'

/** BX2: la rete DEDICATA del box, --internal (host-only: solo il Mac). */
export const APPLE_BOX_NETWORK = 'homun-box'

/** BX1.4: l'accensione del servizio MAI scarica il kernel di nascosto. */
export function appleSystemStartArgv(): string[] {
  return ['system', 'start', '--disable-kernel-install']
}

/** BX1.4: il kernel raccomandato si installa SOLO dopo il consenso esplicito. */
export function appleKernelSetRecommendedArgv(): string[] {
  return ['system', 'kernel', 'set', '--recommended']
}

/** La versione della CLI (sonda: risponde → installata). */
export function appleVersionArgv(): string[] {
  return ['--version']
}

/** Lo stato del servizio (sonda: running? kernel?). */
export function appleSystemStatusArgv(): string[] {
  return ['system', 'status']
}

/**
 * Il parse dell'output di `system status` (PURO). Il formato esatto della CLI
 * vera è tra le cose «da verificare dal vivo»: si accettano righe `running:
 * true` (anche JSON `"running": true` / `"status": "running"`) e, se il
 * kernel è nominato, le parole missing/not installed dicono che MANCA; il
 * kernel non nominato → ok (un servizio a posto non ne parla).
 */
export function parseSystemStatus(stdout: string): { running: boolean; kernelOk: boolean } {
  const s = stdout.toLowerCase()
  const running = /"?running"?\s*[:=]\s*"?(true|running)"?/.test(s)
  const kernelMissing = /kernel/.test(s) && /(missing|not installed|not found|absent|none)/.test(s)
  return { running, kernelOk: !kernelMissing }
}

/** BX2: la rete interna del box si crea se manca (l'inspect lo dice). */
export function appleNetworkCreateArgv(): string[] {
  return ['network', 'create', '--internal', APPLE_BOX_NETWORK]
}

/** BX2: l'inspect della rete, da cui si legge il GATEWAY (il Mac per il box). */
export function appleNetworkInspectArgv(): string[] {
  return ['network', 'inspect', APPLE_BOX_NETWORK]
}

/**
 * Il gateway della rete dal suo inspect (PURO): JSON con subnet 192.0.x.y/24
 * e gateway 192.0.x.1 (il formato di container), oppure righe
 * `gateway: <ip>`. Il primo IPv4 del campo gateway.
 */
export function parseNetworkGateway(stdout: string): string | null {
  const m = /"gateway"\s*:\s*"([0-9.]+)"/.exec(stdout) ?? /gateway[=:]\s*([0-9.]+)/i.exec(stdout)
  return m && /^\d+\.\d+\.\d+\.\d+$/.test(m[1]!) ? m[1]! : null
}

/**
 * BX2: i flag del browser del bot col proxy al GATEWAY della rete interna
 * invece di host.docker.internal (PURO: la sostituzione tocca SOLO il valore
 * di --proxy-server, gli altri flag restano identici e nello stesso ordine).
 */
export function browserMcpFlagsWithGateway(agentId: string, proxyPort: number, gateway: string, opts: { child?: boolean; owner?: string } = {}): string[] {
  return browserMcpFlags(agentId, proxyPort, opts).map((f) =>
    f.startsWith('http://host.docker.internal:') ? `http://${gateway}:${proxyPort}` : f
  )
}

// ---- il contenitore del box ----

/** L'elenco dei container (un nome per riga, -a anche i fermi: come ps -a). */
export function applePsArgv(): string[] {
  return ['ls', '-a', '--format', '{{.name}}']
}

export function appleStartArgv(container: string): string[] {
  return ['start', container]
}

export function appleStopArgv(container: string): string[] {
  return ['stop', container]
}

/**
 * La creazione del box (BX2): `run -d` — la CLI di Apple non separa create e
 * start come Docker. UTENTE non root (1000:1000, come CONTAINER_USER), limiti
 * --memory/--cpus (pids NON esiste nella CLI di Apple: il confine dei
 * processi è la VM del container — annotato nel REPORT), i TRE volumi di
 * oggi (box rw, plugin RO dal kernel, browser rw), la RETE dedicata interna.
 * Niente --cap-drop/--security-opt: non esistono; il confine è la VM.
 */
export function appleBoxRunArgv(container: string, volume: string, network: 'bridge' | 'none', limits: BoxLimits, image: string): string[] {
  return [
    'run', '-d',
    '--name', container,
    '-u', CONTAINER_USER,
    '-m', limits.memory,
    '-c', String(limits.cpus),
    ...(network === 'bridge' ? ['--network', APPLE_BOX_NETWORK] : []),
    '-v', `${volume}:${BOX_MOUNT}`,
    '-v', `${PLUGINS_VOLUME}:${PLUGINS_MOUNT}:ro`,
    '-v', `${BROWSER_VOLUME}:${BROWSER_MOUNT}`,
    '-w', BOX_MOUNT,
    image,
    'sleep', 'infinity'
  ]
}

export function appleBoxRmArgv(container: string): string[] {
  return ['rm', '-f', container]
}

/** La creazione di ALWAYS: ogni container Apple ha l'init suo nella VM. */
export function appleBoxInitCheckArgv(container: string): string[] {
  return ['inspect', '--format', '{{.running}}', container]
}

export function appleBoxMountsArgv(container: string): string[] {
  return ['inspect', '--format', `{{range .mounts}}{{.destination}}:{{if .readOnly}}ro{{else}}rw{{end}} {{end}}`, container]
}

export function appleBoxWritableArgv(container: string): string[] {
  return ['exec', container, 'test', '-w', `${BOX_MOUNT}/workspace`]
}

export function appleContainerImageArgv(container: string): string[] {
  return ['inspect', '--format', '{{.image}}', container]
}

export function appleEnsureHomeArgv(container: string, agentId: string): string[] {
  return ['exec', container, 'mkdir', '-p', boxHomePath(agentId)]
}

export function appleImageInspectArgv(tag: string): string[] {
  return ['image', 'inspect', tag]
}

/** La dimensione in byte della NOSTRA immagine (BX3; formato da verificare dal vivo). */
export function appleImageSizeArgv(tag: string): string[] {
  return ['image', 'inspect', '--format', '{{.size}}', tag]
}

export function appleBuildArgv(tag: string, dockerfilePath: string, contextDir: string): string[] {
  return ['build', '-t', tag, '-f', dockerfilePath, contextDir]
}

export function appleVolumeLsArgv(volume: string): string[] {
  return ['volume', 'ls', '--format', '{{.name}}', '--filter', `name=^/${volume}$`]
}

// ---- exec (stessa forma di Docker: il manuale dichiara -i -u -w -e -d) ----

/** L'env nell'argv: stessa regola dei segreti di Docker (solo il NOME). */
function pushEnvArgv(argv: string[], env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    argv.push('-e', key.startsWith('SANDBOT_SECRET_') ? key : `${key}=${value}`)
  }
}

export function appleExecArgv(container: string, command: string, opts: DockerExecOptions = {}): string[] {
  const argv = ['exec', '-i', '-w', opts.workdir ?? BOX_MOUNT]
  pushEnvArgv(argv, opts.env ?? {})
  argv.push(container, 'sh', '-c', command)
  return argv
}

export function appleExecBackgroundArgv(
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

export function appleKillGroupArgv(container: string, pgid: number, signal: DockerKillSignal, user: string = CONTAINER_USER): string[] {
  return ['exec', '-u', user, container, 'kill', `-${signal}`, '--', `-${pgid}`]
}

export function appleStatSizeArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_MOUNT, container, 'stat', '-c', '%s', '--', path]
}

export function appleStdioMcpArgv(opts: { workdir: string; command: string; args?: string[]; envKeys?: string[]; home?: string }, container: string): string[] {
  const argv = ['exec', '-i', '-u', CONTAINER_USER, '-w', opts.workdir, '-e', `HOME=${opts.home ?? opts.workdir}`]
  for (const key of opts.envKeys ?? []) argv.push('-e', key)
  argv.push(container, opts.command, ...(opts.args ?? []))
  return argv
}

// ---- file del box: stessa forma di Docker (sh -c COSTANTI, argv posizionali) ----

export function appleReadFileArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_MOUNT, container, 'cat', '--', path]
}

export function appleWriteFileArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_MOUNT, container, 'sh', '-c', DOCKER_WRITE_SH, 'sh', path]
}

export function appleListDirArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_MOUNT, container, 'ls', '-la', '--', path]
}

export function appleRealpathArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-u', CONTAINER_USER, '-w', BOX_MOUNT, container, 'realpath', '-e', '--', path]
}

export function appleFindListArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-u', CONTAINER_USER, '-w', BOX_MOUNT, container, 'find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', FIND_LIST_PRINTF]
}

export function appleReadB64Argv(container: string, path: string): string[] {
  return ['exec', '-i', '-u', CONTAINER_USER, container, 'base64', '-w', '0', '--', path]
}

export function appleWriteB64Argv(container: string, path: string): string[] {
  return ['exec', '-i', '-u', CONTAINER_USER, '-w', BOX_MOUNT, container, 'sh', '-c', DOCKER_WRITE_B64_SH, 'sh', path]
}

export function appleTestPathArgv(container: string, flag: '-f' | '-e' | '-d', path: string): string[] {
  return ['exec', '-u', CONTAINER_USER, container, 'test', flag, path]
}

/** La rimozione di una cartella: plugin → one-shot ROOT sul volume; box → exec. */
export function appleRmDirArgv(boxPath: string, image: string, container: string): string[] {
  if (boxPath.startsWith(`${PLUGINS_MOUNT}/`)) {
    return ['run', '--rm', '-u', '0', '-v', `${PLUGINS_VOLUME}:/p`, image, 'rm', '-rf', '--', `/p${boxPath.slice(PLUGINS_MOUNT.length)}`]
  }
  return ['exec', container, 'rm', '-rf', '--', boxPath]
}

/** cp box → Mac (stessa forma di Docker). */
export function appleCpFromBoxArgv(container: string, boxPath: string, macPath: string): string[] {
  return ['cp', `${container}:${boxPath}`, macPath]
}

// ---- volumi dedicati e plugin ----

export function applePluginsVolumeCreateArgv(): string[] {
  return ['volume', 'create', PLUGINS_VOLUME]
}

export function applePluginCopyCreateArgv(helper: string, image: string): string[] {
  return ['run', '--name', helper, '-v', `${PLUGINS_VOLUME}:/p`, image, 'true']
}

export function applePluginsMkdirArgv(image: string, parentBoxPath: string): string[] {
  return ['run', '--rm', '-u', '0', '-v', `${PLUGINS_VOLUME}:/p`, image, 'mkdir', '-p', '--', `/p${parentBoxPath.slice(PLUGINS_MOUNT.length)}`]
}

export function applePluginCpArgv(localDir: string, helper: string, boxPath: string): string[] {
  return ['cp', localDir, `${helper}:/p${boxPath.slice(PLUGINS_MOUNT.length)}`]
}

export function applePluginsChownArgv(image: string, boxPath: string): string[] {
  return ['run', '--rm', '-u', '0', '-v', `${PLUGINS_VOLUME}:/p`, image, 'chown', '-R', '0:0', '--', `/p${boxPath.slice(PLUGINS_MOUNT.length)}`]
}

export function applePluginsChmodArgv(image: string, boxPath: string): string[] {
  return ['run', '--rm', '-u', '0', '-v', `${PLUGINS_VOLUME}:/p`, image, 'chmod', '-R', 'a+rX,a-w', '--', `/p${boxPath.slice(PLUGINS_MOUNT.length)}`]
}

export function applePluginsRmHelperArgv(helper: string): string[] {
  return ['rm', '-f', helper]
}

// ---- il browser del bot (wrapper e flag di Docker; il proxy al GATEWAY) ----

export function appleBrowserVolumeCreateArgv(): string[] {
  return ['volume', 'create', BROWSER_VOLUME]
}

export function appleBrowserRootArgv(image: string, browserRootSh: string): string[] {
  return ['run', '--rm', '-v', `${BROWSER_VOLUME}:${BROWSER_MOUNT}`, image, 'sh', '-c', browserRootSh]
}

export function appleBrowserWritableArgv(container: string): string[] {
  return ['exec', '-u', BROWSER_USER, container, 'test', '-O', BROWSER_MOUNT, '-a', '-w', BROWSER_MOUNT]
}

export function appleBrowserOldProfileRmArgv(container: string, owner: string): string[] {
  return ['exec', '-u', CONTAINER_USER, container, 'rm', '-rf', '--', `${boxHomePath(owner)}/.browser/profile`]
}

/**
 * Il launcher del server MCP del browser (BX2): gli STESSI wrapper e flag di
 * Docker (le stringhe COSTANTI), come 1001 nel volume /browser, col proxy al
 * GATEWAY della rete interna al posto di host.docker.internal.
 */
export function appleBrowserMcpArgv(agentId: string, proxyPort: number, opts: { child?: boolean; owner?: string; gateway?: string }, container: string): string[] {
  const owner = opts.owner ?? agentId
  const flags = opts.gateway
    ? browserMcpFlagsWithGateway(agentId, proxyPort, opts.gateway, opts)
    : browserMcpFlags(agentId, proxyPort, opts)
  return [
    'exec', '-i',
    '-u', BROWSER_USER,
    '-w', BROWSER_MOUNT,
    container,
    'sh', '-c', opts.child ? DOCKER_BROWSER_WRAPPER_SH : DOCKER_BROWSER_DESKTOP_WRAPPER_SH, 'sh',
    browserPidFile(owner, opts.child === true ? agentId : undefined),
    ...flags
  ]
}

export function appleBrowserReadFileArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, '-w', BROWSER_MOUNT, container, 'cat', '--', path]
}

export function appleBrowserReadB64Argv(container: string, path: string): string[] {
  return ['exec', '-u', BROWSER_USER, container, 'base64', '-w', '0', '--', path]
}

export function appleBrowserRmFileArgv(container: string, path: string): string[] {
  return ['exec', '-u', BROWSER_USER, container, 'rm', '-f', '--', path]
}

// ---- desktop/schermo (X11 uguale: dentro la VM del container gira Linux) ----

export function appleScreenControlVncArgv(container: string, owner: string, display: string): string[] {
  return ['exec', '-d', '-u', BROWSER_USER, '-w', browserStateDir(owner), container, 'sh', '-c', DOCKER_SCREEN_CONTROL_VNC_SH, 'sh', display]
}

export function appleScreenControlPidReadArgv(container: string, owner: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, '-w', BROWSER_MOUNT, container, 'cat', '--', `${browserStateDir(owner)}/vnc-control.pid`]
}

export function appleScreenSocketReadyArgv(container: string, socketPath: string): string[] {
  return ['exec', '-u', BROWSER_USER, container, 'test', '-S', socketPath]
}

export function appleScreenDisplayReadArgv(container: string, owner: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, '-w', BROWSER_MOUNT, container, 'cat', '--', `${browserStateDir(owner)}/display`]
}

export function appleScreenBridgeArgv(socketPath: string, container: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, container, 'node', '-e', SCREEN_BRIDGE_NODE_JS, socketPath]
}

export function appleXdotoolArgv(container: string, display: string, xauthority: string, args: string[]): string[] {
  return ['exec', '-u', BROWSER_USER, '-e', `DISPLAY=${display}`, '-e', `XAUTHORITY=${xauthority}`, container, 'xdotool', ...args]
}

export function appleScreenCaptureArgv(container: string, display: string, xauthority: string, owner: string, name: string): string[] {
  return ['exec', '-u', BROWSER_USER, '-e', `DISPLAY=${display}`, '-e', `XAUTHORITY=${xauthority}`, container, 'import', '-window', 'root', `png:${browserStateDir(owner)}/${name}`]
}

export function appleScreenGeometryArgv(container: string, display: string, xauthority: string): string[] {
  return ['exec', '-u', BROWSER_USER, '-e', `DISPLAY=${display}`, '-e', `XAUTHORITY=${xauthority}`, container, 'xdotool', 'getdisplaygeometry']
}

// ---- il terminale del bot ----

export function appleTerminalArgv(container: string, owner: string): string[] {
  const home = boxHomePath(owner)
  return ['exec', '-i', '-u', CONTAINER_USER, '-w', home, '-e', `HOME=${home}`, '-e', 'TERM=xterm-256color', container, 'python3', '-c', TERMINAL_PROGRAM_PY, home]
}

export function appleTermPidListArgv(container: string, owner: string): string[] {
  return ['exec', '-i', '-u', CONTAINER_USER, '-w', BOX_MOUNT, container, 'find', terminalPidDir(owner), '-maxdepth', '1', '-name', '*.pid', '-printf', '%f\\n']
}

export function appleTermPidCleanArgv(container: string, owner: string): string[] {
  return ['exec', '-i', '-u', CONTAINER_USER, '-w', BOX_MOUNT, container, 'find', terminalPidDir(owner), '-maxdepth', '1', '-name', '*.pid', '-delete']
}

// ---- migrazione dai volumi vecchi e spazio su disco ----

export function appleBoxChownArgv(volume: string, image: string): string[] {
  return ['run', '--rm', '-v', `${volume}:${BOX_MOUNT}`, image, 'sh', '-c', DOCKER_BOX_INIT_SH]
}

export function appleBoxMigrateArgv(oldVolume: string, agentId: string, image: string, boxVolume: string): string[] {
  return ['run', '--rm', '-v', `${oldVolume}:/from:ro`, '-v', `${boxVolume}:${BOX_MOUNT}`, image, 'sh', '-c', DOCKER_BOX_MIGRATE_SH, 'sh', agentId]
}

export function appleBoxMarkerCheckArgv(image: string, boxVolume: string): string[] {
  return ['run', '--rm', '-v', `${boxVolume}:${BOX_MOUNT}`, image, 'test', '-f', BOX_MIGRATION_MARKER]
}

export function appleBoxMarkerWriteArgv(image: string, boxVolume: string): string[] {
  return ['run', '--rm', '-v', `${boxVolume}:${BOX_MOUNT}`, image, 'touch', BOX_MIGRATION_MARKER]
}

export function appleDfArgv(): string[] {
  return ['system', 'df', '--format', 'json']
}

/** La pulizia SICURA (BX3): SOLO immagini dangling (mai la nostra, col tag). */
export function applePruneSafeArgv(): string[][] {
  return [['image', 'prune']]
}

export function appleRemoveImageArgv(tag: string): string[] {
  return ['image', 'delete', tag]
}

export function appleRemoveVolumesArgv(names: string[]): string[] {
  return ['volume', 'delete', ...names]
}
