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

  it('system df --format json: voci Images/Containers/Local Volumes/Build Cache in byte umani', () => {
    const out = run('ready', ['system', 'df', '--format', 'json']).stdout
    const df = JSON.parse(out) as Array<{ Type: string; Size: string; Reclaimable: string }>
    const types = df.map((e) => e.Type)
    for (const want of ['Images', 'Containers', 'Local Volumes', 'Build Cache']) expect(types).toContain(want)
    const volumes = df.find((e) => e.Type === 'Local Volumes')!
    expect(parseFloat(volumes.Size)).toBeGreaterThan(0)
  })

  it('image inspect --format {{.size}} → un numero di byte', () => {
    const r = run('ready', ['image', 'inspect', '--format', '{{.size}}', 'sandbot-box:abc'])
    expect(r.status).toBe(0)
    expect(Number(r.stdout.trim())).toBeGreaterThan(1_000_000_000)
  })

  it('la pulizia sicura risponde: image prune e builder prune; image delete e volume delete pure', () => {
    expect(run('ready', ['image', 'prune', '-f']).status).toBe(0)
    expect(run('ready', ['builder', 'prune', '-f']).status).toBe(0)
    expect(run('ready', ['image', 'delete', 'sandbot-box:vecchia']).status).toBe(0)
    expect(run('ready', ['volume', 'delete', 'sandbot-box']).status).toBe(0)
  })

  it('network inspect homun-box → il gateway della rete interna', () => {
    const r = run('ready', ['network', 'inspect', 'homun-box'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('gateway')
    expect(r.stdout).toMatch(/192\.0\.\d+\.1/)
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
    // la dimensione (--format) resta sempre disponibile (le righe di spazio su disco)
    const size = fake(['image', 'inspect', '--format', '{{.size}}', 'sandbot-box:fake'])
    expect(size.status).toBe(0)
    expect(size.stdout.trim()).toBe('1180000000')
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
