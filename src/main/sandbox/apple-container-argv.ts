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
  DOCKER_BROWSER_PID_BOOT_SH,
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

/**
 * BR1 (fase box-rete): la rete DEDICATA della modalità none, --internal come
 * homun-box. La CLI di Apple NON ha una rete «none»: un run senza --network
 * va sulla rete PREDEFINITA, in NAT verso Internet — l'esatto opposto di
 * «senza rete». Con none il box gira su QUESTA rete isolata (e col proxy che
 * NON ascolta mai sul suo gateway: BR2).
 */
export const APPLE_BOX_ISOLATED_NETWORK = 'homun-box-isolated'

/** BR1: la rete di Homun che la modalità richiede (PURO). */
export function appleNetworkOf(network: 'bridge' | 'none'): string {
  return network === 'bridge' ? APPLE_BOX_NETWORK : APPLE_BOX_ISOLATED_NETWORK
}

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

/** Lo stato del servizio (sonda: la TABELLA di default, il fallback). */
export function appleSystemStatusArgv(): string[] {
  return ['system', 'status']
}

/**
 * OBV1 (fase onboarding-b-dal-vivo): lo status si chiede in JSON —
 * `container system status --format json`. È il formato che la sonda usa
 * PER PRIMO; la tabella di default resta il fallback per una CLI che il
 * flag non lo conosce.
 */
export function appleSystemStatusJsonArgv(): string[] {
  return ['system', 'status', '--format', 'json']
}

/** Lo status letto dall'uscita della CLI (PURO): running, appRoot e arch. */
export interface SystemStatusParsed {
  running: boolean
  /** `paths.appRoot` (dove vive il kernel): null se l'uscita non lo dice */
  appRoot: string | null
  /** `host.architecture`: null se l'uscita non lo dice */
  arch: string | null
}

/**
 * OBV1: il parse del JSON VERO di `system status --format json` (PURO). Le
 * uscite della prova dal vivo sono le fixture dei test
 * (system-status-fixtures.ts): `status === "running"` accende il servizio,
 * `paths.appRoot` e `host.architecture` dicono DOVE guardare il kernel.
 * null = non è JSON valido (o manca lo status): il chiamante prova la
 * tabella. MAI euristiche sul testo.
 */
export function parseSystemStatusJson(stdout: string): SystemStatusParsed | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const j = o as { status?: unknown; paths?: { appRoot?: unknown }; host?: { architecture?: unknown } }
  if (typeof j.status !== 'string') return null
  return {
    running: j.status === 'running',
    appRoot: typeof j.paths?.appRoot === 'string' && j.paths.appRoot !== '' ? j.paths.appRoot : null,
    arch: typeof j.host?.architecture === 'string' && j.host.architecture !== '' ? j.host.architecture : null
  }
}

/**
 * OBV1: il parse della TABELLA VERA di `system status` (il formato di
 * default, PURO): righe «campo valore» SENZA separatori — `status running`,
 * `paths.appRoot <percorso>`, `host.architecture arm64`. La riga dello
 * status è `^status\s+(\S+)$`: il valore è UNA parola. null = non è la
 * tabella (nessuna riga dello status).
 */
export function parseSystemStatusTable(stdout: string): SystemStatusParsed | null {
  // OBD4d: [ \t]+ — \s+ attraversava il fine riga: con paths.appRoot VUOTO
  // il valore diventava quello della RIGA DOPO (paths.installRoot /usr/local/).
  // Il valore può contenere SPAZI («Application Support»): il gruppo prende
  // la riga (il punto non attraversa \n) e si ripulisce dei bordi [ \t]
  const status = /^status[ \t]+(\S+)[ \t]*$/m.exec(stdout)
  if (!status) return null
  const rawAppRoot = /^paths\.appRoot[ \t]+(.*)$/m.exec(stdout)?.[1] ?? null
  const appRoot = rawAppRoot !== null && rawAppRoot.trim() !== '' ? rawAppRoot.trim() : null
  const arch = /^host\.architecture[ \t]+(\S+)[ \t]*$/m.exec(stdout)?.[1] ?? null
  return { running: status[1] === 'running', appRoot, arch }
}

