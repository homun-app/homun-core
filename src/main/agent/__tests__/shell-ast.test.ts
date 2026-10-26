import { describe, expect, it } from 'vitest'
import { analyzeCommand, SUBCOMMAND_TOOLS } from '../shell-ast'

const an = (src: string) => analyzeCommand(src)

describe('analyzeCommand', () => {
  it('estrae ogni comando semplice da pipeline, ;, &&, ||, subshell', async () => {
    const a = await an('a | b; c && d || (e; f)')
    expect(a.commands.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(a.parseError).toBe(false)
    expect(a.hasSubstitution).toBe(false)
  })

  it('comandi dentro $(...) e backtick vengono estratti e marcati come substitution', async () => {
    const cmd = await an('echo $(whoami)')
    expect(cmd.hasSubstitution).toBe(true)
    expect(cmd.commands.map((c) => c.name)).toContain('whoami')

    const backtick = await an('echo `id -u`')
    expect(backtick.hasSubstitution).toBe(true)
    expect(backtick.commands.map((c) => c.name)).toContain('id')
  })

  it('riconosce i redirect verso file (ma non la lettura <)', async () => {
    expect((await an('echo hi > /tmp/x')).hasRedirectToFile).toBe(true)
    expect((await an('echo hi >> /tmp/x')).hasRedirectToFile).toBe(true)
    expect((await an('cat < /tmp/in')).hasRedirectToFile).toBe(false)
  })

  it('input malformato → parseError', async () => {
    expect((await an('echo "unclosed')).parseError).toBe(true)
  })

  it('argv: parola singola, stringa quotata, assignment non è un argomento', async () => {
    const a = await an('FOO=bar ls -la "/tmp/my dir"')
    const ls = a.commands.find((c) => c.name === 'ls')!
    expect(ls.argv).toEqual(['ls', '-la', '/tmp/my dir'])
  })

  it('sub = primo argomento non-flag, solo per i tool a sottocomandi', async () => {
    const git = (await an('git status -s')).commands[0]!
    expect(git.sub).toBe('status')
    // git senza sottocomando esplicito davanti ai flag
    const gitC = (await an('git -C repo status')).commands[0]!
    expect(gitC.name).toBe('git')
    expect(gitC.sub).toBe('repo') // primo non-flag: conservativo, mai un allow sbagliato
    // per i tool normali il sub NON si calcola
    const ls = (await an('ls -la /tmp')).commands[0]!
    expect(ls.sub).toBeUndefined()
    // e i comandi con sottocomando lo estraggono anche in pipeline
    const mix = await an('docker ps | grep sandbot')
    expect(mix.commands.map((c) => c.name)).toEqual(['docker', 'grep'])
    expect(mix.commands[0]!.sub).toBe('ps')
    expect(mix.commands[1]!.sub).toBeUndefined() // grep non è un tool a sottocomandi
  })

  it('sub: primo argomento non-flag dopo il nome', async () => {
    const docker = (await an('docker exec -it box sh -c "ls"')).commands[0]!
    expect(docker.sub).toBe('exec')
    const brew = (await an('brew install wget')).commands[0]!
    expect(brew.sub).toBe('install')
    expect(SUBCOMMAND_TOOLS.has('kubectl')).toBe(true)
  })

  it('comando vuoto → nessun comando, nessun errore', async () => {
    const a = await an('')
    expect(a.commands).toEqual([])
    expect(a.parseError).toBe(false)
  })
})
