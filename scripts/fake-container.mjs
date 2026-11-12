#!/usr/bin/env node
// Fase box-container (BX5): la CLI FINTA di Apple `container`, per le prove
// senza motore vero (come il provider finto delle sonde). Registra OGNI argv
// che riceve (una riga JSON per chiamata, in append su $SANDBOT_TEST_CONTAINER_LOG)
// e risponde ai comandi che il motore usa: --version, system status/start/
// kernel set, system df --format json, image inspect/prune/delete, volume
// create/delete, network create/inspect, ls, stop/rm, exec.
//
// Il comportamento si sceglie con SANDBOT_TEST_CONTAINER_MODE:
//   not-installed  tutto esce 127 (la CLI «non c'è»)
//   stopped        --version ok, system status: running: false
//   kernel-missing status: running: true MA kernel: missing
//   ready          (default) tutto a posto
//
// Nessuna rete, nessuna scrittura fuori dal file di log. La usa il motore al
// posto della CLI vera SOLO con SANDBOT_TEST_USER_DATA impostata E
// SANDBOT_TEST_CONTAINER_CLI=<percorso di questo file> (sandbox/engine).
import { appendFileSync } from 'node:fs'

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
  if (argv[1] === 'create') { out(argv[argv.length - 1] ?? 'network'); process.exit(0) }
  if (argv[1] === 'inspect') {
    out(JSON.stringify({ name: argv[2] ?? 'homun-box', internal: true, subnets: [{ subnet: '192.0.15.0/24', gateway: '192.0.15.1' }] }))
    process.exit(0)
  }
  die(1, `container: unknown network subcommand: ${argv[1] ?? ''}`)
}

// ---- build (la build del box: dura un attimo e riesce) ----
if (argv[0] === 'build') { out('build (fake): done'); process.exit(0) }

// ---- builder prune (la cache di build, per la pulizia sicura di docker) ----
if (argv[0] === 'builder') { out('build cache pruned (fake)'); process.exit(0) }

// ---- i container: ls/stop/start/rm/exec/cp/run ----
if (argv[0] === 'ls' || argv[0] === 'list' || argv[0] === 'ps') {
  out('sandbot-box')
  process.exit(0)
}
if (argv[0] === 'stop' || argv[0] === 'start') { process.exit(0) }
if (argv[0] === 'rm' || argv[0] === 'delete') { process.exit(0) }
if (argv[0] === 'run') { out('run (fake): container started'); process.exit(0) }
if (argv[0] === 'exec') { process.exit(0) }
if (argv[0] === 'cp') { process.exit(0) }
if (argv[0] === 'inspect') {
  const i = argv.indexOf('--format')
  if (i >= 0 && /running/i.test(argv[i + 1] ?? '')) { out('true'); process.exit(0) }
  if (i >= 0 && /image/i.test(argv[i + 1] ?? '')) { out('sandbot-box:fake'); process.exit(0) }
  out('{}')
  process.exit(0)
}

die(2, `container (fake): unsupported argv: ${JSON.stringify(argv)}`)
