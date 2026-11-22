// Fase box-apple-cli-vera (BAV1): il contratto argv ↔ help VERA. Ogni funzione
// apple*Argv costruisce l'argv con valori di prova e l'argv si controlla
// contro la help VERA della CLI 1.7.1 (le fixture catturate dal vivo):
// - MAI un template Go ({{…}}): la CLI vera esce 64;
// - --format solo con json/table/yaml/toml (l'errore vero della 1.7.1);
// - sottocomando e opzioni solo quelli che la help elenca (righe `-x, --long`).
// Il modulo del contratto è GENERICO (engine-cli-contract: argv e help di un
// motore qualunque — Podman e WSL2 lo riusano); questo test è la tavoletta
// Apple: la tabella dei valori di prova per OGNI funzione esportata.
//
// BRV1 (fase box-apple-rete-vera): le help sono TUTTE nelle fixture — anche
// le 10 che BAV segnalava mancanti (system kernel set, system status, system
// df, ls, stop, inspect, image inspect, volume create, build, network
// inspect). Il contratto è OBBLIGATORIO: un sottocomando usato da un
// apple*Argv senza la sua help in fixture è una VIOLAZIONE che ferma il
// test — l'elenco fisso dei «mancanti» è VIA. La CLI vera non si chiama MAI
// dai test: una help nuova si cattura dal vivo e si copia con lo script.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkEngineArgv, cliOptionSignature, hardViolations, type EngineArgvViolation } from '../engine-cli-contract'
import * as MOD from '../apple-container-argv'
import { DEFAULT_BOX_LIMITS } from '../docker-argv'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'container-1.7.1')

/** La fixture della help di un sottocomando (nome file → sottocomando). */
const HELP_FILES: Record<string, string> = {
  'run-help.txt': 'run',
  'exec-help.txt': 'exec',
  'cp-help.txt': 'cp',
  'start-help.txt': 'start',
  'stop-help.txt': 'stop',
  'rm-help.txt': 'rm',
  'ls-help.txt': 'ls',
  'inspect-help.txt': 'inspect',
  'build-help.txt': 'build',
  'system-start-help.txt': 'system start',
  'system-status-help.txt': 'system status',
  'system-df-help.txt': 'system df',
  'system-kernel-set-help.txt': 'system kernel set',
  'volume-create-help.txt': 'volume create',
  'volume-ls-help.txt': 'volume ls',
  'volume-delete-help.txt': 'volume delete',
  'network-create-help.txt': 'network create',
  'network-inspect-help.txt': 'network inspect',
  'image-inspect-help.txt': 'image inspect',
  'image-prune-help.txt': 'image prune',
  'image-delete-help.txt': 'image delete',
  // U4 (fase prima-release): la cancellazione del builder fermo — help
  // trascritta dalla spec (OVERVIEW e USAGE citate dal vivo, blocco OPZIONI
  // con il boilerplate della famiglia; sandbot non usa --force)
  'builder-delete-help.txt': 'builder delete'
}
const helps: Record<string, string> = Object.fromEntries(
  Object.entries(HELP_FILES).map(([file, sub]) => [sub, readFileSync(join(FIXTURES, file), 'utf8')])
)

/** I valori ammessi di --format quando la help non li dice: l'errore VERO della 1.7.1. */
const FORMAT_VALUES = ['json', 'table', 'yaml', 'toml']

/** I sottocomandi che --format NON lo hanno: la CLI vera dice Unknown option. */
const NO_FORMAT = ['inspect', 'image inspect']

