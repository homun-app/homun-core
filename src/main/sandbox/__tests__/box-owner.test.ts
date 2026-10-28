// Fase 12 (punto 1): le risorse del box di un FIGLIO sono quelle del PADRE.
// boxOwnerOf è la funzione unica che decide il proprietario; write-file e
// read-file di un figlio cadono nella home del padre (file CONDIVISI, come in
// Grok e in Claude Code) e i confini restano quelli della home del proprietario.
// Modalità host su directory temporanea (mai la home reale), store mockato.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-boxowner-test-'))
const agents = vi.hoisted(() => new Map<string, { id: string; parentId: string | null }>())
vi.mock('../../store/db', () => ({
  getSetting: (_key: string, fallback: unknown) => 'host',
  dataDir: () => TMP,
  getAgent: (id: string) => agents.get(id) ?? null
}))

const { boxOwnerOf, writeFileInBox, readFileInBox, validBoxPathOf } = await import('../index')

beforeAll(() => {
  agents.set('agent_padre', { id: 'agent_padre', parentId: null })
  agents.set('sub_a1b2c3d4', { id: 'sub_a1b2c3d4', parentId: 'agent_padre' })
  agents.set('agent_libero', { id: 'agent_libero', parentId: null })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('fase 12 (punto 1): boxOwnerOf — il proprietario delle risorse del box', () => {
  it('per un figlio è il PADRE, per i bot normali l\'id stesso, per gli sconosciuti l\'id (boot freddo)', () => {
    expect(boxOwnerOf('sub_a1b2c3d4')).toBe('agent_padre')
    expect(boxOwnerOf('agent_padre')).toBe('agent_padre')
    expect(boxOwnerOf('agent_sconosciuto')).toBe('agent_sconosciuto')
  })
})

describe('fase 12 (punto 1): la home del figlio È quella del padre (file condivisi)', () => {
  it('write-file del FIGLIO scrive nella home del PADRE e il padre la legge', async () => {
    await writeFileInBox('sub_a1b2c3d4', 'subagents/sub_a1b2c3d4/report.md', '# Report\ncontenuto')
    const path = join(TMP, 'box', 'home', 'agent_padre', 'subagents', 'sub_a1b2c3d4', 'report.md')
    expect(existsSync(path)).toBe(true)
    // il PADRE legge lo stesso file (home condivisa)
    expect(await readFileInBox('agent_padre', 'subagents/sub_a1b2c3d4/report.md')).toContain('# Report')
    // e il FIGLIO rilegge il proprio file dalla home del padre
    expect(await readFileInBox('sub_a1b2c3d4', 'subagents/sub_a1b2c3d4/report.md')).toContain('# Report')
    // NESSUNA home del figlio è stata creata
    expect(existsSync(join(TMP, 'box', 'home', 'sub_a1b2c3d4'))).toBe(false)
  })

  it('validBoxPathOf: i confini del figlio sono quelli del box del PADRE (fuori dal box si rifiuta)', () => {
    expect(validBoxPathOf('sub_a1b2c3d4', 'subagents/sub_a1b2c3d4/report.md')).toBe(true)
    // il box è CONDIVISO: uscire dalla home restando nel box si può (come il padre)
    expect(validBoxPathOf('sub_a1b2c3d4', '../altro-bot/consegna.md')).toBe(true)
    // FUORI dal box non si passa (né per il figlio né per il padre)
    expect(validBoxPathOf('sub_a1b2c3d4', '../../../fuori/report.md')).toBe(false)
    expect(validBoxPathOf('agent_padre', '../../../fuori/report.md')).toBe(false)
    expect(validBoxPathOf('sub_a1b2c3d4', '/workspace/consegna.md')).toBe(true)
  })
})
