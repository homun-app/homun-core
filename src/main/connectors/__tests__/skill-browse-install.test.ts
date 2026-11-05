// Fase skill · Sfoglia (B3): aggiungere un pacchetto DALLA FINESTRA senza la
// card in chat. Lo stesso percorso di oggi (buildPluginCard → staging →
// installPlugin) ma avviato dall'utente: enabledFor arriva dalla finestra
// («Tutti i bot» o un elenco) e NON c'è nessun messaggio in chat. La
// sicurezza è quella dei plugin di oggi: le skill installate così sono DI
// TERZI (imported al `/`, <dato_esterno> col tool skill). Repo git LOCALE
// file:// (solo col flag di test); temporanei con mkdtemp nella cartella dei
// vincoli, mai $TMPDIR.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPluginCard, installPlugin, installedPlugins, discardPluginProposal, pluginProposalDetails,
  PLUGINS_SETTING, type InstallDeps
} from '../install'
import { invocableSkillList, readSkillFor } from '../../agent/skills'
import { setDataDir, getSetting, setSetting } from '../../store/db'
import type { ConnectorsSecretStore } from '../sealed-store'
import type { McpServerConfig } from '../../mcp'
import type { MarketplacePlugin, PluginSource } from '../marketplace'

const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'
const DATA = mkdtempSync(TMP_BASE + 'sandbot-browse-install-')
let REPO: string

const REG = { name: 'mp-di-test', source: '', kind: 'git' as const, official: false, addedAt: 1 }
const PLUGINS: Record<string, MarketplacePlugin> = {}

beforeAll(() => {
  setDataDir(DATA)
  REPO = mkdtempSync(TMP_BASE + 'sandbot-browse-install-mp-')
  const mk = (p: string): string => { mkdirSync(join(REPO, p), { recursive: true }); return join(REPO, p) }
  writeFileSync(join(mk('.claude-plugin'), 'marketplace.json'), JSON.stringify({
    name: 'mp-di-test',
    plugins: [
      { name: 'solo-skill', description: 'Due skill', source: './plugins/solo-skill' },
      { name: 'con-connettore', description: 'Skill più server', source: './plugins/con-connettore' }
    ]
  }))
  const skillMd = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\nIstruzioni della skill ${name}.`
  // il manifest col name del plugin: le skill prendono il nome <plugin>--<skill>
  writeFileSync(join(mk('plugins/solo-skill/.claude-plugin'), 'plugin.json'), JSON.stringify({ name: 'solo-skill' }))
  writeFileSync(join(mk('plugins/solo-skill/skills/uno'), 'SKILL.md'), skillMd('uno', 'la prima skill'))
  writeFileSync(join(mk('plugins/solo-skill/skills/due'), 'SKILL.md'), skillMd('due', 'la seconda skill'))
  writeFileSync(join(mk('plugins/con-connettore/skills/tre'), 'SKILL.md'), skillMd('tre', 'la terza'))
  writeFileSync(join(mk('plugins/con-connettore'), '.mcp.json'), JSON.stringify({ mcpServers: { x: { url: 'https://x.example' } } }))
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: REPO })
  REG.source = `file://${REPO}`
  PLUGINS['solo-skill'] = { name: 'solo-skill', description: 'Due skill', source: { kind: 'relative', path: './plugins/solo-skill' } as PluginSource }
  PLUGINS['con-connettore'] = { name: 'con-connettore', description: 'Skill più server', source: { kind: 'relative', path: './plugins/con-connettore' } as PluginSource }
})
afterAll(() => {
  rmSync(DATA, { recursive: true, force: true })
  rmSync(REPO, { recursive: true, force: true })
})

const fakeStore = (): ConnectorsSecretStore => ({
  read: async () => undefined,
  write: async () => undefined,
  remove: async () => undefined,
  removeAll: async () => undefined
})

