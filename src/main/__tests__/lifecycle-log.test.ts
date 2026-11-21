// U6 (fase mcp-ui): il registro del ciclo di vita del main — sempre attivo,
// leggero, in ~/Library/Logs/Homun/main.log (nella sonda: SANDBOT_TEST_USER_DATA
// la sposta in una cartella temporanea, MAI il ~/Library/Logs/Homun vero).
// Righe con orario per avvio (pid, versione), lock, second-instance, finestra
// creata/mostrata/chiusa, before-quit, will-quit, quit e durata dell'uscita.
// Ruota oltre ~1 MB. MAI dati dell'utente. PURA (deps iniettabili).
import { describe, expect, it } from 'vitest'
import {
  createLifecycleLog,
  mainLogDir,
  LIFECYCLE_LOG_MAX_BYTES,
  type LifecycleLogDeps
} from '../lifecycle-log'

/** Un fs FINTO che registra le scritture. */
function fakeFs(existing: Record<string, { size: number; content: string }> = {}) {
  const files = new Map(Object.entries(existing).map(([k, v]) => [k, { ...v }]))
  const ops: string[] = []
  const deps: LifecycleLogDeps = {
    appendFileSync: (p, data) => {
      const f = files.get(p) ?? { size: 0, content: '' }
      f.content += data
      f.size = f.content.length
      files.set(p, f)
      ops.push(`append ${p.split('/').pop()}`)
    },
    mkdirSync: (p) => { ops.push(`mkdir ${p}`) },
    existsSync: (p) => files.has(p) || p.endsWith('Logs') || p.endsWith('main.log.1') ? files.has(p) || p.endsWith('Logs') : false,
    statSync: (p) => ({ size: files.get(p)?.size ?? 0 }),
    renameSync: (from, to) => {
      const f = files.get(from)
      if (f) { files.delete(from); files.set(to, f) }
      ops.push(`rename ${from.split('/').pop()} -> ${to.split('/').pop()}`)
    },
    rmSync: (p) => { files.delete(p); ops.push(`rm ${p.split('/').pop()}`) },
    now: () => Date.parse('2026-11-21T07:00:00.000Z')
  }
  return { deps, files, ops }
}

const DIR = '/Users/prova/Library/Logs/Homun'
const FILE = `${DIR}/main.log`

describe('U6: mainLogDir — il registro del main', () => {
  it('di norma sta in ~/Library/Logs/Homun (il getPath logs dell\'app)', () => {
    expect(mainLogDir(() => DIR)).toBe(DIR)
  })

  it('con SANDBOT_TEST_USER_DATA (le prove) in una cartella TEMPORANEA, mai nel vero ~/Library/Logs/Homun', () => {
    expect(mainLogDir(() => DIR, { SANDBOT_TEST_USER_DATA: '/T/sonda' } as NodeJS.ProcessEnv)).toBe('/T/sonda/Logs')
  })
})

describe('U6: createLifecycleLog — le righe del ciclo di vita', () => {
  it('una riga per evento: orario ISO, nome evento e i campi', () => {
    const { deps, files } = fakeFs()
    const log = createLifecycleLog(DIR, deps)
    log.line('boot', { pid: 1234, version: '0.3.1001', mode: 'ui' })
    log.line('lock')
    log.line('before-quit', { windows: 1 })
    expect(files.get(FILE)!.content).toBe(
      '2026-11-21T07:00:00.000Z boot pid=1234 version=0.3.1001 mode=ui\n' +
      '2026-11-21T07:00:00.000Z lock\n' +
      '2026-11-21T07:00:00.000Z before-quit windows=1\n'
    )
  })

  it('i campi undefined NON si scrivono (la durata prima del before-quit non c\'è)', () => {
    const { deps, files } = fakeFs()
    const log = createLifecycleLog(DIR, deps)
    log.line('quit', { 'exit-ms': undefined })
    expect(files.get(FILE)!.content).toBe('2026-11-21T07:00:00.000Z quit\n')
  })

  it('ruota oltre ~1 MB: main.log diventa main.log.1 (il .1 vecchio si toglie) e si riparte da vuoto', () => {
    const { deps, files } = fakeFs({
      [FILE]: { size: LIFECYCLE_LOG_MAX_BYTES + 10, content: 'x'.repeat(LIFECYCLE_LOG_MAX_BYTES + 10) },
      [`${FILE}.1`]: { size: 5, content: 'vecchio' }
    })
    const log = createLifecycleLog(DIR, deps)
    log.line('boot')
    expect(files.has(`${FILE}.1`)).toBe(true)
    expect(files.get(`${FILE}.1`)!.content.startsWith('xxxxx')).toBe(true) // il contenuto VECCHIO di main.log
    expect(files.get(FILE)!.content).not.toContain('xxxxx') // il nuovo parte da zero
    expect(files.has(`${FILE}.2`)).toBe(false)
  })

  it('un errore del fs NON si propaga mai (il registro non ferma l\'app)', () => {
    const { deps } = fakeFs()
    deps.appendFileSync = () => { throw new Error('disco pieno') }
    const log = createLifecycleLog(DIR, deps)
    expect(() => log.line('boot')).not.toThrow()
  })
})