/** Ogni funzione apple*Argv con i valori di prova e il suo sottocomando. */
const S: Record<string, { args: unknown[]; sub: string }> = {
  appleSystemStartArgv: { args: [], sub: 'system start' },
  appleKernelSetRecommendedArgv: { args: [], sub: 'system kernel set' },
  appleVersionArgv: { args: [], sub: '' },
  appleSystemStatusArgv: { args: [], sub: 'system status' },
  appleSystemStatusJsonArgv: { args: [], sub: 'system status' },
  appleNetworkCreateArgv: { args: [], sub: 'network create' },
  appleNetworkInspectArgv: { args: [], sub: 'network inspect' },
  applePsArgv: { args: [], sub: 'ls' },
  appleStartArgv: { args: ['sandbot-box'], sub: 'start' },
  appleStopArgv: { args: ['sandbot-box'], sub: 'stop' },
  appleBoxRunArgv: { args: ['sandbot-box', 'sandbot-box', 'bridge', DEFAULT_BOX_LIMITS, 'sandbot-box:abab9640c765'], sub: 'run' },
  appleBoxRmArgv: { args: ['sandbot-box'], sub: 'rm' },
  appleIsolateLinkDownArgv: { args: ['sandbot-box'], sub: 'exec' },
  // D7 (fase deleghe): il collegamento /workspace → /box/workspace nel box
  appleWorkspaceLinkArgv: { args: ['sandbot-box'], sub: 'exec' },
  appleWorkspaceLinkCheckArgv: { args: ['sandbot-box'], sub: 'exec' },
  appleIsolationCheckArgv: { args: ['sandbot-box'], sub: 'exec' },
  appleBoxInspectArgv: { args: ['sandbot-box'], sub: 'inspect' },
  appleBoxWritableArgv: { args: ['sandbot-box'], sub: 'exec' },
  appleEnsureHomeArgv: { args: ['sandbot-box', 'agent_x'], sub: 'exec' },
  appleImageInspectArgv: { args: ['sandbot-box:abab9640c765'], sub: 'image inspect' },
  appleImageSizeArgv: { args: ['sandbot-box:abab9640c765'], sub: 'image inspect' },
  appleBuildArgv: { args: ['sandbot-box:abab9640c765', '/df/Dockerfile', '/ctx'], sub: 'build' },
  appleVolumeLsArgv: { args: ['sandbot-box'], sub: 'volume ls' },
  appleExecArgv: { args: ['sandbot-box', 'echo ok', { workdir: '/box/home/agent_x', env: { HOME: '/box/home/agent_x', SANDBOT_SECRET_K: 'v' } }], sub: 'exec' },
  appleExecBackgroundArgv: { args: ['sandbot-box', 'build', { workdir: '/box' }, { log: '/l', exit: '/e', pid: '/p' }], sub: 'exec' },
  appleKillGroupArgv: { args: ['sandbot-box', 42, 'KILL', '1001:1001'], sub: 'exec' },
  appleStatSizeArgv: { args: ['sandbot-box', '/box/f'], sub: 'exec' },
  appleStdioMcpArgv: { args: [{ workdir: '/w', command: 'npx', args: ['-y', 'x@1'], envKeys: ['K'], home: '/h' }, 'sandbot-box'], sub: 'exec' },
  appleReadFileArgv: { args: ['sandbot-box', '/box/f'], sub: 'exec' },
  appleWriteFileArgv: { args: ['sandbot-box', '/box/f'], sub: 'exec' },
  appleListDirArgv: { args: ['sandbot-box', '/box'], sub: 'exec' },
  appleRealpathArgv: { args: ['sandbot-box', '/box/f'], sub: 'exec' },
  appleFindListArgv: { args: ['sandbot-box', '/box/home/agent_x'], sub: 'exec' },
  appleReadB64Argv: { args: ['sandbot-box', '/box/f'], sub: 'exec' },
  appleWriteB64Argv: { args: ['sandbot-box', '/box/f'], sub: 'exec' },
  appleTestPathArgv: { args: ['sandbot-box', '-f', '/box/f'], sub: 'exec' },
  appleRmDirArgv: { args: ['/plugins/p', 'sandbot-box:abab9640c765', 'sandbot-box'], sub: 'run' },
  appleCpFromBoxArgv: { args: ['sandbot-box', '/box/f', '/mac/dest'], sub: 'cp' },
  applePluginsVolumeCreateArgv: { args: [], sub: 'volume create' },
  applePluginCopyCreateArgv: { args: ['helper', 'sandbot-box:abab9640c765'], sub: 'run' },
  applePluginsMkdirArgv: { args: ['sandbot-box:abab9640c765', '/plugins/p'], sub: 'run' },
  applePluginCpArgv: { args: ['/mac/dir', 'helper', '/plugins/p'], sub: 'cp' },
  applePluginsChownArgv: { args: ['sandbot-box:abab9640c765', '/plugins/p'], sub: 'run' },
  applePluginsChmodArgv: { args: ['sandbot-box:abab9640c765', '/plugins/p'], sub: 'run' },
  applePluginsRmHelperArgv: { args: ['helper'], sub: 'rm' },
  appleBrowserVolumeCreateArgv: { args: [], sub: 'volume create' },
  appleBrowserRootArgv: { args: ['sandbot-box:abab9640c765', 'sh -c browser-root'], sub: 'run' },
  appleBrowserWritableArgv: { args: ['sandbot-box'], sub: 'exec' },
  appleBrowserOldProfileRmArgv: { args: ['sandbot-box', 'agent_x'], sub: 'exec' },
  // BRB2 (fase browser-riavvio-box): il rm dei lock di un avvio precedente
  appleBrowserLocksRmArgv: { args: ['sandbot-box', 'agent_x'], sub: 'exec' },
  appleBrowserMcpArgv: { args: ['agent_x', 8085, { gateway: '192.0.15.1' }, 'sandbot-box'], sub: 'exec' },
  appleBrowserReadFileArgv: { args: ['sandbot-box', '/browser/f'], sub: 'exec' },
  // BRB1 (fase browser-riavvio-box): la lettura pid+boot in un solo exec — il
  // sottocomando exec è già nelle help in fixture
  appleBrowserPidBootReadArgv: { args: ['sandbot-box', '/browser/agent_x/mcp.pid'], sub: 'exec' },
  appleBrowserReadB64Argv: { args: ['sandbot-box', '/browser/f'], sub: 'exec' },
  appleBrowserRmFileArgv: { args: ['sandbot-box', '/browser/f'], sub: 'exec' },
  appleScreenControlVncArgv: { args: ['sandbot-box', 'agent_x', ':0'], sub: 'exec' },
  appleScreenControlPidReadArgv: { args: ['sandbot-box', 'agent_x'], sub: 'exec' },
  appleScreenSocketReadyArgv: { args: ['sandbot-box', '/browser/x/s.sock'], sub: 'exec' },
  appleScreenDisplayReadArgv: { args: ['sandbot-box', 'agent_x'], sub: 'exec' },
  appleScreenBridgeArgv: { args: ['/browser/x/s.sock', 'sandbot-box'], sub: 'exec' },
  appleXdotoolArgv: { args: ['sandbot-box', ':0', './Xauthority', ['mousemove', '10', '20']], sub: 'exec' },
  appleScreenCaptureArgv: { args: ['sandbot-box', ':0', './Xauthority', 'agent_x', 'shot.png'], sub: 'exec' },
  appleScreenGeometryArgv: { args: ['sandbot-box', ':0', './Xauthority'], sub: 'exec' },
  appleTerminalArgv: { args: ['sandbot-box', 'agent_x'], sub: 'exec' },
  appleTermPidListArgv: { args: ['sandbot-box', 'agent_x'], sub: 'exec' },
  appleTermPidCleanArgv: { args: ['sandbot-box', 'agent_x'], sub: 'exec' },
  appleBoxChownArgv: { args: ['sandbot-box', 'sandbot-box:abab9640c765'], sub: 'run' },
  appleBoxMigrateArgv: { args: ['sandbot-agent_x-box', 'agent_x', 'sandbot-box:abab9640c765', 'sandbot-box'], sub: 'run' },
  appleBoxMarkerCheckArgv: { args: ['sandbot-box:abab9640c765', 'sandbot-box'], sub: 'run' },
  appleBoxMarkerWriteArgv: { args: ['sandbot-box:abab9640c765', 'sandbot-box'], sub: 'run' },
  appleDfArgv: { args: [], sub: 'system df' },
  applePruneSafeArgv: { args: [], sub: 'image prune' },
  appleCleanupArgv: { args: [false], sub: 'builder delete' },
  appleRemoveImageArgv: { args: ['sandbot-box:vecchia'], sub: 'image delete' },
  appleRemoveVolumesArgv: { args: [['sandbot-box', 'sandbot-browser']], sub: 'volume delete' }
}

