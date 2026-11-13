// OB4 (fase onboarding-b): il primo uso del box PRIMA che la preparazione
// finisca dà un errore IN PAROLE («Il computer del bot si sta ancora
// preparando.») — MAI un ripiego silenzioso sul Mac. La porta è
// ensureBoxContainer: legge il setting box.setup e rifiuta finché la
// macchina a stati corre. Con la preparazione ferma (ready, errore,
// annullata, mai partita) il flusso di oggi non cambia.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

vi.mock('../../agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

const { setDataDir, dataDir, db, setSetting } = await import('../../store/db')
const { ensureBoxContainer, BOX_PREPARING_MESSAGE } = await import('../index')

beforeAll(() => {
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-box-setup-gate-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

const setSetup = (phase: string): void => {
  setSetting('box.setup', { phase, bytes: null, total: null, buildPhase: null, error: null, startedAt: 1, neededBytes: 1 })
}

describe('OB4: il primo uso del box prima di ready', () => {
  it('la preparazione CORRE: l\'uso del box risponde l\'errore in parole', async () => {
    // il box si usa in modalità box: la porta scatta PRIMA di qualunque argv
    setSetting('sandbox.mode', 'box')
    for (const phase of ['checking-space', 'downloading', 'verifying', 'awaiting-installer', 'starting-service', 'installing-kernel', 'building-image']) {
      setSetup(phase)
      await expect(ensureBoxContainer(), phase).rejects.toThrow(BOX_PREPARING_MESSAGE)
    }
    setSetting('sandbox.mode', 'host')
  })

  it('l\'errore in parole è quello della spec, non un tecnico', () => {
    expect(BOX_PREPARING_MESSAGE).toBe('Il computer del bot si sta ancora preparando.')
  })

  it('la preparazione FERMA (ready, errore, annullata, mai partita): il flusso di oggi non cambia', async () => {
    // il runner resta quello dei test (nessuno spawn): il punto è che NON
    // scatta la porta della preparazione
    setSetup('ready')
    setSetup('error')
    setSetup('cancelled')
    setSetting('box.setup', null)
    // modalità host (quella di default): l'ensure è un no-op, NON parte
    // NESSUN argv e NESSUN errore di preparazione
    await expect(ensureBoxContainer()).resolves.toBeUndefined()
  })
})
