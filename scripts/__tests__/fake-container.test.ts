// Fase box-container (BX5): la CLI FINTA di Apple container. Registra gli
// argv (file di log) e risponde ai comandi che il motore usa; i comportamenti
// si scelgono con SANDBOT_TEST_CONTAINER_MODE (not-installed / stopped /
// kernel-missing / ready). Zero rete, zero motore vero: process spawn del
// file .mjs con env pilotata.
import { describe, expect, it, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const FAKE = join(ROOT, 'scripts', 'fake-container.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'sandbot-fake-container-test-'))

/** Lancia la CLI finta con env di prova; log su un file del TMP (uno per chiamata). */
let runSeq = 0
function run(mode: string, argv: string[]): { status: number | null; stdout: string; stderr: string; log: string[][] } {
  const logFile = join(TMP, `log-${++runSeq}-${mode}.jsonl`)
  const r = spawnSync(process.execPath, [FAKE, ...argv], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SANDBOT_TEST_CONTAINER_MODE: mode,
      SANDBOT_TEST_CONTAINER_LOG: logFile
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

  it('system status: ready → running; stopped → NON running; kernel-missing → running MA kernel mancante', () => {
    expect(run('ready', ['system', 'status']).stdout.toLowerCase()).toContain('running: true')
    const st = run('stopped', ['system', 'status']).stdout.toLowerCase()
    expect(st).toContain('running: false')
    const km = run('kernel-missing', ['system', 'status']).stdout.toLowerCase()
    expect(km).toContain('running: true')
    expect(km).toContain('kernel')
    expect(km).toContain('missing')
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
    const r = spawnSync(wrapper, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, SANDBOT_TEST_CONTAINER_MODE: 'ready' } })
    expect(r.status).toBe(0)
  })
})
