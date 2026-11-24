// Fase box-container (BX3): lo spazio su disco tutelato. Le funzioni PURA
// (parse del df del motore, margine dei 5 GB, le righe per la UI) e i due
// comportamenti automatici dell'ensure del box (prune della cache di build
// DOPO una build riuscita; l'immagine VECCHIA si elimina quando la nuova è
// pronta e il box è ripartito) — col runner finto, senza Docker.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-disk-space-test-'))
const FIXTURES = join(import.meta.dirname, 'fixtures', 'container-1.7.1')
/** Il corpo di una fixture: senza la riga `$ container…` e senza `[exit N]`. */
const fixture = (name: string): string => {
  const text = readFileSync(join(FIXTURES, name), 'utf8')
  return text.replace(/^\$ container[^\n]*\n/, '').replace(/\[exit \d+\]\n?$/, '').trim()
}
const mode = vi.hoisted(() => ({ value: 'host' as string }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key === 'sandbox.mode' ? mode.value : fallback),
  dataDir: () => TMP
}))

const disk = await import('../disk-space')
const { ensureBoxContainer, setDockerRunnerForTests, boxImage, resetBotHomesForTests } = await import('../index')
const { BOX_CONTAINER, boxImageTag } = await import('../docker-argv')

const IMG = boxImageTag('FROM mcr.microsoft.com/playwright:v1.64.1-noble')

/** Runner finto: l'immagine del box c'è già (niente build), il box c'è e va. */
function healthyBox(extra: { image?: string } = {}) {
  const calls: string[][] = []
  const runner = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> => {
    calls.push(argv)
    if (argv[0] === 'ps') return { stdout: BOX_CONTAINER, stderr: '', exitCode: 0, signal: null }
    if (argv[0] === 'inspect' && argv[2] === '{{.Config.Image}}') return { stdout: extra.image ?? boxImage(), stderr: '', exitCode: 0, signal: null }
    if (argv[0] === 'inspect' && argv[2]?.startsWith('{{range .Mounts}}')) return { stdout: '/box:rw /browser:rw /plugins:ro ', stderr: '', exitCode: 0, signal: null }
    if (argv[0] === 'inspect') return { stdout: 'true', stderr: '', exitCode: 0, signal: null }
    if (argv[0] === 'image' && argv[1] === 'inspect') return { stdout: '0', stderr: '', exitCode: 0, signal: null }
    return { stdout: '', stderr: '', exitCode: 0, signal: null }
  }
  return { calls, runner }
}

beforeAll(() => { mode.value = 'box' })
beforeEach(() => resetBotHomesForTests())
afterEach(() => setDockerRunnerForTests(null))
afterAll(() => {
  mode.value = 'host'
  rmSync(TMP, { recursive: true, force: true })
})

describe('BX3: il parse del df del motore (parseDfJson/parseHumanBytes, puri)', () => {
  it('parseHumanBytes: 1.18GB → 1.18e9 (decimali, come docker), 315MB, 12kB, numero nudo', () => {
    expect(disk.parseHumanBytes('1.18GB')).toBe(1_180_000_000)
    expect(disk.parseHumanBytes('315MB')).toBe(315_000_000)
    expect(disk.parseHumanBytes('12kB')).toBe(12_000)
    expect(disk.parseHumanBytes('42')).toBe(42)
    expect(disk.parseHumanBytes('xz')).toBeNull()
  })

  it('parseDfJson: le voci Images/Containers/Local Volumes/Build Cache con Size e Reclaimable', () => {
    const df = disk.parseDfJson(JSON.stringify([
      { Type: 'Images', TotalCount: 3, Size: '1.18GB', Reclaimable: '1.15GB' },
      { Type: 'Containers', TotalCount: 1, Size: '1.09MB', Reclaimable: '0B' },
      { Type: 'Local Volumes', TotalCount: 4, Size: '315MB', Reclaimable: '0B' },
      { Type: 'Build Cache', TotalCount: 17, Size: '1.15GB', Reclaimable: '1.15GB' }
    ]))
    expect(df?.imagesBytes).toBe(1_180_000_000)
    expect(df?.imagesReclaimableBytes).toBe(1_150_000_000)
    expect(df?.volumesBytes).toBe(315_000_000)
    expect(df?.buildCacheBytes).toBe(1_150_000_000)
    expect(df?.buildCacheReclaimableBytes).toBe(1_150_000_000)
  })

  it('parseDfJson: output assurdo → null (mai numeri inventati)', () => {
    expect(disk.parseDfJson('')).toBeNull()
    expect(disk.parseDfJson('not json')).toBeNull()
  })

  it('reclaimableBytes: immagini vecchie + cache di build + container fermi', () => {
    const df = disk.parseDfJson(JSON.stringify([
      { Type: 'Images', Size: '2GB', Reclaimable: '800MB' },
      { Type: 'Containers', Size: '10MB', Reclaimable: '9MB' },
      { Type: 'Build Cache', Size: '1GB', Reclaimable: '1GB' }
    ]))
    expect(disk.reclaimableBytes(df!)).toBe(800_000_000 + 9_000_000 + 1_000_000_000)
  })
})

