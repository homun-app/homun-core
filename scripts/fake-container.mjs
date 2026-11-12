#!/usr/bin/env node
// Fase box-container (BX5): la CLI FINTA di Apple `container`, per le prove
// senza motore vero (come il provider finto delle sonde). Registra OGNI argv
// che riceve (una riga JSON per chiamata, in append su $SANDBOT_TEST_CONTAINER_LOG)
// e risponde ai comandi che il motore usa: --version, system status/start/
// kernel set, system df --format json, image inspect/prune/delete, volume
// create/delete, network create/inspect, ls, stop/rm, exec, cp, run.
//
// Il comportamento si sceglie con SANDBOT_TEST_CONTAINER_MODE:
//   not-installed  tutto esce 127 (la CLI «non c'è»)
//   stopped        --version ok, system status: running: false
//   kernel-missing status: running: true MA kernel: missing
//   ready          (default) tutto a posto
//
// BR1 (fase box-rete): il STATO si ricorda rileggendo il proprio log — i
// container creati da `run -d`/`create` (nome, rete, immagine) esistono per
// `ls` e gli inspect finché un `rm` non li toglie; le RETI esistono dopo
// `network create` (homun-box c'è già, homun-box-isolated no). E un `run -d`
// SENZA --network viene RIFIUTATO con errore: con la CLI di Apple «nessuna
// rete» non esiste, un run senza flag va sulla rete PREDEFINITA in NAT verso
// Internet — nessuna sonda futura può passare col difetto. Con
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
// Nessuna rete, nessuna scrittura fuori dal file di log. La usa il motore al
// posto della CLI vera SOLO con SANDBOT_TEST_USER_DATA impostata E
// SANDBOT_TEST_CONTAINER_CLI=<percorso di questo file> (sandbox/engine).
import { appendFileSync, readFileSync } from 'node:fs'

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

/**
 * BR1: lo stato dal log — l'ULTIMO container creato da run -d/create (nome,
 * rete, immagine) finché un rm/delete col suo nome non lo toglie; le reti
 * create (homun-box esiste GIÀ, come la prima della sonda di box-container).
 * BRR: il box sa anche se CORRE e se le interfacce sono SU — il run -d è un
 * boot (interfacce su), lo start di un box FERMATO pure, il link down come
 * root le mette giù.
 */
function scanState() {
  let box = null
  const networks = new Set(['homun-box'])
  for (const a of logArgvs()) {
    if (!Array.isArray(a)) continue
    if ((a[0] === 'run' && a.includes('-d')) || a[0] === 'create') {
      const nameI = a.indexOf('--name')
      if (nameI >= 0) {
        const netI = a.indexOf('--network')
        const sleepI = a.lastIndexOf('sleep')
        // run -d: il box CORRE e il boot ha messo le interfacce SU; create
        // (il run di Docker) parte FERMO: le decide lo start
        box = { name: a[nameI + 1], network: netI >= 0 ? a[netI + 1] : null, image: sleepI > 0 ? a[sleepI - 1] : 'sandbot-box:fake', running: a[0] === 'run', linksUp: a[0] === 'run' }
      }
    }
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
  }
  return { box, networks }
}

/** Il JSON dell'inspect di una rete: subnet e gateway della rete richiesta. */
const networkJson = (name) =>
  JSON.stringify({ name, internal: true, subnets: [{ subnet: name === 'homun-box-isolated' ? '192.0.16.0/24' : '192.0.15.0/24', gateway: name === 'homun-box-isolated' ? '192.0.16.1' : '192.0.15.1' }] })

// ---- --version ----
if (argv[0] === '--version' || argv[0] === 'version') {
  out('container version 1.7.1 (fake, fase box-container)')
  process.exit(0)
}

