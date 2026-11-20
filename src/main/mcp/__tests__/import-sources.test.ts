// E2 (fase mcp-env): «Importa da Cursor, Claude o ZCode» — SOLO al clic
// dell'utente. I file veri non si toccano MAI nei test: qui JSON finti e una
// home finta iniettabile. Quel che conta: stdio con env (i SEGRETI cifrati,
// di default TOKEN/KEY/SECRET/PASSWORD/AUTH), http con Authorization cifrata,
// l'elenco di scansione SENZA valori, il file intero mai copiato (solo le
// voci scelte), i doppioni saltati dal chiamante, e NESSUNA lettura fuori
// dai due gestori (guardia: il modulo delle vie lo importa solo ipc.ts, e
// solo DENTRO i callback).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { importSourcePaths, scanImportedSources, buildImportedServer, type ImportedFileJson } from '../import-sources'

const HOME = '/Users/prova'

const CURSOR_JSON: ImportedFileJson = {
  mcpServers: {
    mattermost: {
      command: 'npx',
      args: ['-y', '@donach/mattermost-mcp'],
      env: { MATTERMOST_URL: 'https://mattermost.competitoor.com', MATTERMOST_TOKEN: 'tok-finto', MATTERMOST_TEAM_ID: 'team1' }
    },
    'web-ufficio': { url: 'https://ufficio.example/mcp', headers: { Authorization: 'Bearer uff-tok', 'X-Piano': 'free' } }
  }
}
const CLAUDE_JSON: ImportedFileJson = {
  mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } }
}
const ZCODE_JSON: ImportedFileJson = { mcp: { servers: { sequential: { type: 'stdio', command: 'npx', args: ['-y', '@sequencemcp'], env: { SEQ_API_KEY: 'k' } } } } }

const readJson = (files: Record<string, ImportedFileJson>) => async (path: string): Promise<ImportedFileJson | null> => files[path] ?? null

describe('E2: le VIE dei tre file (solo al clic, mai altrove)', () => {
  it('cursor, claude e zcode nei loro posti precisi', () => {
    const p = importSourcePaths(HOME)
    expect(p).toEqual([
      { source: 'cursor', path: `${HOME}/.cursor/mcp.json` },
      { source: 'claude', path: `${HOME}/Library/Application Support/Claude/claude_desktop_config.json` },
      { source: 'zcode', path: `${HOME}/.zcode/cli/config.json` }
    ])
  })
})

describe('E2: scanImportedSources — nome e tipo, MAI i valori', () => {
  it('trova stdio e http dai tre file, con i NOMI delle variabili e l\'informazione di segreto', async () => {
    const paths = importSourcePaths(HOME)
    const rows = await scanImportedSources({
      paths,
      readJson: readJson({
        [paths[0]!.path]: CURSOR_JSON,
        [paths[1]!.path]: CLAUDE_JSON,
        [paths[2]!.path]: ZCODE_JSON
      })
    })
    expect(rows).toEqual([
      { source: 'cursor', name: 'mattermost', transport: 'stdio', envNames: ['MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_TEAM_ID'], secretNames: ['MATTERMOST_TOKEN'] },
      { source: 'cursor', name: 'web-ufficio', transport: 'http', envNames: ['Authorization', 'X-Piano'], secretNames: ['Authorization'] },
      { source: 'claude', name: 'filesystem', transport: 'stdio', envNames: [], secretNames: [] },
      { source: 'zcode', name: 'sequential', transport: 'stdio', envNames: ['SEQ_API_KEY'], secretNames: ['SEQ_API_KEY'] }
    ])
    // NESSUN valore segreto (né altro) nella riga di scansione
    expect(JSON.stringify(rows)).not.toContain('tok-finto')
    expect(JSON.stringify(rows)).not.toContain('uff-tok')
  })

  it('un file assente o malformato si salta in silenzio (null), gli altri restano', async () => {
    const paths = importSourcePaths(HOME)
    const rows = await scanImportedSources({
      paths,
      readJson: async (path) => (path === paths[0]!.path ? CURSOR_JSON : null)
    })
    expect(rows.map((r) => r.name)).toEqual(['mattermost', 'web-ufficio'])
  })

  it('voci malformate (senza comando né url) si saltano, MAI un errore dell\'intero file', async () => {
    const paths = importSourcePaths(HOME)
    const rows = await scanImportedSources({
      paths,
      readJson: readJson({ [paths[0]!.path]: { mcpServers: { rotto: {}, buono: { command: 'node', args: ['s.js'] } } } })
    })
    expect(rows.map((r) => r.name)).toEqual(['buono'])
  })
})

