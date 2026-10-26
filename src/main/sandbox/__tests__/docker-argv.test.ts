import { describe, expect, it } from 'vitest'
import {
  dockerExecArgv,
  dockerReadFileArgv,
  dockerWriteFileArgv,
  dockerListDirArgv,
  dockerPsArgv,
  dockerStartArgv,
  dockerCreateArgv,
  dockerVolumeChownArgv,
  DOCKER_WRITE_SH
} from '../docker-argv'

describe('dockerExecArgv', () => {
  it('argv senza shell: exec -i -w /home/box <container> sh -c <command>', () => {
    expect(dockerExecArgv('sandbot-x', 'echo hi')).toEqual([
      'exec', '-i', '-w', '/home/box', 'sandbot-x', 'sh', '-c', 'echo hi'
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
    expect(dockerReadFileArgv('c', path)).toEqual(['exec', '-i', '-w', '/home/box', 'c', 'cat', '--', path])
  })

  it('write: sh -c costante, path come argomento posizionale, contenuto NON in argv', () => {
    const argv = dockerWriteFileArgv('c', '/home/box/x; $(reboot)`y`')
    expect(argv).toEqual(['exec', '-i', '-w', '/home/box', 'c', 'sh', '-c', DOCKER_WRITE_SH, 'sh', '/home/box/x; $(reboot)`y`'])
    // lo script è fisso: crea la dir del file e riversa lo stdin byte per byte
    expect(DOCKER_WRITE_SH).toBe('mkdir -p "$(dirname "$1")" && cat > "$1"')
  })

  it('list: ls -la con path come argv', () => {
    expect(dockerListDirArgv('c', '.')).toEqual(['exec', '-i', '-w', '/home/box', 'c', 'ls', '-la', '--', '.'])
  })
})

describe('lifecycle & hardening (§5.2)', () => {
  it('ps: filtro nome esatto ancorato, senza grep', () => {
    expect(dockerPsArgv('sandbot-x')).toEqual([
      'ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^/sandbot-x$'
    ])
  })

  it('start: argv diretto', () => {
    expect(dockerStartArgv('c')).toEqual(['start', 'c'])
  })

  it('create: utente non-root, cap-drop ALL, no-new-privileges, pids/memory/cpus, rete configurabile', () => {
    const argv = dockerCreateArgv('sandbot-x', 'sandbot-x-box', 'bridge')
    for (const flag of ['--user', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus', '--network']) {
      expect(argv).toContain(flag)
    }
    const val = (flag: string) => argv[argv.indexOf(flag) + 1]
    expect(val('--user')).toBe('1000:1000')
    expect(val('--cap-drop')).toBe('ALL')
    expect(val('--security-opt')).toBe('no-new-privileges')
    expect(val('--pids-limit')).toBe('512')
    expect(val('--memory')).toBe('2g')
    expect(val('--cpus')).toBe('2')
    expect(val('--network')).toBe('bridge')
    // rete isolata quando configurata
    expect(val('--network')).not.toBe('none')
    expect(dockerCreateArgv('c', 'v', 'none')[dockerCreateArgv('c', 'v', 'none').indexOf('--network') + 1]).toBe('none')
  })

  it('init volume: one-shot chown per l’utente non-root', () => {
    expect(dockerVolumeChownArgv('v')).toEqual(['run', '--rm', '-v', 'v:/home/box', 'ubuntu:24.04', 'chown', '-R', '1000:1000', '/home/box'])
  })
})
