// M10 (fase 0.3.1001): SANDBOT_TEST_BOX_PREFIX presente ma NON valida non si
// ignora più in silenzio — la sandbox NON parte (mai coi nomi dell'utente),
// con un errore chiaro. Test puri sullo stato + il rifiuto di ensureBoxContainer.
import { describe, expect, it, afterEach, vi } from 'vitest'
import { testBoxPrefixState, invalidTestBoxPrefixError } from '../docker-argv'

// la modalità sandbox si legge dal setting: docker per il test del rifiuto
let sandboxMode = 'docker'
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key === 'sandbox.mode' ? sandboxMode : fallback),
  dataDir: () => '/tmp/sandbot-m10-test'
}))

describe('M10: testBoxPrefixState (pura)', () => {
  it('assente (o vuota) → absent', () => {
    expect(testBoxPrefixState({})).toEqual({ kind: 'absent' })
    expect(testBoxPrefixState({ SANDBOT_TEST_BOX_PREFIX: '' })).toEqual({ kind: 'absent' })
  })
  it('valida → valid col prefisso', () => {
    expect(testBoxPrefixState({ SANDBOT_TEST_BOX_PREFIX: 'sbtest19' })).toEqual({ kind: 'valid', prefix: 'sbtest19' })
    expect(testBoxPrefixState({ SANDBOT_TEST_BOX_PREFIX: 'sbtest' })).toEqual({ kind: 'valid', prefix: 'sbtest' })
  })
  it('presente ma non valida (cfbox, sandbot, SBTEST1, troppo lunga…) → invalid col valore', () => {
    for (const bad of ['cfbox', 'sandbot', '../x', 'sbtest-box', 'SBTEST1', 'sbtest0123456789012', 'sbtest_1', 'sbtest box']) {
      expect(testBoxPrefixState({ SANDBOT_TEST_BOX_PREFIX: bad })).toEqual({ kind: 'invalid', value: bad })
    }
  })
  it('l’errore dice il valore, la forma attesa e che la sandbox non parte', () => {
    const msg = invalidTestBoxPrefixError('cfbox')
    expect(msg).toContain('cfbox')
    expect(msg).toContain('sbtest')
    expect(msg).toContain('NOT start')
    expect(msg).toContain("NEVER use the user's container names")
  })
})

describe('M10: variabile non valida → il modulo la espone e la sandbox non parte', () => {
  afterEach(() => {
    delete process.env.SANDBOT_TEST_BOX_PREFIX
    sandboxMode = 'docker'
    vi.resetModules()
  })

  it('INVALID_TEST_BOX_PREFIX è il valore sbagliato (null se assente o valida)', async () => {
    delete process.env.SANDBOT_TEST_BOX_PREFIX
    vi.resetModules()
    expect((await import('../docker-argv')).INVALID_TEST_BOX_PREFIX).toBeNull()
    process.env.SANDBOT_TEST_BOX_PREFIX = 'sbtest19'
    vi.resetModules()
    expect((await import('../docker-argv')).INVALID_TEST_BOX_PREFIX).toBeNull()
    process.env.SANDBOT_TEST_BOX_PREFIX = 'cfbox'
    vi.resetModules()
    expect((await import('../docker-argv')).INVALID_TEST_BOX_PREFIX).toBe('cfbox')
  })

  it('non valida: i nomi RESTANO quelli dell’utente ma ensureBoxContainer RIFIUTA di partire', async () => {
    process.env.SANDBOT_TEST_BOX_PREFIX = 'cfbox'
    vi.resetModules()
    const argv = await import('../docker-argv')
    // mai i nomi prefissati col valore sbagliato…
    expect(argv.BOX_CONTAINER).toBe('sandbot-box')
    // …ma soprattutto: la catena docker NON parte, con l'errore chiaro
    const sandbox = await import('../index')
    await expect(sandbox.ensureBoxContainer()).rejects.toThrow('invalid SANDBOT_TEST_BOX_PREFIX ("cfbox")')
  })

  it('in modalità host la catena docker non serve: nessun rifiuto', async () => {
    process.env.SANDBOT_TEST_BOX_PREFIX = 'cfbox'
    sandboxMode = 'host'
    vi.resetModules()
    const sandbox = await import('../index')
    await expect(sandbox.ensureBoxContainer()).resolves.toBeUndefined()
  })
})
