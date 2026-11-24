// U7 (fase mcp-ui): «Importa da altre app» legge (SOLO al clic) anche Claude
// Code (~/.claude.json, utente e progetti), Codex CLI (~/.codex/config.toml,
// TOML con un parser MINIMO senza dipendenze nuove), Windsurf, Gemini CLI e
// VS Code, oltre a Cursor, Claude Desktop e ZCode. Le variabili RIFERITE
// (${env:…}, ${input:…}, bearer_token_env_var) si importano «da compilare»
// (needsAuth, MAI il valore letterale del placeholder); i formati non capiti
// sono server SALTATI col motivo. I file veri non si toccano MAI: qui testi
// finti e home iniettabile.
import { describe, expect, it } from 'vitest'
import {
  importSourcePaths,
  parseSourceFile,
  scanImportedSources,
  buildImportedServer,
  parseTomlSubset
} from '../import-sources'

const HOME = '/Users/test'

describe('U7: le VIE delle otto app (solo al clic, mai altrove)', () => {
  it('cursor, claude, zcode, claude-code, codex, windsurf, gemini e vscode nei loro posti', () => {
    expect(importSourcePaths(HOME).map((p) => p.source)).toEqual([
      'cursor', 'claude', 'zcode', 'claude-code', 'codex', 'windsurf', 'gemini', 'vscode'
    ])
    const p = importSourcePaths(HOME)
    expect(p[3]).toEqual({ source: 'claude-code', path: `${HOME}/.claude.json` })
    expect(p[4]).toEqual({ source: 'codex', path: `${HOME}/.codex/config.toml` })
    expect(p[5]).toEqual({ source: 'windsurf', path: `${HOME}/.codeium/windsurf/mcp_config.json` })
    expect(p[6]).toEqual({ source: 'gemini', path: `${HOME}/.gemini/settings.json` })
    expect(p[7]).toEqual({ source: 'vscode', path: `${HOME}/Library/Application Support/Code/User/mcp.json` })
  })
})

describe('U7: parseTomlSubset — il parser TOML MINIMO (nessuna dipendenza nuova)', () => {
  it('tabelle, stringhe, array di stringhe e tabelle inline del config di Codex', () => {
    const toml = [
      '# il config di Codex',
      'model = "gpt-5"',
      '',
      '[mcp_servers.weather]',
      'command = "npx"',
      'args = ["-y", "@some/weather"]',
      'env = { WEATHER_API_KEY = "k-finta" }',
      '',
      '[mcp_servers.mattermost]',
      'command = "uvx"',
      'args = ["mattermost-mcp"]',
      'bearer_token_env_var = "MATTERMOST_TOKEN"'
    ].join('\n')
    const obj = parseTomlSubset(toml)
    expect(obj).not.toBeNull()
    const servers = obj!.mcp_servers as Record<string, unknown>
    expect(obj!.model).toBe('gpt-5')
    expect(servers.weather).toEqual({ command: 'npx', args: ['-y', '@some/weather'], env: { WEATHER_API_KEY: 'k-finta' } })
    expect(servers.mattermost).toEqual({ command: 'uvx', args: ['mattermost-mcp'], bearer_token_env_var: 'MATTERMOST_TOKEN' })
  })

  it('stringhe letterali, chiavi con virgolette nelle tabelle, escape base', () => {
    const obj = parseTomlSubset('[mcp_servers."il.mio"]\npath = \'C:\\x\'\nname = "con \\"virgolette\\" e \\n"')
    const servers = obj!['mcp_servers'] as Record<string, unknown>
    expect(servers['il.mio']).toEqual({ path: 'C:\\x', name: 'con "virgolette" e \n' })
  })

  it('TOML che esce dal sottoinsieme → null (file saltato, mai un errore)', () => {
    expect(parseTomlSubset('x = [1, 2]')).toBeNull() // array di numeri fuori dal sottoinsieme
    expect(parseTomlSubset('x =')).toBeNull()
    expect(parseTomlSubset('non è toml')).toBeNull()
    expect(parseTomlSubset('[[array-di-tabelle]]\nx = "y"')).toBeNull()
  })
})

