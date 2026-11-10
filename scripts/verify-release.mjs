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
// - FASE RILASCIO DI PROVA (RP2): per OGNI Mach-O sotto Contents/Resources/
//   vendor (llama-server, le sue dylib, il .node di Engramma):
//   codesign --verify --strict, Team ID uguale a quello dell'app, flag
//   runtime, architettura arm64 — e ogni @rpath/@loader_path di llama-server
//   (otool -L) che si risolve DENTRO il bundle, mai /opt/homebrew o /usr/local.
//   Non firmata (--dir, release:local): la parte che non dipende dalla firma
//   (percorsi, architettura, otool) resta e codesign si salta.
// - con --signed: codesign --verify --deep --strict e stapler validate.
//
// FASE RILASCIO — CORREZIONI (K3):
// - il bundle si chiama Homun.app CON LA MAIUSCOLA (una volta copiata in
//   /Applications non deve sostituire Homun.app di Homun 2 cambiando forma);
// - CFBundleIconFile non è electron.icns (l'icona è quella di Homun);
// - NESSUNA descrizione di microfono/camera in Info.plist (nessuna funzione
//   le usa, i permessi sono negati in A5); M7: NESSUNA NS*UsageDescription
//   fuori da un elenco esplicito (oggi vuoto).
//
// RP2: le verifiche vendor vivono in funzioni ESPORTATE con exec iniettabile
// (i test le provano su un bundle finto senza firmare nulla); il corpo CLI
// gira solo quando lo script è invocato davvero (isCli), così l'import nei
// test non esce con process.exit.
//
// FASE VERIFY-RELEASE CLI (RT1): il percorso del bundle si normalizza UNA
// VOLTA all'ingresso (in CI APP_PATH esce da `find dist-installers …` ed è
// RELATIVO) e anche le funzioni esportate risolvono i propri percorsi da
// sole: nessun confronto dipende da come il chiamante scrive il percorso.
import { readFile, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCurrentFuseWire, FuseVersion, FuseV1Options } from '@electron/fuses'
// FuseState vive nel sottomodulo constants (valori byte del fuse wire)
import { FuseState } from '@electron/fuses/dist/constants.js'

// ---- RP2: i pezzi della verifica vendor, esportati e iniettabili ----

/** L'exec di produzione: codesign scrive su stderr, otool su stdout. */
export const defaultExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** I percorsi dylib delle load commands da `otool -L` (righe indentate). */
export function parseLoadPaths(otoolL) {
  return otoolL
    .split('\n')
    .filter((l) => l.startsWith('\t'))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean)
}