/**
 * OBV1: il parse dello status, PRIMA il JSON poi la tabella (PURO). Le
 * vecchie euristiche sul testo (`running:` seguito da `:` o `=`, le parole
 * missing/not installed per il kernel) sono VIA: la CLI vera stampa una
 * tabella senza separatori e NON parla mai del kernel.
 */
export function parseSystemStatus(stdout: string): SystemStatusParsed {
  return parseSystemStatusJson(stdout) ?? parseSystemStatusTable(stdout) ?? { running: false, appRoot: null, arch: null }
}

/** BX2: la rete interna del box si crea se manca (l'inspect lo dice). */
export function appleNetworkCreateArgv(network: string = APPLE_BOX_NETWORK): string[] {
  return ['network', 'create', '--internal', network]
}

/** BX2: l'inspect della rete, da cui si legge il GATEWAY (il Mac per il box). */
export function appleNetworkInspectArgv(network: string = APPLE_BOX_NETWORK): string[] {
  return ['network', 'inspect', network]
}

/**
 * BRV3 (fase box-apple-rete-vera): il gateway della rete dal suo inspect
 * (PURO) — il JSON VERO della CLI 1.7.1, quello della fixture
 * network-inspect-homun-box: si fa JSON.parse, si prende il PRIMO elemento
 * dell'array e si legge `status.ipv4Gateway` (la CLI vera scrive `"gateway"`
 * attaccato a `ipv4`: NESSUNA regex sul testo lo vede — il difetto che dal
 * vivo lasciava il browser del box senza proxy). Validazione IPv4 come
 * sempre (dotted-quad). null = JSON illeggibile, array vuoto o campo
 * assente: MAI ripieghi su formati inventati né righe `gateway: <ip>`.
 */
export function parseNetworkGateway(stdout: string): string | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(o) || o.length === 0) return null
  const gw = (o[0] as { status?: { ipv4Gateway?: unknown } })?.status?.ipv4Gateway
  return typeof gw === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(gw) ? gw : null
}

/**
 * BR2 (fase box-rete): la SOTTORETE della rete (CIDR) dal suo inspect (PURO).
 * BRV3: come il gateway, dal `status.ipv4Subnet` del JSON VERO (fixture
 * network-inspect-homun-box) — niente regex sul testo, niente il vecchio
 * campo `subnets[].subnet` del formato inventato dalla finta di una volta.
 * È il confine del secondo ascolto del proxy (chi ci può parlare) e della
 * regola d'uscita (quali destinazioni sono vietate): 192.0.x.y NON è un
 * intervallo privato classico, la lista dei privati non lo conosce.
 */
export function parseNetworkSubnet(stdout: string): string | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(o) || o.length === 0) return null
  const cidr = (o[0] as { status?: { ipv4Subnet?: unknown } })?.status?.ipv4Subnet
  return typeof cidr === 'string' && /^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(cidr) ? cidr : null
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

/**
 * BAV1 (fase box-apple-cli-vera): l'elenco dei container in JSON, MAI coi
 * template Go — la CLI vera li rifiuta (`--format {{.name}}` esce 64: i
 * valori sono solo json/table/yaml/toml). L'elenco è l'array di oggetti
 * `{configuration:{id,…}, status:{state,…}, id}` della fixture ls-a-json:
 * l'esistenza si legge col parse puro (BAV2), non dalle righe.
 */
