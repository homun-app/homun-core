import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-host-test-'))
// fase 11 (residuo 0d): la radice del box viene dalla directory DATI, che il
// test inietta su una temporanea — la home reale non viene MAI toccata
vi.mock('../../store/db', () => ({
  getSetting: (_key: string, fallback: unknown) => fallback,
  dataDir: () => TMP
}))

const { execCommand, readFileInBox, writeFileInBox, listDirectoryInBox, boxRoot } = await import('../index')

const AGENT = 'agent_test'

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('backend host: file via fs/promises (§5.2)', () => {
  it('write → read riportano il contenuto byte per byte (niente newline aggiunto, marker heredoc innocui)', async () => {
    const content = 'riga1\nSENZA newline finale\ncontiene SANDBOT_EOF e $(date) e `id`'
    await writeFileInBox(AGENT, 'sub/dir/file.txt', content)
    expect(readFileSync(join(TMP, 'box', 'home', AGENT, 'sub/dir/file.txt'), 'utf8')).toBe(content)
    expect(await readFileInBox(AGENT, 'sub/dir/file.txt')).toBe(content)
  })

  it('read con path relativo risolve nella home del bot', async () => {
    await writeFileInBox(AGENT, 'rel.txt', 'x')
    expect(await readFileInBox(AGENT, 'rel.txt')).toBe('x')
  })

  it('list-directory elenca la home del bot', async () => {
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

// la struttura del box condiviso: workspace comune + home per agente (0d)
describe('struttura del box condiviso (residuo 0d)', () => {
  beforeAll(() => {
    expect(existsSync(join(TMP, 'box'))).toBe(true)
  })
  it('la radice è <dir dati>/box con workspace/ e home/<agentId>/', () => {
    expect(existsSync(join(boxRoot(), 'workspace'))).toBe(true)
    expect(existsSync(join(boxRoot(), 'home', AGENT))).toBe(true)
    // il box NON vive nella home reale dell'utente
    expect(boxRoot()).toBe(join(TMP, 'box'))
  })
})
