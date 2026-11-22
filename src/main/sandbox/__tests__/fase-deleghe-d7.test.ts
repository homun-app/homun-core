// D7 (fase deleghe): /workspace è un percorso VERO anche nel terminale del
// box. Il caso vero del 22/11: il prompt dice /workspace e i tool dei file
// lo traducono, ma NEL BOX il percorso non esisteva — run-command mkdir
// /workspace/… → «Permission denied», 4 messaggi tra bot per «concordare»
// il percorso e il principale che scriveva /workspace/… mentre Chef
// scriveva /box/workspace/… per gli stessi file.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-deleghe-d7-'))

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key in settings.value ? settings.value[key] : fallback),
  dataDir: () => TMP,
  getAgent: () => null
}))

const { dockerWorkspaceLinkArgv, dockerWorkspaceLinkCheckArgv, BOX_MOUNT, dockerListDirArgv, BOX_CONTAINER } = await import('../docker-argv')
const { appleWorkspaceLinkArgv, appleWorkspaceLinkCheckArgv } = await import('../apple-container-argv')
const { dockerEngine } = await import('../docker-engine')
const { appleContainerEngine } = await import('../apple-container-engine')

describe('D7: l\'argv del collegamento /workspace → /box/workspace, per OGNI motore', () => {
  it('docker: ln -sfn come ROOT, idempotente, e il check test -L', () => {
    expect(dockerWorkspaceLinkArgv(BOX_CONTAINER)).toEqual(['exec', '-u', '0', BOX_CONTAINER, 'ln', '-sfn', `${BOX_MOUNT}/workspace`, '/workspace'])
    expect(dockerWorkspaceLinkCheckArgv(BOX_CONTAINER)).toEqual(['exec', BOX_CONTAINER, 'test', '-L', '/workspace'])
    // -sfn: symlink, FORCE, no-dereference → due avvii non sbagliano
    expect(dockerWorkspaceLinkArgv(BOX_CONTAINER).join(' ')).toContain('-sfn')
  })

  it('apple container: stesso collegamento, stesso check (Podman/WSL2 riusano il contratto della CLI)', () => {
    expect(appleWorkspaceLinkArgv(BOX_CONTAINER)).toEqual(['exec', '-u', '0', BOX_CONTAINER, 'ln', '-sfn', `${BOX_MOUNT}/workspace`, '/workspace'])
    expect(appleWorkspaceLinkCheckArgv(BOX_CONTAINER)).toEqual(['exec', BOX_CONTAINER, 'test', '-L', '/workspace'])
  })

  it('i DUE motori espongono il collegamento nel loro argv (workspaceLink/workspaceLinkCheck)', () => {
    expect(dockerEngine.argv.workspaceLink?.(BOX_CONTAINER)).toEqual(dockerWorkspaceLinkArgv(BOX_CONTAINER))
    expect(appleContainerEngine.argv.workspaceLink?.(BOX_CONTAINER)).toEqual(appleWorkspaceLinkArgv(BOX_CONTAINER))
    expect(dockerEngine.argv.workspaceLinkCheck?.(BOX_CONTAINER)).toBeDefined()
    expect(appleContainerEngine.argv.workspaceLinkCheck?.(BOX_CONTAINER)).toBeDefined()
  })
})

const { ensureBoxWorkspaceLink, setBoxWorkspaceLinkedForTests, workspaceNameForPrompt } = await import('../index')

describe('D7: l\'ensure del collegamento — due avvii, nessun errore, ln UNA volta sola', () => {
  type Call = { argv: string[] }
  const makeRunner = (linkExistsAfterLn: boolean) => {
    const calls: Call[] = []
    let linked = false
    const runner = (argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      calls.push({ argv })
      const joined = argv.join(' ')
      if (joined.includes(' test -L /workspace')) return Promise.resolve({ exitCode: linked ? 0 : 1, stdout: '', stderr: '' })
      if (joined.includes(' ln -sfn ')) {
        if (linkExistsAfterLn) linked = true
        return Promise.resolve({ exitCode: linkExistsAfterLn ? 0 : 1, stdout: '', stderr: linkExistsAfterLn ? '' : 'ln: /workspace: Read-only file system' })
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }
    return { runner, calls }
  }

  beforeEach(() => setBoxWorkspaceLinkedForTests(null))

  it('primo avvio: check manca → ln; secondo avvio: check c\'è → NESSUN ln (idempotente)', async () => {
    const { runner, calls } = makeRunner(true)
    const first = await ensureBoxWorkspaceLink(runner as never, BOX_CONTAINER)
    expect(first).toBe(true)
    const lnCalls = calls.filter((c) => c.argv.includes('ln'))
    expect(lnCalls).toHaveLength(1)
    // secondo avvio: il check passa, nessun altro ln, nessun errore
    calls.length = 0
    const second = await ensureBoxWorkspaceLink(runner as never, BOX_CONTAINER)
    expect(second).toBe(true)
    expect(calls.filter((c) => c.argv.includes('ln'))).toHaveLength(0)
    expect(workspaceNameForPrompt()).toBe('/workspace')
  })

  it('collegamento FALLITO (filesystem in sola lettura): una riga di log, il prompt ricade su /box/workspace', async () => {
    const { runner } = makeRunner(false)
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
    let ok: boolean | null = null
    try {
      ok = await ensureBoxWorkspaceLink(runner as never, BOX_CONTAINER)
    } finally {
      console.log = orig
    }
    expect(ok).toBe(false)
    expect(logs.some((l) => l.includes('/workspace'))).toBe(true)
    // UN SOLO punto decide il nome che il bot vede
    expect(workspaceNameForPrompt()).toBe('/box/workspace')
    const { computerSection } = await import('../../agent/prompts')
    const section = computerSection()
    expect(section).toContain('`/box/workspace`')
    expect(section).not.toContain('`/workspace`')
    // e il prompt torna quello giusto quando il collegamento torna
    setBoxWorkspaceLinkedForTests(null)
  })
})

describe('D7: i tool dei file accettano ENTRAMBI i nomi e risolvono la stessa cartella', () => {
  it('host: resolveBoxPath(/workspace/…) e la cartella reale <radice>/workspace/… sono la STESSA', async () => {
    const { resolveBoxPath } = await import('../box-paths')
    const root = join(TMP, 'box-d7')
    const a = resolveBoxPath('/workspace/ricettario/pastiera-napoletana.md', root, join(root, 'home/bot'), (p) => p)
    const b = resolveBoxPath(resolve(root, 'workspace/ricettario/pastiera-napoletana.md'), root, join(root, 'home/bot'), (p) => p)
    expect(a).toEqual(b)
  })

  it('box: list-directory /workspace passa il percorso al container COM\'È (lo risolve il collegamento)', () => {
    // run-command ls /workspace e list-directory /workspace: nel container
    // /workspace È /box/workspace grazie al collegamento (testato sopra)
    expect(dockerListDirArgv(BOX_CONTAINER, '/workspace')).toEqual(['exec', '-i', '-w', BOX_MOUNT, BOX_CONTAINER, 'ls', '-la', '--', '/workspace'])
  })

  it('il prompt di base dice /workspace quando il collegamento c\'è (il default), con la riga della cartella comune', async () => {
    const { computerSection } = await import('../../agent/prompts')
    setBoxWorkspaceLinkedForTests(null)
    const section = computerSection()
    expect(section).toContain('`/workspace`')
    expect(section).toContain('COMMON space')
  })
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))
