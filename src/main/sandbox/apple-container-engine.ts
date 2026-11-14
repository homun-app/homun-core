// Fase box-container (BX1): il motore APPLE CONTAINER (macOS ≥ 26, chip
// Apple). Gli argv sono le funzioni pure di apple-container-argv; l'env dei
// figli è quello del daemon tale e quale (la CLI di Apple non ha socket da
// cercare: niente DOCKER_HOST). Il percorso della CLI: l'override di test
// (SANDBOT_TEST_USER_DATA + SANDBOT_TEST_CONTAINER_CLI, la CLI finta di BX5)
// vince su tutto; poi HOMUN_CONTAINER_PATH, il PATH e /usr/local/bin/container
// (dove lo mette il pacchetto firmato di Apple).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BoxEngine, BoxEngineArgv, BoxEngineReads } from './engine'
import { BOX_CONTAINER, BOX_VOLUME, BOX_IMAGE_REPO, PLUGINS_MOUNT, BROWSER_MOUNT } from './docker-argv'
import {
  APPLE_BOX_NETWORK,
  appleNetworkOf,
  appleNetworkInspectArgv,
  parseNetworkGateway,
  parseNetworkSubnet,
  appleSystemStartArgv,
  appleKernelSetRecommendedArgv,
  appleNetworkCreateArgv,
  appleIsolateLinkDownArgv,
  appleIsolationCheckArgv,
  applePsArgv,
  appleStartArgv,
  appleStopArgv,
  appleBoxRunArgv,
  appleBoxRmArgv,
  appleBoxInspectArgv,
  appleLsJsonIds,
  parseAppleBoxInspect,
  appleVolumeNamesFromLsJson,
  appleImageSizeBytesFromInspect,
  appleBoxWritableArgv,
  appleEnsureHomeArgv,
  appleImageInspectArgv,
  appleImageSizeArgv,
  appleBuildArgv,
  appleVolumeLsArgv,
  appleExecArgv,
  appleExecBackgroundArgv,
  appleKillGroupArgv,
  appleStatSizeArgv,
  appleStdioMcpArgv,
  appleReadFileArgv,
  appleWriteFileArgv,
  appleListDirArgv,
  appleRealpathArgv,
  appleFindListArgv,
  appleReadB64Argv,
  appleWriteB64Argv,
  appleTestPathArgv,
  appleRmDirArgv,
  appleCpFromBoxArgv,
  applePluginsVolumeCreateArgv,
  applePluginCopyCreateArgv,
  applePluginsMkdirArgv,
  applePluginCpArgv,
  applePluginsChownArgv,
  applePluginsChmodArgv,
  applePluginsRmHelperArgv,
  appleBrowserVolumeCreateArgv,
  appleBrowserRootArgv,
  appleBrowserWritableArgv,
  appleBrowserOldProfileRmArgv,
  appleBrowserMcpArgv,
  appleBrowserReadFileArgv,
  appleBrowserReadB64Argv,
  appleBrowserRmFileArgv,
  appleScreenControlVncArgv,
  appleScreenControlPidReadArgv,
  appleScreenSocketReadyArgv,
  appleScreenDisplayReadArgv,
  appleScreenBridgeArgv,
  appleXdotoolArgv,
  appleScreenCaptureArgv,
  appleScreenGeometryArgv,
  appleTerminalArgv,
  appleTermPidListArgv,
  appleTermPidCleanArgv,
  appleBoxChownArgv,
  appleBoxMigrateArgv,
  appleBoxMarkerCheckArgv,
  appleBoxMarkerWriteArgv,
  appleDfArgv,
  applePruneSafeArgv,
  appleRemoveImageArgv,
  appleRemoveVolumesArgv
} from './apple-container-argv'
import { DOCKER_BROWSER_ROOT_SH } from './docker-argv'

