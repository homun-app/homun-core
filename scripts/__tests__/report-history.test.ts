// Fase locale correzioni (LC1): il REPORT si AGGIUNGE in cima, mai
// sostituire. Il commit 09737d7b aveva SOVRASCRITTO REPORT.md (da 6649 righe
// e 53 report a 88 righe e uno): questo test inchioda l'invariante — la
// coda del file deve essere, BYTE PER BYTE, il REPORT.md com'era a a6aa41ee
// (l'ultimo commit che lo aveva intero, tag fase-memoria-engramma-correzioni-2).
// Vale anche per il futuro: ogni nuova sezione si prepende, la coda resta.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')

/** REPORT.md com'era a a6aa41ee, byte per byte (crasha se il commit non c'è). */
function reportAtA6aa41ee(): Buffer {
  return execFileSync('git', ['show', 'a6aa41ee:REPORT.md'], { cwd: REPO, maxBuffer: 10 * 1024 * 1024 })
}

describe('fase locale correzioni LC1: il REPORT non si sostituisce', () => {
  it('la coda di REPORT.md è il REPORT.md di a6aa41ee, byte per byte', () => {
    const current = readFileSync(join(REPO, 'REPORT.md'))
    const old = reportAtA6aa41ee()
    // non solo incluso: CODA esatta (prependere NON tocca la coda)
    expect(current.length).toBeGreaterThan(old.length)
    expect(current.subarray(current.length - old.length).equals(old)).toBe(true)
  })

  it('i report di prima ci sono TUTTI: 54 intestazioni «# REPORT» (1 + 53 di a6aa41ee) o più', () => {
    const current = readFileSync(join(REPO, 'REPORT.md'), 'utf8')
    const old = reportAtA6aa41ee().toString('utf8')
    const count = (s: string): number => (s.match(/^# REPORT/gm) ?? []).length
    expect(count(current)).toBeGreaterThanOrEqual(count(old) + 1)
    expect(count(old)).toBe(53)
    expect(current.length).toBeGreaterThan(200_000) // 6649 righe non possono sparire
  })
})