export function applePsArgv(): string[] {
  return ['ls', '-a', '--format', 'json']
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
 * BAV4 (fase box-apple-cli-vera): `--init` C'È nella CLI vera (run-help:
 * «Run an init process inside the container that forwards signals and reaps
 * processes») — la stessa ragione di G2 per Docker: PID 1 raccoglie gli
 * zombie dei comandi in background. Il box nato senza (useInit:false,
 * come quello creato dal vivo) si ricrea UNA volta, ragione 'senza-init'.
 * Niente --cap-drop/--security-opt nel NOSTRO argv; il confine è la VM.
 * BR1 (fase box-rete): SEMPRE esattamente un --network, con una rete di
 * Homun — `bridge` → homun-box, `none` → homun-box-isolated + --no-dns. Mai
 * la rete predefinita di Apple (NAT verso Internet): «senza rete» non si fa
 * omettendo il flag.
 */
export function appleBoxRunArgv(container: string, volume: string, network: 'bridge' | 'none', limits: BoxLimits, image: string): string[] {
  return [
    'run', '-d', '--init',
    '--name', container,
    '-u', CONTAINER_USER,
    '-m', limits.memory,
    '-c', String(limits.cpus),
    '--network', appleNetworkOf(network),
    ...(network === 'none' ? ['--no-dns'] : []),
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

// ---- BR1 (fase box-rete): la modalità none isolata e VERIFICATA ----

/**
 * BR1, difesa in profondità: porta GIÙ ogni interfaccia del box tranne lo.
 * Stringa COSTANTE (nessuna interpolazione), gira COME ROOT (exec -u 0):
 * l'utente del bot (1000:1000, senza setuid dopo BX2) non può rialzarla.
 * Serve `ip` (iproute2) nell'immagine: c'è nel Dockerfile del box.
 */
export const APPLE_ISOLATE_LINK_DOWN_SH = 'for i in /sys/class/net/*; do n=${i##*/}; [ "$n" = lo ] || ip link set dev "$n" down; done'

/** BR1: il link down come ROOT, subito dopo il run -d e prima di ogni exec del bot. */
export function appleIsolateLinkDownArgv(container: string): string[] {
  return ['exec', '-u', '0', container, 'sh', '-c', APPLE_ISOLATE_LINK_DOWN_SH]
}

/**
 * BR1: la VERIFICA (sempre come ROOT): per ogni interfaccia diversa da lo,
 * /sys/class/net/<if>/operstate deve essere down. Stampa l'interfaccia che
 * non lo è ed esce diverso da zero: il chiamante fallisce CHIUSO (box
 * rimosso, azione del bot in parole) — mai un box none senza verifica.
 */
export const APPLE_ISOLATION_CHECK_SH = 'for i in /sys/class/net/*; do n=${i##*/}; [ "$n" = lo ] && continue; s=$(cat "$i/operstate" 2>/dev/null); [ "$s" = down ] || { echo "$n is $s"; exit 1; }; done'

/** BR1: la verifica operstate come ROOT, dopo il link down. */
export function appleIsolationCheckArgv(container: string): string[] {
  return ['exec', '-u', '0', container, 'sh', '-c', APPLE_ISOLATION_CHECK_SH]
}

/**
 * BAV2 (fase box-apple-cli-vera): l'inspect DEL box, l'unico spawn da cui
 * escono TUTTI i fatti del container esistente (init, immagine, mount, rete)
 * — l'array JSON VERO della fixture inspect-box, letto dal parse puro
 * parseAppleBoxInspect. Al posto dei quattro inspect -f di Docker.
 */
export function appleBoxInspectArgv(container: string): string[] {
  return ['inspect', container]
}

export function appleBoxWritableArgv(container: string): string[] {
  return ['exec', container, 'test', '-w', `${BOX_MOUNT}/workspace`]
}

// ---- BAV2: i parse PURI delle uscite JSON VERE (fixture container-1.7.1) ----

/**
 * Gli id dei container dall'uscita di `ls -a --format json` (PURO): l'array
 * di oggetti `{configuration:{id,…}, status:{state,…}, id}` della fixture
 * ls-a-json — l'ESISTENZA non passa più dai nomi per riga. null = non è
 * JSON valido: il chiamante lo tratta come elenco vuoto, mai un errore che
 * ferma i bot (le regole di oggi del ps).
 */
export function appleLsJsonIds(stdout: string): string[] | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(o)) return null
  const ids: string[] = []
  for (const el of o) {
    const id = (el as { configuration?: { id?: unknown }; id?: unknown })?.configuration?.id ?? (el as { id?: unknown })?.id
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
}

/**
 * CC2 (fase computer-card): lo stato del box dall'uscita di `ls -a --format
 * json` (PURO, fixture ls-a-json): il `status.state` della VOCE del box —
 * 'running' se gira, qualunque altro stato → 'stopped'; il box ASSENTE
 * dall'elenco → 'missing'; JSON illeggibile → 'unknown' (non si indovina
 * MAI: chi chiama lo mostra e riprova alla prossima lettura).
 */
export function appleBoxStateFromLsJson(stdout: string, container: string): 'running' | 'stopped' | 'missing' | 'unknown' {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return 'unknown' }
  if (!Array.isArray(o)) return 'unknown'
  for (const el of o) {
    const id = (el as { configuration?: { id?: unknown }; id?: unknown })?.configuration?.id ?? (el as { id?: unknown })?.id
    if (id !== container) continue
    const state = (el as { status?: { state?: unknown } })?.status?.state
    return state === 'running' ? 'running' : 'stopped'
  }
  return 'missing'
}