describe('BAV1: il contratto argv ↔ help vera della CLI container 1.7.1', () => {
  it('la tabella dei valori di prova copre OGNI funzione apple*Argv esportata (nessuna via)', () => {
    const esportate = Object.entries(MOD)
      .filter(([n, f]) => typeof f === 'function' && n.startsWith('apple') && n.endsWith('Argv'))
      .map(([n]) => n)
      .sort()
    expect(esportate.length).toBe(Object.keys(S).length)
    expect(esportate).toEqual(Object.keys(S).sort())
  })

  it('le help di fixture dichiarate esistono TUTTE (nessuna mappa verso un file mancante)', () => {
    const presenti = new Set(readdirSync(FIXTURES))
    for (const f of Object.keys(HELP_FILES)) expect(presenti.has(f), f).toBe(true)
  })

  // OGNI funzione: l'argv costruito coi valori di prova parla la CLI vera.
  // Visto FALLIRE il 2026-11-14 su applePsArgv (ls --format {{.name}}), i
  // quattro inspect --format, volume ls --filter, image inspect --format.
  // BRV1: NESSUNA violazione è più tollerata — nemmeno 'help-missing': le
  // help sono TUTTE nelle fixture e ogni sottocomando usato si controlla.
  // Visto FALLIRE il 2026-11-14 (BRV) sulle 10 help ancora mancanti.
  for (const [name, { args, sub }] of Object.entries(S)) {
    it(`${name} parla la help vera di «${sub || 'container'}»`, () => {
      const built = (MOD as unknown as Record<string, (...a: unknown[]) => string[] | string[][]>)[name]!(...args)
      // pruneSafe torna UNA SEQUENZA di argv: si controllano tutti
      for (const argv of Array.isArray(built[0]) ? (built as string[][]) : [built as string[]]) {
        const violations = checkEngineArgv(argv, {
          subcommand: sub,
          helps,
          formatValues: FORMAT_VALUES,
          noFormatSubcommands: NO_FORMAT
        })
        expect(violations, `${name}: ${JSON.stringify(argv)} → ${JSON.stringify(violations)}`).toEqual([])
      }
    })
  }

  it('BRV1 il contratto è OBBLIGATORIO: OGNI sottocomando usato da un apple*Argv ha la sua help in fixture (nessun elenco fisso di mancanti)', () => {
    const usati = new Set<string>()
    for (const [name, { args, sub }] of Object.entries(S)) {
      if (sub === '') continue // `--version`: solo opzioni globali, niente help
      usati.add(sub)
      const built = (MOD as unknown as Record<string, (...a: unknown[]) => string[] | string[][]>)[name]!(...args)
      for (const argv of Array.isArray(built[0]) ? (built as string[][]) : [built as string[]]) {
        for (const v of checkEngineArgv(argv, { subcommand: sub, helps, formatValues: FORMAT_VALUES, noFormatSubcommands: NO_FORMAT })) {
          expect(v.kind, `${name}: ${JSON.stringify(argv)} → ${JSON.stringify(v)}`).not.toBe('help-missing')
        }
      }
    }
    // e la tabella dei valori di prova non lascia sottocomandi SCOPERTI:
    // ogni help in fixture serve ad almeno un argv (le due tabelle si coprono)
    expect([...usati].sort()).toEqual(Object.values(HELP_FILES).sort())
  })
})

