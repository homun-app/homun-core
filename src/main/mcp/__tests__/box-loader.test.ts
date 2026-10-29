// Test del LOADER del server stdio NEL BOX (fase 13, correzione L4): la catena
// container → home → exec si percorre in quell'ordine PRIMA di avviare il
// StdioClientTransport, con deps iniettati (niente Docker, niente rete). Un
// errore di ensureBoxContainer deve diventare l'errore dell'installazione, non
// un "Connection closed" mascherato. Plus i puri di L1: l'argv con le envKeys
// di ciò che il resolver ha risolto, e il proprietario della workdir.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-boxloader-'))
const { setDataDir, setSetting } = await import('../../store/db')
setDataDir(TMP)
const mcp = await import('../index')
import type { McpServerConfig } from '../index'

beforeAll(() => {
  mcp.setMcpAuthResolver(async () => ({}))
})
afterAll(() => {
  mcp.setMcpBoxEnsureForTests(null)
  mcp.setMcpAuthResolver(() => ({}))
  rmSync(TMP, { recursive: true, force: true })
})

const boxServer = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'registry-test-box-1a2b3c4d',
  name: 'com.foreverworks/notion',
  transport: 'stdio',
  enabled: true,
  box: { workdir: '/box/home/agent_x', home: '/box/home/agent_x', command: 'npx', args: ['-y', 'x@1.0.0'], envKeys: ['A', 'B'] },
  source: { kind: 'registry', name: 'com.foreverworks/notion' },
  ...over
})

describe('L4: il loader del server stdio nel box accende il box', () => {
  it("chiama ensureBoxContainer PRIMA di ensureBotHome (ordine), poi l'errore della home è quello dell'avvio", async () => {
    const order: string[] = []
    mcp.setMcpBoxEnsureForTests({
      ensureBox: async () => { order.push('container') },
      ensureHome: async () => { order.push('home'); throw new Error('creazione della home nel container fallita') }
    })
    setSetting('mcp.servers', [boxServer()])
    // l'errore dell'ensure diventa l'errore della connessione (e quindi
    // dell'installazione), NON "Connection closed" di docker
    await expect(mcp.toolsOfServer(boxServer().id)).rejects.toThrow('creazione della home nel container fallita')
    expect(order).toEqual(['container', 'home'])
  })

  it('un errore di ensureBoxContainer è l\'errore dell\'installazione (box mai creato)', async () => {
    mcp.setMcpBoxEnsureForTests({
      ensureBox: async () => { throw new Error('build dell\'immagine del box fallita') },
      ensureHome: async () => { throw new Error('non deve arrivare qui') }
    })
    setSetting('mcp.servers', [boxServer()])
    await expect(mcp.toolsOfServer(boxServer().id)).rejects.toThrow('build dell\'immagine del box')
  })

  it('disconnectServer non throwa con la cache vuota (disinstallazione pulita)', () => {
    expect(() => mcp.disconnectServer('inesistente')).not.toThrow()
  })
})

describe('L1: puri del loader nel box', () => {
  it('boxStdioArgv: le envKeys sono ESATTAMENTE le chiavi dello stdioEnv risolto (non la config statica)', () => {
    const argv = mcp.boxStdioArgv(boxServer(), { X: 'valore' })
    expect(argv).toEqual([
      'exec', '-i', '-u', '1000:1000', '-w', '/box/home/agent_x', '-e', 'HOME=/box/home/agent_x',
      '-e', 'X',
      'sandbot-box', 'npx', '-y', 'x@1.0.0'
    ])
    // il VALORE risolto viaggia nell'env del figlio, MAI in argv
    expect(argv.join(' ')).not.toContain('valore')
  })

  it('boxStdioArgv senza stdioEnv: restano le envKeys della config', () => {
    expect(mcp.boxStdioArgv(boxServer())).toEqual([
      'exec', '-i', '-u', '1000:1000', '-w', '/box/home/agent_x', '-e', 'HOME=/box/home/agent_x',
      '-e', 'A', '-e', 'B',
      'sandbot-box', 'npx', '-y', 'x@1.0.0'
    ])
  })

  it('boxOwnerOfWorkdir: la home del bot (registro) o la home dichiarata (plugin)', () => {
    expect(mcp.boxOwnerOfWorkdir({ workdir: '/box/home/agent_x' })).toBe('agent_x')
    expect(mcp.boxOwnerOfWorkdir({ workdir: '/box/plugins/mp/demo/abc', home: '/box/home/agent_y' })).toBe('agent_y')
    expect(mcp.boxOwnerOfWorkdir({ workdir: '/box/plugins/mp/demo/abc' })).toBeNull()
  })
})