/** Il riferimento dell'immagine NORMALIZZATO (PURO): via il prefisso docker.io/library/. */
export function normalizeAppleImageRef(ref: string): string {
  return ref.startsWith('docker.io/library/') ? ref.slice('docker.io/library/'.length) : ref
}

/** I fatti del box esistente dall'UNICO inspect JSON (PURO, fixture inspect-box). */
export interface AppleBoxInspect {
  /** `status.state === 'running'`. */
  running: boolean
  /** `configuration.useInit` (G2/BAV4: nato senza --init → si ricrea una volta). */
  useInit: boolean
  /** `configuration.image.reference`, NORMALIZZATO (via docker.io/library/). */
  imageRef: string
  /** i mount: destinazione e sola lettura (`options` contiene "ro"). */
  mounts: Array<{ destination: string; ro: boolean }>
  /** `configuration.networks[0].network` (BR3). */
  network: string
}

/**
 * Il parse dell'uscita di `container inspect <box>` (PURO): TUTTI i fatti
 * del box esistente da UN solo spawn — running, useInit, l'immagine
 * normalizzata (docker.io/library/sandbot-box:x ≡ sandbot-box:x), i mount
 * con il loro ro, la rete. null = JSON illeggibile o senza il container:
 * le regole di oggi (non si ricrea, salvo none che fallisce chiuso).
 */
export function parseAppleBoxInspect(stdout: string): AppleBoxInspect | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(o) || o.length === 0) return null
  const c = (o[0] as { configuration?: Record<string, unknown>; status?: Record<string, unknown> })?.configuration
  const st = (o[0] as { status?: Record<string, unknown> })?.status
  if (!c || typeof c !== 'object') return null
  const refRaw = (c.image as { reference?: unknown } | undefined)?.reference
  const mountsRaw = Array.isArray(c.mounts) ? c.mounts : []
  const mounts = mountsRaw.map((m) => {
    const mount = m as { destination?: unknown; options?: unknown }
    return {
      destination: typeof mount.destination === 'string' ? mount.destination : '',
      ro: Array.isArray(mount.options) && mount.options.includes('ro')
    }
  })
  const networks = Array.isArray(c.networks) ? c.networks : []
  const network = typeof (networks[0] as { network?: unknown } | undefined)?.network === 'string'
    ? (networks[0] as { network: string }).network
    : ''
  return {
    running: (st?.state as unknown) === 'running',
    useInit: c.useInit === true,
    imageRef: typeof refRaw === 'string' ? normalizeAppleImageRef(refRaw) : '',
    mounts,
    network
  }
}

