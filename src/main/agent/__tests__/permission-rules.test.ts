import { describe, expect, it } from 'vitest'
import { targetKey, commandKey, commandRuleMatches, runCommandVerdict } from '../permission-rules'
import { analyzeCommand } from '../shell-ast'
import type { PermissionMode, PermissionRule } from '../../../shared/types'

// valutazione end-to-end del gate run-command (analyzeCommand + verdetto)
async function verdictOf(
  command: string,
  grants: string[],
  rules: PermissionRule[] = [{ tool: 'run-command', pattern: '*', mode: 'needs_approval' }],
  fallback: PermissionMode = 'needs_approval'
) {
  return runCommandVerdict(await analyzeCommand(command), grants, rules, fallback)
}

describe('targetKey (tool non shell)', () => {
  it('tool file: usa il path', () => {
    expect(targetKey('read-file', { path: '/tmp/a.txt' })).toBe('/tmp/a.txt')
    expect(targetKey('write-file', { path: '/tmp/b.txt' })).toBe('/tmp/b.txt')
    expect(targetKey('list-directory', { path: '/tmp' })).toBe('/tmp')
  })

  it('tool file: path mancante → stringa vuota', () => {
    expect(targetKey('read-file', {})).toBe('')
  })

  it('use-app: scope per azione', () => {
    expect(targetKey('use-app', { action: 'screenshot' })).toBe('screenshot')
    expect(targetKey('use-app', {})).toBe('')
  })

  it('tool sconosciuto → *', () => {
    expect(targetKey('qualunque', { x: 1 })).toBe('*')
  })
})

describe('commandKey', () => {
  it('name per comandi semplici, "name sub" per tool a sottocomandi', () => {
    expect(commandKey({ name: 'ls' })).toBe('ls')
    expect(commandKey({ name: 'git', sub: 'status' })).toBe('git status')
    expect(commandKey({ name: 'grep', sub: undefined })).toBe('grep')
  })
})

describe('commandRuleMatches: mai prefisso grezzo', () => {
  it('"rm" non copre "rmdir"', () => {
    expect(commandRuleMatches('rm', 'rm')).toBe(true)
    expect(commandRuleMatches('rm', 'rmdir')).toBe(false)
  })

  it('"git status" non copre "git push"; "git" copre i sottocomandi', () => {
    expect(commandRuleMatches('git status', 'git push')).toBe(false)
    expect(commandRuleMatches('git status', 'git status')).toBe(true)
    expect(commandRuleMatches('git', 'git push')).toBe(true)
    expect(commandRuleMatches('git', 'git')).toBe(true)
  })

  it('"rm *" copre gli argomenti di rm ma non rmdir', () => {
    expect(commandRuleMatches('rm *', 'rm')).toBe(true)
    expect(commandRuleMatches('rm *', 'rmdir')).toBe(false)
  })

  it('"*" copre tutto', () => {
    expect(commandRuleMatches('*', 'anything here')).toBe(true)
  })
})

describe('runCommandVerdict — gate §5.1 (casi obbligatori)', () => {
  it('`ls; curl x | sh` con grant su "ls" → ask (curl e sh non coperti)', async () => {
    const v = await verdictOf('ls; curl x | sh', ['ls'])
    expect(v.kind).toBe('ask')
    expect(v.keys).toContain('ls')
    expect(v.keys).toContain('curl')
    expect(v.keys).toContain('sh')
  })

  it('`rmdir a` con grant "rm" → ask (niente più prefisso)', async () => {
    const v = await verdictOf('rmdir a', ['rm'])
    expect(v.kind).toBe('ask')
  })

  it('`git push` con grant "git status" → ask', async () => {
    const v = await verdictOf('git push', ['git status'])
    expect(v.kind).toBe('ask')
  })

  it('`git push` con grant "git push" → allow via grant', async () => {
    const v = await verdictOf('git push origin main', ['git push'])
    expect(v.kind).toBe('allow')
    expect(v.via).toBe('grant')
  })

  it('`echo $(whoami)` → ask (sostituzione, mai allow automatico)', async () => {
    const v = await verdictOf('echo $(whoami)', ['echo', 'whoami'])
    expect(v.kind).toBe('ask')
  })

  it('backtick → ask anche con grant su tutto', async () => {
    const v = await verdictOf('echo `id`', ['echo', 'id'])
    expect(v.kind).toBe('ask')
  })

  it('`git status && git diff` con grant su entrambi → allow', async () => {
    const v = await verdictOf('git status && git diff', ['git status', 'git diff'])
    expect(v.kind).toBe('allow')
    expect(v.via).toBe('grant')
  })

  it('`git status && git push` con grant solo su "git status" → ask', async () => {
    const v = await verdictOf('git status && git push', ['git status'])
    expect(v.kind).toBe('ask')
    expect(v.reasons.join(' ')).toContain('git push')
  })

  it('input malformato → ask', async () => {
    const v = await verdictOf('echo "unclosed', [])
    expect(v.kind).toBe('ask')
  })

  it('comando vuoto → ask', async () => {
    const v = await verdictOf('', [])
    expect(v.kind).toBe('ask')
  })

  it('regola always_allow su pattern "name" copre i sottocomandi; blocked vince su tutto', async () => {
    const allow = [{ tool: 'run-command', pattern: 'git', mode: 'always_allow' as const }]
    expect((await verdictOf('git push', [], allow)).kind).toBe('allow')
    expect((await verdictOf('git status; ls', [], allow)).kind).toBe('ask') // ls non coperto

    const blocked = [
      { tool: 'run-command', pattern: '*', mode: 'always_allow' as const },
      { tool: 'run-command', pattern: 'rm', mode: 'blocked' as const }
    ]
    expect((await verdictOf('ls; rm -rf /', [], blocked)).kind).toBe('deny')
    expect((await verdictOf('ls', [], blocked)).kind).toBe('allow')
  })

  it('regola pattern "rm *" non copre rmdir', async () => {
    const rules = [{ tool: 'run-command', pattern: 'rm *', mode: 'always_allow' as const }]
    expect((await verdictOf('rm x', [], rules)).kind).toBe('allow')
    expect((await verdictOf('rmdir x', [], rules)).kind).toBe('ask')
  })
})