/** Il runner degli argv del box (la firma del DockerRunner di sandbox/index). */
export type BoxArgvRunner = (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>

/** Il gateway della rete interna, ricordato dopo l'inspect (BX2). */
let cachedGateway: string | null = null

/** BR2: la SOTTORETE di homun-box (CIDR), ricordata col gateway. */
let cachedSubnet: string | null = null

/** Solo per i test (e l'ensure del box): il gateway della rete del box. */
export function setBoxNetworkGateway(ip: string | null): void {
  cachedGateway = ip
}

/** Il gateway della rete del box (null = non ancora letto). */
export function boxNetworkGateway(): string | null {
  return cachedGateway
}

/** Solo per i test: la sottorete della rete del box (BR2). */
export function setBoxNetworkSubnet(cidr: string | null): void {
  cachedSubnet = cidr
}

/** BR2: la sottorete di homun-box in forma CIDR (null = non ancora letta). */
export function boxNetworkSubnet(): string | null {
  return cachedSubnet
}

/**
 * BAV3 (fase box-apple-cli-vera): l'ensure IDEMPOTENTE di un volume, il
 * kernel di OBV2. La `volume create` della CLI di Apple NON è idempotente
 * (esce 1 con «volume 'x' already exists» — l'errore che dal vivo fermava
 * OGNI comando al secondo giro): si LEGGE l'elenco (BAV2: volume ls --format
 * json), se il volume c'è è fatto; se manca si crea; se la create esce ≠ 0
 * si RILEGGE — se ora c'è («already exists», o una corsa parallela che l'ha
 * fatto prima di noi) è fatto lo stesso, solo se manca davvero è errore.
 */
export async function ensureAppleVolume(run: BoxArgvRunner, name: string): Promise<void> {
  const readNames = async (): Promise<string[] | null> => {
    const ls = await run(appleVolumeLsArgv(name), { timeoutMs: 15_000 })
    return ls.exitCode === 0 ? appleVolumeNamesFromLsJson(ls.stdout) : null
  }
  const names = await readNames()
  if (names?.includes(name)) return
  const create = await run(['volume', 'create', name], { timeoutMs: 30_000 })
  if (create.exitCode === 0) return
  const again = await readNames()
  if (again?.includes(name)) return
  throw new Error(`creation of volume ${name} failed: ${create.stderr || `exit ${create.exitCode}`}`)
}

/**
 * BX2: il terreno della RETE del box, prima del run. La rete DEDICATA
 * --internal homun-box si crea se manca (inspect → create → inspect) e il
 * suo GATEWAY si ricorda: è l'indirizzo del Mac con cui il browser del bot
 * raggiunge il proxy d'uscita, al posto di host.docker.internal. Esito:
 * il gateway, o null se l'inspect non lo dice (l'avvio prosegue col
 * fallback e il log lo ricorda — la rete interna resta il confine).
 * BR1 (fase box-rete): con `none` la rete è l'altra dedicata di Homun,
 * homun-box-isolated (host-only pure lei): si crea e si ispeziona uguale,
 * MA il suo gateway NON si ricorda — il proxy non ascolta MAI lì (BR2) e il
 * gateway del browser resta quello di homun-box, letto in bridge.
 * BAV3: se la create esce ≠ 0 si RILEGGE come per i volumi — una corsa
 * parallela può averla fatta prima di noi; solo se manca davvero è errore.
 */
export async function ensureAppleBoxNetwork(run: BoxArgvRunner, network: 'bridge' | 'none' = 'bridge'): Promise<string | null> {
  const name = appleNetworkOf(network)
  let ins = await run(appleNetworkInspectArgv(name), { timeoutMs: 15_000 })
  if (ins.exitCode !== 0) {
    const create = await run(appleNetworkCreateArgv(name), { timeoutMs: 30_000 })
    if (create.exitCode !== 0) {
      const retry = await run(appleNetworkInspectArgv(name), { timeoutMs: 15_000 })
      if (retry.exitCode !== 0) {
        throw new Error(`creation of the internal network ${name} failed: ${create.stderr || `exit ${create.exitCode}`}`)
      }
      ins = retry
    } else {
      ins = await run(appleNetworkInspectArgv(name), { timeoutMs: 15_000 })
    }
  }
  const gw = parseNetworkGateway(ins.stdout)
  if (network === 'bridge') {
    // BR2: la sottorete di homun-box si ricorda COL gateway — è il confine
    // del secondo ascolto del proxy e della regola d'uscita
    setBoxNetworkGateway(gw)
    setBoxNetworkSubnet(parseNetworkSubnet(ins.stdout))
  }
  return gw
}

/**
 * Il percorso della CLI container (PURa sull'env): la CLI finta dei test SOLO
 * con SANDBOT_TEST_USER_DATA (mai nella corsa vera), poi l'override esplicito,
 * il PATH e /usr/local/bin/container. Non trovata → il nome semplice: lo
 * spawn risponde ENOENT e l'interfaccia lo dice in parole (come docker oggi).
 */
export function containerCliPath(env: NodeJS.ProcessEnv = process.env, pathEnv = env.PATH ?? ''): string {
  if (env.SANDBOT_TEST_USER_DATA && env.SANDBOT_TEST_CONTAINER_CLI) return env.SANDBOT_TEST_CONTAINER_CLI
  if (env.HOMUN_CONTAINER_PATH) return env.HOMUN_CONTAINER_PATH
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    const p = join(dir, 'container')
    if (existsSync(p)) return p
  }
  const local = '/usr/local/bin/container'
  return existsSync(local) ? local : 'container'
}

