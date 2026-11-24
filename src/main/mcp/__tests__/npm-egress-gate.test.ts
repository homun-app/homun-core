// N1 (fase mcp-egress-sicurezza): un server npm GIÀ INSTALLATO non parte se
// il motore del box non garantisce il recinto (Docker bridge = internet
// libera): il rifiuto è IN PAROLE, PRIMA di ogni avvio (nessun exec nel box),
// e lo stato del connettore lo dice (il foglio del server lo mostra). Col
// motore Apple la rete del box è interna: il proxy è l'unica uscita e il
// server parte come oggi.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { join } from 'node:path'

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-npmegress-'))
const { setDataDir, setSetting, getSetting } = await import('../../store/db')
setDataDir(TMP)
const mcp = await import('../index')
import type { McpServerConfig } from '../index'

const RIFIUTO = /unverified npm servers do not start/

const npmServer = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'npm-mattermost-mcp-aabbccdd',
  name: '@donach/mattermost-mcp',
  transport: 'stdio',
  enabled: true,
  toolSlug: 'mattermost',
  box: { workdir: '/box/home/agent_x', home: '/box/home/agent_x', command: 'npx', args: ['--yes', '@donach/mattermost-mcp@2.3.4'], envKeys: [] },
  egress: { allowHosts: ['mattermost.competitoor.com'] },
  enabledFor: ['agent_x'],
  source: { kind: 'npm', package: '@donach/mattermost-mcp', version: '2.3.4', allowHosts: ['mattermost.competitoor.com'] },
  ...over
})

beforeAll(() => {
  mcp.setMcpAuthResolver(async () => ({}))
})

afterAll(() => {
  mcp.setMcpBoxEnsureForTests(null)
  mcp.setMcpAuthResolver(async () => ({}))
  setSetting('mcp.servers', [])
  setSetting('sandbox.engine', 'auto')
  rmSync(TMP, { recursive: true, force: true })
})

describe('N1: server npm installato + motore Docker (uscita libera) → NON parte', () => {
  it('il rifiuto è la frase in parole, PRIMA di ogni avvio: nessuna chiamata al box', async () => {
    const calls: string[] = []
    mcp.setMcpBoxEnsureForTests({
      ensureBox: async () => { calls.push('container'); throw new Error('NON DEVE PARTIRE QUI') },
      ensureHome: async () => { calls.push('home') }
    })
    setSetting('mcp.servers', [npmServer()])
    setSetting('sandbox.engine', 'docker')
    await expect(mcp.toolsOfServer(npmServer().id)).rejects.toThrow(RIFIUTO)
    expect(calls).toEqual([])
  })

  it('lo stato del connettore dice l\'errore (il foglio del server lo mostra)', async () => {
    mcp.setMcpBoxEnsureForTests({
      ensureBox: async () => { throw new Error('NON DEVE PARTIRE QUI') },
      ensureHome: async () => undefined
    })
    setSetting('mcp.servers', [npmServer()])
    setSetting('sandbox.engine', 'docker')
    await expect(mcp.toolsOfServer(npmServer().id)).rejects.toThrow(RIFIUTO)
    const state = getSetting<Record<string, { status?: string; error?: string }>>('connectors.state', {})[npmServer().id]
    expect(state?.status).toBe('error')
    expect(state?.error).toMatch(RIFIUTO)
  })
})

describe('N1: col motore Apple (rete interna) il server parte come oggi', () => {
  it('il gate passa: la catena di avvio inizia (l\'errore, se c\'è, è quello dell\'avvio)', async () => {
    const calls: string[] = []
    mcp.setMcpBoxEnsureForTests({
      ensureBox: async () => { calls.push('container'); throw new Error('sentinella-dopo-il-gate') },
      ensureHome: async () => { calls.push('home') }
    })
    setSetting('mcp.servers', [npmServer()])
    setSetting('sandbox.engine', 'apple-container')
    // il gate è passato: l'errore è quello del avvio vero (la sentinella), non il rifiuto
    await expect(mcp.toolsOfServer(npmServer().id)).rejects.toThrow('sentinella-dopo-il-gate')
    expect(calls).toEqual(['container'])
  })
})
