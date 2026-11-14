#!/usr/bin/env node
// Fase box-container (BX5): la CLI FINTA di Apple `container`, per le prove
// senza motore vero (come il provider finto delle sonde). Registra OGNI argv
// che riceve (una riga JSON per chiamata, in append su $SANDBOT_TEST_CONTAINER_LOG)
// e risponde ai comandi che il motore usa: --version, system status/start/
// kernel set, system df --format json, image inspect/prune/delete, volume
// create/ls/delete, network create/inspect, ls, inspect, stop/start/rm, exec,
// cp, run, build.
//
// Il comportamento si sceglie con SANDBOT_TEST_CONTAINER_MODE:
//   not-installed  tutto esce 127 (la CLI «non c'è»)
//   stopped        --version ok, system status: status "stopped"
//   kernel-missing status: status "running" MA il FILE del kernel assente
//   ready          (default) tutto a posto (kernel compreso)
//
// OBV5 (fase onboarding-b-dal-vivo): la finta PARLA COME LA VERA —
// `system status --format json` stampa il JSON VERO della 1.7.1 (una riga,
// le fixture della prova dal vivo) e `system status` la TABELLA VERA senza
// separatori; l'appRoot è quello di prova (SANDBOT_TEST_CONTAINER_APP_ROOT,
// altrimenti una cartella accanto al log). Il KERNEL è un FILE VERO della
// cartella kernels/ dell'appRoot (default.kernel-arm64 → symlink →
// vmlinux-6.18.56-208-debug non vuoto): lo crea `system system kernel set
// --recommended`, e se c'è GIÀ esce 1 con l'errore VERO di «File exists»
// (il comando vero NON è idempotente). Chi legge lo status lo rileva dal
// FILE, come il codice vero dopo OBV1.
//
// BAV1 (fase box-apple-cli-vera): la finta è SEVERA come la VERA. La prova
// dal vivo del 2026-11-14 è morta perché il motore parlava Docker alla CLI
// di Apple e la finta lo accettava: ORA
//   - `--format` con un valore che non sia json/table/yaml/toml esce 64 con
//     l'errore VERO («The value … is invalid …»);
//   - `inspect --format` e `image inspect --format` escono 64 con
//     `Error: Unknown option '--format'`;
//   - `volume create` di un volume che ESISTE esce 1 con l'errore VERO
//     (NON è idempotente);
//   - le opzioni dei sottocomandi con la help in fixture si controllano
//     contro la HELP VERA (es. `volume ls --filter` → Unknown option);
//   - `ls -a --format json`, `inspect`, `volume ls --format json` e
//     `system df --format json` stampano il FORMATO VERO delle fixture
//     (stesse chiavi, stessa forma), riempito con lo STATO della finta
//     (container, volumi, rete, immagine — vissuti nel log).
// Se qualcosa dipende dal formato si corregge il codice, non la finta.
//
// Il DIALETTO Docker (i test di confronto dei motori passano qui i loro
// argv: `ps`, `inspect -f`, `create`, `image rm`, `builder`): quelle
// chiamate restano come prima, e in quella corsa volume create resta
// idempotente come la CLI di Docker. Il motore Apple non li usa MAI.
//
// BR1 (fase box-rete): il STATO si ricorda rileggendo il proprio log — i
// container creati da `run -d`/`create` (nome, rete, immagine, --init, i
// mount) esistono per `ls` e gli inspect finché un `rm` non li toglie; le
// RETI esistono dopo `network create` (homun-box c'è già, homun-box-isolated
// no) e i VOLUMI dopo `volume create` o un run/create che li monta. Un `run
// -d` SENZA --network viene RIFIUTATO con errore: con la CLI di Apple
// «nessuna rete» non esiste, un run senza flag va sulla rete PREDEFINITA in
// NAT verso Internet — nessuna sonda futura può passare col difetto. Con
// SANDBOT_TEST_CONTAINER_OPERSTATE=up l'exec della VERIFICA (lo script che
// legge operstate) fallisce: le interfacce non sono giù. Con
// SANDBOT_TEST_CONTAINER_ISOLATED_FAIL=1 la create di homun-box-isolated
// cade: la rete isolata non si può creare.
//
// BRR (fase box-rete-riavvio): il RIAVVIO — ogni container Apple è una VM:
// il `run -d` è un boot nuovo e le interfacce sono SU; un `start` di un box
// FERMATO (uno `stop` nel log) è un boot nuovo pure lui e le interfacce
// tornano SU; su un box già avanti lo start non fa nulla. Il link down come
// root le mette GIÙ. L'exec della VERIFICA legge questo stato: boot senza
// link down → «eth0 is up» (esce 1), dopo il link down → passa.
//
// Nessuna rete, nessuna scrittura fuori dall'appRoot di prova e dal file di
// log. La usa il motore al posto della CLI vera SOLO con
// SANDBOT_TEST_USER_DATA impostata E
// SANDBOT_TEST_CONTAINER_CLI=<percorso di questo file> (sandbox/engine).
import { appendFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const MODE = process.env.SANDBOT_TEST_CONTAINER_MODE ?? 'ready'
const argv = process.argv.slice(2)

// la registrazione PRIMA di tutto: anche le chiamate che «falliscono» si vedono
if (process.env.SANDBOT_TEST_CONTAINER_LOG) {
  try {
    appendFileSync(process.env.SANDBOT_TEST_CONTAINER_LOG, `${JSON.stringify({ at: Date.now(), mode: MODE, argv })}\n`)
  } catch { /* il log è best-effort */ }
}

const out = (s) => { process.stdout.write(`${s}\n`) }
const die = (code, msg) => { process.stderr.write(`${msg}\n`); process.exit(code) }

if (MODE === 'not-installed') die(127, 'container: command not found')

/** Le righe del log (gli argv già ricevuti): lo STATO della CLI finta. */
const logArgvs = () => {
  try {
    return readFileSync(process.env.SANDBOT_TEST_CONTAINER_LOG ?? '', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv)
  } catch {
    return []
  }
}

// ---- BAV1: la help VERA delle fixture → le opzioni ammesse per sottocomando ----
const FIXTURES_DIR = join(import.meta.dirname, '..', 'src', 'main', 'sandbox', '__tests__', 'fixtures', 'container-1.7.1')
const HELP_FILES = {
  run: 'run-help.txt',
  exec: 'exec-help.txt',
  cp: 'cp-help.txt',
  start: 'start-help.txt',
  rm: 'rm-help.txt',
  'system start': 'system-start-help.txt',
  'volume ls': 'volume-ls-help.txt',
  'volume delete': 'volume-delete-help.txt',
  'network create': 'network-create-help.txt',
  'image prune': 'image-prune-help.txt',
  'image delete': 'image-delete-help.txt'
}
const helpText = (sub) => {
  try {
    return HELP_FILES[sub] ? readFileSync(join(FIXTURES_DIR, HELP_FILES[sub]), 'utf8') : null
  } catch {
    return null
  }
}
/** La firma di un sottocomando: opzione → prende un valore? (righe `-x, --long <v>`). */
const helpSignature = (sub) => {
  const text = helpText(sub)
  if (text === null) return null
  const options = new Map()
  for (const raw of text.split('\n')) {
    const m = /^ {2,}((?:-{1,2}[A-Za-z0-9][\w-]*)(?:[ ,/]+(?:-{1,2}[A-Za-z0-9][\w-]*))*(?:[ ]+<[^>]+>)?).*/.exec(raw)
    if (!m) continue
    const takes = /<[^>]+>\s*$/.test(m[1].trim())
    for (const t of m[1].split(/[ ,/]+/)) if (/^-{1,2}[A-Za-z0-9][\w-]*$/.test(t)) options.set(t, takes)
  }
  return options
}
const subcommandOf = (a) => {
  if (typeof a[0] !== 'string') return ''
  if (a[0] === 'system' || a[0] === 'volume' || a[0] === 'image' || a[0] === 'network' || a[0] === 'builder') {
    return [a[0], a[1]].filter(Boolean).join(' ')
  }
  return a[0]
}

/** I valori ammessi di --format: dall'errore VERO della 1.7.1. */
const FORMAT_VALUES = ['json', 'table', 'yaml', 'toml']
/** I sottocomandi che ACCETTANO --format (gli altri lo rifiutano: Unknown option). */
const FORMAT_SUBCOMMANDS = ['ls', 'volume ls', 'image ls', 'network ls', 'system status', 'system df']

/** Il dialetto Docker: i test di confronto dei motori passano qui i loro argv. */
const dockerDialect = () => {
  for (const a of logArgvs()) {
    if (!Array.isArray(a) || typeof a[0] !== 'string') continue
    if (a[0] === 'ps' || a[0] === 'create' || a[0] === 'builder') return true
    if (a[0] === 'inspect' && a.includes('-f')) return true
    if (a[0] === 'image' && (a[1] === 'rm' || a[1] === 'prune') && a.includes('-f')) return true
  }
  return false
}

// BAV1: la severità — prima del comando, sui dialetti sbagliati
if (!dockerDialect()) {
  const sub = subcommandOf(argv)
  const sig = helpSignature(sub)
  // le opzioni del sottocomando contro la help VERA (le righe `-x, --long`)
  if (sig !== null) {
    let i = 0
    for (const w of sub.split(' ')) if (argv[i] === w) i++
    for (; i < argv.length; i++) {
      const t = argv[i]
      if (t === '--' || !t.startsWith('-')) break
      if (t.startsWith('--') && t.includes('=')) {
        if (!sig.has(t.slice(0, t.indexOf('=')))) die(64, `Error: Unknown option '${t.slice(0, t.indexOf('='))}'`)
        continue
      }
      if (!sig.has(t)) die(64, `Error: Unknown option '${t}'`)
      if (sig.get(t)) i++ // l'opzione prende un valore: si salta
    }
  }
  // --format: solo sui sottocomandi che ce l'hanno, solo coi valori VERI
  const fi = argv.indexOf('--format')
  if (fi >= 0 && typeof argv[fi + 1] === 'string') {
    if (!FORMAT_SUBCOMMANDS.includes(sub)) die(64, "Error: Unknown option '--format'")
    if (!FORMAT_VALUES.includes(argv[fi + 1])) {
      die(64, `Error: The value '${argv[fi + 1]}' is invalid for '--format <format>'. Please provide one of 'json', 'table', 'yaml' or 'toml'.`)
    }
  }
  if (fi >= 0 && argv[fi + 1] === undefined) die(64, `Error: The value '' is invalid for '--format <format>'. Please provide one of 'json', 'table', 'yaml' or 'toml'.`)
}

/**
 * BAV5: i file del WRAPPER DI BACKGROUND visti nel log. Ogni exec -d col
 * wrapper (sh -c <wrapper> sh <cmd> <log> <exit> <pid>) «ha scritto» i suoi
 * tre file nel box: le letture (cat) di quei percorsi rispondono.
 */
function shellWrapperFiles(all) {
  const files = { log: new Set(), exit: new Set(), pid: new Set() }
  for (const a of all) {
    if (!Array.isArray(a) || a[0] !== 'exec' || !a.includes('-d')) continue
    const ci = a.indexOf('-c')
    const script = ci >= 0 ? a[ci + 1] : ''
    if (typeof script !== 'string' || !script.includes('setsid') || !script.includes('"$3"')) continue
    // dopo lo script: 'sh', <comando>, <log>, <exit>, <pid>
    const log = a[ci + 4]
    const exit = a[ci + 5]
    const pid = a[ci + 6]
    if (typeof log === 'string') files.log.add(log)
    if (typeof exit === 'string') files.exit.add(exit)
    if (typeof pid === 'string') files.pid.add(pid)
  }
  return files
}

/**
 * BR1: lo stato dal log — l'ULTIMO container creato da run -d/create (nome,
 * rete, immagine, --init, i mount, i limiti) finché un rm/delete col suo
 * nome non lo toglie; le reti create (homun-box esiste GIÀ, come la prima
 * della sonda di box-container); i VOLUMI esistono dopo volume create o
 * dopo un run/create che li monta. BRR: il box sa anche se CORRE e se le
 * interfacce sono SU — il run -d è un boot (interfacce su), lo start di un
 * box FERMATO pure, il link down come root le mette giù.
 */
function scanState(opts = {}) {
  let box = null
  let built = false
  const networks = new Set(['homun-box'])
  const volumes = new Set()
  const all = logArgvs()
  // skipLast: la CHIAMATA CORRENTE è già nel log (registrata prima di tutto)
  // — volume create decide dello stato PRIMA di sé
  if (opts.skipLast) all.pop()
  for (const a of all) {
    if (!Array.isArray(a)) continue
    // OB6: la NOSTRA immagine esiste SOLO dopo una build (il log è lo stato)
    if (a[0] === 'build') built = true
    if ((a[0] === 'run' && a.includes('-d')) || a[0] === 'create') {
      const nameI = a.indexOf('--name')
      if (nameI >= 0) {
        const netI = a.indexOf('--network')
        const sleepI = a.lastIndexOf('sleep')
        const mounts = []
        for (let i = 0; i < a.length; i++) {
          if ((a[i] === '-v' || a[i] === '--volume') && typeof a[i + 1] === 'string' && a[i + 1].includes(':')) {
            const [volume, dest, ...opts] = a[i + 1].split(':')
            if (volume && dest) mounts.push({ volume, dest, ro: opts.includes('ro') })
          }
        }
        const user = a[a.indexOf('-u') + 1] ?? '1000:1000'
        const mem = String(a[a.indexOf('-m') + 1] ?? '4g')
        const memMult = /g/i.test(mem) ? 1024 ** 3 : /m/i.test(mem) ? 1024 ** 2 : /k/i.test(mem) ? 1024 : 1
        // run -d: il box CORRE e il boot ha messo le interfacce SU; create
        // (il run di Docker) parte FERMO: le decide lo start
        box = {
          name: a[nameI + 1],
          network: netI >= 0 ? a[netI + 1] : null,
          image: sleepI > 0 ? a[sleepI - 1] : 'sandbot-box:fake',
          useInit: a.includes('--init'),
          mounts,
          user: typeof user === 'string' ? user : '1000:1000',
          cpus: Number(a[a.indexOf('-c') + 1] ?? 2) || 2,
          memoryBytes: Math.round(parseFloat(mem) * memMult),
          workdir: a[a.indexOf('-w') + 1] ?? '/box',
          running: a[0] === 'run',
          linksUp: a[0] === 'run'
        }
      }
    }
    // i volumi montati da un run/create ESISTONO (la CLI crea il volume mancante)
    if ((a[0] === 'run' || a[0] === 'create') && !a.includes('--rm')) {
      for (let i = 0; i < a.length; i++) {
        if ((a[i] === '-v' || a[i] === '--volume') && typeof a[i + 1] === 'string' && a[i + 1].includes(':')) {
          const v = a[i + 1].split(':')[0]
          if (v && !v.startsWith('/')) volumes.add(v)
        }
      }
    }
    if (a[0] === 'volume' && a[1] === 'create' && typeof a[2] === 'string') volumes.add(a[2])
    // BRR: il «riavvio» — start di un box FERMATO = boot nuovo, interfacce
    // SU; su un box che già corre lo start non tocca nulla
    if (a[0] === 'start' && box && a.slice(1).includes(box.name) && !box.running) {
      box.running = true
      box.linksUp = true
    }
    if (a[0] === 'stop' && box && a.slice(1).includes(box.name)) box.running = false
    // il link down COME ROOT: le interfacce vanno GIÙ (il boot le aveva messe su)
    if (a[0] === 'exec' && a[1] === '-u' && a[2] === '0' && a.some((x) => typeof x === 'string' && x.includes('ip link set')) && box) {
      box.linksUp = false
    }
    if ((a[0] === 'rm' || a[0] === 'delete') && box && a.slice(1).includes(box.name)) box = null
    if (a[0] === 'network' && a[1] === 'create') networks.add(a[a.length - 1])
    // BAV3: la create CADUTA non lascia la rete (la finta lo segna col
    // contrario, così chi RILEGGE vede il vero)
    if (a[0] === 'network' && (a[1] === 'delete' || a[1] === 'rm')) networks.delete(a[a.length - 1])
  }
  return { box, networks, volumes, built }
}

/** Il JSON dell'inspect di una rete: subnet e gateway della rete richiesta. */
const networkJson = (name) =>
  JSON.stringify({ name, internal: true, subnets: [{ subnet: name === 'homun-box-isolated' ? '192.0.16.0/24' : '192.0.15.0/24', gateway: name === 'homun-box-isolated' ? '192.0.16.1' : '192.0.15.1' }] })

// ---- BAV1: le FORME VERE delle fixture, riempite con lo stato della finta ----

/** Il riferimento pieno dell'immagine (le library di Docker arrivano col prefisso). */
const fullImageRef = (image) => {
  if (typeof image !== 'string' || image.includes('/') || image.includes('.')) return image ?? 'sandbot-box:fake'
  return `docker.io/library/${image}`
}

const CREATED = '2026-11-14T07:30:38Z'

/** Il percorso del volume, come lo stampa la CLI vera (l'appRoot di prova). */
const volumeSource = (name) =>
  process.env.SANDBOT_TEST_CONTAINER_APP_ROOT
    ? join(process.env.SANDBOT_TEST_CONTAINER_APP_ROOT, 'volumes', name, 'volume.img')
    : `/Users/test/Library/Application Support/com.apple.container/volumes/${name}/volume.img`

/** L'elemento del box: le CHIAVI della fixture inspect-box/ls-a-json, i valori dello stato. */
function boxElement(b) {
  const ref = fullImageRef(b.image)
  return {
    configuration: {
      capAdd: [],
      capDrop: [],
      creationDate: CREATED,
      dns: { nameservers: [], options: [], searchDomains: [] },
      id: b.name,
      image: {
        descriptor: {
          annotations: {
            'com.apple.containerization.image.name': ref,
            'io.containerd.image.name': ref,
            'org.opencontainers.image.created': '2026-11-13T21:11:08Z',
            'org.opencontainers.image.ref.name': String(ref).split(':').pop() ?? ''
          },
          digest: 'sha256:ba8e44dff3b9103e8c6931f8d9091954a97c0c703d9f2b4324d61780967bddc8',
          mediaType: 'application/vnd.oci.image.index.v1+json',
          size: 375
        },
        reference: ref
      },
      initProcess: {
        arguments: ['infinity'],
        environment: ['PLAYWRIGHT_BROWSERS_PATH=/ms-playwright', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL=C.UTF-8', 'LANG=C.UTF-8'],
        executable: 'sleep',
        rlimits: [],
        supplementalGroups: [],
        terminal: false,
        user: { raw: { userString: b.user } },
        workingDirectory: b.workdir
      },
      labels: {},
      mounts: b.mounts.map((m) => ({
        destination: m.dest,
        options: m.ro ? ['ro'] : [],
        source: volumeSource(m.volume),
        type: { volume: { cache: { on: {} }, format: 'ext4', name: m.volume, sync: { fsync: {} } } }
      })),
      networks: [{ network: b.network, options: { hostname: b.name, mtu: 1280 } }],
      platform: { architecture: 'arm64', os: 'linux' },
      publishedPorts: [],
      publishedSockets: [],
      readOnly: false,
      resources: { cpuOverhead: 1, cpus: b.cpus, memoryInBytes: b.memoryBytes },
      rosetta: false,
      runtimeHandler: 'container-runtime-linux',
      ssh: false,
      sysctls: {},
      useInit: b.useInit,
      virtualization: false
    },
    id: b.name,
    status: {
      networks: [
        { hostname: b.name, ipv4Address: '192.168.128.2/24', ipv4Gateway: '192.168.128.1', ipv6Address: 'fdcb:b3be:434:c533:f8ac:c0ff:feb9:408c/64', macAddress: 'fa:ac:c0:b9:40:8c', mtu: 1280, network: b.network, variant: 'reserved' }
      ],
      startedDate: CREATED,
      state: b.running ? 'running' : 'stopped'
    }
  }
}

/** La voce di un volume: le CHIAVI della fixture volume-ls-json. */
const volumeElement = (name) => ({
  configuration: { creationDate: CREATED, driver: 'local', format: 'ext4', labels: {}, name, options: {}, sizeInBytes: 549755813888, source: volumeSource(name) },
  id: name
})

// ---- --version ----
if (argv[0] === '--version' || argv[0] === 'version') {
  out('container version 1.7.1 (fake, fase box-container)')
  process.exit(0)
}

// ---- OBV5: l'appRoot di prova e il KERNEL come FILE VERO ----
// l'appRoot della cartella di prova: quello delle sonde, o una accanto al
// log (così ogni «chiamata» del test ha il suo mondo, e afterAll la toglie).
// OBD4a (fase onboarding-b-dettagli): la finta NON crea cartelle da sola —
// senza appRoot i comandi che ne hanno bisogno escono 2
const APP_ROOT =
  process.env.SANDBOT_TEST_CONTAINER_APP_ROOT ??
  (process.env.SANDBOT_TEST_CONTAINER_LOG
    ? join(dirname(process.env.SANDBOT_TEST_CONTAINER_LOG), 'fake-app-root')
    : null)
const KERNEL_TARGET = 'vmlinux-6.18.56-208-debug'
const KERNEL_LINK = 'default.kernel-arm64'
const kernelLinkPath = () => join(APP_ROOT, 'kernels', KERNEL_LINK)

/** il kernel c'è? (il SYMLINK esiste E il bersaglio è un file non vuoto) */
const kernelPresent = () => {
  try {
    const st = statSync(kernelLinkPath()) // statSync SEGUE il symlink
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

/** crea il kernel nel layout VERO: kernels/default.kernel-arm64 → vmlinux-… */
const ensureKernel = () => {
  mkdirSync(join(APP_ROOT, 'kernels'), { recursive: true })
  const target = join(APP_ROOT, 'kernels', KERNEL_TARGET)
  if (!existsSync(target)) writeFileSync(target, Buffer.alloc(64 * 1024, 7))
  if (!existsSync(kernelLinkPath())) symlinkSync(KERNEL_TARGET, kernelLinkPath())
}

// kernel-missing è PASSIVO: il FILE decide (non si crea e NON si toglie — se
// un `kernel set` lo mette, le sonde dopo lo VEDONO, come sulla macchina vera)

// lo status DELLA MODALITÀ, pronto per JSON e tabella
const statusOfMode = () => (MODE === 'stopped' ? 'stopped' : 'running')

// OBV5: gli esiti VERI della 1.7.1 (le fixture della prova dal vivo, con
// l'appRoot di prova e lo status della modalità)
const statusJson = () =>
  '{"client":{"appName":"container","build":"release","commit":"a15b46097aa4c2325da13c1fb5192b9274aab083","version":"1.7.1"},' +
  '"host":{"architecture":"arm64","cpus":10,"operatingSystem":"Version 27.2.1 (Build 26B131)"},' +
  `"paths":{"appRoot":"${APP_ROOT}","installRoot":"/usr/local/"},` +
  '"resources":{"containersRunning":0,"containersTotal":0,"images":0},' +
  '"server":{"appName":"container-apiserver","build":"release","commit":"a15b46097aa4c2325da13c1fb5192b9274aab083","version":"1.7.1"},' +
  `"status":"${statusOfMode()}"}`
const statusTable = () =>
  'FIELD               VALUE\n' +
  `status              ${statusOfMode()}\n` +
  'client.version      1.7.1\n' +
  'client.build        release\n' +
  'client.commit       a15b46097aa4c2325da13c1fb5192b9274aab083\n' +
  'host.os             Version 27.2.1 (Build 26B131)\n' +
  'host.architecture   arm64\n' +
  'host.cpus           10\n' +
  'server.version      1.7.1\n' +
  'server.build        release\n' +
  'server.commit       a15b46097aa4c2325da13c1fb5192b9274aab083\n' +
  'server.appName      container-apiserver\n' +
  `paths.appRoot       ${APP_ROOT}\n` +
  'paths.installRoot   /usr/local/\n' +
  'paths.logRoot       \n' +
  'containers.total    0\n' +
  'containers.running  0\n' +
  'images.total        0'

/** l'errore VERO di kernel set quando il kernel c'è già (non è idempotente) */
const KERNEL_FILE_EXISTS_STDERR =
  'Error Domain=NSCocoaErrorDomain Code=516 "The file “default.kernel-arm64” couldn’t be copied because an item with the same name already exists." ' +
  `UserInfo={NSSourceFilePathErrorKey=${APP_ROOT}/kernels/${KERNEL_TARGET}} ` +
  'NSUnderlyingError=0x600000c4e000 (NSPOSIXErrorDomain Code=17 "File exists")'

// ---- system ----
if (argv[0] === 'system') {
  // OBD4a: i comandi che hanno bisogno dell'appRoot, senza appRoot escono 2
  if ((argv[1] === 'status' || (argv[1] === 'kernel' && argv[2] === 'set')) && !APP_ROOT) {
    die(2, 'fake-container: SANDBOT_TEST_CONTAINER_APP_ROOT mancante')
  }
  if (argv[1] === 'status') {
    // OBV5: la finta parla come la vera — col flag il JSON (una riga), senza
    // la TABELLA di default. Il kernel è un FILE: ready lo crea (come dopo
    // un kernel set); kernel-missing è passivo (il FILE decide); stopped
    // non lo tocca
    if (MODE === 'ready') ensureKernel()
    out(argv[2] === '--format' && argv[3] === 'json' ? statusJson() : statusTable())
    process.exit(0)
  }
  if (argv[1] === 'start') { out('starting (fake): service is running'); process.exit(0) }
  if (argv[1] === 'stop') { out('stopped (fake)'); process.exit(0) }
  if (argv[1] === 'kernel' && argv[2] === 'set') {
    // OBV5: NON idempotente come il vero — col kernel già presente esce 1
    // col File exists; se manca, lo crea nel layout vero (symlink → target)
    if (kernelPresent()) die(1, KERNEL_FILE_EXISTS_STDERR)
    ensureKernel()
    out('kernel installed (fake)')
    process.exit(0)
  }
  if (argv[1] === 'df') {
    // BAV1: la forma VERA della 1.7.1 — un OGGETTO containers/images/volumes
    // con sizeInBytes e reclaimable (fixture system-df-json), NON l'array di
    // Docker; i valori dallo STATO della finta
    const { box, volumes, built } = scanState()
    const n = volumes.size
    out(JSON.stringify({
      containers: box ? { active: box.running ? 1 : 0, reclaimable: 0, sizeInBytes: 10580217856, total: 1 } : { active: 0, reclaimable: 0, sizeInBytes: 0, total: 0 },
      images: built ? { active: 2, reclaimable: 244289536, sizeInBytes: 5396357120, total: 4 } : { active: 0, reclaimable: 0, sizeInBytes: 0, total: 0 },
      volumes: { active: n, reclaimable: 0, sizeInBytes: n * 39910059, total: n }
    }))
    process.exit(0)
  }
  die(1, `container: unknown system subcommand: ${argv[1] ?? ''}`)
}

// ---- image ----
if (argv[0] === 'image') {
  if (argv[1] === 'inspect') {
    // BAV1: NESSUN --format (la CLI vera: Unknown option, exit 64 — l'hanno
    // già fermato i controlli di severità sopra); l'inspect dell'ESISTENZA:
    // senza build non c'è; la dimensione sta nel JSON (variants[].size)
    if (!scanState().built) die(1, `container (fake): image ${argv[argv.length - 1]} not found`)
    const ref = fullImageRef(String(argv[argv.length - 1] ?? 'sandbot-box:fake'))
    out(JSON.stringify([
      {
        configuration: {
          creationDate: '2026-11-13T21:10:41Z',
          descriptor: {
            annotations: { 'com.apple.containerization.image.name': ref, 'io.containerd.image.name': ref, 'org.opencontainers.image.ref.name': String(ref).split(':').pop() ?? '' },
            digest: 'sha256:ba8e44dff3b9103e8c6931f8d9091954a97c0c703d9f2b4324d61780967bddc8',
            mediaType: 'application/vnd.oci.image.index.v1+json',
            size: 375
          },
          name: ref
        },
        id: 'ba8e44dff3b9103e8c6931f8d9091954a97c0c703d9f2b4324d61780967bddc8',
        variants: [
          { config: { architecture: 'arm64', os: 'linux' }, digest: 'sha256:045a5a157f2e3d3d405db5494d5162549427d32e83e7af61e28d7cbad397df4a', platform: { architecture: 'arm64', os: 'linux' }, size: 1302970425 }
        ]
      }
    ]))
    process.exit(0)
  }
  if (argv[1] === 'ls') {
    // le immagini della finta: la NOSTRA dopo la build, la base sempre
    const { built } = scanState()
    const images = [{ name: 'docker.io/library/alpine:3.20', size: 7800000000 }]
    if (built) images.unshift({ name: 'docker.io/library/sandbot-box:abab9640c765', size: 1302970425 })
    out(JSON.stringify(images))
    process.exit(0)
  }
  if (argv[1] === 'prune') { out('pruned (fake)'); process.exit(0) }
  if (argv[1] === 'delete' || argv[1] === 'rm') { out(`deleted (fake): ${argv.slice(2).join(' ')}`); process.exit(0) }
  die(1, `container: unknown image subcommand: ${argv[1] ?? ''}`)
}

// ---- volume ----
if (argv[0] === 'volume') {
  if (argv[1] === 'create') {
    const name = argv[2] ?? 'volume'
    // BAV1: NON idempotente come il vero — l'errore VERO se esiste già. (Nel
    // dialetto Docker resta com'era: la CLI di Docker idempotente è.)
    if (!dockerDialect() && scanState({ skipLast: true }).volumes.has(name)) {
      die(1, `Error: volume '${name}' already exists`)
    }
    out(name)
    process.exit(0)
  }
  if (argv[1] === 'delete' || argv[1] === 'rm') { out(`deleted (fake): ${argv.slice(2).join(' ')}`); process.exit(0) }
  if (argv[1] === 'ls' || argv[1] === 'list') {
    const names = [...scanState().volumes].sort()
    if (argv.includes('-q') || argv.includes('--quiet')) { out(names.join('\n')); process.exit(0) }
    if (argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json') {
      // BAV1: il FORMATO VERO — array di {configuration:{name,…}, id}
      out(JSON.stringify(names.map(volumeElement)))
      process.exit(0)
    }
    // la tabella di default (il motore non la usa: forma plausibile)
    out('NAME\n' + names.join('\n'))
    process.exit(0)
  }
  if (argv[1] === 'inspect') {
    const name = argv[2]
    if (!scanState().volumes.has(name)) die(1, `Error: volume not found: ${name}`)
    out(JSON.stringify([volumeElement(name)], null, 2))
    process.exit(0)
  }
  die(1, `container: unknown volume subcommand: ${argv[1] ?? ''}`)
}

// ---- network ----
if (argv[0] === 'network') {
  if (argv[1] === 'create') {
    const name = argv[argv.length - 1]
    if (name === 'homun-box-isolated' && process.env.SANDBOT_TEST_CONTAINER_ISOLATED_FAIL === '1') {
      // BAV3: la create è CADUTA — la rete NON esiste. Il log registra il
      // CONTRARIO della create (così chi rilegge non la vede, come nel vero)
      if (process.env.SANDBOT_TEST_CONTAINER_LOG) {
        try {
          appendFileSync(process.env.SANDBOT_TEST_CONTAINER_LOG, `${JSON.stringify({ at: Date.now(), mode: MODE, argv: ['network', 'delete', name] })}\n`)
        } catch { /* il log è best-effort */ }
      }
      die(1, `container (fake): creation of the internal network ${name} failed`)
    }
    out(name ?? 'network'); process.exit(0)
  }
  if (argv[1] === 'inspect') {
    const name = argv[2] ?? 'homun-box'
    if (!scanState().networks.has(name)) die(1, `container (fake): network ${name} not found`)
    out(networkJson(name)); process.exit(0)
  }
  if (argv[1] === 'ls' || argv[1] === 'list') {
    out(JSON.stringify([...scanState().networks].map((n) => ({ configuration: { name: n }, id: n }))))
    process.exit(0)
  }
  die(1, `container: unknown network subcommand: ${argv[1] ?? ''}`)
}

// ---- build (la build del box: le righe VERE della CLI, distribuite nel tempo) ----
// OBD3 (fase onboarding-b-dettagli): la build stampa su STDERR le righe
// della FIXTURE (lo stderr vero di `container build --progress plain` della
// 1.7.1, copiata alla lettera nel repo) e su STDOUT una riga sola: il nome
// dell'immagine (-t). Con SANDBOT_TEST_CONTAINER_BUILD_DELAY_MS le righe
// sono DISTRIBUITE nel tempo (la sonda vede il progresso che avanza);
// l'attesa è SINCRONA (Atomics.wait): il flusso del processo resta qui e
// nessun altro controllo risponde al posto della build.
const BUILD_FIXTURE_PATH = join(FIXTURES_DIR, '..', 'container-1.7.1-build-plain.txt')
if (argv[0] === 'build') {
  let lines
  try {
    lines = readFileSync(BUILD_FIXTURE_PATH, 'utf8').split('\n')
    if (lines[lines.length - 1] === '') lines.pop() // il \n finale del file
  } catch (e) {
    die(2, `container (fake): fixture del build non leggibile: ${BUILD_FIXTURE_PATH} (${e instanceof Error ? e.message : String(e)})`)
  }
  const delay = Number(process.env.SANDBOT_TEST_CONTAINER_BUILD_DELAY_MS ?? '0')
  const perLine = Number.isFinite(delay) && delay > 0 ? Math.max(1, Math.floor(delay / Math.max(1, lines.length))) : 0
  for (const line of lines) {
    if (perLine > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, perLine)
    process.stderr.write(`${line}\n`)
  }
  // lo stdout della CLI vera è UNA riga: il nome dell'immagine
  const t = argv.indexOf('-t')
  if (t >= 0 && argv[t + 1]) out(argv[t + 1])
  process.exit(0)
}

// ---- builder prune (la cache di build, per la pulizia sicura di docker) ----
if (argv[0] === 'builder') { out('build cache pruned (fake)'); process.exit(0) }

// ---- i container: ls/stop/start/rm/exec/cp/run/inspect ----

// BAV1: `ps` è il DIALETTO Docker (i test di confronto dei motori): nomi per
// riga come oggi. Il motore Apple usa `ls`.
if (argv[0] === 'ps') {
  const { box } = scanState()
  if (box) out(box.name)
  process.exit(0)
}

// BAV1: `ls` parla la CLI vera — json (l'array della fixture ls-a-json),
// -q (i nomi) o la tabella di default
if (argv[0] === 'ls' || argv[0] === 'list') {
  const { box } = scanState()
  if (argv.includes('-q') || argv.includes('--quiet')) {
    if (box) out(box.name)
    process.exit(0)
  }
  if (argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json') {
    out(JSON.stringify(box ? [boxElement(box)] : []))
    process.exit(0)
  }
  // la tabella di default (il motore non la usa)
  out('ID  IMAGE  OS  ARCH  STATE  IP  CPUS  MEMORY  STARTED' + (box ? `\n${box.name}  ${fullImageRef(box.image)}  linux  arm64  ${box.running ? 'running' : 'stopped'}  192.168.128.2/24  ${box.cpus}  ${Math.round(box.memoryBytes / 1024 ** 2)} MB  ${CREATED}` : ''))
  process.exit(0)
}

if (argv[0] === 'stop' || argv[0] === 'start') { process.exit(0) }
if (argv[0] === 'rm' || argv[0] === 'delete') { process.exit(0) }
if (argv[0] === 'run') {
  // BR1: un run -d SENZA --network non esiste — rifiutato, mai la rete di
  // default in NAT. I one-shot di servizio (--rm) non sono il box: passano.
  if (argv.includes('-d') && !argv.includes('--network')) {
    die(64, 'container (fake): run -d requires --network with a Homun network (homun-box | homun-box-isolated) — senza flag il container andrebbe sulla rete predefinita, in NAT verso Internet')
  }
  out('run (fake): container started'); process.exit(0)
}
// il create DI DOCKER (lo usa il motore docker nei test dell'ensure BR3): lo
// stato lo registra scanState dal --name/--network/immagine dell'argv
if (argv[0] === 'create') { out('create (fake): container created'); process.exit(0) }
if (argv[0] === 'exec') {
  // BR1 + BRR: la VERIFICA (lo script che legge operstate) risponde con lo
  // STATO del box dal log — boot (run -d, o start di un box fermato) senza
  // link down → le interfacce sono SU e fallisce; dopo il link down passa.
  // SANDBOT_TEST_CONTAINER_OPERSTATE=up le tiene SU per sempre: nemmeno il
  // link down le abbassa (il difetto «resta up dopo il link down» dei test)
  if (argv.some((a) => typeof a === 'string' && a.includes('operstate'))) {
    const suPerSempre = process.env.SANDBOT_TEST_CONTAINER_OPERSTATE === 'up'
    if (suPerSempre || scanState().box?.linksUp) die(1, 'eth0 is up')
  }
  // BAV5: il WRAPPER DI BACKGROUND del daemon (sh -c <wrapper> sh <cmd>
  // <log> <exit> <pid>) scrive i suoi file DENTRO il box — il «box» della
  // finta non ha filesystem, quindi i file si emulano rispondendo alle
  // letture: cat dell'exit file → 0 (il comando è andato), del log → vuoto,
  // del pid → un pid. Senza questo il foreground del run-command non finiva
  // MAI (il polling dell'exit file non vedeva nulla).
  if (argv.includes('-d')) {
    const ci = argv.indexOf('-c')
    const script = ci >= 0 ? argv[ci + 1] : ''
    if (typeof script === 'string' && script.includes('setsid') && script.includes('"$3"')) process.exit(0)
  }
  if (argv.includes('cat')) {
    const pi = argv.indexOf('--')
    const path = pi >= 0 ? argv[pi + 1] : undefined
    if (typeof path === 'string') {
      // i percorsi del wrapper sono RELATIVI alla home del bot (l'exec -w li
      // risolve nel box): il cat arriva col PERCORSO ASSOLUTO — si confronta
      // per suffisso
      const files = shellWrapperFiles(logArgvs())
      const hit = (set) => [...set].some((rel) => path === rel || path.endsWith(`/${rel}`))
      if (hit(files.exit)) { out('0'); process.exit(0) }
      if (hit(files.log)) { out(''); process.exit(0) }
      if (hit(files.pid)) { out('4242'); process.exit(0) }
    }
  }
  process.exit(0)
}
if (argv[0] === 'cp') { process.exit(0) }
if (argv[0] === 'inspect') {
  // BAV1: l'inspect della CLI vera, SENZA formati: l'array JSON dell'elemento
  // del box (stessa forma della fixture inspect-box), o l'errore VERO. Il
  // `-f` è il dialetto Docker dei test di confronto: resta come oggi.
  const fi = argv.indexOf('--format')
  const di = argv.indexOf('-f')
  if (fi >= 0) die(64, "Error: Unknown option '--format'")
  if (di >= 0) {
    const { box } = scanState()
    const f = String(argv[di + 1] ?? '')
    if (/running/i.test(f)) { out('true'); process.exit(0) }
    if (/image/i.test(f)) { out(box?.image ?? 'sandbot-box:fake'); process.exit(0) }
    if (/network/i.test(f)) { out(box?.network ?? ''); process.exit(0) }
    if (/mounts/i.test(f)) { out('/box:rw /browser:rw /plugins:ro '); process.exit(0) }
    out('{}')
    process.exit(0)
  }
  const name = argv[1]
  const { box } = scanState()
  if (!box || box.name !== name) die(1, `Error: container not found: ${name}`)
  out(JSON.stringify([boxElement(box)], null, 2))
  process.exit(0)
}

die(2, `container (fake): unsupported argv: ${JSON.stringify(argv)}`)