/**
 * I nomi dei volumi dall'uscita di `volume ls --format json` (PURO): un nome
 * per voce, dal campo `configuration.name` (fixture volume-ls-json). null =
 * JSON illeggibile. La CLI NON ha --filter: il filtro lo fa chi chiama.
 */
export function appleVolumeNamesFromLsJson(stdout: string): string[] | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(o)) return null
  const names: string[] = []
  for (const el of o) {
    const name = (el as { configuration?: { name?: unknown } })?.configuration?.name
    if (typeof name === 'string' && name !== '') names.push(name)
  }
  return names
}

/**
 * La dimensione in byte dell'immagine INTERA dall'uscita di `image inspect`
 * (PURO): la SOMMA dei `variants[].size` — ogni variante è l'immagine
 * completa per una piattaforma (la fixture image-inspect ne ha una,
 * 1 302 970 425 byte). Il `descriptor.size` del manifest NON è quello: sono
 * i 375 byte del solo JSON dell'indice. null = JSON illeggibile.
 */
export function appleImageSizeBytesFromInspect(stdout: string): number | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(o) || o.length === 0) return null
  const variants = (o[0] as { variants?: unknown }).variants
  if (!Array.isArray(variants) || variants.length === 0) return null
  let total = 0
  for (const v of variants) {
    const size = (v as { size?: unknown }).size
    if (typeof size !== 'number' || !Number.isFinite(size)) return null
    total += size
  }
  return total
}

export function appleEnsureHomeArgv(container: string, agentId: string): string[] {
  return ['exec', container, 'mkdir', '-p', boxHomePath(agentId)]
}

export function appleImageInspectArgv(tag: string): string[] {
  return ['image', 'inspect', tag]
}

/**
 * La dimensione in byte della NOSTRA immagine (BX3): anche qui NESSUN
 * --format (BAV1) — l'inspect stampa il JSON VERO (fixture image-inspect) e
 * la dimensione si legge dal campo `variants[].size` col parse puro di BAV2.
 */
export function appleImageSizeArgv(tag: string): string[] {
  return ['image', 'inspect', tag]
}

/** OBD3 (fase onboarding-b-dettagli): --progress plain ESPLICITO — il formato #N si legge riga per riga. */
export function appleBuildArgv(tag: string, dockerfilePath: string, contextDir: string): string[] {
  return ['build', '--progress', 'plain', '-t', tag, '-f', dockerfilePath, contextDir]
}

/**
 * BAV1: l'elenco dei volumi in JSON. La CLI di Apple NON ha --filter (la
 * help vera non lo elenca): i nomi si filtrano qui, dal parse puro di BAV2
 * (`configuration.name` per voce — fixture volume-ls-json).
 */
