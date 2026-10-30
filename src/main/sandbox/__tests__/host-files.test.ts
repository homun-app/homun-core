import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
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

  // ---- fase 11 (punto 1): confini dei path e scrittura atomica ----

  it('`/workspace` è l\'alias della cartella comune: scrive e legge lo stesso file daQualsiasi bot', async () => {
    await writeFileInBox(AGENT, '/workspace/weekend/luoghi.md', '# Luoghi\nBologna')
    // dal punto di vista di un ALTRO agente è lo stesso file (box condiviso)
    expect(await readFileInBox('agent_altro', '/workspace/weekend/luoghi.md')).toBe('# Luoghi\nBologna')
    expect(readFileSync(join(TMP, 'box', 'workspace', 'weekend', 'luoghi.md'), 'utf8')).toBe('# Luoghi\nBologna')
  })

  it('fuori dalla radice del box → rifiuto con errore chiaro (read, write, list)', async () => {
    // la home è due livelli dentro la radice: tre ../ escono dal box condiviso
    for (const path of ['/etc/passwd', '../../../etc/passwd', join(TMP, 'fuori.txt')]) {
      await expect(readFileInBox(AGENT, path)).rejects.toThrow(/leaves the shared box/)
      await expect(writeFileInBox(AGENT, path, 'x')).rejects.toThrow(/leaves the shared box/)
      await expect(listDirectoryInBox(AGENT, path)).rejects.toThrow(/leaves the shared box/)
    }
  })

  it('scrittura ATOMICA: il contenuto arriva intero e non restano file temporanei', async () => {
    const content = 'riga1\nriga2 senza newline finale'
    await writeFileInBox(AGENT, 'atomico.md', content)
    expect(await readFileInBox(AGENT, 'atomico.md')).toBe(content)
    // il temporaneo (stessa cartella) è stato rinominato: non ne resta traccia
    const files = readdirSync(join(TMP, 'box', 'home', AGENT))
    expect(files.filter((f) => f.includes('sandbot-tmp'))).toHaveLength(0)
    expect(files).toContain('atomico.md')
    // riscrittura: di nuovo atomico, sempre un solo file
    await writeFileInBox(AGENT, 'atomico.md', 'v2')
    expect(await readFileInBox(AGENT, 'atomico.md')).toBe('v2')
    expect(readdirSync(join(TMP, 'box', 'home', AGENT)).filter((f) => f.includes('sandbot-tmp'))).toHaveLength(0)
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