/** Gli argv del motore Apple: il container del box è il BOX_CONTAINER di oggi. */
const argv: BoxEngineArgv = {
  ps: applePsArgv,
  start: appleStartArgv,
  stop: appleStopArgv,
  boxCreate: appleBoxRunArgv,
  boxRm: appleBoxRmArgv,
  boxWritable: appleBoxWritableArgv,
  ensureHome: appleEnsureHomeArgv,
  imageInspect: appleImageInspectArgv,
  imageSize: appleImageSizeArgv,
  build: appleBuildArgv,
  volumeLs: appleVolumeLsArgv,
  exec: appleExecArgv,
  execBackground: appleExecBackgroundArgv,
  killGroup: appleKillGroupArgv,
  statSize: appleStatSizeArgv,
  stdioMcp: (opts) => appleStdioMcpArgv(opts, BOX_CONTAINER),
  readFile: appleReadFileArgv,
  writeFile: appleWriteFileArgv,
  listDir: appleListDirArgv,
  realpath: appleRealpathArgv,
  findList: appleFindListArgv,
  readB64: appleReadB64Argv,
  browserWriteB64: appleWriteB64Argv,
  testPath: appleTestPathArgv,
  rmDir: (boxPath, image) => appleRmDirArgv(boxPath, image, BOX_CONTAINER),
  cpFromBox: appleCpFromBoxArgv,
  pluginsVolumeCreate: applePluginsVolumeCreateArgv,
  pluginCopyCreate: applePluginCopyCreateArgv,
  pluginsMkdir: applePluginsMkdirArgv,
  pluginCp: applePluginCpArgv,
  pluginsChown: applePluginsChownArgv,
  pluginsChmod: applePluginsChmodArgv,
  pluginsRmHelper: applePluginsRmHelperArgv,
  browserVolumeCreate: appleBrowserVolumeCreateArgv,
  browserRoot: (image) => appleBrowserRootArgv(image, DOCKER_BROWSER_ROOT_SH),
  browserWritable: appleBrowserWritableArgv,
  browserOldProfileRm: appleBrowserOldProfileRmArgv,
  browserMcp: (agentId, proxyPort, opts) => appleBrowserMcpArgv(agentId, proxyPort, { ...opts, gateway: cachedGateway ?? undefined }, BOX_CONTAINER),
  browserReadFile: appleBrowserReadFileArgv,
  browserReadB64: appleBrowserReadB64Argv,
  browserRmFile: appleBrowserRmFileArgv,
  screenControlVnc: (owner, display) => appleScreenControlVncArgv(BOX_CONTAINER, owner, display),
  screenControlPidRead: appleScreenControlPidReadArgv,
  screenSocketReady: appleScreenSocketReadyArgv,
  screenDisplayRead: appleScreenDisplayReadArgv,
  screenBridge: (socketPath) => appleScreenBridgeArgv(socketPath, BOX_CONTAINER),
  xdotool: (display, xauthority, args) => appleXdotoolArgv(BOX_CONTAINER, display, xauthority, args),
  screenCapture: (display, xauthority, owner, name) => appleScreenCaptureArgv(BOX_CONTAINER, display, xauthority, owner, name),
  screenGeometry: (display, xauthority) => appleScreenGeometryArgv(BOX_CONTAINER, display, xauthority),
  terminal: (owner) => appleTerminalArgv(BOX_CONTAINER, owner),
  termPidList: appleTermPidListArgv,
  termPidClean: appleTermPidCleanArgv,
  boxChown: appleBoxChownArgv,
  boxMigrate: (oldVolume, agentId, image) => appleBoxMigrateArgv(oldVolume, agentId, image, BOX_VOLUME),
  boxMarkerCheck: (image) => appleBoxMarkerCheckArgv(image, BOX_VOLUME),
  boxMarkerWrite: (image) => appleBoxMarkerWriteArgv(image, BOX_VOLUME),
  df: appleDfArgv,
  pruneSafe: applePruneSafeArgv,
  removeImage: appleRemoveImageArgv,
  removeVolumes: appleRemoveVolumesArgv
}

