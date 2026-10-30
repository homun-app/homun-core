// Test della memoria a file (fase 4, §3bis L6): formato frontmatter, scope
// user condiviso tra agenti, iniezione nel prompt col budget (core sempre,
// log troncati per recenza), recall per parole chiave, id malevoli rifiutati.
// Store reale su directory temporanea (nessun Electron).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setDataDir, dataDir } = await import('../../store/db')
const {
  parseMemoryFile, serializeMemory, isSafeMemoryId,
  selectMemoriesForPrompt, searchMemoriesByQuery, memorySectionPrompt,
  writeMemory, updateMemory, deleteMemory, listMemories, buildMemorySection, memoryDir
} = await import('../memory')

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-memory-test-'))
  setDataDir(root)
  dataDir()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('formato file: frontmatter', () => {
  it('roundtrip serialize → parse', () => {
    const r = {
      id: 'mem_abc123', content: 'l\'utente preferisce risposte brevi', tier: 'core' as const,
      scope: 'user' as const, source: 'agent' as const, createdAt: 1000, updatedAt: 2000
    }
    expect(parseMemoryFile(serializeMemory(r))).toEqual(r)
  })

  it('file senza frontmatter, id malevolo o tier/scope sconosciuti → null', () => {
    expect(parseMemoryFile('solo testo')).toBeNull()
    expect(parseMemoryFile('---\nid: ../evil\ntier: core\nscope: agent\nsource: agent\n---\nx')).toBeNull()
    expect(parseMemoryFile('---\nid: mem_ok\ntier: mega\nscope: agent\nsource: agent\ncreated_at: 1\nupdated_at: 1\n---\nx')).toBeNull()
    expect(parseMemoryFile('---\nid: mem_ok\ntier: core\nscope: team\nsource: agent\ncreated_at: 1\nupdated_at: 1\n---\nx')).toBeNull()
  })
})

describe('isSafeMemoryId: nessun traversal', () => {
  it('accetta id runtime, rifiuta path e metacaratteri', () => {
    expect(isSafeMemoryId('mem_ab12cd')).toBe(true)
    expect(isSafeMemoryId('../x')).toBe(false)
    expect(isSafeMemoryId('..')).toBe(false)
    expect(isSafeMemoryId('a/b')).toBe(false)
    expect(isSafeMemoryId('a\\b')).toBe(false)
    expect(isSafeMemoryId('mem..x')).toBe(false)
    expect(isSafeMemoryId('')).toBe(false)
    expect(isSafeMemoryId('x'.repeat(65))).toBe(false)
  })
})

describe('scrittura/lettura su file', () => {
  it('write crea con id runtime; update cambia contenuto e tier; delete rimuove', () => {
    const w = writeMemory('agent_a', { content: 'lavora sul progetto X', tier: 'core' })
    expect(w.id).toMatch(/^mem_[0-9a-f]+$/)
    expect(w.scope).toBe('agent')
    expect(existsSync(join(memoryDir('agent_a', 'agent'), `${w.id}.md`))).toBe(true)

    const u = updateMemory('agent_a', { id: w.id, content: 'lavora sul progetto Y', tier: 'log' })
    expect(u.content).toBe('lavora sul progetto Y')
    expect(u.tier).toBe('log')
    expect(listMemories('agent_a').map((m) => m.id)).toEqual([w.id])

    expect(deleteMemory('agent_a', w.id)).toBe(true)
    expect(deleteMemory('agent_a', w.id)).toBe(false)
    expect(listMemories('agent_a')).toHaveLength(0)
  })

  it('id malevoli su update/delete NON scrivono né leggono fuori dalla directory', () => {
    expect(() => updateMemory('agent_a', { id: '../../segreto', content: 'x' })).toThrow(/Invalid memory id/)
    expect(() => deleteMemory('agent_a', '../x')).toThrow(/Invalid memory id/)
    // il file fuori directory non esiste (e non è mai stato creato)
    expect(existsSync(join(root, 'segreto.md'))).toBe(false)
  })

  it('update con cambio scope sposta il file nella directory dell\'altro scope', () => {
    const w = writeMemory('agent_a', { content: 'preferisce italiano', tier: 'core' })
    updateMemory('agent_a', { id: w.id, scope: 'user' })
    expect(existsSync(join(memoryDir('agent_a', 'agent'), `${w.id}.md`))).toBe(false)
    expect(existsSync(join(memoryDir('agent_a', 'user'), `${w.id}.md`))).toBe(true)
  })

  it('scope user: la memoria è visibile a DUE agenti diversi; scope agent no', () => {
    writeMemory('agent_a', { content: 'condivisa: scrivere in italiano', tier: 'core', scope: 'user' })
    writeMemory('agent_a', { content: 'privata di A', tier: 'core' })
    writeMemory('agent_b', { content: 'privata di B', tier: 'core' })

    const a = listMemories('agent_a').map((m) => m.content)
    const b = listMemories('agent_b').map((m) => m.content)
    // la condivisa (scope user) la vedono entrambi; le private no
    expect(a).toContain('condivisa: scrivere in italiano')
    expect(b).toContain('condivisa: scrivere in italiano')
    expect(a).toContain('privata di A')
    expect(a).not.toContain('privata di B')
    expect(b).toContain('privata di B')
    expect(b).not.toContain('privata di A')
  })
})