export function appleVolumeLsArgv(_volume: string): string[] {
  return ['volume', 'ls', '--format', 'json']
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
 * BRB2 (fase browser-riavvio-box): i lock di Chromium e di xauth di un
 * avvio precedente si tolgono COME 1001 prima del browser principale —
 * argv puri col profilo e la cartella del proprietario, come Docker.
 */
export function appleBrowserLocksRmArgv(container: string, owner: string): string[] {
  return [
    'exec', '-u', BROWSER_USER, container, 'rm', '-f', '--',
    `${browserProfilePath(owner)}/SingletonLock`,
    `${browserProfilePath(owner)}/SingletonSocket`,
    `${browserProfilePath(owner)}/SingletonCookie`,
    `${browserStateDir(owner)}/Xauthority-c`,
    `${browserStateDir(owner)}/Xauthority-l`
  ]
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

/**
 * BRB1 (fase browser-riavvio-box): la lettura pid+boot in UN SOLO exec come
 * 1001 — lo script COSTANTE è quello di docker-argv (dentro il box gira
 * Linux uguale), il path del pid file come argomento posizionale.
 */
export function appleBrowserPidBootReadArgv(container: string, pidFile: string): string[] {
  return ['exec', '-i', '-u', BROWSER_USER, '-w', BROWSER_MOUNT, container, 'sh', '-c', DOCKER_BROWSER_PID_BOOT_SH, 'sh', pidFile]
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

/** Una voce dell'elenco `ls -a --format json` già ridotta ai campi che contano (U4). */
interface AppleLsEntry { id: string; state: string; labels: Record<string, string> }

/** Le voci dell'elenco `ls -a --format json` (PURO): null se non è JSON valido. */
function appleLsEntries(stdout: string): AppleLsEntry[] | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(o)) return null
  const entries: AppleLsEntry[] = []
  for (const el of o) {
    const c = el as { configuration?: { id?: unknown; labels?: unknown }; id?: unknown; status?: { state?: unknown } }
    const id = c?.configuration?.id ?? c?.id
    if (typeof id !== 'string' || id === '') continue
    const labels = (c?.configuration?.labels ?? {}) as Record<string, unknown>
    entries.push({
      id,
      state: typeof c?.status?.state === 'string' ? c.status.state : '',
      labels: Object.fromEntries(Object.entries(labels).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    })
  }
  return entries
}

/** L'etichetta con cui la CLI Apple marca il container del costruttore (builder). */
export const APPLE_BUILDER_ROLE_LABEL = 'com.apple.container.resource.role'

/**
 * U4 (fase prima-release): il builder è ACCESO? (una build è in corso) —
 * dall'uscita di `ls -a --format json` (fixture ls-a-prima-release): la
 * voce con l'etichetta del builder in state 'running'. null = uscita non
 * valida: non si decide, il chiamante resta prudente.
 */
export function appleBuilderRunningFromLsJson(stdout: string): boolean | null {
  const entries = appleLsEntries(stdout)
  if (entries === null) return null
  return entries.some((e) => e.labels[APPLE_BUILDER_ROLE_LABEL] === 'builder' && e.state === 'running')
}

/**
 * U4 (fase prima-release): TUTTI i container FERMI sono builder? È la
 * condizione per contare containers.reclaimable nella stima: se c'è un
 * fermo che NON è builder (per esempio il box), la pulizia non lo tocca e
 * la parte container è sconosciuta. null = uscita non valida.
 */
export function appleStoppedAllBuildersFromLsJson(stdout: string): boolean | null {
  const entries = appleLsEntries(stdout)
  if (entries === null) return null
  const stopped = entries.filter((e) => e.state !== 'running')
  return stopped.every((e) => e.labels[APPLE_BUILDER_ROLE_LABEL] === 'builder')
}

/**
 * La pulizia Apple della UI «Libera spazio» (U4, fase prima-release): il
 * builder FERMO si cancella con `container builder delete` (il costruttore
 * delle immagini con la sua cache: si ricrea da solo alla prossima build),
 * POI `container image prune` SENZA --all (solo le immagini orfane). A
 * builder ACCESO una build è in corso: NESSUN argv; a lettura sconosciuta
 * si fa solo la parte sicura (le orfane). MAI `container prune` (col box
 * fermo cancellerebbe anche lui) e MAI `image prune --all` (tolgerebbe
 * l'immagine base di Playwright, che serve alla build).
 */
export function appleCleanupArgv(builderRunning: boolean | null): string[][] {
  if (builderRunning === true) return [] // build in corso: NESSUNA pulizia
  return [...(builderRunning === false ? [['builder', 'delete'] as string[]] : []), ['image', 'prune']]
}

export function appleRemoveImageArgv(tag: string): string[] {
  return ['image', 'delete', tag]
}

export function appleRemoveVolumesArgv(names: string[]): string[] {
  return ['volume', 'delete', ...names]
}