describe('BX3: il margine dei 5 GB prima di build e download (enoughDiskSpace, pura)', () => {
  it('ci vuole la stima PIÙ 5 GB di margine: libero insufficiente → manca la differenza', () => {
    expect(disk.enoughDiskSpace(10e9, 2e9)).toEqual({ ok: true, missingBytes: 0 })
    const r = disk.enoughDiskSpace(5e9, 2e9)
    expect(r.ok).toBe(false)
    expect(r.missingBytes).toBe(2e9) // 2 + 5 - 5
  })

  it('il margine di default è 5 GB, ma si può chiedere diverso', () => {
    expect(disk.enoughDiskSpace(2.5e9, 2e9).ok).toBe(false)
    expect(disk.enoughDiskSpace(2.5e9, 2e9, 0.4e9).ok).toBe(true)
  })

  it('spazio libero ignoto → non si parta per ottimismo', () => {
    expect(disk.enoughDiskSpace(null, 2e9).ok).toBe(false)
  })
})

describe('BX3: le righe di «Spazio su disco» (diskSpaceRows, pura)', () => {
  const df = disk.parseDfJson(JSON.stringify([
    { Type: 'Images', Size: '1.18GB', Reclaimable: '30MB' },
    { Type: 'Local Volumes', Size: '315MB', Reclaimable: '0B' },
    { Type: 'Build Cache', Size: '1.15GB', Reclaimable: '1.15GB' }
  ]))!

  it('cinque righe: immagine, file dei bot, recuperabile, modello locale, modello memoria', () => {
    const rows = disk.diskSpaceRows({
      df,
      boxImageBytes: 1_180_000_000,
      modelBytes: 2_500_000_000,
      memoryModelBytes: 400_000_000
    })
    expect(rows.map((r) => r.id)).toEqual(['box-image', 'box-files', 'reclaimable', 'model', 'memory-model'])
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(by['box-image'].bytes).toBe(1_180_000_000)
    expect(by['box-files'].bytes).toBe(315_000_000)
    expect(by.reclaimable.bytes).toBe(30_000_000 + 1_150_000_000)
    expect(by.model.bytes).toBe(2_500_000_000)
    expect(by['memory-model'].bytes).toBe(400_000_000)
    // le azioni distruttive sono MARCATE (la UI chiede la conferma)
    expect(new Set(rows.map((r) => r.destructive))).toEqual(new Set([true, true, false, true, true]))
  })

  it('senza motore (host): le righe del box restano ma senza dimensione', () => {
    const rows = disk.diskSpaceRows({ df: null, boxImageBytes: null, modelBytes: null, memoryModelBytes: null })
    expect(rows.length).toBe(5)
    expect(rows.every((r) => r.bytes === null)).toBe(true)
  })
})

