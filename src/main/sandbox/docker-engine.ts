// Fase box-container (BX1): il motore DOCKER. Comportamento INTATTO: ogni
// argv è la funzione di oggi, richiamata tale e quale (il test di BX5 li
// confronta byte per byte). L'UNICA cosa che vive qui è la risoluzione
// dell'eseguibile e l'env dei figli: NESSUN ALTRO modulo del sorgente chiama
// resolveTool('docker') — un test lo cerca dappertutto.
import { resolveTool, dockerChildEnv, isToolResolved } from '../tool-paths'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BoxEngine, BoxEngineArgv } from './engine'
import {
  dockerContainerNetworkArgv,
  dockerExecArgv,
  dockerExecBackgroundArgv,
  dockerKillGroupArgv,
  dockerStatSizeArgv,
  dockerStdioMcpArgv,
  dockerReadFileArgv,
  dockerWriteFileArgv,
  dockerListDirArgv,
  dockerRealpathArgv,
  dockerFindListArgv,
  dockerBoxReadB64Argv,
  dockerBrowserWriteB64Argv,
  dockerTestPathArgv,
  dockerRmDirArgv,
  dockerCpFromBoxArgv,
  dockerPsArgv,
  dockerStartArgv,
  dockerStopArgv,
  dockerBoxCreateArgv,
  dockerBoxRmArgv,
  dockerBoxInitCheckArgv,
  dockerBoxMountsArgv,
  dockerBoxWritableArgv,
  dockerContainerImageArgv,
  dockerEnsureHomeArgv,
  dockerImageInspectArgv,
  dockerImageSizeArgv,
  dockerBuildArgv,
  dockerVolumeLsArgv,
  dockerPluginsVolumeCreateArgv,
  dockerPluginCopyCreateArgv,
  dockerPluginsMkdirArgv,
  dockerPluginCpArgv,
  dockerPluginsChownArgv,
  dockerPluginsChmodArgv,
  dockerPluginsRmHelperArgv,
  dockerBrowserVolumeCreateArgv,
  dockerBrowserRootArgv,
  dockerBrowserWritableArgv,
  dockerBrowserOldProfileRmArgv,
  dockerBrowserMcpArgv,
  dockerBrowserReadFileArgv,
  dockerBrowserPidBootReadArgv,
  dockerBrowserReadB64Argv,
  dockerBrowserRmFileArgv,
  dockerScreenControlVncArgv,
  dockerScreenControlPidReadArgv,
  dockerScreenSocketReadyArgv,
  dockerScreenDisplayReadArgv,
  dockerScreenBridgeArgv,
  dockerXdotoolArgv,
  dockerScreenCaptureArgv,
  dockerScreenGeometryArgv,
  dockerTerminalArgv,
  dockerTermPidListArgv,
  dockerTermPidCleanArgv,
  dockerBoxChownArgv,
  dockerBoxMigrateArgv,
  dockerBoxMarkerCheckArgv,
  dockerBoxMarkerWriteArgv,
  dockerDfArgv,
  dockerPruneSafeArgv,
  dockerRemoveImageArgv,
  dockerRemoveVolumesArgv
} from './docker-argv'

