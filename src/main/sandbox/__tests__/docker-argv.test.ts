import { describe, expect, it } from 'vitest'
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
  DOCKER_WRITE_SH,
  DOCKER_BOX_MIGRATE_SH,
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

  it('env: -e solo col NOME della variabile, il valore non compare mai in argv', () => {
    const argv = dockerExecArgv('c', 'curl -H $SANDBOT_SECRET_API_KEY', { env: { SANDBOT_SECRET_API_KEY: 'SK-1234-SEGRETO' } })
    const i = argv.indexOf('-e')
    expect(argv[i + 1]).toBe('SANDBOT_SECRET_API_KEY')
    expect(argv.join(' ')).not.toContain('SK-1234-SEGRETO')
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
    for (const flag of ['--user', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus', '--network']) {
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
