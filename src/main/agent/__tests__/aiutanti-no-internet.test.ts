// AH6 (fase aiutanti): il bot SA che nel box i comandi non hanno internet.
// Con uscita 'none': la descrizione di run-command e il prompt portano UNA
// riga che lo dice (e indicano web_fetch o il browser per il web); l'output
// di un comando che fallisce con errore di nome/rete riceve la nota in coda.
// Con 'direct' (la bridge di Docker) niente riga e niente nota: tutto com'è.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const facts = vi.hoisted(() => ({ mode: 'host' as 'host' | 'box', egress: 'direct' as 'none' | 'direct' }))
vi.mock('../../sandbox', () => ({
  sandboxMode: () => facts.mode,
  browserSandboxOk: () => false,
  boxShellEgressOf: () => facts.egress
}))

const { computerSection } = await import('../prompts')
const { BOX_NO_INTERNET_LINE, withNoInternetNote } = await import('../../sandbox/box-egress')
const { applyBoxNoInternet } = await import('../turn-tools')
import type { ToolDef } from '../llm'

beforeEach(() => {
  facts.mode = 'host'
  facts.egress = 'direct'
})

const runCommandDef = (): ToolDef => ({
  name: 'run-command',
  description: 'Runs a shell command in the sandbox: stdout, stderr, exit code.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
})

describe('AH6: la riga «niente internet per i comandi» con uscita none (descrizione e prompt)', () => {
  it('prompt: box + uscita none → la sezione computer contiene la riga', () => {
    facts.mode = 'box'
    facts.egress = 'none'
    expect(computerSection()).toContain(BOX_NO_INTERNET_LINE)
  })

  it('prompt: box + uscita direct (bridge di Docker) → NESSUNA riga', () => {
    facts.mode = 'box'
    facts.egress = 'direct'
    expect(computerSection()).not.toContain(BOX_NO_INTERNET_LINE)
  })

  it('prompt: GUARDIA in host la riga non c' + 'è (il Mac esce)', () => {
    facts.mode = 'host'
    expect(computerSection()).not.toContain(BOX_NO_INTERNET_LINE)
  })

  it('descrizione: applyBoxNoInternet aggiunge la riga SOLO a run-command e solo con uscita none', () => {
    const defs = [runCommandDef(), { name: 'read-file', description: 'legge', parameters: { type: 'object', properties: {} } }]
    const out = applyBoxNoInternet(defs, true)
    expect(out[0]!.description).toContain(BOX_NO_INTERNET_LINE)
    expect(out[1]!.description).toBe('legge')
    // con uscita direct niente riga (la descrizione resta quella di sempre)
    const outDirect = applyBoxNoInternet(defs, false)
    expect(outDirect[0]!.description).not.toContain(BOX_NO_INTERNET_LINE)
  })
})

describe('AH6: la nota in coda agli errori di rete/DNS', () => {
  it('«Could not resolve host» (curl) riceve la nota in coda', () => {
    const out = withNoInternetNote('curl: (6) Could not resolve host: dealer.moto.it\n[exit 6]')
    expect(out).toContain('Could not resolve host')
    expect(out.trim().endsWith(']'))
    expect(out).toContain('the bot computer has no internet for commands: use web_fetch or the browser')
    // la nota è IN CODA
    expect(out.indexOf('[exit 6]')).toBeLessThan(out.indexOf('no internet for commands'))
  })

  it('anche «Temporary failure in name resolution» e «Network is unreachable»', () => {
    expect(withNoInternetNote('wget: Temporary failure in name resolution')).toContain('no internet for commands')
    expect(withNoInternetNote('ping: Network is unreachable')).toContain('no internet for commands')
  })

  it('un output SENZA errori di rete resta com' + 'è (guardia)', () => {
    expect(withNoInternetNote('total 0\n[exit 0]')).toBe('total 0\n[exit 0]')
  })
})
