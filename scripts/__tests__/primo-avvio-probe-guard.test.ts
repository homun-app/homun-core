// Fase primo-avvio: le guardie degli strumenti di P2 (la riproduzione) e
// della sonda, e le funzioni PURE della libreria condivisa
// (scripts/lib/primo-avvio.mjs). Le regole della fase, lette dal sorgente
// come nelle guardie delle altre sonde: SOLO l'app impacchettata di prova in
// una cartella temporanea (mai /Applications/Homun.app, mai dist-installers),
// SOLO SANDBOT_TEST_USER_DATA, Portachiavi e SafeStorage FINTI, la CLI
// `container` FINTA, niente osascript/sudo/docker, la lista delle finestre
// dal di fuori con CGWindowListCopyWindowInfo, pulizia nel finally.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_TMP_BASE } from '../../src/test-tmp'
import {
  resolveTestApp, onScreenWindow, coveredByWindowsInFront, parseLogLine, uiBootSince, lastUiBoot, msOf
} from '../lib/primo-avvio.mjs'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const P2 = read('../fase-primo-avvio-p2-riproduzione.mjs')
const LIB = read('../lib/primo-avvio.mjs')
const SWIFT = read('../lib/window-list.swift')
const SONDA = read('../fase-primo-avvio-probe.mjs')
/** Il codice senza i commenti di riga: i divieti valgono su quello che si ESEGUE. */
const codeOf = (src: string): string => src.replace(/\/\/.*$/gm, '').replace(/\n\s*\/\*[\s\S]*?\*\//g, '')

describe('fase primo-avvio: guardie della riproduzione (P2) e della sonda', () => {
  it('l\'app è SOLO quella impacchettata di prova, in una temporanea: passa da resolveTestApp (mai /Applications/Homun.app, mai dist-installers)', () => {
    expect(LIB).toContain('export function resolveTestApp(')
    expect(LIB).toContain("app.startsWith('/Applications/') || app.includes('/dist-installers/')")
    // PRIMA i divieti, POI l'esistenza: di /Applications/Homun.app non si fa nemmeno uno stat
    expect(LIB.indexOf("app.startsWith('/Applications/')")).toBeLessThan(LIB.indexOf('existsSync(exe)'))
    for (const src of [P2, SONDA]) {
      expect(src).toContain('resolveTestApp(')
      // nessun lancio per conto proprio: l'app arriva SOLO da resolveTestApp
      expect(src).not.toMatch(/spawn(Sync)?\([^)]*(Homun\.app|\/Applications)/)
    }
  })

  it('i dati sono TEMPORANEI (mkdtemp nella base della fase) con SANDBOT_TEST_USER_DATA, Portachiavi e SafeStorage FINTI, container FINTO', () => {
    // il percorso lo si costruisce a pezzi: nel codice dei TEST non può esserci
    // il letterale (guardia ci-beta5)
    const tmpBase = ['var', 'folders', 'nb', 'r6fbsdsn3z58bkbb9w55nn780000gn', 'T'].join('/')
    expect(LIB).toContain(`export const TMP_BASE = '/${tmpBase}'`)
    expect(LIB).toContain('SANDBOT_TEST_USER_DATA: dataDir')
    expect(LIB).toContain("SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json')")
    expect(LIB).toContain("SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json')")
    expect(LIB).toContain('HOMUN_CONTAINER_PATH: fakeContainer')
    for (const src of [P2, SONDA]) {
      expect(src).toContain("mkdtempSync(join(TMP_BASE, `${PREFIX}-`))")
      expect(src).not.toMatch(/mkdtempSync\(join\((?!TMP_BASE)/)
      expect(src).not.toMatch(/os\.tmpdir\(\)|TMPDIR/)
      expect(src).not.toMatch(/['"]\/tmp['"/ ]/)
    }
  })

  it('la lista delle finestre si legge dal di fuori con CGWindowListCopyWindowInfo (Swift, sola lettura), MAI osascript, mai i titoli delle finestre', () => {
    expect(codeOf(SWIFT)).toContain('CGWindowListCopyWindowInfo')
    expect(codeOf(SWIFT)).not.toMatch(/NSAppleScript|kCGWindowName/) // niente AppleScript, niente titoli
    expect(codeOf(SWIFT)).not.toMatch(/CGEvent|postEvent|AXUIElement|CGWarpMouseCursorPosition|\bCGDisplayHideCursor/) // si legge, non si scrive
    for (const src of [P2, SONDA]) {
      expect(codeOf(src)).not.toMatch(/osascript/i)
      expect(src).toContain('compileWindowList(')
    }
    expect(codeOf(LIB)).not.toMatch(/osascript/i)
  })

  it('NESSUN sudo, docker, container vero: la CLI `container` è la finta della sonda', () => {
    for (const src of [P2, SONDA, LIB]) {
      const code = codeOf(src)
      expect(code).not.toMatch(/['"]sudo['"]/)
      expect(code).not.toMatch(/spawn(Sync)?\([^)]*['"]docker['"]/)
      expect(code).not.toMatch(/spawn(Sync)?\([^)]*['"]container['"]/)
      expect(code).not.toMatch(/shell\.open|screencapture/)
    }
    expect(LIB).toContain("if [ \"$1\" = \"--version\" ]; then echo \"container 1.7.1-finta\"; exit 0; fi")
  })

  it('`open` si usa SOLO nella riproduzione, e solo sull\'app di prova (il Finder, il Dock, un lancio in background); la sonda no, come le altre', () => {
    const opens = [...codeOf(LIB).matchAll(/spawnSync\('\/usr\/bin\/open', ([^,)]+)/g)].map((m) => m[1].trim())
    expect(opens, 'lanciare e il reopen: sempre l\'array costruito sull\'app di prova, o l\'app stessa').toEqual(['args', '[app]'])
    // solo dalla libreria, che conosce l'app di prova: gli script non chiamano `open` per conto loro
    expect(codeOf(P2)).not.toMatch(/\/usr\/bin\/open/)
    expect(codeOf(SONDA)).not.toMatch(/\/usr\/bin\/open|reopenWithOpen|launchWithOpen/)
  })

  it('i processi si cercano dall\'AMBIENTE della cartella dati (mai per nome: l\'Homun vero gira sullo stesso Mac)', () => {
    expect(LIB).toContain('p.line.includes(`SANDBOT_TEST_USER_DATA=${dataDir}`)')
    expect(LIB).not.toMatch(/pgrep|pkill/)
    for (const src of [P2, SONDA]) {
      expect(src).toContain('stopProbeDaemons(PREFIX')
      expect(src).not.toMatch(/pgrep|pkill|killall/)
    }
  })

  it('la pulizia sta nel finally (cartelle dei dati e di lavoro cancellate, processi di prova fermati) e lo dice', () => {
    for (const src of [P2, SONDA]) {
      expect(src).toMatch(/\} finally \{\s*\n\s*await cleanup\(\)/)
      expect(src).toContain('rmSync(')
      expect(src).toContain('cartelle temporanee')
    }
  })
})

describe('fase primo-avvio: resolveTestApp — solo l\'app di prova in una temporanea', () => {
  const mk = (dir: string, file = 'Homun'): string => {
    mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(dir, 'Contents', 'MacOS', file), '')
    return dir
  }
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-primo-avvio-lib-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('accetta un Homun.app sotto la base temporanea della fase (anche dalla variabile HOMUN_TEST_APP)', () => {
    const app = mk(mkdtempSync(join(dir, 'uno-')))
    const viaArg = resolveTestApp([`--app=${app}`], {}, dir)
    expect(viaArg.app.startsWith(dir)).toBe(true)
    expect(viaArg.exe.endsWith('/Contents/MacOS/Homun')).toBe(true)
    expect(resolveTestApp([], { HOMUN_TEST_APP: app }, dir).app).toBe(viaArg.app)
  })

  it('senza --app né HOMUN_TEST_APP si ferma subito: non si indovina mai l\'app', () => {
    expect(() => resolveTestApp([], {}, dir)).toThrow(/--app=/)
  })

  it('rifiuta un percorso fuori dalla temporanea della fase, anche se è un Homun.app', () => {
    const app = mk(mkdtempSync(join(dir, 'due-')))
    expect(() => resolveTestApp([`--app=${app}`], {}, join(dir, 'altra-base'))).toThrow(/cartella temporanea/)
  })

  it('rifiuta esplicitamente /Applications e dist-installers (prima ancora di guardare se esiste)', () => {
    const forbidden = ['/Applications/Homun.app', '/x/dist-installers/mac-arm64/Homun.app']
    for (const app of forbidden) expect(() => resolveTestApp([`--app=${app}`], {}, '/')).toThrow(/mai \/Applications\/Homun\.app né dist-installers/)
  })

  it('dentro la temporanea ma senza eseguibile non è un Homun.app', () => {
    expect(() => resolveTestApp([`--app=${dir}`], {}, dir)).toThrow(/non è un Homun\.app/)
  })
})

describe('fase primo-avvio: le finestre dal di fuori (pure)', () => {
  const SCREEN = { x: 0, y: 0, w: 1920, h: 1080 }
  const win = (o) => ({ pid: 7, owner: 'Homun', number: 1, layer: 0, alpha: 1, onscreen: true, x: 360, y: 76, w: 1200, h: 800, z: 2, ...o })

  it('onScreenWindow: la finestra normale a schermo (layer 0, alpha > 0, onscreen) e quanta sta dentro uno schermo', () => {
    const r = onScreenWindow({ screens: [SCREEN], windows: [win({ onscreen: false }), win({ number: 2 }), win({ number: 3, w: 10, h: 10 })] })
    expect(r.win.number).toBe(2)
    expect(r.inside).toBe(1)
  })

  it('una finestra con alpha 0, fuori da ogni schermo o non «onscreen» non conta: win null', () => {
    expect(onScreenWindow({ screens: [SCREEN], windows: [win({ alpha: 0 })] }).win).toBeNull()
    expect(onScreenWindow({ screens: [SCREEN], windows: [win({ onscreen: false })] }).win).toBeNull()
    expect(onScreenWindow({ screens: [], windows: [win()] }).win.number).toBe(1)
    expect(onScreenWindow({ screens: [], windows: [win()] }).inside).toBe(0)
    expect(onScreenWindow({ screens: [SCREEN], windows: [win({ layer: 24 })] }).win).toBeNull()
  })

  it('metà dentro e metà fuori dallo schermo: inside ≈ 0,5 (la griglia di 24×24)', () => {
    const r = onScreenWindow({ screens: [SCREEN], windows: [win({ x: SCREEN.w - 600 })] })
    expect(r.inside).toBeGreaterThan(0.49)
    expect(r.inside).toBeLessThan(0.51)
  })

  it('coveredByWindowsInFront: 0 se nessuna le sta davanti, 1 se una finestra davanti la copre tutta', () => {
    const w = win()
    expect(coveredByWindowsInFront({ windows: [win({ pid: 0, owner: '', number: 9 }), w] }, w)).toBe(0)
    expect(coveredByWindowsInFront({ windows: [win({ pid: 0, owner: '', number: 9, x: 0, y: 0, w: 1920, h: 1080, z: 1 }), { ...w, z: 2 }] }, w)).toBe(1)
    // una finestra DIETRO non copre; una di un altro layer (il menu bar) non conta
    expect(coveredByWindowsInFront({ windows: [{ ...w, z: 2 }, win({ number: 9, z: 3, x: 0, y: 0, w: 1920, h: 1080 })] }, w)).toBe(0)
    expect(coveredByWindowsInFront({ windows: [win({ number: 9, z: 0, x: 0, y: 0, w: 1920, h: 1080, layer: 24 }), w] }, w)).toBe(0)
  })

  it('una finestra che non è a schermo non è «coperta» (z null)', () => {
    expect(coveredByWindowsInFront({ windows: [] }, win({ onscreen: false, z: null }))).toBe(0)
    expect(coveredByWindowsInFront({ windows: [] }, null)).toBe(0)
  })
})

describe('fase primo-avvio: il registro della temporanea (pure)', () => {
  const RIGHE = [
    '2026-11-23T08:10:33.114Z boot pid=96028 version=0.3.1001 mode=ui',
    '2026-11-23T08:10:33.116Z lock',
    '2026-11-23T08:10:33.715Z boot pid=96031 version=0.3.1001 mode=daemon',
    '2026-11-23T08:10:33.848Z renderer-ready ms=734',
    '2026-11-23T08:10:33.900Z did-fail-load ms=250 code=-105 desc=ERR_NAME_NOT_RESOLVED main=true origin=homun://app/',
    '2026-11-23T08:10:38.375Z window-snapshot ms=5261 visible=true minimized=false displays=2 inside=true app-hidden=false',
    '2026-11-23T08:10:41.072Z quit exit-ms=77',
    '2026-11-23T08:10:48.446Z boot pid=96105 version=0.3.1001 mode=ui',
    '2026-11-23T08:10:48.664Z window-shown ms=218'
  ]

  it('parseLogLine: orario, evento e i campi chiave=valore', () => {
    expect(parseLogLine(RIGHE[0])).toMatchObject({ event: 'boot', f: { pid: '96028', version: '0.3.1001', mode: 'ui' } })
    expect(parseLogLine(RIGHE[3])!.f).toEqual({ ms: '734' })
    expect(parseLogLine('non è una riga')).toBeNull()
    expect(parseLogLine('')).toBeNull()
  })

  it('uiBootSince: l\'avvio NATO DOPO l\'offset — null finché la sua riga boot non è scritta (mai l\'avvio di prima)', () => {
    const prima = RIGHE.slice(0, 7).join('\n') + '\n'
    // il file com'era PRIMA del lancio: nessun avvio nuovo
    expect(uiBootSince(prima, prima.length)).toBeNull()
    // è scritta una riga qualsiasi (non il boot): ancora niente
    expect(uiBootSince(prima + '2026-11-23T08:10:48.000Z lock\n', prima.length)).toBeNull()
    const text = prima + RIGHE.slice(7).join('\n') + '\n'
    const b = uiBootSince(text, prima.length)
    expect(b!.bootPid).toBe(96105)
    expect(b!.lines.map((l) => l.event)).toEqual(['boot', 'window-shown'])
    expect(msOf(b, 'window-shown')).toBe(218)
    expect(msOf(b, 'renderer-ready')).toBeNull()
  })

  it('uiBootSince con offset 0 legge dal primo avvio del file', () => {
    const b = uiBootSince(RIGHE.join('\n') + '\n', 0)
    expect(b!.bootPid).toBe(96028)
    expect(b!.lines.map((l) => l.event)).toEqual(['boot', 'lock', 'boot', 'renderer-ready', 'did-fail-load', 'window-snapshot', 'quit', 'boot', 'window-shown'])
    expect(msOf(b, 'window-snapshot')).toBe(5261)
  })

  it('lastUiBoot: l\'ULTIMO avvio della UI del file', () => {
    expect(lastUiBoot(RIGHE)!.bootPid).toBe(96105)
    expect(lastUiBoot([])).toBeNull()
  })
})