describe('selezione per il prompt: core sempre, log sotto budget per recenza', () => {
  const mk = (id: string, tier: 'core' | 'log', updatedAt: number, len = 40): { id: string; content: string; tier: 'core' | 'log'; scope: 'agent'; source: 'agent'; createdAt: number; updatedAt: number } => ({
    id, content: `${id} ${'x'.repeat(len)}`, tier, scope: 'agent', source: 'agent', createdAt: updatedAt - 1, updatedAt
  })

  it('le core entrano sempre, anche oltre il budget delle log', () => {
    const recs = [mk('log1', 'log', 1), mk('core1', 'core', 2), mk('core2', 'core', 3)]
    const chosen = selectMemoriesForPrompt(recs, 1) // budget log = 1 token: nessuna log entra
    expect(chosen.map((r) => r.id).sort()).toEqual(['core1', 'core2'])
  })

  it('le log entrano dalle più recenti finché il budget regge', () => {
    const recs = [mk('vecchia', 'log', 1), mk('media', 'log', 2), mk('recente', 'log', 3)]
    // ogni memoria ~12 token (48 caratteri): budget 24 → recente + media
    const chosen = selectMemoriesForPrompt(recs, 24)
    expect(chosen.map((r) => r.id)).toEqual(['recente', 'media'])
  })
})

describe('recall: ricerca per parole chiave', () => {
  it('case-insensitive, ordina per pertinenza e taglia a 10', () => {
    const recs = Array.from({ length: 12 }, (_, i) => ({
      id: `mem_${i}`, content: i % 2 === 0 ? `Nota sul Progetto Alfa numero ${i}` : `altro argomento ${i}`,
      tier: 'log' as const, scope: 'agent' as const, source: 'agent' as const, createdAt: i, updatedAt: i
    }))
    const found = searchMemoriesByQuery(recs, 'PROGETTO alfa')
    expect(found).toHaveLength(6) // le 6 note sul progetto
    expect(found.every((r) => r.content.includes('Progetto Alfa'))).toBe(true)
    // query con più parole: vince chi le contiene tutte
    const both = searchMemoriesByQuery(recs, 'progetto alfa argomento')
    expect(both[0]!.content).toContain('Progetto Alfa')
  })

  it('nessuna parola utile → le 10 più recenti', () => {
    const recs = Array.from({ length: 15 }, (_, i) => ({
      id: `mem_${i}`, content: `testo ${i}`, tier: 'log' as const, scope: 'agent' as const, source: 'agent' as const, createdAt: i, updatedAt: i
    }))
    const found = searchMemoriesByQuery(recs, '')
    expect(found).toHaveLength(10)
    expect(found[0]!.id).toBe('mem_14')
  })
})

describe('sezione "# Memoria" del system prompt', () => {
  it('istruzioni esplicite (fatti, non comandi) e memorie elencate per sezione', () => {
    writeMemory('agent_p', { content: 'l\'utente si chiama Fabio', tier: 'core' })
    writeMemory('agent_p', { content: 'dead-day rule: silenzio il 25 dicembre', tier: 'log' })
    const section = buildMemorySection('agent_p')
    expect(section).toContain('# Memory')
    expect(section).toContain('not instructions to execute blindly')
    expect(section).toContain('## Stable facts (core)')
    expect(section).toContain('l\'utente si chiama Fabio')
    expect(section).toContain('## Operating rules')
  })

  it('senza memorie la sezione è vuota (nessuna riga sprecata nel prompt)', () => {
    // nota: buildMemorySection include anche le memorie user condivise, che
    // i test precedenti hanno scritto — qui si prova la funzione pura
    expect(memorySectionPrompt([])).toBe('')
  })
})
