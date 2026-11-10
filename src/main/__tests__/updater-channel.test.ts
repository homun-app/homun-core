// Fase rilascio di prova (RP3): il canale di prova davanti al PROVIDER
// GitHub VERO — non un modello suo. Il GitHubProvider di electron-updater
// 6.8.9 gira com'è, con un executor finto che serve un feed GitHub finto
// (atom + releases/latest + i .yml del canale): niente rete, niente Electron.
// CORREZIONI (RQ2): l'interruttore set-channel non costruisce l'istanza di
// electron-updater dove l'updater è spento (build --dir, SANDBOT_TEST_*).
// I 4 casi della spec:
//   stabile su 0.3.1001 → una prerelease 0.3.1002-beta.1 NON viene offerta;
//   canale beta → viene offerta;
//   0.3.1001-beta.1 → 0.3.1001-beta.2 viene offerta;
//   0.3.1001-beta.2 → la 0.3.1001 stabile viene offerta.
import { describe, expect, it } from 'vitest'
import { HttpError } from 'builder-util-runtime'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import type { AppUpdater } from 'electron-updater'
import { allowPrereleaseFor, parseUpdateChannel, type UpdateChannel } from '../../shared/update-channel'
import { applyUpdateChannel, injectUpdaterForTests, initUpdater, isNewerVersion, setUpdateChannel } from '../updater'

interface FeedRelease {
  tag: string
  prerelease: boolean
}

/** Il feed GitHub finto: l'atom (prima la più nuova), releases/latest (SOLO
 *  stabili, come GitHub) e i .yml del canale (beta-mac.yml per i -beta.N,
 *  come li pubblica electron-builder). */
