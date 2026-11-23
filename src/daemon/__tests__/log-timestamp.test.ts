// P1 (fase primo-avvio): gli orari nel daemon.log. Prima le righe
// «[sandbotd] …» arrivavano senza orario: non si potevano incrociare con
// main.log (che ha il prefisso ISO). Qui la parte PURA: il wrapper delle
// funzioni di console del daemon, con una console FINTA — nessun processo,
// nessun file. Lo stdout dei server MCP (righe SENZA il prefisso) resta com'è.
import { describe, expect, it } from 'vitest'
import { installDaemonLogTimestamps, DAEMON_LOG_PREFIX, type DaemonConsole } from '../log-timestamp'

/** La console finta: ogni chiamata diventa «livello|argomenti». */
function fakeConsole() {
  const calls: Array<{ level: string; args: unknown[] }> = []
  const make = (level: string) => (...args: unknown[]) => { calls.push({ level, args }) }
  const console: DaemonConsole = { log: make('log'), info: make('info'), warn: make('warn'), error: make('error') }
  return { console, calls, text: (i: number) => `${calls[i]!.level}|${calls[i]!.args.map(String).join(' ')}` }
}

const T0 = Date.parse('2026-11-23T06:57:57.656Z')

describe('P1: installDaemonLogTimestamps — le righe [sandbotd] con il prefisso ISO', () => {
  it('una riga [sandbotd] prende davanti l\'orario ISO, come main.log', () => {
    const f = fakeConsole()
    let now = T0
    installDaemonLogTimestamps(f.console, () => now)
    f.console.log(`${DAEMON_LOG_PREFIX} attivo: pid 72678, ws 127.0.0.1:52341`)
    expect(f.text(0)).toBe('log|2026-11-23T06:57:57.656Z [sandbotd] attivo: pid 72678, ws 127.0.0.1:52341')
    now += 1500
    f.console.error(`${DAEMON_LOG_PREFIX} arresto`)
    expect(f.text(1)).toBe('error|2026-11-23T06:57:59.156Z [sandbotd] arresto')
  })

  it('vale per log, info, warn ed error; gli altri argomenti restano (l\'errore dopo i due punti)', () => {
    const f = fakeConsole()
    installDaemonLogTimestamps(f.console, () => T0)
    f.console.warn(`${DAEMON_LOG_PREFIX} oblio della cella x: byte ancora pendenti (a, b)`)
    const err = new Error('porta occupata')
    f.console.error(`${DAEMON_LOG_PREFIX} avvio fallito:`, err)
    expect(f.calls[0]!.args).toEqual(['2026-11-23T06:57:57.656Z [sandbotd] oblio della cella x: byte ancora pendenti (a, b)'])
    expect(f.calls[1]!.args).toEqual(['2026-11-23T06:57:57.656Z [sandbotd] avvio fallito:', err])
  })

  it('lo stdout dei server MCP (righe SENZA il prefisso) resta com\'è, parola per parola', () => {
    const f = fakeConsole()
    installDaemonLogTimestamps(f.console, () => T0)
    f.console.log('[MCP] weather-server avviato su stdio')
    f.console.error('npm WARN deprecated package@1.0.0')
    f.console.info('')
    expect(f.calls[0]!.args).toEqual(['[MCP] weather-server avviato su stdio'])
    expect(f.calls[1]!.args).toEqual(['npm WARN deprecated package@1.0.0'])
    expect(f.calls[2]!.args).toEqual([''])
  })

  it('il prefisso conta solo all\'INIZIO della riga: un [sandbotd] in mezzo non è una riga nostra', () => {
    const f = fakeConsole()
    installDaemonLogTimestamps(f.console, () => T0)
    f.console.log('output del tool: [sandbotd] finto')
    expect(f.calls[0]!.args).toEqual(['output del tool: [sandbotd] finto'])
  })

  it('una riga il cui primo argomento non è una stringa non si tocca', () => {
    const f = fakeConsole()
    installDaemonLogTimestamps(f.console, () => T0)
    f.console.error(42, `${DAEMON_LOG_PREFIX} dopo un numero`)
    expect(f.calls[0]!.args).toEqual([42, '[sandbotd] dopo un numero'])
  })

  it('disinstallare rimette le funzioni di prima (nessun doppio orario)', () => {
    const f = fakeConsole()
    const restore = installDaemonLogTimestamps(f.console, () => T0)
    restore()
    const again = installDaemonLogTimestamps(f.console, () => T0)
    f.console.log(`${DAEMON_LOG_PREFIX} una volta sola`)
    expect(f.text(0)).toBe('log|2026-11-23T06:57:57.656Z [sandbotd] una volta sola')
    again()
    f.console.log(`${DAEMON_LOG_PREFIX} nudo`)
    expect(f.text(1)).toBe('log|[sandbotd] nudo')
  })

  it('installato due volte (senza disinstallare) l\'orario resta UNO', () => {
    const f = fakeConsole()
    installDaemonLogTimestamps(f.console, () => T0)
    installDaemonLogTimestamps(f.console, () => T0)
    f.console.log(`${DAEMON_LOG_PREFIX} una volta sola`)
    expect(f.text(0)).toBe('log|2026-11-23T06:57:57.656Z [sandbotd] una volta sola')
  })
})
