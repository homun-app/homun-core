// CC1 (fase computer-card): quando il browser del bot SI APRE, l'app viene
// avvisata. Oggi l'evento `screen` parte solo alla CHIUSURA della sessione
// (screenBrowserClosed → emitStatus): la card «Computer» resta sullo stato
// letto all'apertura. Qui si avvia una sessione VERA di manager col server
// MCP finto (SANDBOT_TEST_FAKE_BROWSER_MCP, nessun Docker) e si pretende
// l'emit { type: 'screen', status: { browser: 'running' } } SUBITO, con la
// sessione ancora aperta — prima che qualunque chiusura la faccia scattare.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// cartelle temporanee SOLO con mkdtemp nella directory fissata (CB1, fase
// ci-beta5: da TEST_TMP_BASE — sulla CI è la cartella temporanea del sistema)
import { TEST_TMP_BASE } from '../../../test-tmp'
const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-cc1-'))
const { setDataDir } = await import('../../store/db')
setDataDir(TMP)

// il server MCP finto del repo, come browser.test.ts
process.env.SANDBOT_TEST_FAKE_BROWSER_MCP = resolve('scripts/fake-browser-mcp.mjs')

const { callBrowserTool, resetBrowserForTests } = await import('../browser')
const { initScreen, resetScreenForTests } = await import('../screen')
import type { SandbotEvent } from '../../../shared/types'

const AGENT = 'agent_cc1'

const events: SandbotEvent[] = []

beforeAll(async () => {
  resetScreenForTests()
  await resetBrowserForTests()
  // il broadcast del daemon qui è un array: si cattura l'evento push
  initScreen({
    emit: (e) => { events.push(e) },
    wsPort: 0,
    isBusy: () => false,
    enqueueTurn: () => undefined,
    markTakeoverCard: () => undefined
  })
})

afterAll(async () => {
  await resetBrowserForTests()
  resetScreenForTests()
  delete process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
  rmSync(TMP, { recursive: true, force: true })
})

describe('CC1: l\'evento screen parte anche all\'APERTURA del browser', () => {
  it('avviata la sessione, l\'emit riceve { browser: "running" } con la sessione ancora aperta', async () => {
    expect(events.filter((e) => e.type === 'screen')).toEqual([])
    const r = await callBrowserTool(AGENT, 'browser_open', { url: 'https://spa.example/offerte' })
    expect(r.meta.browserPage).toBe(true) // la sessione è nata e ha risposto
    const screens = events.filter((e) => e.type === 'screen')
    expect(screens.length).toBeGreaterThanOrEqual(1)
    expect(screens[0]).toMatchObject({ agentId: AGENT, status: { browser: 'running' } })
  })
})