describe('BX3: i comportamenti automatici dell\'ensure del box', () => {
  it('dopo una build RIUSCITA parte la pulizia SICURA della cache (mai l\'immagine in uso)', async () => {
    // fase design (verifica della suite): il probe dello spazio disco anche qui
    // (il test qui sotto lo reimposta a null per provare quello VERO): senza, la
    // build partiva solo se la macchina aveva ~6,5 GB liberi davvero
    disk.setDiskSpaceProbeForTests(() => 20_000_000_000)
    const calls: string[][] = []
    let imageMissing = true
    setDockerRunnerForTests(async (argv) => {
      calls.push(argv)
      if (argv[0] === 'image' && argv[1] === 'inspect') {
        // la prima volta manca (build), poi c'è
        if (imageMissing) { imageMissing = false; return { stdout: '', stderr: 'no such image', exitCode: 1, signal: null } }
        return { stdout: '', stderr: '', exitCode: 0, signal: null }
      }
      if (argv[0] === 'build') return { stdout: '', stderr: '', exitCode: 0, signal: null }
      if (argv[0] === 'ps') return { stdout: '', stderr: '', exitCode: 0, signal: null } // box da creare
      if (argv[0] === 'exec' && argv.includes('test')) return { stdout: '', stderr: '', exitCode: 0, signal: null }
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    })
    await ensureBoxContainer()
    const prunes = calls.filter((a) => a[0] === 'image' && a[1] === 'prune' || a[0] === 'builder')
    expect(prunes.length).toBeGreaterThan(0)
    expect(prunes.every((a) => !a.includes('-a'))).toBe(true) // MAI -a: l'immagine in uso resta
  })

  it('la build NON parte senza lo spazio libero (stima + 5 GB): errore chiaro, nessun argv build', async () => {
    disk.setDiskSpaceProbeForTests(() => 1_000_000_000) // 1 GB liberi: troppo poco
    let built = 0
    setDockerRunnerForTests(async (argv) => {
      if (argv[0] === 'image' && argv[1] === 'inspect') return { stdout: '', stderr: 'no such image', exitCode: 1, signal: null }
      if (argv[0] === 'build') { built++; return { stdout: '', stderr: '', exitCode: 0, signal: null } }
      if (argv[0] === 'ps') return { stdout: '', stderr: '', exitCode: 0, signal: null }
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    })
    await expect(ensureBoxContainer()).rejects.toThrow(/[Ss]pazio|space/)
    expect(built).toBe(0)
    disk.setDiskSpaceProbeForTests(null)
  })

  it('aggiornamento che cambia l\'immagine: la VECCHIA si elimina DOPO che il box è ripartito', async () => {
    const vecchia = boxImageTag('FROM mcr.microsoft.com/playwright:v1.64.1-noble-VECCHIA')
    const f = healthyBox({ image: vecchia })
    const removed: string[][] = []
    setDockerRunnerForTests(async (argv) => {
      if (argv[0] === 'image' && argv[1] === 'rm') removed.push(argv)
      return f.runner(argv)
    })
    await ensureBoxContainer()
    // la ricreazione è avvenuta (l'immagine del container era VECCHIA)...
    expect(f.calls.some((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === BOX_CONTAINER)).toBe(true)
    // ...e la VECCHIA immagine è stata tolta, la NUOVA mai (la rimozione
    // parte dopo il riparto del box: si aspetta che avvenga, non un tempo fisso)
    await vi.waitFor(() => expect(removed).toEqual([['image', 'rm', vecchia]]), { timeout: 2000, interval: 10 })
    expect(removed.some((a) => a.includes(boxImage()))).toBe(false)
  })

  it('il controllo spazio usa il probe iniettabile e poi quello VERO (statfs)', () => {
    disk.setDiskSpaceProbeForTests(() => 123)
    expect(disk.freeDiskBytesOf('/')).toBe(123)
    disk.setDiskSpaceProbeForTests(null)
    expect(disk.freeDiskBytesOf('/')).toBeGreaterThan(1_000_000_000) // il disco vero ha più di 1 GB
  })
})

describe("U4 (fase prima-release): la stima Apple conta SOLO ciò che la pulizia toglie davvero", () => {
  // i NUMERI VERI del Mac dell'utente (fixture system-df-prima-release): i
  // 6,9 GB «recuperabili» sono il container buildkit FERMO, i 244 MB di
  // immagini sono l'immagine base di Playwright che NON va tolta
  const df = disk.parseDfJson(fixture('system-df-prima-release.txt'))!

  it("tutti i FERMI sono builder → si contano SOLO i containers.reclaimable (6.946.705.408), le immagini NON si contano", () => {
    expect(disk.appleCleanupReclaimableBytes(df, true)).toBe(6_946_705_408)
  })

  it("con il BOX fermo (un fermo NON è builder) la parte container è sconosciuta e NON si conta: 0", () => {
    expect(disk.appleCleanupReclaimableBytes(df, false)).toBe(0)
  })

  it("lettura ls mancata → 0 (non si conta); df mancante → null", () => {
    expect(disk.appleCleanupReclaimableBytes(df, null)).toBe(0)
    expect(disk.appleCleanupReclaimableBytes(null, true)).toBe(null)
  })

  it("diskSpaceRows accetta la stima Apple come valore della riga reclaimable (l'override vince su reclaimableBytes)", () => {
    const rows = disk.diskSpaceRows({ df, boxImageBytes: null, modelBytes: null, memoryModelBytes: null, reclaimable: disk.appleCleanupReclaimableBytes(df, true) })
    expect(rows.find((r) => r.id === 'reclaimable')!.bytes).toBe(6_946_705_408)
    const oggi = disk.diskSpaceRows({ df, boxImageBytes: null, modelBytes: null, memoryModelBytes: null })
    expect(oggi.find((r) => r.id === 'reclaimable')!.bytes).toBe(244_289_536 + 6_946_705_408)
  })
})