/** L'argv del motore Docker: OGNI funzione di oggi, richiamata tale e quale. */
const argv: BoxEngineArgv = {
  ps: dockerPsArgv,
  start: dockerStartArgv,
  stop: dockerStopArgv,
  boxCreate: dockerBoxCreateArgv,
  boxRm: dockerBoxRmArgv,
  boxInitCheck: dockerBoxInitCheckArgv,
  boxMounts: dockerBoxMountsArgv,
  boxWritable: dockerBoxWritableArgv,
  containerImage: dockerContainerImageArgv,
  containerNetwork: dockerContainerNetworkArgv,
  ensureHome: dockerEnsureHomeArgv,
  imageInspect: dockerImageInspectArgv,
  imageSize: dockerImageSizeArgv,
  build: dockerBuildArgv,
  volumeLs: dockerVolumeLsArgv,
  exec: dockerExecArgv,
  execBackground: dockerExecBackgroundArgv,
  killGroup: dockerKillGroupArgv,
  statSize: dockerStatSizeArgv,
  stdioMcp: dockerStdioMcpArgv,
  readFile: dockerReadFileArgv,
  writeFile: dockerWriteFileArgv,
  listDir: dockerListDirArgv,
  realpath: dockerRealpathArgv,
  findList: dockerFindListArgv,
  readB64: dockerBoxReadB64Argv,
  testPath: dockerTestPathArgv,
  rmDir: dockerRmDirArgv,
  cpFromBox: dockerCpFromBoxArgv,
  pluginsVolumeCreate: dockerPluginsVolumeCreateArgv,
  pluginCopyCreate: dockerPluginCopyCreateArgv,
  pluginsMkdir: dockerPluginsMkdirArgv,
  pluginCp: dockerPluginCpArgv,
  pluginsChown: dockerPluginsChownArgv,
  pluginsChmod: dockerPluginsChmodArgv,
  pluginsRmHelper: dockerPluginsRmHelperArgv,
  browserVolumeCreate: dockerBrowserVolumeCreateArgv,
  browserRoot: dockerBrowserRootArgv,
  browserWritable: dockerBrowserWritableArgv,
  browserOldProfileRm: dockerBrowserOldProfileRmArgv,
  browserMcp: dockerBrowserMcpArgv,
  browserReadFile: dockerBrowserReadFileArgv,
  browserReadB64: dockerBrowserReadB64Argv,
  browserWriteB64: dockerBrowserWriteB64Argv,
  browserRmFile: dockerBrowserRmFileArgv,
  screenControlVnc: dockerScreenControlVncArgv,
  screenControlPidRead: dockerScreenControlPidReadArgv,
  screenSocketReady: dockerScreenSocketReadyArgv,
  screenDisplayRead: dockerScreenDisplayReadArgv,
  screenBridge: dockerScreenBridgeArgv,
  xdotool: dockerXdotoolArgv,
  screenCapture: dockerScreenCaptureArgv,
  screenGeometry: dockerScreenGeometryArgv,
  terminal: dockerTerminalArgv,
  termPidList: dockerTermPidListArgv,
  termPidClean: dockerTermPidCleanArgv,
  boxChown: dockerBoxChownArgv,
  boxMigrate: dockerBoxMigrateArgv,
  boxMarkerCheck: dockerBoxMarkerCheckArgv,
  boxMarkerWrite: dockerBoxMarkerWriteArgv,
  df: dockerDfArgv,
  pruneSafe: dockerPruneSafeArgv,
  removeImage: dockerRemoveImageArgv,
  removeVolumes: dockerRemoveVolumesArgv
}

/** Il motore Docker (il comportamento di oggi, intatto). */
export const dockerEngine: BoxEngine = {
  id: 'docker',
  command: () => resolveTool('docker'),
  childEnv: (env) => dockerChildEnv(env),
  argv,
  /** BR3: Docker usa i SUOI nomi di rete, nessuna rete di Homun. */
  networkNameOf: (network) => network,
  /** BRB1 (fase browser-riavvio-box): la lettura pid+boot in un solo exec. */
  browserPidBootRead: dockerBrowserPidBootReadArgv
}

/**
 * Lo stato del tool docker per la UI (ex dockerToolStatus del daemon, fase
 * rilascio A7): installed = trovato su disco, running = c'è un socket a cui
 * parlare (NIENTE spawn: costo zero, senza rete). Vive QUI perché la
 * risoluzione del percorso non esce dal modulo del motore.
 */
export function dockerToolStatusInfo(): { installed: boolean; running: boolean; path: string } {
  const installed = isToolResolved('docker')
  const socket = Boolean(process.env.DOCKER_HOST) ||
    existsSync('/var/run/docker.sock') ||
    existsSync(join(homedir(), '.docker', 'run', 'docker.sock'))
  return { installed, running: installed && socket, path: resolveTool('docker') }
}