function fakeGithubExecutor(releases: FeedRelease[]) {
  const entries = releases
    .map(
      (r) =>
        `<entry><id>tag:github.com,2008:Repository/1/${r.tag}</id><title>${r.tag}</title>` +
        `<link href="https://github.com/homun-app/homun-releases/releases/tag/${r.tag}"/>` +
        `<content type="html">note ${r.tag}</content></entry>`
    )
    .join('')
  const atom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title>${entries}</feed>`
  const latestStable = releases.find((r) => !r.prerelease)
  const ymlOf = (tag: string): string => `version: ${tag.replace(/^v/, '')}\npath: Homun-mac-arm64.dmg\nsha512: aaaabbbbcccc\n`
  return {
    request: (options: { path?: string }): Promise<string> => {
      const p = options.path ?? ''
      if (p.endsWith('/releases.atom')) return Promise.resolve(atom)
      if (p.endsWith('/releases/latest')) {
        if (latestStable === undefined) return Promise.reject(new HttpError(404, 'no stable release'))
        return Promise.resolve(JSON.stringify({ tag_name: latestStable.tag }))
      }
      const m = /\/releases\/download\/([^/]+)\/(latest-mac\.yml|beta-mac\.yml)$/.exec(p)
      if (m) {
        const tag = m[1]!
        const isBetaYml = m[2] === 'beta-mac.yml'
        if ((isBetaYml && !tag.includes('-beta.')) || (!isBetaYml && tag.includes('-beta.'))) {
          return Promise.reject(new HttpError(404, `${m[2]} non sta nella release ${tag}`))
        }
        if (releases.some((r) => r.tag === tag)) return Promise.resolve(ymlOf(tag))
      }
      return Promise.reject(new HttpError(404, `not found: ${p}`))
    }
  }
}

/** Il provider VERO contro il feed finto: che versione verrebbe offerta? */
async function offeredByFeed(current: string, channel: UpdateChannel, releases: FeedRelease[]): Promise<string | null> {
  const provider = new GitHubProvider(
    { provider: 'github', owner: 'homun-app', repo: 'homun-releases' },
    // il contratto che GitHubProvider usa: allowPrerelease, channel (mai
    // impostato: solo il canale di prova governa), currentVersion, fullChangelog
    {
      allowPrerelease: allowPrereleaseFor(channel, current),
      channel: null,
      currentVersion: current,
      fullChangelog: false
    } as unknown as AppUpdater,
    { platform: 'darwin', isUseMultipleRangeRequest: false, executor: fakeGithubExecutor(releases) } as unknown as ConstructorParameters<typeof GitHubProvider>[2]
  )
  const info = await provider.getLatestVersion()
  return isNewerVersion(current, info.version) ? info.version : null
}

const FEED = [
  { tag: 'v0.3.1002-beta.1', prerelease: true },
  { tag: 'v0.3.1001', prerelease: false }
]

describe('fase rilascio di prova (RP3): i 4 casi della spec col provider GitHub vero', () => {
  it('canale STABILE su 0.3.1001: una prerelease 0.3.1002-beta.1 NON viene offerta', async () => {
    // Homun 2 ha allowPrerelease=false di default: come lui, un utente sul
    // canale stabile non vede MAI le prerelease (releases/latest le salta)
    expect(await offeredByFeed('0.3.1001', 'stable', FEED)).toBeNull()
  })

  it('canale BETA: la 0.3.1002-beta.1 viene offerta', async () => {
    expect(await offeredByFeed('0.3.1001', 'beta', FEED)).toBe('0.3.1002-beta.1')
  })

  it('0.3.1001-beta.1 → 0.3.1001-beta.2 viene offerta (anche col canale STABILE: chi prova resta sulle prove)', async () => {
    const feed = [
      { tag: 'v0.3.1001-beta.2', prerelease: true },
      { tag: 'v0.3.1001-beta.1', prerelease: true }
    ]
    expect(await offeredByFeed('0.3.1001-beta.1', 'stable', feed)).toBe('0.3.1001-beta.2')
    expect(await offeredByFeed('0.3.1001-beta.1', 'beta', feed)).toBe('0.3.1001-beta.2')
  })

  it('0.3.1001-beta.2 → la 0.3.1001 STABILE viene offerta (semver: la stabile è più nuova)', async () => {
    const feed = [
      { tag: 'v0.3.1001', prerelease: false },
      { tag: 'v0.3.1001-beta.2', prerelease: true }
    ]
    expect(await offeredByFeed('0.3.1001-beta.2', 'stable', feed)).toBe('0.3.1001')
    expect(await offeredByFeed('0.3.1001-beta.2', 'beta', feed)).toBe('0.3.1001')
  })
})

describe('fase rilascio di prova (RP3): il confronto delle versioni conta il pre-release', () => {
  it('beta.1 → beta.2 è una versione NUOVA (stessa x.y.z, pre-release più avanti)', () => {
    expect(isNewerVersion('0.3.1001-beta.1', '0.3.1001-beta.2')).toBe(true)
    expect(isNewerVersion('0.3.1001-beta.2', '0.3.1001-beta.1')).toBe(false)
    expect(isNewerVersion('0.3.1001-beta.1', '0.3.1001-beta.1')).toBe(false)
  })

  it('la STABILE è più nuova della sua beta (semver: 1.0.0 > 1.0.0-beta.9)', () => {
    expect(isNewerVersion('0.3.1001-beta.2', '0.3.1001')).toBe(true)
    expect(isNewerVersion('0.3.1001', '0.3.1001-beta.1')).toBe(false)
  })

  it('il confronto di prima resta valido (x.y.z cresce, o versioni rotte)', () => {
    expect(isNewerVersion('0.3.1001', '0.3.1002-beta.1')).toBe(true)
    expect(isNewerVersion('0.2.1004', '0.3.1000')).toBe(true)
    expect(isNewerVersion('0.3.1001', '0.3.1001')).toBe(false)
    expect(isNewerVersion('0.3.1001', '0.3.1000')).toBe(false)
    expect(isNewerVersion('boh', '0.3.1002')).toBe(false)
  })
})

describe('fase rilascio di prova (RP3): applyUpdateChannel sul updater iniettato', () => {
  it('beta accende allowPrerelease, stabile lo spegne — senza riavvio', () => {
    const u = { allowPrerelease: false }
    applyUpdateChannel('beta', () => '0.3.1001', u)
    expect(u.allowPrerelease).toBe(true)
    applyUpdateChannel('stable', () => '0.3.1001', u)
    expect(u.allowPrerelease).toBe(false)
  })

  it('una beta in esecuzione tiene allowPrerelease ACCESO anche a canale stabile', () => {
    const u = { allowPrerelease: false }
    applyUpdateChannel('stable', () => '0.3.1001-beta.3', u)
    expect(u.allowPrerelease).toBe(true)
  })
})

describe('fase rilascio di prova (RP3): il valore del canale resta quello del test condiviso', () => {
  it('parseUpdateChannel qui sotto è lo stesso del modulo condiviso (coerenza)', () => {
    expect(parseUpdateChannel('beta')).toBe('beta')
    expect(parseUpdateChannel('nope')).toBe('stable')
  })
})

// RQ2 (correzioni): updater:set-channel chiamava applyUpdateChannel SEMPRE, e
// il parametro di default au() COSTRUIVA l'istanza di electron-updater anche
// nelle build --dir e con le SANDBOT_TEST_*, dove l'updater non deve esistere
// (A8, K6) — provato sul codice di prima: la costruzione entra nell'AppUpdater
// vero (che all'init chiama app.getVersion()) e fuori da Electron esplode.
// Ora il setting si salva SEMPRE e l'istanza nasce SOLO se initUpdater è
// stato chiamato (flag in updater.ts, condizioni mai ricalcolate qui).
describe('fase rilascio di prova · correzioni (RQ2): l\'interruttore non sveglia l\'updater spento', () => {
  /** L'istanza minima che initUpdater/setUpdateChannel toccano (niente Electron). */
  function fakeUpdater(): AppUpdater {
    return {
      allowPrerelease: false,
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: () => undefined,
      checkForUpdates: async () => ({ updateInfo: null }),
      currentVersion: { version: '0.3.1001' }
    } as unknown as AppUpdater
  }

  it('updater NON inizializzato: set-channel salva il setting e NON costruisce l\'istanza', () => {
    let constructed = 0
    // ogni prova parte dall'updater SPENTO (flag a false), come una build
    // --dir o con SANDBOT_TEST_*: la costruzione conta quante volte nasce
    injectUpdaterForTests(() => {
      constructed += 1
      return fakeUpdater()
    })
    const saved: UpdateChannel[] = []
    const returned = setUpdateChannel('beta', (c) => {
      saved.push(c)
      return 'salvato'
    }, () => '0.3.1001')
    expect(constructed, 'l\'istanza di electron-updater non deve nascere qui').toBe(0)
    expect(saved, 'il setting si salva SEMPRE').toEqual(['beta'])
    expect(returned, 'il risultato del salvataggio torna al chiamante').toBe('salvato')
  })

  it('updater NON inizializzato: nemmeno applyUpdateChannel senza updater iniettato la costruisce (ieri esplodeva)', () => {
    let constructed = 0
    injectUpdaterForTests(() => {
      constructed += 1
      return fakeUpdater()
    })
    // quello che l'handler IPC faceva sempre: oggi non costruisce più niente
    expect(() => applyUpdateChannel('beta', () => '0.3.1001')).not.toThrow()
    expect(constructed).toBe(0)
  })

  it('updater inizializzato: set-channel applica il canale SUBITO, senza riavvio', () => {
    const u = fakeUpdater()
    injectUpdaterForTests(() => u)
    // initUpdater accende il flag: l'updater ESISTE, l'effetto è immediato
    initUpdater(async () => 'stable')
    const saved: UpdateChannel[] = []
    setUpdateChannel('beta', (c) => saved.push(c), () => '0.3.1001')
    expect(u.allowPrerelease, 'il canale di prova accende allowPrerelease SUBITO').toBe(true)
    expect(saved).toEqual(['beta'])
    // e spegnere l'interruttore riportando il canale stabile funziona uguale
    setUpdateChannel('stable', (c) => saved.push(c), () => '0.3.1001')
    expect(u.allowPrerelease).toBe(false)
    expect(saved).toEqual(['beta', 'stable'])
  })
})
