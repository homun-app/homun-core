// Verifica della .app prodotta da electron-builder (fase rilascio A4 —
// adattato da homun2 scripts-verify-release.mjs.txt; niente receipt del
// motore: qui si controlla l'app ELECTRON).
//
//   node scripts/verify-release.mjs <percorso-Homun.app> [--expected-arch arm64] [--signed] [--expected-version 0.3.1000]
//
// - architettura dell'eseguibile (arm64);
// - Info.plist: CFBundleIdentifier app.homun.desktop e versione attesa;
// - il plist del LaunchAgent (A3) DENTRO il bundle;
// - i FUSE letti dall'eseguibile (@electron/fuses) coi valori attesi;
// - app.asar presente e NESSUN sorgente sciolto in Contents/Resources/app;
// - con --signed: codesign --verify --deep --strict e stapler validate.
//
// FASE RILASCIO — CORREZIONI (K3):
// - il bundle si chiama Homun.app CON LA MAIUSCOLA (una volta copiata in
//   /Applications non deve sostituire Homun.app di Homun 2 cambiando forma);
// - CFBundleIconFile non è electron.icns (l'icona è quella di Homun);
// - NESSUNA descrizione di microfono/camera in Info.plist (nessuna funzione
//   le usa, i permessi sono negati in A5); M7: NESSUNA NS*UsageDescription
//   fuori da un elenco esplicito (oggi vuoto).
import { readFile, stat, readdir } from 'node:fs/promises'
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
const signed = process.argv.includes('--signed')
if (!appPath) {
  console.error('Usage: verify-release.mjs <Homun.app> [--expected-arch arm64] [--expected-version 0.3.1000] [--signed]')
  process.exit(2)
}

