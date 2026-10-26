import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// getSetting senza Electron: modalità host di default
vi.mock('../../store/db', () => ({ getSetting: (_key: string, fallback: unknown) => fallback }))

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-host-test-'))
// homedir → directory temporanea: la box non tocca la home reale
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => TMP }
})

const { execCommand, readFileInBox, writeFileInBox, listDirectoryInBox } = await import('../index')

const AGENT = 'agent_test'

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('backend host: file via fs/promises (§5.2)', () => {
  it('write → read riportano il contenuto byte per byte (niente newline aggiunto, marker heredoc innocui)', async () => {
    const content = 'riga1\nSENZA newline finale\ncontiene SANDBOT_EOF e $(date) e `id`'
    await writeFileInBox(AGENT, 'sub/dir/file.txt', content)
    expect(readFileSync(join(TMP, 'SandBot', AGENT, 'box', 'sub/dir/file.txt'), 'utf8')).toBe(content)
    expect(await readFileInBox(AGENT, 'sub/dir/file.txt')).toBe(content)
  })

  it('read con path relativo risolve nella box', async () => {
    await writeFileInBox(AGENT, 'rel.txt', 'x')
    expect(await readFileInBox(AGENT, 'rel.txt')).toBe('x')
  })

  it('list-directory elenca la box', async () => {
    const out = await listDirectoryInBox(AGENT, '.')
    expect(out).toContain('rel.txt')
    expect(out).toContain('sub')
  })

  it('execCommand host: output intatto e env iniettata', async () => {
    const r = await execCommand(AGENT, 'printf senza-newline')
    expect(r.stdout).toBe('senza-newline')
    const e = await execCommand(AGENT, 'printf "%s" "$SANDBOT_SECRET_PROVA"', { env: { SANDBOT_SECRET_PROVA: 'valore' } })
    expect(e.stdout).toBe('valore')
  })
})

// il describe sopra gira una sola volta dopo l'import mockato; existsSync serve
// solo da canario in caso di refactor dei path
describe('sanity box path', () => {
  beforeAll(() => {
    expect(existsSync(join(TMP, 'SandBot', AGENT, 'box'))).toBe(true)
  })
  it('la box vive sotto la homedir mockata', () => { expect(true).toBe(true) })
})
