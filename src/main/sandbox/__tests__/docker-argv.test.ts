import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dockerStdioMcpArgv,
  dockerRmDirArgv,
  dockerPluginCopyCreateArgv,
  dockerPluginsMkdirArgv,
  dockerPluginCpArgv,
  dockerPluginsChownArgv,
  dockerPluginsChmodArgv,
  dockerPluginsRmHelperArgv,
  dockerPluginsVolumeCreateArgv,
  pluginsContainerPath,
  dockerBoxMountsArgv,
  boxHasPluginsMountRo,
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
    dockerContainerImageArgv,
    dockerBuildArgv,
    DOCKER_WRITE_SH,
    DOCKER_BOX_INIT_SH,
    DOCKER_BOX_MIGRATE_SH,
    DOCKER_BG_WRAPPER_SH,
    BOX_CONTAINER,
    BOX_VOLUME,
    BOX_MOUNT,
    PLUGINS_VOLUME,
    PLUGINS_MOUNT,
    boxHomePath,
    DEFAULT_BOX_LIMITS
,
    PLAYWRIGHT_MCP_CONFIG, PLAYWRIGHT_MCP_CONFIG_JSON
} from '../docker-argv'

// ---- fase 14 correzioni (P1+P2): il browser come pwuser nel volume /browser ----