describe('E2: buildImportedServer — la voce scelta diventa server manuale (segreti nel canale cifrato)', () => {
  it('stdio: comando/args, NON segreti in envValues, SEGRETI in secret.env', () => {
    const built = buildImportedServer('cursor', 'mattermost', CURSOR_JSON)
    expect(built).not.toBeNull()
    expect(built!.cfg).toMatchObject({
      name: 'mattermost', transport: 'stdio', command: 'npx',
      args: ['-y', '@donach/mattermost-mcp'],
      envSpec: [
        { name: 'MATTERMOST_URL', secret: false },
        { name: 'MATTERMOST_TOKEN', secret: true },
        { name: 'MATTERMOST_TEAM_ID', secret: false }
      ],
      envValues: { MATTERMOST_URL: 'https://mattermost.competitoor.com', MATTERMOST_TEAM_ID: 'team1' }
    })
    expect(built!.secret).toEqual({ env: { MATTERMOST_TOKEN: 'tok-finto' } })
    // il file intero NON si copia: solo la voce
    expect(JSON.stringify(built!.cfg)).not.toContain('web-ufficio')
  })

  it('http: url e header — Authorization cifrata negli headers', () => {
    const built = buildImportedServer('cursor', 'web-ufficio', CURSOR_JSON)
    expect(built!.cfg).toMatchObject({ name: 'web-ufficio', transport: 'http', url: 'https://ufficio.example/mcp', auth: { kind: 'headers' } })
    expect(built!.secret).toEqual({ headers: { Authorization: 'Bearer uff-tok', 'X-Piano': 'free' } })
  })

  it('zcode: server sotto mcp.servers con type/command/args/env', () => {
    const built = buildImportedServer('zcode', 'sequential', ZCODE_JSON)
    expect(built!.cfg).toMatchObject({ name: 'sequential', transport: 'stdio', command: 'npx' })
    expect(built!.secret).toEqual({ env: { SEQ_API_KEY: 'k' } })
  })

  it('una voce scomparsa tra scansione e conferma → null (si salta, niente errori)', () => {
    expect(buildImportedServer('cursor', 'sparito', CURSOR_JSON)).toBeNull()
  })
})

describe('E2: le vie si leggono SOLO nei due gestori del clic (guardia sul sorgente)', () => {
  const IPC_SRC = readFileSync(fileURLToPath(new URL('../../ipc.ts', import.meta.url)), 'utf8')

  it('ipc.ts registra i due canali e chiama scan/apply DENTRO i callback (niente lettura alla registrazione)', () => {
    expect(IPC_SRC).toContain("'mcp-import:scan'")
    expect(IPC_SRC).toContain("'mcp-import:apply'")
    // la lettura avviene solo dentro l'handler (dopo il click), mai al registro
    expect(IPC_SRC).toMatch(/ipcMain\.handle\('mcp-import:scan',[^]*?=>\s*\{[^]*?scanImportedSources/)
  })

  it('nessun altro modulo del repo conosce quelle vie', () => {
    expect(IPC_SRC).not.toMatch(/\.cursor\/mcp\.json/)
    expect(IPC_SRC, 'le vie vivono solo in import-sources.ts').not.toContain('claude_desktop_config.json')
  })
})
