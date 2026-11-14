// Fase box-container (BX5): la CLI FINTA di Apple container. Registra gli
// argv (file di log) e risponde ai comandi che il motore usa; i comportamenti
// si scelgono con SANDBOT_TEST_CONTAINER_MODE (not-installed / stopped /
// kernel-missing / ready). Zero rete, zero motore vero: process spawn del
// file .mjs con env pilotata.
import { describe, expect, it, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync, readlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const FAKE = join(ROOT, 'scripts', 'fake-container.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'sandbot-fake-container-test-'))

/** Lancia la CLI finta con env di prova; log su un file del TMP (uno per chiamata). */
let runSeq = 0
function run(mode: string, argv: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; log: string[][] } {
  const logFile = join(TMP, `log-${++runSeq}-${mode}.jsonl`)
  const r = spawnSync(process.execPath, [FAKE, ...argv], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SANDBOT_TEST_CONTAINER_MODE: mode,
      SANDBOT_TEST_CONTAINER_LOG: logFile,
      ...extraEnv
    }
  })
  const log = existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv as string[])
    : []
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', log }
}

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('BX5: la CLI finta di container — i comportamenti per variabile d\'ambiente', () => {
  it('--version risponde (pronto e spento); NON installata → esce diverso da 0', () => {
    expect(run('ready', ['--version']).status).toBe(0)
    expect(run('stopped', ['--version']).status).toBe(0)
    const ni = run('not-installed', ['--version'])
    expect(ni.status).not.toBe(0)
  })

  it('BAV1 system df --format json: la forma VERA di Apple — un OGGETTO containers/images/volumes con sizeInBytes e reclaimable', () => {
    const r = run('ready', ['system', 'df', '--format', 'json'])
    expect(r.status).toBe(0)
    const df = JSON.parse(r.stdout) as Record<string, { active: number; reclaimable: number; sizeInBytes: number; total: number }>
    for (const k of ['containers', 'images', 'volumes']) {
      expect(df[k], k).toBeDefined()
      expect(df[k].sizeInBytes).toBeGreaterThanOrEqual(0)
      expect(df[k].reclaimable).toBeGreaterThanOrEqual(0)
    }
    // NON è l'array di Docker con le voci Type/Size: la CLI vera stampa un oggetto
    expect(Array.isArray(df)).toBe(false)
  })

  it('BAV1 image inspect SENZA --format: exit 0 solo dopo la build, e il JSON porta variants[].size', () => {
    const logFile = join(TMP, `log-bav1-imgsize-${Date.now()}.jsonl`)
    const env = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env })
    expect(fake(['image', 'inspect', 'sandbot-box:abc']).status).not.toBe(0)
    expect(fake(['build', '-t', 'sandbot-box:abc', '.']).status).toBe(0)
    const r = fake(['image', 'inspect', 'sandbot-box:abc'])
    expect(r.status).toBe(0)
    const img = JSON.parse(r.stdout) as Array<{ variants: Array<{ size: number }> }>
    expect(img[0]!.variants[0]!.size).toBeGreaterThan(1_000_000_000)
  })

  it('la pulizia sicura risponde: image prune e builder prune; image delete e volume delete pure', () => {
    expect(run('ready', ['image', 'prune']).status).toBe(0)
    expect(run('ready', ['builder', 'prune']).status).toBe(0)
    expect(run('ready', ['image', 'delete', 'sandbot-box:vecchia']).status).toBe(0)
    expect(run('ready', ['volume', 'delete', 'sandbot-box']).status).toBe(0)
  })

  it('BRV2 network inspect homun-box → il gateway .1 della sottorete 192.168.128.0/24, dalla FORMA della fixture', () => {
    const r = run('ready', ['network', 'inspect', 'homun-box'])
    expect(r.status).toBe(0)
    const net = JSON.parse(r.stdout)
    expect(net[0].status.ipv4Gateway).toBe('192.168.128.1')
    expect(net[0].status.ipv4Subnet).toBe('192.168.128.0/24')
  })

  // BR1 (fase box-rete): la CLI finta RIFIUTA un run -d senza --network —
  // con la CLI di Apple «nessuna rete» non esiste: un run senza --network
  // va sulla rete PREDEFINITA in NAT verso Internet. Così nessuna sonda
  // futura può passare col difetto. I one-shot (--rm) non hanno rete per
  // progetto: non sono il box.
  it('BR1: un run -d SENZA --network viene RIFIUTATO con errore; con --network passa', () => {
    const bad = run('ready', ['run', '-d', '--name', 'sandbot-box', 'img', 'sleep', 'infinity'])
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toMatch(/--network/)
    const badNoD = run('ready', ['run', '-d', '--name', 'sandbot-box', 'sleep', 'infinity'])
    expect(badNoD.status).not.toBe(0)
    const ok = run('ready', ['run', '-d', '--name', 'sandbot-box', '--network', 'homun-box', 'img', 'sleep', 'infinity'])
    expect(ok.status).toBe(0)
    // i one-shot di servizio (--rm) restano legitimi anche senza rete
    expect(run('ready', ['run', '--rm', '-u', '0', 'img', 'mkdir', '-p', '/p/x']).status).toBe(0)
  })

  it('OGNI argv viene REGISTRATO nel log (JSON per riga)', () => {
    const r = run('ready', ['image', 'prune', '-f'])
    expect(r.log).toEqual([['image', 'prune', '-f']])
  })

  it('l\'accensione e il kernel: system start --disable-kernel-install e system kernel set --recommended', () => {
    expect(run('ready', ['system', 'start', '--disable-kernel-install']).status).toBe(0)
    expect(run('ready', ['system', 'kernel', 'set', '--recommended']).status).toBe(0)
  })

  it('è ESEGUIBILE anche come script .mjs diretto (la sonda la passa come CLI)', () => {
    chmodSync(FAKE, 0o755)
    const wrapper = join(TMP, 'cli')
    writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${FAKE} "$@"\n`)
    chmodSync(wrapper, 0o755)
    const r = spawnSync(wrapper, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: join(TMP, 'log-ob6-wrapper.jsonl') } })
    expect(r.status).toBe(0)
  })

  // BRR (fase box-rete-riavvio): ogni container Apple è una VM — un `start`
  // di un box FERMATO è un boot NUOVO e le interfacce tornano SU. La CLI
  // finta lo simula tenendo lo STATO (running, interfacce) NEL LOG: qui le
  // chiamate CONDIVIDONO il log, così la sequenza si vede.
  it('BRR: il riavvio — run -d → verifica FALLISCE (boot), link down → passa, stop → start → verifica FALLISCE di nuovo', () => {
    const logFile = join(TMP, 'log-brr-riavvio.jsonl')
    const run = (argv: string[], extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, [FAKE, ...argv], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile, ...extra }
      })
    const check = () => run(['exec', '-u', '0', 'sandbot-box', 'sh', '-c', 'for i in /sys/class/net/*; do echo "$i/operstate"; done'])
    const linkDown = () => run(['exec', '-u', '0', 'sandbot-box', 'sh', '-c', 'for i in /sys/class/net/*; do ip link set dev "$i" down; done'])
    // il box NASCE: boot nuovo, le interfacce sono SU → la verifica cade
    expect(run(['run', '-d', '--name', 'sandbot-box', '--network', 'homun-box-isolated', 'sandbot-box:fake', 'sleep', 'infinity']).status).toBe(0)
    expect(check().status).toBe(1)
    // il link down le mette GIÙ → la verifica passa
    expect(linkDown().status).toBe(0)
    expect(check().status).toBe(0)
    // il box si FERMA e RIPARTE: il boot nuovo riporta le interfacce SU
    expect(run(['stop', 'sandbot-box']).status).toBe(0)
    expect(run(['start', 'sandbot-box']).status).toBe(0)
    expect(check().status).toBe(1)
    expect(linkDown().status).toBe(0)
    expect(check().status).toBe(0)
    // lo start di un box che GIÀ CORRE non è un boot: le interfacce restano giù
    expect(run(['start', 'sandbot-box']).status).toBe(0)
    expect(check().status).toBe(0)
  })

  // BRR: il difetto dei test — le interfacce che RESTANO su anche dopo il
  // link down (SANDBOT_TEST_CONTAINER_OPERSTATE=up le tiene su per sempre)
  it('BRR: con OPERSTATE=up la verifica cade SEMPRE, anche dopo il link down', () => {
    const logFile = join(TMP, 'log-brr-resta-up.jsonl')
    const run = (argv: string[]) =>
      spawnSync(process.execPath, [FAKE, ...argv], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile, SANDBOT_TEST_CONTAINER_OPERSTATE: 'up' }
      })
    expect(run(['run', '-d', '--name', 'sandbot-box', '--network', 'homun-box-isolated', 'sandbot-box:fake', 'sleep', 'infinity']).status).toBe(0)
    const check = ['exec', '-u', '0', 'sandbot-box', 'sh', '-c', 'for i in /sys/class/net/*; do echo "$i/operstate"; done']
    const linkDown = ['exec', '-u', '0', 'sandbot-box', 'sh', '-c', 'for i in /sys/class/net/*; do ip link set dev "$i" down; done']
    expect(run(check).status).toBe(1)
    expect(run(linkDown).status).toBe(0)
    expect(run(check).status).toBe(1)
  })
})

// ---- OBD4a: senza le variabili la finta NON crea cartelle ----
// La finta lasciava una mkdtemp VUOTA a ogni invocazione senza
// SANDBOT_TEST_CONTAINER_APP_ROOT né SANDBOT_TEST_CONTAINER_LOG (15 giri di
// suite = 15 cartelle in T). Ora senza appRoot i comandi che ne hanno
// bisogno escono 2; gli altri funzionano come prima.
describe('OBD4a: invocazione senza APP_ROOT né LOG → nessuna cartella nuova, exit 2 dove serve', () => {
  it('nessuna cartella sandbot-fake-container-* in T; system status esce 2 col messaggio chiaro; gli altri comandi come prima', async () => {
    const { readdirSync } = await import('node:fs')
    const { TEST_TMP_BASE } = await import('../../src/test-tmp')
    const bare = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready' }
    const fakeDirs = (): string[] => readdirSync(TEST_TMP_BASE).filter((n) => n.startsWith('sandbot-fake-container-')).sort()
    const before = fakeDirs()
    const status = spawnSync(process.execPath, [FAKE, 'system', 'status'], { encoding: 'utf8', env: bare })
    expect(status.status).toBe(2)
    expect(status.stderr).toContain('fake-container: SANDBOT_TEST_CONTAINER_APP_ROOT mancante')
    // anche kernel set (l'altro comando che scrive nell'appRoot)
    const kset = spawnSync(process.execPath, [FAKE, 'system', 'kernel', 'set', '--recommended'], { encoding: 'utf8', env: bare })
    expect(kset.status).toBe(2)
    // gli ALTRI comandi funzionano come prima (niente appRoot necessario)
    expect(spawnSync(process.execPath, [FAKE, '--version'], { encoding: 'utf8', env: bare }).status).toBe(0)
    expect(spawnSync(process.execPath, [FAKE, 'system', 'start', '--disable-kernel-install'], { encoding: 'utf8', env: bare }).status).toBe(0)
    expect(spawnSync(process.execPath, [FAKE, 'build', '-t', 'x', '.'], { encoding: 'utf8', env: bare }).status).toBe(0)
    expect(fakeDirs()).toEqual(before) // NESSUNA cartella nuova
  })
})

// ---- OB6 (fase onboarding-b): la build può DURARE ----
describe('OB6: la build finta può durare (SANDBOT_TEST_CONTAINER_BUILD_DELAY_MS)', () => {
  it('senza ritardo risponde subito; col ritardo ci mette almeno quel tempo', () => {
    const t0 = Date.now()
    const fast = run('ready', ['build'])
    expect(fast.status).toBe(0)
    expect(Date.now() - t0).toBeLessThan(2_000)
    const t1 = Date.now()
    const slow = spawnSync(process.execPath, [FAKE, 'build'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: join(TMP, 'log-ob6-delay.jsonl'), SANDBOT_TEST_CONTAINER_BUILD_DELAY_MS: '1200' }
    })
    expect(slow.status).toBe(0)
    expect(Date.now() - t1).toBeGreaterThanOrEqual(1_100)
  })
})

// ---- OBD3 (fase onboarding-b-dettagli): la build finta parla come la VERA ----
// Le righe della finta sono QUELLE DELLA FIXTURE (lo stderr vero della CLI
// 1.7.1, copiato alla lettera nel repo): il test le blocca byte per byte.
// Se qualcosa dipende dal formato, si corregge il codice, non la finta.
const BUILD_FIXTURE = readFileSync(join(ROOT, 'src', 'main', 'sandbox', '__tests__', 'fixtures', 'container-1.7.1-build-plain.txt'), 'utf8')

describe('OBD3: `build` stampa su stderr le righe della fixture VERA, distribuite nel ritardo', () => {
  it('con --progress plain: stderr = la fixture BYTE PER BYTE, stdout il nome dell\'immagine', () => {
    const logFile = join(TMP, 'log-obd3-build.jsonl')
    const r = spawnSync(process.execPath, [FAKE, 'build', '--progress', 'plain', '-t', 'sandbot-box:obd3', '-f', '/df/Dockerfile', '/ctx'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe(BUILD_FIXTURE)
    // lo stdout della CLI vera è una riga sola: il nome dell'immagine
    expect(r.stdout.trim()).toBe('sandbot-box:obd3')
  })

  it('senza ritardo le righe escono SUBITO tutte (la build dura solo col delay)', () => {
    const r = run('ready', ['build', '-t', 'sandbot-box:x', '.'])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe(BUILD_FIXTURE)
  })

  it('col ritardo (SANDBOT_TEST_CONTAINER_BUILD_DELAY_MS) la build DURA e le righe restano le stesse', () => {
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [FAKE, 'build', '-t', 'sandbot-box:x', '.'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: join(TMP, 'log-obd3-slow.jsonl'), SANDBOT_TEST_CONTAINER_BUILD_DELAY_MS: '800' }
    })
    expect(r.status).toBe(0)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700)
    expect(r.stderr).toBe(BUILD_FIXTURE)
  })
})

// ---- OB6: la NOSTRA immagine esiste SOLO dopo la build ----
describe('OB6: image inspect risponde OK solo DOPO una build', () => {
  it('senza build l\'inspect dice che l\'immagine non c\'è; dopo la build c\'è', () => {
    const logFile = join(TMP, `log-build-state-${Date.now()}.jsonl`)
    const env = (extra: Record<string, string>) => ({ PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile, ...extra })
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env: env({}) })
    // il .part: la stessa sequence nel log — la build registrata rende l'immagine visibile
    const before = fake(['image', 'inspect', 'sandbot-box:fake'])
    expect(before.status).not.toBe(0)
    const build = fake(['build', 'sandbot-box:fake', '.'])
    expect(build.status).toBe(0)
    const after = fake(['image', 'inspect', 'sandbot-box:fake'])
    expect(after.status).toBe(0)
    // la dimensione sta nel JSON dell'inspect (variants[].size), MAI col --format
    const size = fake(['image', 'inspect', 'sandbot-box:fake'])
    expect(size.status).toBe(0)
    expect(JSON.parse(size.stdout)[0].variants[0].size).toBeGreaterThan(1_000_000_000)
  })
})

// ---- OBV5 (fase onboarding-b-dal-vivo): la finta parla come la VERA ----
// Le fixture sono le uscite VERE della prova dal vivo (system-status-fixtures):
// la finta le stampa IDENTICHE (solo l'appRoot è della cartella di prova), e
// questi test le BLOCCANO: se la finta o la fixture cambiano forma, qui cade.
import {
  NEUTRAL_APP_ROOT, SYSTEM_STATUS_JSON, SYSTEM_STATUS_TABLE,
  KERNEL_LINK_NAME, KERNEL_TARGET_NAME
} from '../../src/main/sandbox/__tests__/system-status-fixtures'

describe('OBV5: la CLI finta stampa i formati VERI (JSON e tabella), bloccati dai test', () => {
  const APP_ROOT = join(TMP, 'obv5-app-root') // l'appRoot della cartella di prova
  const withRoot = { SANDBOT_TEST_CONTAINER_APP_ROOT: APP_ROOT }

  it('`system status --format json` (ready): il JSON VERO della 1.7.1, una riga, con l\'appRoot di prova', () => {
    const r = run('ready', ['system', 'status', '--format', 'json'], withRoot)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(SYSTEM_STATUS_JSON.replace(NEUTRAL_APP_ROOT, APP_ROOT))
  })

  it('la TABELLA di default (ready): la tabella VERA, senza separatori, riga per riga', () => {
    const r = run('ready', ['system', 'status'], withRoot)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(SYSTEM_STATUS_TABLE.replace(NEUTRAL_APP_ROOT, APP_ROOT))
  })

  it('stopped: il JSON dice "stopped" e anche la tabella', () => {
    const j = run('stopped', ['system', 'status', '--format', 'json'], withRoot)
    expect(j.status).toBe(0)
    expect(JSON.parse(j.stdout).status).toBe('stopped')
    const t = run('stopped', ['system', 'status'], withRoot)
    expect(t.status).toBe(0)
    expect(t.stdout).toMatch(/^status\s+stopped\s*$/m)
  })

  it('kernel-missing: running MA il FILE del kernel non c\'è (il JSON non ne parla)', () => {
    const root = join(TMP, 'obv5-km-root')
    const j = run('kernel-missing', ['system', 'status', '--format', 'json'], { SANDBOT_TEST_CONTAINER_APP_ROOT: root })
    expect(j.status).toBe(0)
    expect(JSON.parse(j.stdout).status).toBe('running')
    expect(j.stdout.toLowerCase()).not.toContain('kernel') // mai più euristiche sul testo
    expect(existsSync(join(root, 'kernels', KERNEL_LINK_NAME))).toBe(false)
  })

  it('ready: il kernel È un file della cartella kernels/ dell\'appRoot (symlink → bersaglio non vuoto)', () => {
    const root = join(TMP, 'obv5-ready-root')
    const j = run('ready', ['system', 'status', '--format', 'json'], { SANDBOT_TEST_CONTAINER_APP_ROOT: root })
    expect(j.status).toBe(0)
    const link = join(root, 'kernels', KERNEL_LINK_NAME)
    expect(existsSync(link)).toBe(true)
    expect(readlinkSync(link)).toBe(KERNEL_TARGET_NAME)
    expect(statSync(link).isFile()).toBe(true) // segue il symlink
    expect(statSync(link).size).toBeGreaterThan(0)
  })

  it('`system kernel set --recommended`: crea il kernel; la SECONDA volta esce 1 con l\'errore VERO di «File exists»', () => {
    const root = join(TMP, 'obv5-kset-root')
    const first = run('kernel-missing', ['system', 'kernel', 'set', '--recommended'], { SANDBOT_TEST_CONTAINER_APP_ROOT: root })
    expect(first.status).toBe(0)
    expect(existsSync(join(root, 'kernels', KERNEL_LINK_NAME))).toBe(true)
    // NON è idempotente, come il vero: esce 1 col File exists
    const second = run('kernel-missing', ['system', 'kernel', 'set', '--recommended'], { SANDBOT_TEST_CONTAINER_APP_ROOT: root })
    expect(second.status).toBe(1)
    expect(second.stderr).toContain('NSCocoaErrorDomain Code=516')
    expect(second.stderr).toContain('an item with the same name already exists')
    expect(second.stderr).toContain('NSPOSIXErrorDomain Code=17 "File exists"')
  })
})

describe('OBV5: la corsa di test non chiama MAI la CLI vera (ora container è installato sul Mac)', () => {
  it('containerCliPath() non risolve mai /usr/local/bin/container: la rete di sicurezza della corsa vitest', async () => {
    // test-setup punta HOMUN_CONTAINER_PATH a un percorso inesistente della
    // temporanea di prova: qualunque sonda non stubbata spawnerebbe ENOENT,
    // mai la CLI VERA che ora vive in /usr/local/bin
    const { containerCliPath } = await import('../../src/main/sandbox/apple-container-engine')
    expect(containerCliPath()).not.toBe('/usr/local/bin/container')
    expect(existsSync(containerCliPath())).toBe(false)
  })
})

// ---- BAV1 (fase box-apple-cli-vera): la finta è SEVERA come la VERA ----
// La prova dal vivo: la CLI vera esce 64 sui --format inventati e su
// inspect --format, e volume create NON è idempotente. La finta che li
// accettava nascondeva il difetto (la catena del guasto del 2026-11-14).
// Questi test sono stati visti FALLIRE sulla finta di prima della fase.
describe('BAV1: la CLI finta rifiuta quello che rifiuta la vera', () => {
  it('--format con un valore inventato → exit 64 con l\'errore VERO', () => {
    for (const argv of [
      ['ls', '-a', '--format', '{{.name}}'],
      ['volume', 'ls', '--format', '{{.name}}'],
      ['system', 'df', '--format', 'pretty']
    ]) {
      const r = run('ready', argv)
      expect(r.status, JSON.stringify(argv)).toBe(64)
      expect(r.stderr.trim(), JSON.stringify(argv)).toBe(`Error: The value '${argv[argv.indexOf('--format') + 1]}' is invalid for '--format <format>'. Please provide one of 'json', 'table', 'yaml' or 'toml'.`)
    }
    // i valori veri passano
    expect(run('ready', ['ls', '-a', '--format', 'json']).status).toBe(0)
    expect(run('ready', ['volume', 'ls', '--format', 'json']).status).toBe(0)
  })

  it('inspect --format → Error: Unknown option \'--format\', exit 64 (l\'errore del vivo)', () => {
    const r = run('ready', ['inspect', '--format', '{{.running}}', 'sandbot-box'])
    expect(r.status).toBe(64)
    expect(r.stderr.trim()).toBe("Error: Unknown option '--format'")
    const img = run('ready', ['image', 'inspect', '--format', '{{.size}}', 'sandbot-box:abc'])
    expect(img.status).toBe(64)
    expect(img.stderr.trim()).toBe("Error: Unknown option '--format'")
  })

  it('volume create di un volume che ESISTE → exit 1 con l\'errore VERO (non è idempotente)', () => {
    const logFile = join(TMP, `log-bav1-vol-${Date.now()}.jsonl`)
    const env = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env })
    expect(fake(['volume', 'create', 'sandbot-plugins']).status).toBe(0)
    const second = fake(['volume', 'create', 'sandbot-plugins'])
    expect(second.status).toBe(1)
    expect(second.stderr.trim()).toBe("Error: volume 'sandbot-plugins' already exists")
    // e il volume ORMAI c'è: l'elenco lo dice (BAV2/BAV3 leggono prima di creare)
    const ls = fake(['volume', 'ls', '--format', 'json'])
    expect(ls.status).toBe(0)
    expect(JSON.parse(ls.stdout).map((v: { configuration: { name: string } }) => v.configuration.name)).toContain('sandbot-plugins')
  })

  it('inspect di un container che non c\'è → l\'errore VERO della fixture, exit 1', () => {
    const r = run('ready', ['inspect', 'nonesiste'])
    expect(r.status).toBe(1)
    expect(r.stderr.trim()).toBe('Error: container not found: nonesiste')
  })

  it('le opzioni sono quelle della HELP VERA: --filter su volume ls esce 64 come sconosciuta', () => {
    const r = run('ready', ['volume', 'ls', '--format', 'json', '--filter', 'name=^/sandbot-box$'])
    expect(r.status).toBe(64)
    expect(r.stderr.trim()).toBe("Error: Unknown option '--filter'")
  })
})

// ---- BAV1: le forme VERE delle fixture, riempite con lo stato della finta ----
// La finta stampa il FORMATO della CLI vera (stesse chiavi, stessa forma) per
// ls --format json, inspect, volume ls --format json e system df --format
// json: le fixture copiate alla lettera sono il blocco (confronto
// STRUTTURALE: stesse chiavi a ogni livello, i valori sono dello stato).
const FIXTURES = join(ROOT, 'src', 'main', 'sandbox', '__tests__', 'fixtures', 'container-1.7.1')

/** Le chiavi di un valore JSON, RICORSIVE: le foglie (stringhe/numeri) sono uguali per forma. */
const shapeOf = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : []
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]))
  }
  return typeof v
}

/** Il corpo di una fixture: senza la riga `$ container…` e senza la riga `[exit N]`. */
const fixtureBody = (name: string): string => {
  const text = readFileSync(join(FIXTURES, name), 'utf8')
  return text.replace(/^\$ container[^\n]*\n/, '').replace(/\[exit \d+\]\n?$/, '').trim()
}

describe('BAV1: la finta stampa le FORME vere (stesse chiavi delle fixture)', () => {
  /** Il box della finta: un run -d con tutto quello che serve, in un log solo. */
  const boxLog = () => {
    const logFile = join(TMP, `log-bav1-shape-${Date.now()}.jsonl`)
    const env = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env })
    fake(['build', '-t', 'sandbot-box:abab9640c765', '.'])
    fake(['volume', 'create', 'sandbot-box'])
    fake(['volume', 'create', 'sandbot-plugins'])
    fake(['volume', 'create', 'sandbot-browser'])
    fake([
      'run', '-d', '--init', '--name', 'sandbot-box', '-u', '1000:1000', '-m', '4g', '-c', '2',
      '--network', 'homun-box', '-v', 'sandbot-box:/box', '-v', 'sandbot-plugins:/plugins:ro', '-v', 'sandbot-browser:/browser',
      '-w', '/box', 'sandbot-box:abab9640c765', 'sleep', 'infinity'
    ])
    return { logFile, fake }
  }

  it('ls -a --format json: l\'array di oggetti {configuration, id, status} della fixture', () => {
    const { fake } = boxLog()
    const r = fake(['ls', '-a', '--format', 'json'])
    expect(r.status).toBe(0)
    const got = JSON.parse(r.stdout)
    expect(Array.isArray(got)).toBe(true)
    expect(got).toHaveLength(1)
    const want = JSON.parse(fixtureBody('ls-a-json.txt'))
    expect(shapeOf(got[0])).toEqual(shapeOf(want[0]))
    expect(got[0].configuration.id).toBe('sandbot-box')
    expect(got[0].configuration.useInit).toBe(true)
    expect(got[0].configuration.mounts.map((m: { destination: string; options: string[] }) => `${m.destination}:${m.options.includes('ro') ? 'ro' : 'rw'}`)).toEqual(['/box:rw', '/plugins:ro', '/browser:rw'])
    expect(got[0].status.state).toBe('running')
  })

  it('inspect sandbot-box: l\'elemento del box, stessa forma della fixture inspect-box', () => {
    const { fake } = boxLog()
    const r = fake(['inspect', 'sandbot-box'])
    expect(r.status).toBe(0)
    const got = JSON.parse(r.stdout)
    const want = JSON.parse(fixtureBody('inspect-box.txt'))
    expect(shapeOf(got[0])).toEqual(shapeOf(want[0]))
    expect(got[0].configuration.image.reference).toBe('docker.io/library/sandbot-box:abab9640c765')
    expect(got[0].configuration.networks[0].network).toBe('homun-box')
  })

  it('volume ls --format json: le voci {configuration, id} con configuration.name', () => {
    const { fake } = boxLog()
    const r = fake(['volume', 'ls', '--format', 'json'])
    expect(r.status).toBe(0)
    const got = JSON.parse(r.stdout)
    const want = JSON.parse(fixtureBody('volume-ls-json.txt'))
    expect(got.map((v: { configuration: { name: string } }) => v.configuration.name).sort()).toEqual(['sandbot-box', 'sandbot-browser', 'sandbot-plugins'])
    expect(shapeOf(got[0])).toEqual(shapeOf(want[0]))
  })

  it('system df --format json: l\'OGGETTO {containers, images, volumes} della fixture', () => {
    const { fake } = boxLog()
    const r = fake(['system', 'df', '--format', 'json'])
    expect(r.status).toBe(0)
    const got = JSON.parse(r.stdout)
    const want = JSON.parse(fixtureBody('system-df-json.txt'))
    expect(shapeOf(got)).toEqual(shapeOf(want))
    expect(got.volumes.total).toBe(3)
  })

  it('ls -a -q: i SOLI nomi, uno per riga (come la fixture quiet)', () => {
    const { fake } = boxLog()
    const r = fake(['ls', '-a', '-q'])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('sandbot-box')
  })
})

// ---- BRV2 (fase box-apple-rete-vera): anche la RETE parla la fixture ----
// `network inspect` e `network ls` della finta stampano la FORMA delle
// fixture VERE (network-inspect-homun-box, network-ls-json): l'array di
// {configuration{creationDate, labels, mode, name, options, plugin}, id,
// status{ipv4Gateway, ipv4Subnet, ipv6Subnet}} — MAI il {name, internal,
// subnets[]} inventato di prima (il formato che nascondeva il difetto del
// parse). Lo stato resta quello della finta: homun-box 192.168.128.0/24
// gateway .1; homun-box-isolated una sottorete SUA, diversa. I VALORI del
// gateway/sottorete di homun-box si possono pilotare (SANDBOT_TEST_
// CONTAINER_GATEWAY/SUBNET) come i test del proxy iniettano 127.0.0.1:
// l'indirizzo dichiarato è quello che il daemon deve ascoltare.
describe('BRV2: la finta stampa la rete nella FORMA della fixture (stesse chiavi alla stessa profondità)', () => {
  it('network inspect homun-box: l\'elemento della fixture, con gateway .1 e sottorete 192.168.128.0/24', () => {
    const logFile = join(TMP, `log-brv2-net-${Date.now()}.jsonl`)
    const env = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env })
    const r = fake(['network', 'inspect', 'homun-box'])
    expect(r.status).toBe(0)
    const got = JSON.parse(r.stdout)
    const want = JSON.parse(fixtureBody('network-inspect-homun-box.txt'))
    expect(shapeOf(got[0])).toEqual(shapeOf(want[0]))
    expect(got[0].configuration.name).toBe('homun-box')
    expect(got[0].configuration.mode).toBe('hostOnly')
    expect(got[0].id).toBe('homun-box')
    expect(got[0].status.ipv4Gateway).toBe('192.168.128.1')
    expect(got[0].status.ipv4Subnet).toBe('192.168.128.0/24')
    // il vecchio formato INVENTATO ({name, internal, subnets[]}) è VIA
    expect(got[0].internal).toBeUndefined()
    expect(got[0].subnets).toBeUndefined()
  })

  it('network inspect homun-box-isolated: la STESSA forma ma una sottorete SUA, diversa da homun-box', () => {
    const logFile = join(TMP, `log-brv2-iso-${Date.now()}.jsonl`)
    const env = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env })
    expect(fake(['network', 'create', '--internal', 'homun-box-isolated']).status).toBe(0)
    const r = fake(['network', 'inspect', 'homun-box-isolated'])
    expect(r.status).toBe(0)
    const got = JSON.parse(r.stdout)
    const want = JSON.parse(fixtureBody('network-inspect-homun-box.txt'))
    expect(shapeOf(got[0])).toEqual(shapeOf(want[0]))
    expect(got[0].configuration.mode).toBe('hostOnly')
    expect(got[0].status.ipv4Gateway).not.toBe('192.168.128.1')
    expect(got[0].status.ipv4Subnet).not.toBe('192.168.128.0/24')
    expect(got[0].status.ipv4Subnet).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/)
  })

  it('network ls --format json: la forma della fixture network-ls-json (le voci dello stato della finta)', () => {
    const logFile = join(TMP, `log-brv2-ls-${Date.now()}.jsonl`)
    const env = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env })
    const r = fake(['network', 'ls', '--format', 'json'])
    expect(r.status).toBe(0)
    const got = JSON.parse(r.stdout)
    const want = JSON.parse(fixtureBody('network-ls-json.txt'))
    expect(Array.isArray(got)).toBe(true)
    expect(got.length).toBeGreaterThanOrEqual(1)
    // il riferimento di forma è la voce homun-box della fixture (labels
    // vuote come la finta; la voce default porta un label builtin suo)
    const wantHomun = want.find((n: { id: string }) => n.id === 'homun-box')
    for (const el of got) expect(shapeOf(el)).toEqual(shapeOf(wantHomun))
    const homun = got.find((n: { id: string }) => n.id === 'homun-box')
    expect(homun.status.ipv4Gateway).toBe('192.168.128.1')
    expect(homun.status.ipv4Subnet).toBe('192.168.128.0/24')
  })

  it('i VALORI di homun-box si pilotano (gateway/sottorete dichiarati): il percorso dei test del proxy e della sonda', () => {
    const logFile = join(TMP, `log-brv2-env-${Date.now()}.jsonl`)
    const env = {
      PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile,
      SANDBOT_TEST_CONTAINER_GATEWAY: '127.0.0.1', SANDBOT_TEST_CONTAINER_SUBNET: '127.0.0.0/8'
    }
    const r = spawnSync(process.execPath, [FAKE, 'network', 'inspect', 'homun-box'], { encoding: 'utf8', env })
    expect(r.status).toBe(0)
    const got = JSON.parse(r.stdout)
    expect(got[0].status.ipv4Gateway).toBe('127.0.0.1')
    expect(got[0].status.ipv4Subnet).toBe('127.0.0.0/8')
    // la forma NON cambia: sono i soli VALORI dello stato della finta
    const want = JSON.parse(fixtureBody('network-inspect-homun-box.txt'))
    expect(shapeOf(got[0])).toEqual(shapeOf(want[0]))
  })
})

// ---- BAV5: il wrapper di BACKGROUND del daemon — i file che scrive nel box ----
// Il run-command foreground parte col wrapper (sh -c <wrapper> sh <cmd> <log>
// <exit> <pid>) e il daemon aspetta l'EXIT FILE leggendolo col cat del box:
// il «box» della finta non ha filesystem, quindi la finta risponde alle
// letture dei percorsi del wrapper (exit → 0, log → vuoto, pid → un pid).
describe('BAV5: la finta onora il contratto del wrapper di background', () => {
  it('cat dell\'exit file → 0, del log → vuoto, del pid → un pid (il comando finisce)', () => {
    const logFile = join(TMP, `log-bav5-wrapper-${Date.now()}.jsonl`)
    const env = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env })
    // il wrapper vero del daemon (le righe costanti di docker-argv)
    const WRAPPER = [
      'mkdir -p "$(dirname "$2")"',
      'if command -v setsid >/dev/null 2>&1; then',
      '  setsid sh -c "$1" >"$2" 2>&1 &',
      '  cmd=$!',
      '  echo "$cmd" >"$4"',
      'else',
      '  sh -c "$1" >"$2" 2>&1 &',
      '  cmd=$!',
      '  echo "$$" >"$4"',
      'fi',
      'wait "$cmd"',
      'echo "$?" >"$3"'
    ].join('\n')
    const launch = fake(['exec', '-d', '-w', '/box', 'sandbot-box', 'sh', '-c', WRAPPER, 'sh', 'echo uno', '/box/home/a/x.log', '/box/home/a/x.exit', '/box/home/a/x.pid'])
    expect(launch.status).toBe(0)
    // il polling del daemon: cat dell'exit file → il comando è FINITO con 0
    expect(fake(['exec', '-i', '-w', '/box', 'sandbot-box', 'cat', '--', '/box/home/a/x.exit']).stdout).toBe('0\n')
    // il log del comando: vuoto (la finta non interpreta il comando)
    expect(fake(['exec', '-i', '-w', '/box', 'sandbot-box', 'cat', '--', '/box/home/a/x.log']).stdout).toBe('\n')
    // il pid del comando: un numero
    expect(fake(['exec', '-i', '-w', '/box', 'sandbot-box', 'cat', '--', '/box/home/a/x.pid']).stdout.trim()).toBe('4242')
    // gli ALTRI file del box restano come prima (cat qualsiasi → vuoto, exit 0)
    expect(fake(['exec', '-i', '-w', '/box', 'sandbot-box', 'cat', '--', '/box/home/a/altro.txt']).status).toBe(0)
  })

  it('i percorsi del wrapper sono RELATIVI alla home: il cat arriva COL PERCORSO ASSOLUTO (come il daemon)', () => {
    const logFile = join(TMP, `log-bav5-wrapper-rel-${Date.now()}.jsonl`)
    const env = { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: logFile }
    const fake = (argv: string[]) => spawnSync(process.execPath, [FAKE, ...argv], { encoding: 'utf8', env })
    const WRAPPER = 'mkdir -p "$(dirname "$2")"\nif command -v setsid >/dev/null 2>&1; then\n  setsid sh -c "$1" >"$2" 2>&1 &\n  cmd=$!\n  echo "$cmd" >"$4"\nelse\n  sh -c "$1" >"$2" 2>&1 &\n  cmd=$!\n  echo "$$" >"$4"\nfi\nwait "$cmd"\necho "$?" >"$3"'
    // il lancio vero del daemon: percorsi RELATIVI (l'exec -w li risolve nel box)
    expect(fake(['exec', '-d', '-w', '/box/home/a', '-e', 'HOME=/box/home/a', 'sandbot-box', 'sh', '-c', WRAPPER, 'sh', 'echo due', '.sandbot/shells/sh-x.log', '.sandbot/shells/sh-x.exit', '.sandbot/shells/sh-x.pid']).status).toBe(0)
    // il polling legge l'ASSOLUTO
    const exit = fake(['exec', '-i', '-w', '/box', 'sandbot-box', 'cat', '--', '/box/home/a/.sandbot/shells/sh-x.exit'])
    expect(exit.status).toBe(0)
    expect(exit.stdout).toBe('0\n')
  })
})
