// P1 (fase ci-percorso-temporanei): la base temporanea degli SCRIPT
// (scripts/lib/base-temporanea.mjs) segue la regola di src/test-tmp.ts — la
// stessa della suite — e il censimento di esporta-inutilizzati non cade più
// dove la cartella del Mac manca, com'è sul runner di GitHub (la CI della
// beta.21: ENOENT su mkdtemp). La cartella vera non si tocca: il test la
// SOSTITUISCE con un percorso che non c'è, dalla variabile solo-test
// SANDBOT_TEST_DEV_TMP. Vista ROSSA prima, con la funzione ancora SENZA
// l'alternativa (la cartella del Mac e basta, com'era lo script): dallo
// script vero usciva lo stesso ENOENT della CI. Con l'alternativa esce 0.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEV_TMP as DELLA_SUITE, TEST_TMP_BASE } from '../../src/test-tmp'
import { DEV_TMP as DEGLI_SCRIPT, baseTemporanea } from '../lib/base-temporanea.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'esporta-inutilizzati.mjs')

type Ambiente = Record<string, string | undefined>

/** Un percorso sotto la base dei test che NON esiste: fa le veci della cartella del Mac sul runner di GitHub. */
const cheManca = (): string => join(TEST_TMP_BASE, `sandbot-base-temporanea-che-manca-${process.pid}`)

/** Il messaggio dell'errore di una funzione che deve rifiutarsi, o null se non si è rifiutata. */
const rifiuto = (f: () => unknown): string | null => {
  try {
    f()
    return null
  } catch (e) {
    return String(e)
  }
}

/**
 * La regola della suite con DATO l'ambiente. src/test-tmp.ts la valuta
 * all'IMPORT: si ricarica da capo (vi.resetModules) con le variabili
 * impostate o tolte DAVVERO — la ci-sim lancia la suite CON
 * SANDBOT_TEST_TMP_BASE — e poi l'ambiente torna com'era.
 */
const baseDellaSuite = async (env: Ambiente): Promise<{ base?: string; errore?: string }> => {
  const CHIAVI = ['SANDBOT_TEST_TMP_BASE', 'SANDBOT_TEST_DEV_TMP']
  const prima = Object.fromEntries(CHIAVI.map((k) => [k, process.env[k]]))
  try {
    for (const k of CHIAVI) {
      if (env[k] === undefined) delete process.env[k]
      else process.env[k] = env[k] as string
    }
    vi.resetModules()
    return { base: (await import('../../src/test-tmp')).TEST_TMP_BASE }
  } catch (e) {
    return { errore: String(e) }
  } finally {
    for (const k of CHIAVI) {
      if (prima[k] === undefined) delete process.env[k]
      else process.env[k] = prima[k]
    }
  }
}

describe('base-temporanea: la regola è quella di src/test-tmp.ts', () => {
  // la cartella dell'override: una mkdtemp come le altre, dalla base di sempre, cancellata a fine file
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-base-temporanea-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(() => vi.resetModules())

  it('la cartella del Mac è LA STESSA nei due file, e con l\'ambiente di questa corsa la base è quella della suite (TEST_TMP_BASE)', () => {
    expect(DEGLI_SCRIPT).toBe(DELLA_SUITE)
    expect(baseTemporanea()).toBe(TEST_TMP_BASE)
  })

  it('senza variabili, e con SANDBOT_TEST_TMP_BASE su una cartella che esiste: lo stesso risultato', async () => {
    const casi: Array<[string, Ambiente]> = [
      ['senza variabili', {}],
      ['SANDBOT_TEST_TMP_BASE su una cartella che esiste', { SANDBOT_TEST_TMP_BASE: dir }]
    ]
    for (const [nome, env] of casi) {
      const dellaSuite = await baseDellaSuite(env)
      expect(dellaSuite.errore, nome).toBeUndefined()
      expect(baseTemporanea(env), nome).toBe(dellaSuite.base)
    }
    // e vale quanto dice la regola: dove la cartella del Mac c'è è quella (qui), altrimenti la temporanea di sistema (il runner)
    expect(baseTemporanea({})).toBe(existsSync(DEGLI_SCRIPT) ? DEGLI_SCRIPT : realpathSync(tmpdir()))
    expect(baseTemporanea({ SANDBOT_TEST_TMP_BASE: dir })).toBe(dir)
  })

  it('SANDBOT_TEST_TMP_BASE rotto (una cartella che non c\'è, o un file): tutte e due le regole si rifiutano SUBITO, con lo stesso errore', async () => {
    const file = join(dir, 'un-file')
    writeFileSync(file, 'x')
    for (const rotto of [join(dir, 'non-esiste'), file]) {
      const dellaSuite = await baseDellaSuite({ SANDBOT_TEST_TMP_BASE: rotto })
      expect(dellaSuite.base, rotto).toBeUndefined()
      expect(dellaSuite.errore, rotto).toContain('SANDBOT_TEST_TMP_BASE deve essere una cartella esistente')
      expect(rifiuto(() => baseTemporanea({ SANDBOT_TEST_TMP_BASE: rotto })), rotto).toBe(dellaSuite.errore)
    }
  })
})

describe('la CI sul Mac: la cartella del Mac manca (com\'è sul runner di GitHub)', () => {
  it('senza SANDBOT_TEST_TMP_BASE si cade sulla temporanea di sistema; la variabile della corsa vince comunque', () => {
    const manca = cheManca()
    expect(existsSync(manca)).toBe(false)
    expect(baseTemporanea({ SANDBOT_TEST_DEV_TMP: manca })).toBe(realpathSync(tmpdir()))
    expect(baseTemporanea({ SANDBOT_TEST_DEV_TMP: manca, SANDBOT_TEST_TMP_BASE: TEST_TMP_BASE })).toBe(TEST_TMP_BASE)
  })

  // tsc emette le dichiarazioni di tutto il prodotto: nella suite intera, con tutte le coroutine, può superare i 5 s di default
  it('esporta-inutilizzati senza --out esce 0 (nessun ENOENT), e la cartella che manca nessuno l\'ha creata', { timeout: 120_000 }, () => {
    const manca = cheManca()
    expect(existsSync(manca)).toBe(false)
    // l'ambiente della corsa com'è, con due differenze: la cartella del Mac sostituita da una che non c'è, e SENZA la variabile della corsa (sul runner nessuno la imposta; la ci-sim sì)
    const env: Ambiente = { ...process.env, SANDBOT_TEST_DEV_TMP: manca }
    delete env.SANDBOT_TEST_TMP_BASE
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout).summary.exports).toBeGreaterThan(100)
    expect(existsSync(manca)).toBe(false)
  })
})