describe('U7: parseSourceFile — la forma di ogni app', () => {
  it('windsurf e gemini: mcpServers come Cursor', () => {
    const w = parseSourceFile('windsurf', JSON.stringify({ mcpServers: { mm: { command: 'npx', args: ['-y', 'mm'] } } }))
    expect(w!.entries.mm).toMatchObject({ command: 'npx' })
    const g = parseSourceFile('gemini', JSON.stringify({ mcpServers: { cerca: { url: 'https://g.example/mcp', headers: { Authorization: 'Bearer x' } } } }))
    expect(g!.entries.cerca).toMatchObject({ url: 'https://g.example/mcp' })
  })

  it('vscode: la chiave servers', () => {
    const v = parseSourceFile('vscode', JSON.stringify({ servers: { filesystem: { command: 'npx', args: ['-y', 'fs'] } } }))
    expect(v!.entries.filesystem).toMatchObject({ command: 'npx' })
  })

  it('claude-code: mcpServers UTENTE e quelli dei PROGETTI (projects.<path>.mcpServers)', () => {
    const cc = parseSourceFile('claude-code', JSON.stringify({
      mcpServers: { utente: { command: 'npx', args: ['-y', 'u'] } },
      projects: {
        '/Users/test/lavoro': { mcpServers: { lavoro: { command: 'node', args: ['s.js'] } } },
        '/Users/test/casa': { mcpServers: { casa: { url: 'https://casa.example/mcp' } } }
      },
      history: ['roba', 'privata', 'che', 'non', 'si', 'toca']
    }))
    expect(Object.keys(cc!.entries).sort()).toEqual(['casa', 'lavoro', 'utente'])
  })

  it('codex: [mcp_servers.<nome>] dal TOML', () => {
    const c = parseSourceFile('codex', '[mcp_servers.mm]\ncommand = "uvx"\nargs = ["mattermost-mcp"]')
    expect(c!.entries.mm).toMatchObject({ command: 'uvx' })
  })

  it('testo malformato → null (quel file non c\'è, gli altri restano)', () => {
    expect(parseSourceFile('cursor', '{non json')).toBeNull()
    expect(parseSourceFile('codex', '===')).toBeNull()
  })
})

/** una lettura che serve i TESTI finti per via. */
const readText = (files: Record<string, string>) => async (path: string): Promise<string | null> => files[path] ?? null

describe('U7: scanImportedSources — righe, variabili «da compilare» e SALTATI col motivo', () => {
  const paths = importSourcePaths(HOME)
  const CC = JSON.stringify({
    mcpServers: { 'claude-code-srv': { command: 'npx', args: ['-y', 'cc'], env: { CC_TOKEN: '${input:cc-token}' } } }
  })
  const CODEX = [
    '[mcp_servers.mattermost]',
    'command = "uvx"',
    'args = ["mattermost-mcp"]',
    'bearer_token_env_var = "MATTERMOST_TOKEN"'
  ].join('\n')
  const VSCODE = JSON.stringify({
    servers: {
      buono: { command: 'npx', args: ['-y', 'b'], env: { K: 'v' } },
      'col-comando-riferito': { command: '${env:PIO}', args: [], env: {} },
      'con-var-da-compilare': { command: 'npx', args: ['-y', 'v'], env: { API_KEY: '${env:API_KEY}', PLAIN: 'ok' } }
    }
  })
  const GEMINI = JSON.stringify({ mcpServers: { gem: { command: 'npx', args: ['-y', 'g'], env: { GEM_KEY: '${env:GEM_KEY}' } } } })
  const WINDSURF = JSON.stringify({ mcpServers: { wind: { command: 'npx', args: ['-y', 'w'] } } })

  const scan = () => scanImportedSources({
    paths,
    readText: readText({
      [paths[3]!.path]: CC,
      [paths[4]!.path]: CODEX,
      [paths[5]!.path]: WINDSURF,
      [paths[6]!.path]: GEMINI,
      [paths[7]!.path]: VSCODE
    })
  })

  it('le righe arrivano dalle CINQUE app nuove con nome, comando e via del file', async () => {
    const { rows } = await scan()
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(byName['claude-code-srv']!.source).toBe('claude-code')
    expect(byName['claude-code-srv']!.commandLine).toBe('npx -y cc')
    expect(byName.mattermost!.source).toBe('codex')
    expect(byName.mattermost!.commandLine).toBe('uvx mattermost-mcp')
    expect(byName.wind!.source).toBe('windsurf')
    expect(byName.gem!.source).toBe('gemini')
    expect(byName.buono!.source).toBe('vscode')
  })

  it('la variabile RIFERITA (${input:…}, ${env:…}) non porta MAI il valore: la riga conta un SEGRETO da compilare', async () => {
    const { rows } = await scan()
    const cc = rows.find((r) => r.name === 'claude-code-srv')!
    expect(cc.secretNames).toContain('CC_TOKEN')
    expect(JSON.stringify(rows)).not.toContain('cc-token')
    const gem = rows.find((r) => r.name === 'gem')!
    expect(gem.secretNames).toContain('GEM_KEY')
    // l'env con valore PLAIN resta: solo la variabile riferita diventa da compilare
    const vsc = rows.find((r) => r.name === 'con-var-da-compilare')!
    expect(vsc.secretNames).toContain('API_KEY')
    expect(vsc.envNames).toContain('PLAIN')
  })

  it('bearer_token_env_var (Codex): il NOME della variabile è un segreto da compilare, il valore non esiste', async () => {
    const { rows } = await scan()
    const mm = rows.find((r) => r.name === 'mattermost')!
    expect(mm.secretNames).toContain('MATTERMOST_TOKEN')
    expect(mm.envNames).not.toContain('MATTERMOST_TOKEN')
  })

  it('il comando con ${env:…} NON si importa: server SALTATO col motivo', async () => {
    const { rows, skipped } = await scan()
    expect(rows.some((r) => r.name === 'col-comando-riferito')).toBe(false)
    expect(skipped).toContainEqual({ source: 'vscode', name: 'col-comando-riferito', reason: 'env-in-command' })
  })
})