import {
  BROWSER_USER, BROWSER_VOLUME, BROWSER_MOUNT, browserStateDir, browserProfilePath, browserPidFile,
  dockerBrowserVolumeCreateArgv, dockerBrowserRootArgv, DOCKER_BROWSER_ROOT_SH, dockerBrowserWritableArgv,
  dockerBrowserOldProfileRmArgv, dockerBrowserReadFileArgv,
  dockerBrowserReadB64Argv, dockerBrowserWriteB64Argv, DOCKER_WRITE_B64_SH, dockerBrowserRmFileArgv,
  boxHasBrowserMountRw
} from '../docker-argv'
import { readFileSync as rf } from 'node:fs'

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
    // M4: il volume DEDICATO dei plugin montato /plugins:ro — la sola lettura
    // la impone il KERNEL, non un chmod revocabile dal bot
    expect(argv).toContain('sandbot-plugins:/plugins:ro')
    // P2 (fase 14 correzioni): il volume DEDICATO del browser montato /browser
    // rw — TUTTO lo stato del browser è di 1001 e fuori dalla portata del bot
    expect(argv).toContain('sandbot-browser:/browser')
    expect(argv).toContainEqual('-v')
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
  it('dockerBrowserMcpArgv: exec -i -u 1001:1001 (pwuser, P2) -w /browser (Q1) col wrapper COSTANTE e i flag MCP', () => {
    const argv = dockerBrowserMcpArgv('agent_x', 18765)
    expect(argv.slice(0, 12)).toEqual([
      'exec', '-i',
      '-u', '1001:1001',
      '-w', '/browser',
      'sandbot-box',
      'sh', '-c', DOCKER_BROWSER_WRAPPER_SH, 'sh',
      '/browser/agent_x/mcp.pid'
    ])
    // Q1 (fase 14 correzioni 2): il `-w` è /browser, NON /browser/<owner> —
    // l'OCI runtime fa chdir PRIMA di avviare il wrapper e al primo avvio la
    // cartella del proprietario NON esiste ancora (la crea il mkdir del
    // wrapper): -w /browser/<owner> faceva fallire ogni avvio con rc 127
    expect(argv[argv.indexOf('-w') + 1]).toBe(BROWSER_MOUNT)
    // il wrapper COSTANTE è l'elemento sh -c, il pid file è $1 e i flag seguono
    expect(argv[argv.indexOf('-c') + 1]).toBe(DOCKER_BROWSER_WRAPPER_SH)
    expect(argv).toContain('/browser/agent_x/mcp.pid')
    // I2: NIENTE setsid (il processo di docker exec è già leader di sessione:
    // setsid forka e il padre chiude lo stdio del client) e il pid si scrive
    // PRIMA dell'exec — quel pid è anche il pgid per il kill di gruppo
    expect(DOCKER_BROWSER_WRAPPER_SH).not.toContain('setsid')
    expect(DOCKER_BROWSER_WRAPPER_SH.indexOf('echo $$')).toBeLessThan(DOCKER_BROWSER_WRAPPER_SH.indexOf('exec playwright-mcp'))
    expect(DOCKER_BROWSER_WRAPPER_SH).toContain('exec playwright-mcp')
    expect(DOCKER_BROWSER_WRAPPER_SH).toContain('echo $$')
    // Q1: il wrapper crea la cartella del pid e CI ENTRA (la cwd del server è
    // /browser/<owner>, dove finisce il filename RELATIVO dello screenshot);
    // se mkdir o cd falliscono esce SUBITO: mai un server nella cartella sbagliata
    expect(DOCKER_BROWSER_WRAPPER_SH).toContain('mkdir -p "$(dirname "$1")" && cd "$(dirname "$1")" || exit 1')
    expect(DOCKER_BROWSER_WRAPPER_SH.indexOf('cd "$(dirname "$1")"')).toBeLessThan(DOCKER_BROWSER_WRAPPER_SH.indexOf('echo $$'))
    // TUTTI i flag obbligatori (valori compresi), con il tetto delle uscite (I8)
    const flags = browserMcpFlags('agent_x', 18765)
    for (const [f, v] of [
      ['--headless', null], ['--browser', 'chromium'], ['--no-sandbox', null],
      ['--user-data-dir', '/browser/agent_x/profile'],
      ['--output-dir', '/browser/agent_x/output'],
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

  it('fase 15 S9: --disable-blink-features= VUOTO nella config, mai AutomationControlled', () => {
    // Playwright MCP 0.0.83 aggiunge da sé "--disable-blink-features=AutomationControlled"
    // SOLO se nessun arg contiene "--disable-blink-features": l'arg VUOTO lo
    // accontenta senza nascondere l'automazione (navigator.webdriver resta true)
    const args = JSON.parse(PLAYWRIGHT_MCP_CONFIG_JSON).browser.launchOptions.args as string[]
    expect(args).toContain('--disable-blink-features=')
    // da nessuna parte il valore che maschera il browser automatizzato
    expect(PLAYWRIGHT_MCP_CONFIG_JSON).not.toContain('AutomationControlled')
    // il Dockerfile crea il file con la STESSA stringa (il test fase 12 0e la
    // confronta già; qui il punto è che anche lì niente AutomationControlled)
    const dockerfile = readFileSync('resources/box/Dockerfile', 'utf8')
    expect(dockerfile).not.toContain('--disable-blink-features=AutomationControlled')
    expect(dockerfile).toContain('"--disable-blink-features="')
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
    // di DEFAULT gira come l'utente del container (1000:1000, i comandi del bot)
    expect(dockerKillGroupArgv('sandbot-box', 15, 'TERM')).toEqual(['exec', '-u', '1000:1000', 'sandbot-box', 'kill', '-TERM', '--', '-15'])
    expect(dockerKillGroupArgv('sandbot-box', 15, 'KILL')).toEqual(['exec', '-u', '1000:1000', 'sandbot-box', 'kill', '-KILL', '--', '-15'])
    expect(dockerKillGroupArgv('sandbot-box', 15, '0')).toEqual(['exec', '-u', '1000:1000', 'sandbot-box', 'kill', '-0', '--', '-15'])
    // P2: il kill degli orfani del browser gira COME 1001 (il server è di pwuser:
    // come 1000 riceverebbe EPERM e l'orfano terrebbe il SingletonLock)
    expect(dockerKillGroupArgv('sandbot-box', 15, 'TERM', '1001:1001')).toEqual(['exec', '-u', '1001:1001', 'sandbot-box', 'kill', '-TERM', '--', '-15'])
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

  it('M4: decisione pura con pluginsMountOk — mount /plugins:ro mancante ricrea il SOLO container, inspect fallito NON ricrea', () => {
    expect(boxEnsurePlan({ exists: true, initOk: true, pluginsMountOk: false, writable: true })).toEqual({ kind: 'recreate', reason: 'mount-plugin-mancante' })
    expect(boxEnsurePlan({ exists: true, initOk: true, pluginsMountOk: false, writable: false })).toEqual({ kind: 'recreate', reason: 'mount-plugin-mancante' })
    expect(boxEnsurePlan({ exists: true, initOk: true, pluginsMountOk: true, writable: true })).toEqual({ kind: 'use' })
    // inspect dei mount fallito (undefined): si tiene il container che funziona
    expect(boxEnsurePlan({ exists: true, initOk: true, pluginsMountOk: undefined, writable: true })).toEqual({ kind: 'use' })
  })

  it('P2: decisione pura con browserMountOk — mount /browser:rw mancante ricrea il SOLO container, inspect fallito NON ricrea', () => {
    expect(boxEnsurePlan({ exists: true, initOk: true, pluginsMountOk: true, browserMountOk: false, writable: true })).toEqual({ kind: 'recreate', reason: 'mount-browser-mancante' })
    expect(boxEnsurePlan({ exists: true, initOk: true, browserMountOk: false, writable: false })).toEqual({ kind: 'recreate', reason: 'mount-browser-mancante' })
    // con il mount del browser a posto (o inspect non riuscito) NON è quella la ragione
    expect(boxEnsurePlan({ exists: true, initOk: true, pluginsMountOk: true, browserMountOk: true, writable: true })).toEqual({ kind: 'use' })
    expect(boxEnsurePlan({ exists: true, initOk: true, browserMountOk: undefined, writable: true })).toEqual({ kind: 'use' })
    expect(boxEnsurePlan({ exists: true, initOk: true, browserMountOk: undefined, writable: false })).toEqual({ kind: 'recreate', reason: 'volume-di-root' })
  })

  it('M4/N1: inspect dei mount sulla vista EFFETTIVA .Mounts e boxHasPluginsMountRo (puro)', () => {
    // N1: il template è FISSATO dal test — .Mounts è la vista effettiva dei
    // mount e vale per -v e --mount; un ritorno a .HostConfig.Mounts (che per
    // un container creato con -v è SEMPRE vuoto) ricreava il box a ogni
    // comando e questo test lo prende
    expect(dockerBoxMountsArgv(BOX_CONTAINER)).toEqual(['inspect', '-f', '{{range .Mounts}}{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}} {{end}}', 'sandbot-box'])
    expect(dockerBoxMountsArgv(BOX_CONTAINER)[2]).toContain('.Mounts')
    expect(dockerBoxMountsArgv(BOX_CONTAINER)[2]).not.toContain('.HostConfig.Mounts')
    // fixture VERA: l'output di quel template sul box creato dal nostro codice
    // (Binds: "sandbot-box:/box:nocopy","sandbot-plugins:/plugins:ro",
    // "sandbot-browser:/browser") — l'ORDINE delle voci dipende da Docker
    expect(boxHasPluginsMountRo('/box:rw /browser:rw /plugins:ro ')).toBe(true)
    expect(boxHasPluginsMountRo('/plugins:ro /browser:rw /box:rw ')).toBe(true) // ordine non assunto
    expect(boxHasPluginsMountRo('/box:rw ')).toBe(false) // nato prima di M4
    expect(boxHasPluginsMountRo('/plugins:rw ')).toBe(false) // montato rw: non basta
    expect(boxHasPluginsMountRo('')).toBe(false) // inspect fallito
    expect(boxHasPluginsMountRo('Error: No such object')).toBe(false)
    // P2: il mount del browser /browser:rw, stessa forma
    expect(boxHasBrowserMountRw('/box:rw /browser:rw /plugins:ro ')).toBe(true)
    expect(boxHasBrowserMountRw('/plugins:ro /browser:rw /box:rw ')).toBe(true)
    expect(boxHasBrowserMountRw('/box:rw /plugins:ro ')).toBe(false) // nato prima di P2
    expect(boxHasBrowserMountRw('/browser:ro ')).toBe(false) // montato ro: non basta
    expect(boxHasBrowserMountRw('')).toBe(false)
    expect(boxHasBrowserMountRw('Error: No such object')).toBe(false)
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
      expect(r.error).toContain('the box is not writable by the container user (1000:1000)')
      expect(r.error).toContain('test -w /box/workspace')
      expect(r.error).toContain('sandbot-box')
      expect(r.error).toContain('the data inside was not touched')
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

// ---- fase 12 (punto 1) + P2: il browser del FIGLIO (istanza propria, --isolated) ----

describe('il launcher del browser di un SOTTOAGENTE', () => {
  it('child: --isolated AL POSTO di --user-data-dir, output-dir e pid file col suo id NEL volume del padre, -w /browser (Q1), e gira ANCHE lui come 1001', () => {
    const flags = browserMcpFlags('sub_a1b2c3d4', 18765, { child: true, owner: 'agent_padre' })
    expect(flags).toContain('--isolated')
    expect(flags).not.toContain('--user-data-dir')
    expect(flags[flags.indexOf('--output-dir') + 1]).toBe('/browser/agent_padre/output-sub_a1b2c3d4')
    const argv = dockerBrowserMcpArgv('sub_a1b2c3d4', 18765, { child: true, owner: 'agent_padre' })
    expect(argv).toContain('/browser/agent_padre/mcp-sub_a1b2c3d4.pid')
    // Q1: come il principale, il `-w` è il punto di mount (la cartella del
    // proprietario la crea il wrapper col mkdir)
    expect(argv[argv.indexOf('-w') + 1]).toBe(BROWSER_MOUNT)
    // P2: il figlio gira COME 1001 pure lui (niente più 1000: il suo stato sta
    // nel volume privato del browser, non nella home del padre)
    expect(argv[argv.indexOf('-u') + 1]).toBe('1001:1001')
    // il flag --config resta obbligatorio anche per il figlio
    expect(flags[flags.indexOf('--config') + 1]).toBe(PLAYWRIGHT_MCP_CONFIG)
  })

  it('browserPidFile: padre e figlio non si pestano il pid file (tutti in /browser/<owner>)', () => {
    expect(browserPidFile('agent_x')).toBe('/browser/agent_x/mcp.pid')
    expect(browserPidFile('agent_x', 'sub_a1b2c3d4')).toBe('/browser/agent_x/mcp-sub_a1b2c3d4.pid')
  })
})

// ---- fase 13 (punto 2): i server MCP stdio del registro/plugin nel BOX ----

describe('fase 13: argv del server MCP stdio nel box (dockerStdioMcpArgv)', () => {
  it('docker exec -i -u 1000:1000 -w <home> [-e HOME=<home del bot>] sandbot-box npx …, SENZA wrapper né setsid', () => {
    const argv = dockerStdioMcpArgv({ workdir: '/box/home/agent_x', command: 'npx', args: ['-y', '@foreverworks/mcp-notion@0.1.0'] })
    expect(argv).toEqual([
      'exec', '-i', '-u', '1000:1000', '-w', '/box/home/agent_x', '-e', 'HOME=/box/home/agent_x',
      'sandbot-box', 'npx', '-y', '@foreverworks/mcp-notion@0.1.0'
    ])
    expect(argv.join(' ')).not.toContain('setsid')
    expect(argv.join(' ')).not.toContain('sh -c')
    // L1: il server di plugin dichiara la SUA home (la workdir è la cartella
    // del plugin): HOME arriva uguale a execDocker
    const plugin = dockerStdioMcpArgv({ workdir: '/box/plugins/mp/demo/abc', home: '/box/home/agent_x', command: 'node', args: ['run.js'] })
    expect(plugin).toContain('-e')
    expect(plugin[plugin.indexOf('-e') + 1]).toBe('HOME=/box/home/agent_x')
  })
  it('le variabili SEGRETE passano col SOLO nome (-e NOME): il VALORE mai in argv (HOME non è un segreto, come execDocker)', () => {
    const argv = dockerStdioMcpArgv({
      workdir: '/box/home/a', command: 'npx', args: ['-y', 'x@1.0.0'],
      envKeys: ['NOTION_TOKENS_DIR', 'API_KEY']
    })
    expect(argv).toEqual([
      'exec', '-i', '-u', '1000:1000', '-w', '/box/home/a', '-e', 'HOME=/box/home/a',
      '-e', 'NOTION_TOKENS_DIR', '-e', 'API_KEY',
      'sandbot-box', 'npx', '-y', 'x@1.0.0'
    ])
    // solo HOME (=VALORE) e i NOMI delle chiavi segrete: nessun altro valore in argv
    expect(argv.filter((a) => a.includes('='))).toEqual(['HOME=/box/home/a'])
  })
  it('M4: gli argv della copia nel volume DEDICATO — one-shot root, volume rw solo nei one-shot, argv PURI', () => {
    // il contenitore usa-e-getta della copia: volume montato rw in /p
    expect(dockerPluginCopyCreateArgv('sandbot-plugin-copy-ab12cd34', IMG)).toEqual([
      'create', '--name', 'sandbot-plugin-copy-ab12cd34', '-v', 'sandbot-plugins:/p', IMG, 'true'
    ])
    // mkdir del padre COME ROOT (docker cp crea il figlio, non il padre)
    expect(dockerPluginsMkdirArgv(IMG, '/plugins/mp/demo')).toEqual([
      'run', '--rm', '-u', '0', '-v', 'sandbot-plugins:/p', IMG, 'mkdir', '-p', '--', '/p/mp/demo'
    ])
    // cp nella usa-e-getta col path mappato da /plugins a /p
    expect(dockerPluginCpArgv('/tmp/p', 'sandbot-plugin-copy-ab12cd34', '/plugins/mp/demo/abc123def456')).toEqual([
      'cp', '/tmp/p', 'sandbot-plugin-copy-ab12cd34:/p/mp/demo/abc123def456'
    ])
    // chown e chmod come ROOT (docker cp conserva l'uid del Mac: 501:20)
    expect(dockerPluginsChownArgv(IMG, '/plugins/mp/demo/abc123def456')).toEqual([
      'run', '--rm', '-u', '0', '-v', 'sandbot-plugins:/p', IMG, 'chown', '-R', '0:0', '--', '/p/mp/demo/abc123def456'
    ])
    expect(dockerPluginsChmodArgv(IMG, '/plugins/mp/demo/abc123def456')).toEqual([
      'run', '--rm', '-u', '0', '-v', 'sandbot-plugins:/p', IMG, 'chmod', '-R', 'a+rX,a-w', '--', '/p/mp/demo/abc123def456'
    ])
    // l'usa-e-getta si rimuove SEMPRE
    expect(dockerPluginsRmHelperArgv('sandbot-plugin-copy-ab12cd34')).toEqual(['rm', '-f', 'sandbot-plugin-copy-ab12cd34'])
    // il volume si crea se manca (volume create è idempotente)
    expect(dockerPluginsVolumeCreateArgv()).toEqual(['volume', 'create', 'sandbot-plugins'])
    // il mapping /plugins → /p è una semplice traduzione di prefisso (puro)
    expect(pluginsContainerPath('/plugins/a/b/c')).toBe('/p/a/b/c')
  })
  it('M4: dockerRmDirArgv — path NUOVI via one-shot root sul volume dei plugin, path VECCHI via exec nel box', () => {
    expect(dockerRmDirArgv('/plugins/mp/demo/abc', IMG)).toEqual([
      'run', '--rm', '-u', '0', '-v', 'sandbot-plugins:/p', IMG, 'rm', '-rf', '--', '/p/mp/demo/abc'
    ])
    // i record di prima della correzione (/box/plugins/…) non si rompono
    expect(dockerRmDirArgv('/box/plugins/mp/demo/abc', IMG)).toEqual([
      'exec', 'sandbot-box', 'rm', '-rf', '--', '/box/plugins/mp/demo/abc'
    ])
  })
})

// ---- fase 14 (punto 7a) + correzioni P2: il browser come pwuser (1001) nel volume /browser ----

describe('fase 14 7a + P2: il browser gira come pwuser (1001:1001) con lo stato nel volume /browser', () => {
  it('il launcher del bot PRINCIPALE: -u 1001:1001 e --user-data-dir /browser/<owner>/profile', () => {
    expect(BROWSER_USER).toBe('1001:1001')
    expect(browserProfilePath('agent_x')).toBe('/browser/agent_x/profile')
    expect(browserStateDir('agent_x')).toBe('/browser/agent_x')
    const argv = dockerBrowserMcpArgv('agent_x', 18765)
    expect(argv[argv.indexOf('-u') + 1]).toBe('1001:1001')
    const flags = browserMcpFlags('agent_x', 18765)
    expect(flags[flags.indexOf('--user-data-dir') + 1]).toBe('/browser/agent_x/profile')
    // NESSUN path del browser sotto /box/home (né profilo, né output, né pid):
    // la shell del bot non deve vederli
    const browserPaths = [...flags, ...argv].filter((a) => typeof a === 'string' && a.includes('/browser'))
    expect(browserPaths.length).toBeGreaterThan(0)
    expect([...flags, ...argv].some((a) => typeof a === 'string' && a.includes('/box/home') && a.includes('browser'))).toBe(false)
  })

  it('il FIGLIO (--isolated): nessun profilo persistente, MAI uid 1000 nel launcher', () => {
    const argv = dockerBrowserMcpArgv('sub_a1b2c3d4', 18765, { child: true, owner: 'agent_padre' })
    expect(argv[argv.indexOf('-u') + 1]).toBe('1001:1001')
    const flags = browserMcpFlags('sub_a1b2c3d4', 18765, { child: true, owner: 'agent_padre' })
    expect(flags).toContain('--isolated')
    expect(flags).not.toContain('--user-data-dir')
  })

  it('P2: il one-shot ROOT tocca SOLO la radice del volume /browser (stringa COSTANTE, contenitore --rm separato)', () => {
    expect(dockerBrowserVolumeCreateArgv()).toEqual(['volume', 'create', 'sandbot-browser'])
    expect(dockerBrowserRootArgv(IMG)).toEqual(['run', '--rm', '-v', 'sandbot-browser:/browser', IMG, 'sh', '-c', DOCKER_BROWSER_ROOT_SH])
    // la stringa è COSTANTE e fissa: chown+chmod della SOLA radice, niente -R,
    // niente percorsi dentro /box (regola: un one-shot di root non tocca MAI
    // un percorso che il bot può scrivere)
    expect(DOCKER_BROWSER_ROOT_SH).toBe('chown 1001:1001 /browser && chmod 0700 /browser')
    expect(DOCKER_BROWSER_ROOT_SH).not.toContain('-R')
    expect(DOCKER_BROWSER_ROOT_SH).not.toContain('/box')
    // il controllo come 1001 dopo lo start: argv PURO, test POSIX (-a = AND)
    expect(dockerBrowserWritableArgv('sandbot-box')).toEqual([
      'exec', '-u', '1001:1001', 'sandbot-box', 'test', '-O', '/browser', '-a', '-w', '/browser'
    ])
  })

  it('P2: il profilo VECCHIO nella home del bot si cancella COME 1000 (file del bot: nessun root, nessun privilegio)', () => {
    expect(dockerBrowserOldProfileRmArgv('sandbot-box', 'agent_x')).toEqual([
      'exec', '-u', '1000:1000', 'sandbot-box', 'rm', '-rf', '--', '/box/home/agent_x/.browser/profile'
    ])
  })

  it('P2: la copia dello screenshot — lettura base64 come 1001, scrittura atomica come 1000, rm come 1001', () => {
    // lettura: base64 (il PNG nel canale stdout di una stringa JS non si
    // corrompe), come 1001, path come argomento
    expect(dockerBrowserReadB64Argv('sandbot-box', '/browser/agent_x/screenshot-ab12cd34.png')).toEqual([
      'exec', '-u', '1001:1001', 'sandbot-box', 'base64', '-w', '0', '--', '/browser/agent_x/screenshot-ab12cd34.png'
    ])
    // scrittura: la STESSA forma atomica di DOCKER_WRITE_SH ma con base64 -d
    // sullo stdin, COME 1000, nella home del bot
    expect(dockerBrowserWriteB64Argv('sandbot-box', '/box/home/agent_x/.browser/screens/ab12cd34.png')).toEqual([
      'exec', '-i', '-u', '1000:1000', '-w', '/box', 'sandbot-box', 'sh', '-c', DOCKER_WRITE_B64_SH,
      'sh', '/box/home/agent_x/.browser/screens/ab12cd34.png'
    ])
    expect(DOCKER_WRITE_B64_SH).toBe('mkdir -p "$(dirname "$1")" && base64 -d >"$1.sandbot-tmp" && mv -f "$1.sandbot-tmp" "$1"')
    // cancellazione dell'originale nel volume privato, come 1001
    expect(dockerBrowserRmFileArgv('sandbot-box', '/browser/agent_x/screenshot-ab12cd34.png')).toEqual([
      'exec', '-u', '1001:1001', 'sandbot-box', 'rm', '-f', '--', '/browser/agent_x/screenshot-ab12cd34.png'
    ])
    // la lettura del pid file degli orfani: cat come 1001 (il file è suo)
    expect(dockerBrowserReadFileArgv('sandbot-box', '/browser/agent_x/mcp.pid')).toEqual([
      'exec', '-i', '-u', '1001:1001', '-w', '/browser', 'sandbot-box', 'cat', '--', '/browser/agent_x/mcp.pid'
    ])
  })

  it('P1: il Dockerfile NON crea utenti (useradd con uid 1001 VIETATO) e VERIFICA pwuser 1001:1001', () => {
    const dockerfile = rf('resources/box/Dockerfile', 'utf8')
    // NESSUN useradd con uid 1001: l'immagine base Playwright porta già
    // pwuser (1001:1001) — un secondo utente con quell'uid farebbe FALLIRE la
    // build (UID 1001 is not unique, P1)
    expect(dockerfile).not.toMatch(/useradd\s+[^#\n]*--uid\s+1001/)
    expect(dockerfile).not.toContain('sbrowser')
    // la riga di VERIFICA c'è: se l'immagine base cambia utente o uid, la build
    // FALLISCE in modo chiaro invece di far girare il browser con uid inatteso
    expect(dockerfile).toContain('test "$(id -u pwuser)" = 1001 && test "$(id -g pwuser)" = 1001')
    expect(dockerfile).toContain('pwuser')
  })
})

// ---- Q1 (fase 14 correzioni 2): la guardia sul `-w` di OGNI docker exec ----

describe('Q1: il `-w` di un docker exec è SOLO un percorso che esiste già', () => {
  /**
   * Un `-w` ammesso dalla regola di modulo in docker-argv.ts: /box o /browser
   * (i punti di mount, esistono SEMPRE) oppure una cartella che un passo
   * PRECEDENTE ha già creato — la home di un bot (ensureBotHome, H2) o la
   * cartella di un plugin (l'installazione, fase 13). MAI una cartella che
   * crea il processo stesso: l'OCI runtime fa chdir PRIMA di eseguire il
   * comando e un `-w` inesistente muore con rc 127 (è il bug Q1).
   */
  const allowedWorkdir = (w: string): boolean =>
    w === BOX_MOUNT ||
    w === BROWSER_MOUNT ||
    /^\/box\/home\/[A-Za-z0-9_-]+$/.test(w) ||
    /^\/box\/plugins\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(w)

  it('TUTTI gli argv esportati col `-w` puntano a un percorso dell\'insieme ammesso', () => {
    const argvsWithW = [
      dockerExecArgv(BOX_CONTAINER, 'cmd'), // default, senza workdir esplicito
      dockerExecArgv(BOX_CONTAINER, 'cmd', { workdir: boxHomePath('agent_x') }),
      dockerExecBackgroundArgv(BOX_CONTAINER, 'cmd', { workdir: boxHomePath('agent_x') }, { log: 'l', exit: 'e', pid: 'p' }),
      dockerExecBackgroundArgv(BOX_CONTAINER, 'cmd', {}, { log: 'l', exit: 'e', pid: 'p' }),
      dockerReadFileArgv(BOX_CONTAINER, '/box/home/x/f'),
      dockerWriteFileArgv(BOX_CONTAINER, '/box/home/x/f'),
      dockerListDirArgv(BOX_CONTAINER, '.'),
      dockerStatSizeArgv(BOX_CONTAINER, '/box/home/x/f'),
      dockerStdioMcpArgv({ workdir: boxHomePath('agent_x'), command: 'npx' }),
      dockerStdioMcpArgv({ workdir: '/box/plugins/mp/demo/abc', command: 'node', args: ['run.js'] }),
      dockerBrowserMcpArgv('agent_x', 18765), // launcher del browser principale
      dockerBrowserMcpArgv('sub_a1b2c3d4', 18765, { child: true, owner: 'agent_padre' }), // e del figlio
      dockerBrowserReadFileArgv(BOX_CONTAINER, '/browser/agent_x/mcp.pid'),
      dockerBrowserWriteB64Argv(BOX_CONTAINER, '/box/home/agent_x/.browser/screens/ab12cd34.png')
    ]
    for (const argv of argvsWithW) {
      const ws: string[] = []
      for (let i = 1; i < argv.length; i++) if (argv[i - 1] === '-w') ws.push(argv[i])
      expect(ws.length, `atteso almeno un -w docker in [${argv.join(' ')}]`).toBeGreaterThan(0)
      for (const w of ws) expect(allowedWorkdir(w), `-w "${w}" non ammesso in [${argv.join(' ')}]`).toBe(true)
    }
  })

  it('il bug Q1 non torna: NESSUN `-w` punta alla cartella del proprietario del browser (la crea il wrapper stesso)', () => {
    for (const argv of [
      dockerBrowserMcpArgv('agent_x', 18765),
      dockerBrowserMcpArgv('sub_a1b2c3d4', 18765, { child: true, owner: 'agent_padre' })
    ]) {
      const ws = argv.filter((_, i) => argv[i - 1] === '-w')
      expect(ws).not.toContain(browserStateDir('agent_x'))
      expect(ws).not.toContain(browserStateDir('agent_padre'))
    }
  })
})
