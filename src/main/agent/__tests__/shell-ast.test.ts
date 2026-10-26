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

  it('hasRedirectToFile resta derivato dalle destinazioni', async () => {
    const a = await an('echo hi > /tmp/x')
    expect(a.hasRedirectToFile).toBe(true)
    expect((await an('cat < /tmp/in')).hasRedirectToFile).toBe(false)
  })
})

describe('redirectTargets (C2: destinazioni dei redirect di output)', () => {
  it('espone la destinazione di >, >>, &>, >| e dello stderr 2>', async () => {
    expect((await an('echo hi > /tmp/x')).redirectTargets).toEqual(['/tmp/x'])
    expect((await an('echo hi >> /tmp/x')).redirectTargets).toEqual(['/tmp/x'])
    expect((await an('echo hi &> /tmp/x')).redirectTargets).toEqual(['/tmp/x'])
    expect((await an('echo hi >| /tmp/x')).redirectTargets).toEqual(['/tmp/x'])
    expect((await an('ls 2> /tmp/err')).redirectTargets).toEqual(['/tmp/err'])
    expect((await an('echo ok > /dev/null')).redirectTargets).toEqual(['/dev/null'])
  })

  it('le virgolette nella destinazione vengono rimosse', async () => {
    expect((await an('echo hi > "/tmp/my file"')).redirectTargets).toEqual(['/tmp/my file'])
  })

  it('le duplicazioni di fd (2>&1, >&2) non sono destinazioni file', async () => {
    expect((await an('ls 2>&1')).redirectTargets).toEqual([])
    expect((await an('ls >&2')).redirectTargets).toEqual([])
    expect((await an('ls 2>&1 > /dev/null')).redirectTargets).toEqual(['/dev/null'])
  })

  it('heredoc con redirect su file espone comunque la destinazione', async () => {
    expect((await an('cat > /tmp/x <<EOF\nriga\nEOF')).redirectTargets).toEqual(['/tmp/x'])
    expect((await an('cat <<EOF > /tmp/x\nriga\nEOF')).redirectTargets).toEqual(['/tmp/x'])
    expect((await an('cat <<EOF\nsolo stdout\nEOF')).redirectTargets).toEqual([])
  })

  it('la lettura < non produce destinazioni di output', async () => {
    expect((await an('grep x < /tmp/in')).redirectTargets).toEqual([])
  })
})

describe('hasEnvPrefix (C3: assegnazioni prima del comando)', () => {
  it('FOO=bar ls → il comando è marcato; ls pulito no', async () => {
    const a = await an('FOO=bar ls -la')
    expect(a.commands[0]!.name).toBe('ls')
    expect(a.commands[0]!.hasEnvPrefix).toBe(true)
    expect((await an('ls -la')).commands[0]!.hasEnvPrefix).toBe(false)
  })

  it('più assegnazioni e assegnazione in pipeline', async () => {
    const a = await an('A=1 B=2 git status | grep x')
    expect(a.commands[0]!.hasEnvPrefix).toBe(true)
    expect(a.commands[1]!.hasEnvPrefix).toBe(false)
  })

  it('FOO=1 da solo non è un comando (resta innocuo per il gate)', async () => {
    const a = await an('FOO=1')
    expect(a.commands).toEqual([])
  })
})

describe('secretRefs (C4: riferimenti {{secret:...}} nella riga)', () => {
  it('estrae i nomi unici in ordine di prima comparsa', async () => {
    const a = await an('curl -H "A: {{secret:API_KEY}}" "{{secret:DB_PWD}} {{secret:API_KEY}}"')
    expect(a.secretRefs).toEqual(['API_KEY', 'DB_PWD'])
  })

  it('senza riferimenti → array vuoto', async () => {
    expect((await an('ls -la')).secretRefs).toEqual([])
    expect((await an('echo "{{secret:}}"')).secretRefs).toEqual([]) // nome vuoto: non è un ref valido
  })
})