// ---- system ----
if (argv[0] === 'system') {
  if (argv[1] === 'status') {
    if (MODE === 'stopped') { out('running: false'); process.exit(0) }
    if (MODE === 'kernel-missing') { out('running: true'); out('kernel: missing (use: container system kernel set --recommended)'); process.exit(0) }
    out('running: true'); process.exit(0)
  }
  if (argv[1] === 'start') { out('starting (fake): service is running'); process.exit(0) }
  if (argv[1] === 'stop') { out('stopped (fake)'); process.exit(0) }
  if (argv[1] === 'kernel' && argv[2] === 'set') { out('kernel installed (fake)'); process.exit(0) }
  if (argv[1] === 'df') {
    // il formato di `docker system df --format json`: voci col Type
    out(JSON.stringify([
      { Type: 'Images', TotalCount: 2, Size: '1.18GB', Reclaimable: '30MB' },
      { Type: 'Containers', TotalCount: 1, Size: '1.09MB', Reclaimable: '0B' },
      { Type: 'Local Volumes', TotalCount: 4, Size: '315MB', Reclaimable: '0B' },
      { Type: 'Build Cache', TotalCount: 17, Size: '1.15GB', Reclaimable: '1.15GB' }
    ]))
    process.exit(0)
  }
  die(1, `container: unknown system subcommand: ${argv[1] ?? ''}`)
}

// ---- image ----
if (argv[0] === 'image') {
  if (argv[1] === 'inspect') {
    // `image inspect [--format F] <tag>`: la dimensione della NOSTRA immagine
    const i = argv.indexOf('--format')
    if (i >= 0 && /size/i.test(argv[i + 1] ?? '')) { out('1180000000'); process.exit(0) }
    out('{}'); process.exit(0)
  }
  if (argv[1] === 'prune') { out('pruned (fake)'); process.exit(0) }
  if (argv[1] === 'delete' || argv[1] === 'rm') { out(`deleted (fake): ${argv.slice(2).join(' ')}`); process.exit(0) }
  die(1, `container: unknown image subcommand: ${argv[1] ?? ''}`)
}

// ---- volume ----
if (argv[0] === 'volume') {
  if (argv[1] === 'create') { out(argv[2] ?? 'volume'); process.exit(0) }
  if (argv[1] === 'delete' || argv[1] === 'rm') { out(`deleted (fake): ${argv.slice(2).join(' ')}`); process.exit(0) }
  if (argv[1] === 'ls') { out('sandbot-box\nsandbot-plugins\nsandbot-browser'); process.exit(0) }
  die(1, `container: unknown volume subcommand: ${argv[1] ?? ''}`)
}

// ---- network ----
if (argv[0] === 'network') {
  if (argv[1] === 'create') {
    const name = argv[argv.length - 1]
    if (name === 'homun-box-isolated' && process.env.SANDBOT_TEST_CONTAINER_ISOLATED_FAIL === '1') {
      die(1, `container (fake): creation of the internal network ${name} failed`)
    }
    out(name ?? 'network'); process.exit(0)
  }
  if (argv[1] === 'inspect') {
    const name = argv[2] ?? 'homun-box'
    if (!scanState().networks.has(name)) die(1, `container (fake): network ${name} not found`)
    out(networkJson(name)); process.exit(0)
  }
  die(1, `container: unknown network subcommand: ${argv[1] ?? ''}`)
}

// ---- build (la build del box: dura un attimo e riesce) ----
if (argv[0] === 'build') { out('build (fake): done'); process.exit(0) }

// ---- builder prune (la cache di build, per la pulizia sicura di docker) ----
if (argv[0] === 'builder') { out('build cache pruned (fake)'); process.exit(0) }

// ---- i container: ls/stop/start/rm/exec/cp/run ----
if (argv[0] === 'ls' || argv[0] === 'list' || argv[0] === 'ps') {
  const { box } = scanState()
  if (box) out(box.name)
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
  process.exit(0)
}
if (argv[0] === 'cp') { process.exit(0) }
if (argv[0] === 'inspect') {
  const { box } = scanState()
  // il formato è --format (CLI di Apple) o -f (docker): stesso posto
  const fi = argv.indexOf('--format')
  const i = fi >= 0 ? fi : argv.indexOf('-f')
  const f = i >= 0 ? String(argv[i + 1] ?? '') : ''
  if (i >= 0 && /running/i.test(f)) { out('true'); process.exit(0) }
  if (i >= 0 && /image/i.test(f)) { out(box?.image ?? 'sandbot-box:fake'); process.exit(0) }
  if (i >= 0 && /network/i.test(f)) { out(box?.network ?? ''); process.exit(0) }
  if (i >= 0 && /mounts/i.test(f)) { out('/box:rw /browser:rw /plugins:ro '); process.exit(0) }
  out('{}')
  process.exit(0)
}

die(2, `container (fake): unsupported argv: ${JSON.stringify(argv)}`)
