// Verifica della .app prodotta da electron-builder (fase rilascio A4 —
// adattato da homun2 scripts-verify-release.mjs.txt; niente receipt del
// motore: qui si controlla l'app ELECTRON).
//
//   node scripts/verify-release.mjs <percorso-Homun.app> [--expected-arch arm64] [--signed] [--expected-version 0.3.0]
//
// - architettura dell'eseguibile (arm64);
// - Info.plist: CFBundleIdentifier app.homun.desktop e versione attesa;
// - il plist del LaunchAgent (A3) DENTRO il bundle;
// - i FUSE letti dall'eseguibile (@electron/fuses) coi valori attesi;
// - app.asar presente e NESSUN sorgente sciolto in Contents/Resources/app;
// - con --signed: codesign --verify --deep --strict e stapler validate.
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCurrentFuseWire, FuseVersion, FuseV1Options } from '@electron/fuses'
// FuseState vive nel sottomodulo constants (valori byte del fuse wire)
import { FuseState } from '@electron/fuses/dist/constants.js'

const appPath = process.argv[2]
function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const expectedArch = option('--expected-arch') ?? 'arm64'
const expectedVersion = option('--expected-version') ?? null
const signed = process.argv.includes('--signed')
if (!appPath) {
  console.error('Usage: verify-release.mjs <Homun.app> [--expected-arch arm64] [--expected-version 0.3.0] [--signed]')
  process.exit(2)
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
void scriptDir

function run(command, args, what) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${what} failed\n${result.stdout || ''}\n${result.stderr || ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function die(msg) {
  console.error(`verify-release: ${msg}`)
  process.exit(1)
}

// ---- 1. struttura e Info.plist ----
const contents = path.join(appPath, 'Contents')
const resources = path.join(contents, 'Resources')
const exe = path.join(contents, 'MacOS', 'homun')
if (!(await stat(exe).catch(() => null))) die(`manca l'eseguibile ${exe}`)
if (!(await stat(path.join(resources, 'app.asar')).catch(() => null))) die('manca Resources/app.asar')
// niente sorgenti sciolti: l'app sta tutta nell'asar
const loose = path.join(resources, 'app')
if (await stat(loose).catch(() => null)) die(`sorgenti sciolti fuori dall'asar: ${loose}`)
if (await stat(path.join(contents, 'Resources', 'app.asar.unpacked', 'main', 'daemon.js')).catch(() => null)) {
  die('daemon.js unpacked fuori dall\'asar: col fuse OnlyLoadAppFromAsar il daemon viaggia nel main bundle (A1)')
}

const info = await readFile(path.join(contents, 'Info.plist'), 'utf8')
const bundleId = (/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(info) ?? [])[1]
if (bundleId !== 'app.homun.desktop') die(`CFBundleIdentifier inatteso: ${bundleId}`)
const shortVersion = (/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(info) ?? [])[1]
if (expectedVersion && shortVersion !== expectedVersion) die(`versione inattesa: ${shortVersion} (attesa ${expectedVersion})`)
const asarIntegrity = info.includes('ElectronAsarIntegrity')

// ---- 2. il plist del LaunchAgent (A3) ----
const agentPlist = path.join(contents, 'Library', 'LaunchAgents', 'app.homun.desktop.daemon.plist')
const agentRaw = await readFile(agentPlist, 'utf8').catch(() => null)
if (agentRaw === null) die(`manca il plist del servizio nel bundle: ${agentPlist}`)
for (const needle of ['app.homun.desktop.daemon', 'Contents/MacOS/homun', '--homun-daemon', '<key>SuccessfulExit</key>']) {
  if (!agentRaw.includes(needle)) die(`il plist A3 non contiene ${needle}`)
}

// ---- 3. architettura ----
const fileInfo = spawnSync('file', [exe], { encoding: 'utf8' })
if (fileInfo.status !== 0) die('file(1) fallito sull\'eseguibile')
const arch = fileInfo.stdout.includes('arm64') ? 'arm64' : fileInfo.stdout.includes('x86_64') ? 'x64' : '?'
if (expectedArch && arch !== expectedArch) die(`architettura inattesa: ${fileInfo.stdout.trim()}`)

// ---- 4. fuse ----
const EXPECTED_FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true
}
let wire
try {
  wire = await getCurrentFuseWire(exe)
} catch (e) {
  die(`lettura dei fuse fallita: ${e.message}`)
}
if (String(wire.version) !== String(FuseVersion.V1)) die(`fuse wire non V1: ${wire.version}`)
const fuseState = (index) => {
  const v = wire[index]
  if (v === FuseState.ENABLE) return true
  if (v === FuseState.DISABLE) return false
  return `state:${v}`
}
const FUSE_NAMES = Object.fromEntries(Object.entries(FuseV1Options).filter(([k]) => isNaN(Number(k))).map(([k, v]) => [v, k]))
const fuseReport = {}
for (const [idx, expected] of Object.entries(EXPECTED_FUSES)) {
  const name = FUSE_NAMES[idx] ?? idx
  const actual = fuseState(Number(idx))
  fuseReport[name] = actual
  if (actual !== expected) die(`fuse ${name}: atteso ${expected}, trovato ${actual}`)
}
// il fuse di integrità dell'asar segue ElectronAsarIntegrity in Info.plist
const integrityFuse = fuseState(FuseV1Options.EnableEmbeddedAsarIntegrityValidation)
fuseReport.EnableEmbeddedAsarIntegrityValidation = integrityFuse
if (asarIntegrity && !integrityFuse) die('ElectronAsarIntegrity presente in Info.plist ma il fuse è SPENTO')
if (!asarIntegrity && integrityFuse) die('fuse di integrità ACCESO senza hash in Info.plist: l\'app non partirebbe')

// ---- 5. firma (solo --signed) ----
let notarized = false
if (signed) {
  run('codesign', ['--verify', '--deep', '--strict', appPath], 'Deep code-signature verification')
  run('xcrun', ['stapler', 'validate', appPath], 'Notarization ticket validation')
  notarized = true
}

console.log(
  JSON.stringify(
    {
      app: appPath,
      mode: signed ? 'signed' : 'unsigned',
      arch,
      bundleId,
      version: shortVersion,
      asarIntegrityInInfoPlist: asarIntegrity,
      launchAgentPlist: true,
      fuses: fuseReport,
      notarized
    },
    null,
    2
  )
)
