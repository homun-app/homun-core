// CB3 (fase ci-beta5): TEST_TMP_BASE si può spostare su una cartella scelta
// da chi lancia la corsa con la variabile SOLO-TEST SANDBOT_TEST_TMP_BASE —
// la simula della CI (npm run test:ci-sim) la punta su una mkdtemp della
// cartella temporanea del SISTEMA, come il runner, invece che sulla base di
// sviluppo. Il modulo è l'imbuto unico delle mkdtemp dei test: la variabile
// DEVE puntare a una cartella che esiste, un valore rotto si rifiuta SUBITO
// con un errore chiaro — cadere in silenzio sulla base di sviluppo
// maschererebbe una corsa mal configurata. Il modulo valuta all'import: si
// re-importa con vi.resetModules dopo lo stub dell'env.
import { describe, expect, it, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEST_TMP_BASE, DEV_TMP } from '../test-tmp'

describe('CB3 (fase ci-beta5): SANDBOT_TEST_TMP_BASE sposta TEST_TMP_BASE', () => {
  // la cartella di prova per l'override: una mkdtemp come le altre, dalla
  // base di sempre, cancellata a fine file
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-cb3-tmp-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('la variabile VINCE quando punta a una cartella che esiste', async () => {
    vi.stubEnv('SANDBOT_TEST_TMP_BASE', dir)
    vi.resetModules()
    const mod = await import('../test-tmp')
    expect(mod.TEST_TMP_BASE).toBe(dir)
  })

  it('un valore ROTTO (cartella che non esiste, o un file) si rifiuta SUBITO con errore chiaro', async () => {
    const file = join(dir, 'un-file')
    writeFileSync(file, 'x')
    for (const bad of [join(dir, 'non-esiste'), file]) {
      vi.stubEnv('SANDBOT_TEST_TMP_BASE', bad)
      vi.resetModules()
      await expect(import('../test-tmp')).rejects.toThrow(/SANDBOT_TEST_TMP_BASE/)
    }
  })

  it('senza la variabile resta la base di sempre (la T di sviluppo se c\'è, altrimenti la temporanea di sistema)', async () => {
    // la ci-sim lancia la suite CON la variabile: qui si toglie davvero, per
    // provare la catena di fallback, e si rimette com'era
    const saved = process.env.SANDBOT_TEST_TMP_BASE
    delete process.env.SANDBOT_TEST_TMP_BASE
    try {
      vi.resetModules()
      const mod = await import('../test-tmp')
      const expected = existsSync(DEV_TMP) ? DEV_TMP : realpathSync(tmpdir())
      expect(mod.TEST_TMP_BASE).toBe(expected)
    } finally {
      if (saved !== undefined) process.env.SANDBOT_TEST_TMP_BASE = saved
    }
  })
})
