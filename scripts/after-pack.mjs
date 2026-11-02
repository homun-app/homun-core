// electron-builder `afterPack` (fase rilascio A4 — adattato da homun2
// scripts-after-pack.mjs.txt). L'ordine conta: gira PRIMA della firma di
// electron-builder.
//   1. verifica che il plist del LaunchAgent (A3) sia DENTRO il bundle;
//   2. gira i fuse di Electron — che riscrive l'eseguibile e invalida ogni
//      firma, quindi DEVE venire prima della firma; su macOS si resetta la
//      firma ad-hoc perché quella vera parta pulita.
// Nessun motore Python, niente receipt, niente firma di binari terzi: la
// parte engine di homun2 NON si prende (decisione della fase).
import { FuseVersion, FuseV1Options, flipFuses } from '@electron/fuses'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

/** L'eseguibile Electron impacchettato (macOS). */
function electronBinaryPath(context) {
  const { appOutDir, packager, electronPlatformName } = context
  const exeName = packager.appInfo.productFilename // "Homun"
  if (electronPlatformName === 'darwin') {
    const macExe = packager.platformSpecificBuildOptions.executableName ?? exeName
    return path.join(appOutDir, `${exeName}.app`, 'Contents', 'MacOS', macExe)
  }
  throw new Error(`after-pack: piattaforma non gestita ${electronPlatformName} (la 0.3 è solo macOS)`)
}

function packagedResourcesPath(context) {
  const { appOutDir, packager, electronPlatformName } = context
  if (electronPlatformName === 'darwin') {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
  }
  throw new Error(`after-pack: piattaforma non gestita ${electronPlatformName}`)
}

/**
 * electron-builder 26 scrive l'hash dell'asar in Info.plist
 * (ElectronAsarIntegrity) quando produce il bundle macOS: il fuse
 * EnableEmbeddedAsarIntegrityValidation si accende SOLO se c'è, altrimenti
 * l'app non partirebbe (fuse acceso + hash assente = rifiuto del caricamento).
 */
async function asarIntegrityPresent(context) {
  const info = path.join(packagedResourcesPath(context), '..', 'Info.plist')
  const raw = await readFile(info, 'utf8')
  return raw.includes('ElectronAsarIntegrity')
}

export default async function afterPack(context) {
  const resources = packagedResourcesPath(context)
  const plist = path.join(resources, '..', 'Library', 'LaunchAgents', 'app.homun.desktop.daemon.plist')
  const { stat } = await import('node:fs/promises')
  if (!(await stat(plist).catch(() => null))) {
    throw new Error(`after-pack: manca il plist del LaunchAgent nel bundle: ${plist}`)
  }
  const integrity = await asarIntegrityPresent(context)
  if (!integrity) {
    // lo si dice a schermo: verify-release approfondisce (A4.3)
    console.warn('after-pack: ElectronAsarIntegrity ASSENTE in Info.plist — il fuse di integrità resta spento')
  }
  // K3 (fase rilascio — correzioni): Electron scrive di SUO le descrizioni
  // NSMicrophoneUsageDescription / NSCameraUsageDescription di default
  // nell'Info.plist dell'app («This app needs access to the microphone»),
  // anche quando la config non le chiede. Nessuna funzione le usa e i
  // permessi sono negati in A5: si tolgono DAL BUNDLE, prima della firma.
  {
    const infoPath = path.join(resources, '..', 'Info.plist')
    const before = await readFile(infoPath, 'utf8')
    const cleaned = before
      .replace(/\s*<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]*<\/string>/g, '')
      .replace(/\s*<key>NSCameraUsageDescription<\/key>\s*<string>[^<]*<\/string>/g, '')
    if (cleaned !== before) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(infoPath, cleaned)
      console.log('after-pack: tolte le descrizioni microfono/camera di default di Electron (K3)')
    }
  }
  await flipFuses(electronBinaryPath(context), {
    version: FuseVersion.V1,
    // A1: spegni il vettore "usami come Node" — con il fuse acceso,
    // ELECTRON_RUN_AS_NODE=1 ./Homun dava un REPL con fs/rete a piene mani
    // sotto l'identità dell'app (permessi di Accessibilità, Portachiavi).
    [FuseV1Options.RunAsNode]: false,
    // niente --inspect/--inspect-brk attaccati al main impacchettato
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // niente NODE_OPTIONS nell'app pubblicata (altro vettore di flag arbitrari)
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    // cookie cifrati a riposo (via safeStorage), non in chiaro su disco
    [FuseV1Options.EnableCookieEncryption]: true,
    // il codice dell'app si carica SOLO dall'asar, non da una cartella scambiabile
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // validazione dell'asar incorporata: SOLO se electron-builder ha scritto
    // l'hash in Info.plist (vedi asarIntegrityPresent)
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: integrity,
    // dopo la riscrittura dell'eseguibile si butta la firma ad-hoc invalidata
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin'
  })
  console.log(`after-pack: fuse girati (RunAsNode off, asar integrity ${integrity ? 'ON' : 'OFF'}), plist A3 presente`)
  void repoRoot
}