/**
 * BAV2: le LETTURE del motore Apple — JSON puri, MAI template Go né nomi
 * per riga. L'esistenza dall'elenco `ls -a --format json`, TUTTI i fatti
 * del box esistente da UN solo `inspect` (un solo spawn invece di quattro),
 * i nomi dei volumi dal `volume ls --format json`, la dimensione
 * dell'immagine dal JSON dell'`image inspect` (variants[].size).
 */
const reads: BoxEngineReads = {
  psArgv: (container) => applePsArgv(),
  psExists: (stdout, container) => appleLsJsonIds(stdout)?.includes(container) ?? false,
  boxInspectArgv: appleBoxInspectArgv,
  boxFacts: (stdout, opts) => {
    const p = parseAppleBoxInspect(stdout)
    if (!p) return null
    // punto 1: il confronto dell'immagine sul nome NORMALIZZATO
    // (docker.io/library/sandbot-box:x ≡ sandbot-box:x)
    const imageOk = opts.imageKnown ? p.imageRef === opts.expectedImage : undefined
    return {
      initOk: p.useInit,
      imageOk,
      staleImage: imageOk === false && p.imageRef.startsWith(`${BOX_IMAGE_REPO}:`) ? p.imageRef : null,
      // M4/P2: i mount ci sono tutti? (inspect leggibile MA senza mount → ignoto)
      pluginsMountOk: p.mounts.length > 0 ? p.mounts.some((m) => m.destination === PLUGINS_MOUNT && m.ro) : undefined,
      browserMountOk: p.mounts.length > 0 ? p.mounts.some((m) => m.destination === BROWSER_MOUNT && !m.ro) : undefined,
      networkOk: p.network !== '' ? p.network === opts.networkName : undefined
    }
  },
  volumeLsArgv: () => appleVolumeLsArgv(''),
  volumeNames: (stdout) => appleVolumeNamesFromLsJson(stdout),
  imageSizeArgv: appleImageSizeArgv,
  imageSizeBytes: appleImageSizeBytesFromInspect
}

/**
 * BR1 + BRR1: la VERIFICA operstate come ROOT, un solo exec — ogni
 * interfaccia diversa da lo deve essere down. Lancia se non passa (il
 * chiamante riprova col link down, o fallisce chiuso).
 */
async function verifyBoxInterfaces(run: BoxArgvRunner): Promise<void> {
  const check = await run(appleIsolationCheckArgv(BOX_CONTAINER), { timeoutMs: 30_000 })
  if (check.exitCode !== 0) {
    throw new Error(`verification of the box interfaces failed (not all down): ${(check.stdout || check.stderr || `exit ${check.exitCode}`).slice(0, 200)}`)
  }
}

/** Il motore Apple container. */
export const appleContainerEngine: BoxEngine = {
  id: 'apple-container',
  command: () => containerCliPath(),
  childEnv: (env) => Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  argv,
  reads,
  /** BR3: le reti di Homun, non i nomi di Docker. */
  networkNameOf: appleNetworkOf,
  prepareNetwork: async (run, network) => {
    await ensureAppleBoxNetwork(run, network)
  },
  /** BAV3: i volumi di Homun con la create NON idempotente della CLI di Apple. */
  ensureVolume: async (run, name) => {
    await ensureAppleVolume(run, name)
  },
  /**
   * BR1: le interfacce del box GIÙ come root e la VERIFICA operstate. Ogni
   * fallimento lancia: il chiamante (l'ensure del box) fallisce CHIUSO — il
   * box si rimuove, mai un box none che gira senza verifica passata.
   */
  isolateBoxNetwork: async (run) => {
    const down = await run(appleIsolateLinkDownArgv(BOX_CONTAINER), { timeoutMs: 30_000 })
    if (down.exitCode !== 0) {
      throw new Error(`link down of the box interfaces failed: ${down.stderr || `exit ${down.exitCode}`}`)
    }
    await verifyBoxInterfaces(run)
  },
  /**
   * BRR1 (fase box-rete-riavvio): la SOLA verifica, senza link down — la
   * chiama l'ensure ANCHE col box che si riusa: un riavvio della VM è un
   * boot nuovo che riporta le interfacce SU, e la seconda difesa deve
   * tornare a valere PRIMA di ogni exec del bot.
   */
  isolationCheck: verifyBoxInterfaces
}