// versione attesa: flag esplicito, altrimenti quella del package.json del repo
// (lo script npm release:verify la passa con $npm_package_version)
const repoPackage = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
const expectedVersion = option('--expected-version') ?? repoPackage.version
if (expectedVersion !== repoPackage.version) {
  die(`versione attesa ${expectedVersion} diversa da quella del package.json (${repoPackage.version})`)
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
// K3: il bundle si chiama Homun.app, con la maiuscola esatta. Il nome si
// legge DAL DISCO: APFS è case-insensitive, il percorso passato potrebbe
// aprire homun.app anche scrivendo Homun.app
const normalized = path.normalize(appPath).replace(/\/+$/, '')
const givenName = path.basename(normalized)
const parentEntries = await readdir(path.dirname(normalized)).catch(() => [])
const onDisk = parentEntries.find((e) => e === givenName)
if (!onDisk) {
  const ci = parentEntries.find((e) => e.toLowerCase() === givenName.toLowerCase())
  die(`il bundle non esiste col nome esatto «${givenName}» (su disco: ${ci ?? 'niente con quel nome'})`)
}
const bundleName = onDisk
if (bundleName !== 'Homun.app') die(`il bundle si chiama «${bundleName}» e non «Homun.app»: una volta copiata in /Applications sostituirebbe Homun.app di Homun 2 cambiando la forma del nome (K3)`)
const contents = path.join(appPath, 'Contents')
const resources = path.join(contents, 'Resources')
const exe = path.join(contents, 'MacOS', 'Homun')
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
// K3: l'icona non è quella di Electron…
const iconFile = (/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(info) ?? [])[1]
if (!iconFile) die('CFBundleIconFile assente in Info.plist')
if (iconFile === 'electron.icns') die(`CFBundleIconFile è electron.icns: l'icona dell'app è quella di Electron (K3)`)
if (!(await stat(path.join(resources, iconFile)).catch(() => null))) die(`l'icona del bundle manca: Resources/${iconFile}`)
// …e nessuna descrizione di microfono/camera (funzioni inesistenti, permessi negati in A5).
// M7 (fase 0.3.1001): NESSUNA NS*UsageDescription fuori da un elenco esplicito
// (oggi vuoto): Electron ne scrive di generiche in inglese che Homun non usa
const ALLOWED_USAGE_KEYS = new Set([])
const usageKeys = [...info.matchAll(/<key>(NS[A-Za-z]+UsageDescription)<\/key>/g)].map((m) => m[1])
const unexpectedUsage = usageKeys.filter((k) => !ALLOWED_USAGE_KEYS.has(k))
if (unexpectedUsage.length > 0) {
  die(`NS*UsageDescription in Info.plist fuori dall'elenco consentito: ${unexpectedUsage.join(', ')} (M7 — nessuna funzione di Homun le usa; se una serve, aggiungerla ad ALLOWED_USAGE_KEYS e motivarla nel REPORT)`)
}

// ---- 1bis. il modulo nativo di Engramma (fase memoria-engramma M0) ----
// Il .node sta FUORI dall'asar (Resources/vendor/engramma, via extraResources:
// un modulo nativo va mappato dal file system), deve essere l'esatto binario
// agganciato da vendor/engramma/engramma.lock.json e portare una firma valida
// anche da solo (hardened runtime: ogni libreria nativa è firmata). Nella
// build firmata electron-builder lo rifirma con l'identità dell'app: l'hash
// del lock vale per la build locale (--signed controlla autorità e runtime).
const engrammaNode = path.join(resources, 'vendor', 'engramma', 'engramma.darwin-arm64.node')
if (!(await stat(engrammaNode).catch(() => null))) die(`manca il modulo nativo di Engramma: ${engrammaNode}`)
const engrammaLockPath = path.join(scriptDir, '..', 'vendor', 'engramma', 'engramma.lock.json')
const engrammaLock = JSON.parse(await readFile(engrammaLockPath, 'utf8'))
if (!signed) {
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256').update(await readFile(engrammaNode)).digest('hex')
  if (hash !== engrammaLock.files?.['engramma.darwin-arm64.node']) {
    die(`engramma.darwin-arm64.node nel bundle non è la versione agganciata da ${engrammaLockPath} (tag ${engrammaLock.tag})`)
  }
}
const engrammaSign = run('codesign', ['--verify', '--strict', '--verbose=2', engrammaNode], 'Firma del .node di Engramma (codesign --verify --strict)')
if (signed) {
  // firmato davvero: stessa squadra dell'app e hardened runtime
  const appInfo = run('codesign', ['-dv', '--verbose=2', appPath], 'Lettura della firma dell\'app')
  const nodeInfo = run('codesign', ['-dv', '--verbose=2', engrammaNode], 'Lettura della firma del .node')
  const team = (s) => (/TeamIdentifier=(\S+)/.exec(s) ?? [])[1]
  if (!team(nodeInfo) || team(nodeInfo) !== team(appInfo)) die(`il .node di Engramma non è firmato dalla squadra dell'app (${team(nodeInfo)} ≠ ${team(appInfo)})`)
  if (!/flags=0x[0-9a-f]*\(.*runtime/.test(nodeInfo)) die('il .node di Engramma non ha l\'hardened runtime')
}
void engrammaSign

// ---- 2. il plist del LaunchAgent (A3) ----
const agentPlist = path.join(contents, 'Library', 'LaunchAgents', 'app.homun.desktop.daemon.plist')
const agentRaw = await readFile(agentPlist, 'utf8').catch(() => null)
if (agentRaw === null) die(`manca il plist del servizio nel bundle: ${agentPlist}`)
for (const needle of ['app.homun.desktop.daemon', 'Contents/MacOS/Homun', '--homun-daemon', '<key>SuccessfulExit</key>']) {
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
      bundleName,
      version: shortVersion,
      icon: iconFile,
      asarIntegrityInInfoPlist: asarIntegrity,
      launchAgentPlist: true,
      engramma: { tag: engrammaLock.tag, node: path.relative(contents, engrammaNode), codesign: 'ok' },
      fuses: fuseReport,
      notarized
    },
    null,
    2
  )
)
