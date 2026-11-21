// U7 (fase mcp-ui): le variabili RIFERITE (${env:…}, bearer_token_env_var)
// si importano «da compilare»: il server ha needsAuth e NON si offre al bot
// finché l'utente non compila i valori. Quando li compila (mcp:save), il
// needsAuth si PULISCE — qui la parte PURA del calcolo.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../test-tmp'
import { manualNeedsAuthAfterFill } from '../../main/mcp/manual-env'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-needsauth-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('U7: manualNeedsAuthAfterFill — il needsAuth «da compilare» si pulisce quando i valori arrivano', () => {
  it('senza needsAuth resta undefined (i server normali non cambiano)', () => {
    expect(manualNeedsAuthAfterFill(undefined, { A: '1' })).toBeUndefined()
  })

  it('finché MANCA una chiave il needsAuth resta (il bot non lo vede finché non è compilato)', () => {
    expect(manualNeedsAuthAfterFill({ kind: 'env', keys: ['A', 'B'] }, { A: '1' }))
      .toEqual({ kind: 'env', keys: ['A', 'B'] })
  })

  it('quando TUTTE le chiave hanno un valore (non segreto o cifrato) il needsAuth sparisce', () => {
    expect(manualNeedsAuthAfterFill({ kind: 'env', keys: ['A', 'B'] }, { A: '1', B: '2' })).toBeUndefined()
  })

  it('needsAuth di ALTRO kind (key/settings/setup) non si tocca da qui', () => {
    expect(manualNeedsAuthAfterFill({ kind: 'key', keys: ['A'] }, { A: '1' }))
      .toEqual({ kind: 'key', keys: ['A'] })
  })
})