describe('BAV1: il modulo generico del contratto (la firma letta dalla help)', () => {
  it('cliOptionSignature: righe `-x, --long <v>`, alias multipli e congiunti, valori di --format', () => {
    const run = cliOptionSignature(helps['run']!)
    expect(run.options.get('--init')).toBe(false)
    expect(run.options.get('-v')).toBe(true) // -v, --volume <volume>
    expect(run.options.get('--volume')).toBe(true)
    expect(run.options.get('-w')).toBe(true) // -w, --workdir, --cwd <dir>
    expect(run.options.get('--cwd')).toBe(true)
    expect(run.options.has('--cap-drop')).toBe(true) // la CLI vera CE L'HA
    expect(run.options.has('--pids-limit')).toBe(false)
    expect(run.formatValues).toBeNull() // run non ha --format

    const vls = cliOptionSignature(helps['volume ls']!)
    expect(vls.options.get('--format')).toBe(true)
    expect(vls.options.get('-q')).toBe(false)
    expect(vls.formatValues).toEqual(['json', 'table', 'yaml', 'toml'])
    expect(vls.options.has('--filter')).toBe(false) // NON ESISTE nella CLI vera

    const sstart = cliOptionSignature(helps['system start']!)
    expect(sstart.options.get('--disable-kernel-install')).toBe(false) // --enable-…/--disable-… congiunti
    expect(sstart.options.get('--enable-kernel-install')).toBe(false)
    expect(sstart.options.get('--timeout')).toBe(true)
  })

  it('il contratto è GENERICO: la stessa help vera rifiuta l\'argv Docker del bug dal vivo', () => {
    // l'uscita vera della 1.7.1: exit 64 sul template Go (BRV1: anche ls ha
    // la sua help in fixture — template e valore si rifiutano da lì)
    const v1 = hardViolations(checkEngineArgv(['ls', '-a', '--format', '{{.name}}'], { subcommand: 'ls', helps, formatValues: FORMAT_VALUES }))
    expect(v1).toContainEqual({ kind: 'go-template', token: '{{.name}}' })
    expect(v1).toContainEqual({ kind: 'format-value', value: '{{.name}}', allowed: FORMAT_VALUES })
    // volume ls HA la help: template, valore e --filter (che non esiste)
    expect(
      hardViolations(checkEngineArgv(['volume', 'ls', '--format', '{{.name}}', '--filter', 'name=^/sandbot-box$'], { subcommand: 'volume ls', helps, formatValues: FORMAT_VALUES }))
    ).toHaveLength(3)
    // inspect --format: Unknown option (l'errore vero del vivo)
    expect(
      hardViolations(checkEngineArgv(['inspect', '--format', '{{.running}}', 'sandbot-box'], { subcommand: 'inspect', helps, formatValues: FORMAT_VALUES, noFormatSubcommands: NO_FORMAT }))
    ).toContainEqual({ kind: 'unknown-option', option: '--format', subcommand: 'inspect' })
  })

  it('hardViolations: le help mancanti non bloccano (si SEGNALANO), i difetti sì', () => {
    const v: EngineArgvViolation[] = [
      { kind: 'help-missing', subcommand: 'inspect' },
      { kind: 'go-template', token: '{{.running}}' }
    ]
    expect(hardViolations(v)).toEqual([{ kind: 'go-template', token: '{{.running}}' }])
  })
})