const deps = (): InstallDeps => ({
  store: fakeStore(),
  marketplaces: {
    findPlugin: async (id: string) => {
      const rest = id.startsWith('plugin:') ? id.slice('plugin:'.length) : id
      const at = rest.lastIndexOf('@')
      const plugin = PLUGINS[rest.slice(0, at)] ?? null
      return plugin ? { reg: REG, plugin } : null
    },
    cloneOf: () => null,
    list: () => []
  },
  findRegistryEntry: async () => null,
  listServers: (): McpServerConfig[] => [],
  saveServers: () => undefined,
  toolsOfServer: async () => [],
  openExternal: async () => undefined,
  hasUi: () => true,
  dockerMode: () => false,
  dataDir: () => DATA,
  onChange: () => undefined
})

const CLONE = { allowFileUrlsForTests: true }

describe('B3: anteprima e installazione dalla finestra (senza card in chat)', () => {
  it('l\'anteprima del pacchetto di sole skill: card SENZA server, skill con nome <plugin>--<skill>, dettagli con descrizioni e dimensione', async () => {
    const card = await buildPluginCard('plugin:solo-skill@mp-di-test', '', deps(), CLONE)
    expect(card.ok).toBe(true)
    if (!card.ok) return
    expect(card.card.servers).toEqual([])
    expect(card.card.skills.sort()).toEqual(['solo-skill--due', 'solo-skill--uno'])
    const details = pluginProposalDetails(card.card.id)
    expect(details).not.toBeNull()
    expect(details!.skills.map((s) => s.name).sort()).toEqual(['solo-skill--due', 'solo-skill--uno'])
    expect(details!.skills.find((s) => s.name === 'solo-skill--uno')?.description).toBe('la prima skill')
    expect(details!.sha12).toBe(card.card.sha12)
    expect(details!.size).toBeGreaterThan(0)
  })

  it('il pacchetto CON CONNETTORE si riconosce dall\'anteprima (servers non vuoto: la finestra lo rifiuta)', async () => {
    const card = await buildPluginCard('plugin:con-connettore@mp-di-test', '', deps(), CLONE)
    expect(card.ok).toBe(true)
    if (!card.ok) return
    expect(card.card.servers.length).toBeGreaterThan(0)
  })

  it('installa con enabledFor della FINESTRA (solo Alfa), lo staging si consuma, la cartella arriva nei dati', async () => {
    const card = await buildPluginCard('plugin:solo-skill@mp-di-test', '', deps(), CLONE)
    expect(card.ok).toBe(true)
    if (!card.ok) return
    const r = await installPlugin(card.card, '', deps(), setSetting, getSetting, CLONE, { enabledFor: ['agent_alfa'] })
    expect(r.ok).toBe(true)
    const rec = installedPlugins({ getSetting })[0]!
    expect(rec.name).toBe('solo-skill')
    expect(rec.enabledFor).toEqual(['agent_alfa'])
    expect(rec.skills).toHaveLength(2)
    expect(existsSync(join(DATA, rec.dir, 'skills', 'uno', 'SKILL.md'))).toBe(true)
    // lo staging della proposta è stato consumato dall'installazione
    expect(pluginProposalDetails(card.card.id)).toBeNull()
  })

  it('SICUREZZA: le skill del pacchetto installato dalla finestra sono DI TERZI — imported al `/` e <dato_esterno> col tool skill', () => {
    const list = invocableSkillList('agent_alfa')
    const uno = list.find((s) => s.name === 'solo-skill--uno')
    expect(uno?.imported).toBe(true)
    const read = readSkillFor('agent_alfa', 'solo-skill--uno')
    expect(read).not.toBeNull()
    expect(read!.webContent).toBe(true) // → il loop lo mette nel blocco <dato_esterno>
    // e solo per i bot scelti: Beta NON la vede
    expect(invocableSkillList('agent_beta').some((s) => s.name === 'solo-skill--uno')).toBe(false)
  })

  it('lo scarto (Annulla) butta lo staging della preview', async () => {
    const card = await buildPluginCard('plugin:solo-skill@mp-di-test', '', deps(), CLONE)
    expect(card.ok).toBe(true)
    if (!card.ok) return
    expect(pluginProposalDetails(card.card.id)).not.toBeNull()
    discardPluginProposal(card.card.id)
    expect(pluginProposalDetails(card.card.id)).toBeNull()
    // pulizia: il record della prova precedente non serve più
    setSetting(PLUGINS_SETTING, [])
  })
})