describe('U7: buildImportedServer — il server con needsAuth «da compilare»', () => {
  it('stdio con variabile riferita: envSpec con il segreto, NESSUN valore, needsAuth con la chiave', () => {
    const parsed = parseSourceFile('gemini', JSON.stringify({ mcpServers: { gem: { command: 'npx', args: ['-y', 'g'], env: { GEM_KEY: '${env:GEM_KEY}', PLAIN: 'ok' } } } }))
    const built = buildImportedServer('gemini', 'gem', parsed!)
    expect(built).not.toBeNull()
    expect([...built!.cfg.envSpec!].sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: 'GEM_KEY', secret: true }, { name: 'PLAIN', secret: false }])
    expect(built!.cfg.envValues).toEqual({ PLAIN: 'ok' })
    expect(built!.cfg.needsAuth).toEqual({ kind: 'env', keys: ['GEM_KEY'] })
    expect(JSON.stringify(built)).not.toContain('${env:')
  })

  it('bearer_token_env_var: needsAuth con la variabile, envSpec segreta SENZA valore', () => {
    const parsed = parseSourceFile('codex', '[mcp_servers.mattermost]\ncommand = "uvx"\nargs = ["mattermost-mcp"]\nbearer_token_env_var = "MATTERMOST_TOKEN"')
    const built = buildImportedServer('codex', 'mattermost', parsed!)
    expect(built!.cfg.needsAuth).toEqual({ kind: 'env', keys: ['MATTERMOST_TOKEN'] })
    expect(built!.cfg.envSpec).toEqual([{ name: 'MATTERMOST_TOKEN', secret: true }])
    expect(built!.cfg.envValues).toEqual({})
    expect(built!.secret).toBeUndefined() // nessun valore da cifrare: da compilare
  })

  it('la voce SALTATA (comando riferito) non si costruisce (apply la tratta missing)', () => {
    const parsed = parseSourceFile('vscode', JSON.stringify({ servers: { x: { command: '${env:PIO}', args: [] } } }))
    expect(buildImportedServer('vscode', 'x', parsed!)).toBeNull()
  })

  it('claude-code: la voce del PROGETTO si costruisce come quelle utente', () => {
    const parsed = parseSourceFile('claude-code', JSON.stringify({ projects: { '/p': { mcpServers: { lavoro: { command: 'node', args: ['s.js'] } } } } }))
    const built = buildImportedServer('claude-code', 'lavoro', parsed!)
    expect(built!.cfg).toMatchObject({ name: 'lavoro', transport: 'stdio', command: 'node', args: ['s.js'] })
  })
})