/** I path degli LC_RPATH da `otool -l` (possono contenere @loader_path). */
export function parseRpaths(otoolLowerL) {
  const out = []
  for (const m of otoolLowerL.matchAll(/LC_RPATH[\s\S]*?path\s+(\S+)\s+\(offset/g)) out.push(m[1])
  return out
}

/** @loader_path/@executable_path/x risolti rispetto alla cartella del binario. */
function resolveLoaderToken(token, binaryDir) {
  return path.resolve(binaryDir, token)
}

/**
 * Un LC_RPATH spogliato del token @loader_path/@executable_path (nudo o con
 * slash — il binario vero di llama.cpp ha LC_RPATH = @loader_path SENZA
 * slash): '' → la cartella del binario, null → non è un token (rpath assoluto).
 */
function stripRpathToken(rp) {
  if (rp === '@loader_path') return ''
  if (rp.startsWith('@loader_path/')) return rp.slice('@loader_path/'.length)
  if (rp === '@executable_path') return ''
  if (rp.startsWith('@executable_path/')) return rp.slice('@executable_path/'.length)
  return null
}

/**
 * RP2: ogni dipendenza @… di llama-server deve risolversi DENTRO il bundle.
 * - /opt/homebrew o /usr/local: rifiutati subito (dipendenze Homebrew);
 * - @loader_path/@executable_path: risolti rispetto a binaryDir;
 * - @rpath: provati gli LC_RPATH (anch'essi relativi al binario), vince il
 *   primo candidato che ESISTE; poi il risultato deve stare sotto contentsPath.
 * Torna l'elenco dei problemi (vuoto = tutto dentro il bundle).
 */
export function checkVendorDeps({ loads, rpaths = [], binaryDir, contentsPath, exists = existsSync }) {
  // RT1: i candidati nascono assoluti (path.resolve), quindi i percorsi si
  // normalizzano ALL'INGRESSO — chi chiama può passare anche relativi
  binaryDir = path.resolve(binaryDir)
  contentsPath = path.resolve(contentsPath)
  const problems = []
  const inside = (p) => p === contentsPath || p.startsWith(contentsPath + path.sep)
  for (const load of loads) {
    if (/^\/(opt\/homebrew|usr\/local)\//.test(load)) {
      problems.push(`${load}: dipendenza Homebrew nel bundle (mai /opt/homebrew o /usr/local)`)
      continue
    }
    if (!load.startsWith('@')) continue // /usr/lib, /System: librerie di sistema
    let resolved = null
    if (load.startsWith('@loader_path/') || load.startsWith('@executable_path/')) {
      resolved = resolveLoaderToken(load.replace(/^@(loader|executable)_path\//, ''), binaryDir)
    } else if (load.startsWith('@rpath/')) {
      const rest = load.slice('@rpath/'.length)
      for (const rp of rpaths) {
        const stripped = stripRpathToken(rp)
        const base = stripped === null ? rp : stripped === '' ? binaryDir : resolveLoaderToken(stripped, binaryDir)
        const candidate = path.resolve(base, rest)
        if (exists(candidate)) {
          resolved = candidate
          break
        }
      }
      if (resolved === null) {
        problems.push(`${load} non si risolve DENTRO il bundle (rpath: ${rpaths.join(', ') || 'nessuno'})`)
        continue
      }
    } else {
      continue // @executable_path di altro genere: non nostro
    }
    if (!inside(resolved)) {
      problems.push(`${load} si risolve FUORI dal bundle: ${resolved}`)
      continue
    }
    if (!exists(resolved)) {
      problems.push(`${load} → ${resolved} manca nel bundle`)
    }
  }
  return problems
}

/** Ogni file Mach-O sotto vendor (relativo a vendorDir), col `file -b` iniettabile. */
export async function collectVendorMachOs(vendorDir, fileOf) {
  const found = []
  const walk = async (dir, rel) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const abs = path.join(dir, e.name)
      const relName = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(abs, relName)
      else if (fileOf(abs).includes('Mach-O')) found.push(relName)
    }
  }
  await walk(vendorDir, '')
  return found.sort()
}

/**
 * RP2: la verifica di OGNI Mach-O sotto Contents/Resources/vendor.
 * Firmata (--signed): codesign --verify --strict, Team ID = quello dell'app,
 * flag runtime, architettura arm64. Non firmata: solo architettura (e otool):
 * i binari di release:local hanno semmai firme ad-hoc, non del team.
 * Per llama-server anche le dipendenze (checkVendorDeps). Butta un errore che
 * elenca TUTTI i problemi; torna il report per il JSON finale.
 */
export async function verifyVendorBinaries({ appPath, contentsPath, signed, exec = defaultExec }) {
  // RT1: come in checkVendorDeps, la normalizzazione sta all'ingresso
  contentsPath = path.resolve(contentsPath)
  const vendorDir = path.join(contentsPath, 'Resources', 'vendor')
  const machos = await collectVendorMachOs(vendorDir, (f) => exec('file', ['-b', f]).out)
  if (machos.length === 0) throw new Error(`nessun binario Mach-O sotto ${vendorDir}: il bundle vendor manca`)
  const teamOf = (info) => (/TeamIdentifier=(\S+)/.exec(info) ?? [])[1] ?? null
  const appTeam = signed ? teamOf(exec('codesign', ['-dv', '--verbose=2', appPath]).out) : null
  const problems = []
  const binaries = []
  for (const rel of machos) {
    const file = path.join(vendorDir, rel)
    let team = null
    let runtime = null
    if (signed) {
      const v = exec('codesign', ['--verify', '--strict', file])
      if (v.status !== 0) problems.push(`${rel}: codesign --verify --strict fallito (${v.out.trim() || 'nessuna firma valida'})`)
      const info = exec('codesign', ['-dv', '--verbose=2', file]).out
      team = teamOf(info)
      runtime = /flags=0x[0-9a-f]*\(.*runtime/.test(info)
      if (!team || team !== appTeam) problems.push(`${rel}: TeamIdentifier ${team} ≠ ${appTeam} (quello dell'app)`)
      if (!runtime) problems.push(`${rel}: hardened runtime assente dalla firma`)
    }
    const fileOut = exec('file', ['-b', file]).out
    const arch = /arm64/.test(fileOut) ? 'arm64' : /x86_64/.test(fileOut) ? 'x64' : '?'
    if (arch !== 'arm64') problems.push(`${rel}: architettura inattesa «${fileOut.trim()}» (attesa arm64)`)
    binaries.push({ path: `Resources/vendor/${rel}`, arch, team, runtime })
  }
  // llama-server: ogni @rpath/@loader_path di otool -L DENTRO il bundle
  const llama = path.join(vendorDir, 'llama', 'llama-server')
  if (existsSync(llama)) {
    const loads = parseLoadPaths(exec('otool', ['-L', llama]).out)
    const rpaths = parseRpaths(exec('otool', ['-l', llama]).out)
    problems.push(...checkVendorDeps({ loads, rpaths, binaryDir: path.dirname(llama), contentsPath }))
  }
  if (problems.length > 0) throw new Error(`binari vendor non a posto:\n  - ${problems.join('\n  - ')}`)
  return { binaries }
}

// ---- CLI (solo da riga di comando: importato dai test non esce) ----
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

async function main() {
  const givenPath = process.argv[2]
  function option(name) {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const expectedArch = option('--expected-arch') ?? 'arm64'
  const signed = process.argv.includes('--signed')
  if (!givenPath) {
    console.error('Usage: verify-release.mjs <Homun.app> [--expected-arch arm64] [--expected-version 0.3.1000] [--signed]')
    process.exit(2)
  }
  // RT1: il percorso si risolve UNA volta sola, qui: da qui in avanti tutto
  // usa l'assoluto (in CI APP_PATH arriva relativo da `find dist-installers …`)
  const appPath = path.resolve(givenPath)

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

  // ---- 1bis. i binari nativi di vendor (RP2: OGNI Mach-O, non solo Engramma) ----
  // Il .node sta FUORI dall'asar (Resources/vendor/engramma, via extraResources:
  // un modulo nativo va mappato dal file system) e deve essere l'esatto binario
  // agganciato da vendor/engramma/engramma.lock.json. Nella build FIRMATA
  // electron-builder lo rifirma (tramite @electron/osx-sign, che firma ogni
  // binario di Contents con entitlementsInherit e hardened runtime): l'hash
  // del lock vale solo per la build locale; --signed controlla autorità e
  // runtime di TUTTI i Mach-O di vendor (verifyVendorBinaries).
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
  let vendorReport
  try {
    vendorReport = await verifyVendorBinaries({ appPath, contentsPath: contents, signed })
  } catch (e) {
    die(e instanceof Error ? e.message : String(e))
  }

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
        engramma: { tag: engrammaLock.tag },
        vendor: { machO: vendorReport.binaries, llamaDeps: 'tutte dentro il bundle' },
        fuses: fuseReport,
        notarized
      },
      null,
      2
    )
  )
}

if (isCli) {
  await main()
}
