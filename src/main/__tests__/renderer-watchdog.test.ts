// P3.4 (fase primo-avvio): il cane da guardia del renderer. Se entro 15 s dal
// did-finish-load non arriva renderer-ready — oppure arriva did-fail-load o
// render-process-gone — UN solo webContents.reload(); se non basta, la
// finestra si chiude e si ricrea UNA volta dalla porta unica (showMainWindow).
// Ogni passo ha la sua riga; mai un ciclo: al massimo 1 reload + 1 ricreazione
// per AVVIO. PURA: azioni, registro e timer iniettabili.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RENDERER_READY_TIMEOUT_MS, createRendererWatchdog } from '../renderer-watchdog'
import type { LifecycleLine } from '../lifecycle-log'

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')

function rig() {
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let now = 0
  let nextId = 1
  const lines: string[] = []
  const actions: string[] = []
  const log: LifecycleLine = {
    line: (event, fields = {}) => {
      lines.push([event, ...Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`)].join(' '))
    },
    sinceBoot: () => now
  }
  const watchdog = createRendererWatchdog(
    log,
    {
      reload: () => { actions.push('reload') },
      recreate: () => { actions.push('recreate') }
    },
    {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++
        timers.push({ at: now + ms, fn, id })
        return id
      },
      clearTimeout: (id: unknown) => {
        const i = timers.findIndex((t) => t.id === id)
        if (i !== -1) timers.splice(i, 1)
      }
    }
  )
  return {
    watchdog,
    lines,
    actions,
    pending: () => timers.length,
    advance: (ms: number) => {
      now += ms
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now && timers.includes(t)) {
          timers.splice(timers.indexOf(t), 1)
          t.fn()
        }
      }
    }
  }
}

describe('P3.4: il cane da guardia fa 1 reload, poi 1 ricreazione, poi si ferma', () => {
  it('il renderer arriva al paint entro 15 s: non fa niente, nessuna riga', () => {
    const r = rig()
    r.watchdog.onDidFinishLoad()
    expect(r.pending(), 'il conteggio parte dal did-finish-load').toBe(1)
    r.advance(700)
    r.watchdog.onRendererReady()
    expect(r.pending()).toBe(0)
    r.advance(RENDERER_READY_TIMEOUT_MS * 2)
    expect(r.actions).toEqual([])
    expect(r.lines).toEqual([])
  })

  it('nessun renderer-ready: a 15 s UN reload (con la riga), poi — se la pagina ricarica ma resta muta — UNA ricreazione, poi si ferma', () => {
    const r = rig()
    r.watchdog.onDidFinishLoad()
    r.advance(RENDERER_READY_TIMEOUT_MS - 1)
    expect(r.actions).toEqual([])
    r.advance(1)
    expect(r.actions).toEqual(['reload'])
    expect(r.lines).toEqual([`renderer-watchdog step=reload reason=no-first-paint ms=${RENDERER_READY_TIMEOUT_MS}`])
    // il reload funziona a metà: la pagina si ricarica ma il renderer resta senza paint
    r.watchdog.onDidFinishLoad()
    r.advance(RENDERER_READY_TIMEOUT_MS)
    expect(r.actions).toEqual(['reload', 'recreate'])
    expect(r.lines[1]).toBe(`renderer-watchdog step=recreate reason=no-first-paint ms=${RENDERER_READY_TIMEOUT_MS * 2}`)
    // dopo la ricreazione più niente: mai un ciclo
    r.watchdog.onDidFinishLoad()
    r.advance(RENDERER_READY_TIMEOUT_MS * 3)
    expect(r.actions).toEqual(['reload', 'recreate'])
    expect(r.lines).toHaveLength(2)
    expect(r.pending()).toBe(0)
  })

  it('dopo il reload la pagina non si ricarica nemmeno: la ricreazione arriva 15 s dopo il reload', () => {
    const r = rig()
    r.watchdog.onDidFinishLoad()
    r.advance(RENDERER_READY_TIMEOUT_MS)
    expect(r.actions).toEqual(['reload'])
    expect(r.pending(), 'anche dopo il reload il conteggio è armato').toBe(1)
    r.advance(RENDERER_READY_TIMEOUT_MS - 1)
    expect(r.actions).toEqual(['reload'])
    r.advance(1)
    expect(r.actions).toEqual(['reload', 'recreate'])
  })

  it('il reload basta (renderer-ready dopo il reload): nessuna ricreazione', () => {
    const r = rig()
    r.watchdog.onDidFinishLoad()
    r.advance(RENDERER_READY_TIMEOUT_MS)
    r.watchdog.onDidFinishLoad()
    r.advance(900)
    r.watchdog.onRendererReady()
    r.advance(RENDERER_READY_TIMEOUT_MS * 2)
    expect(r.actions).toEqual(['reload'])
    expect(r.pending()).toBe(0)
  })

  it('did-fail-load del frame principale: reload SUBITO; se ricade, ricreazione; poi si ferma (lo dice)', () => {
    const r = rig()
    r.watchdog.onDidFinishLoad()
    r.advance(250)
    r.watchdog.onDidFailLoad(true)
    expect(r.actions).toEqual(['reload'])
    expect(r.lines).toEqual(['renderer-watchdog step=reload reason=did-fail-load ms=250'])
    r.advance(100)
    r.watchdog.onDidFailLoad(true)
    expect(r.actions).toEqual(['reload', 'recreate'])
    expect(r.lines[1]).toBe('renderer-watchdog step=recreate reason=did-fail-load ms=350')
    r.watchdog.onDidFailLoad(true)
    r.watchdog.onRenderProcessGone()
    r.advance(RENDERER_READY_TIMEOUT_MS * 2)
    expect(r.actions, 'mai un ciclo').toEqual(['reload', 'recreate'])
    expect(r.lines.slice(2)).toEqual(['renderer-watchdog step=stop reason=did-fail-load ms=350'])
  })

  it('did-fail-load di un SOTTOFRAMME (una risorsa) non conta', () => {
    const r = rig()
    r.watchdog.onDidFinishLoad()
    r.watchdog.onDidFailLoad(false)
    r.advance(1_000)
    expect(r.actions).toEqual([])
    expect(r.pending(), 'il conteggio del primo paint va avanti').toBe(1)
  })

  it('render-process-gone: reload subito, poi ricreazione', () => {
    const r = rig()
    r.watchdog.onDidFinishLoad()
    r.advance(4_000)
    r.watchdog.onRenderProcessGone()
    expect(r.actions).toEqual(['reload'])
    expect(r.lines).toEqual(['renderer-watchdog step=reload reason=render-process-gone ms=4000'])
    r.watchdog.onRenderProcessGone()
    expect(r.actions).toEqual(['reload', 'recreate'])
    expect(r.lines[1]).toBe('renderer-watchdog step=recreate reason=render-process-gone ms=4000')
  })

  it('un evento senza did-finish-load (finestra chiusa prima) non fa partire niente', () => {
    const r = rig()
    r.watchdog.onRenderProcessGone()
    expect(r.actions).toEqual([])
    expect(r.lines).toEqual([])
  })

  it('dispose() (l\'app sta uscendo): niente timer e più nessuna azione', () => {
    const r = rig()
    r.watchdog.onDidFinishLoad()
    r.watchdog.dispose()
    expect(r.pending()).toBe(0)
    r.advance(RENDERER_READY_TIMEOUT_MS * 2)
    r.watchdog.onDidFailLoad(true)
    r.watchdog.onDidFinishLoad()
    r.advance(RENDERER_READY_TIMEOUT_MS * 2)
    expect(r.actions).toEqual([])
  })
})

describe('P3.4: il cablaggio nel main (guardie sul sorgente)', () => {
  it('UN cane da guardia per avvio: reload sulla principale, ricreazione dalla porta unica showMainWindow', () => {
    const w = /const watchdog = createRendererWatchdog\(lifecycle, \{[\s\S]*?\n    \}, \{[\s\S]*?\n    \}\)/.exec(INDEX)?.[0] ?? ''
    expect(w).toContain('createRendererWatchdog(lifecycle, {')
    expect(w).toMatch(/reload: \(\) => \{ getMainWindow\(\)\?\.webContents\.reload\(\) \}/)
    expect(w).toMatch(/recreate: \(\) => \{\s*\n\s*getMainWindow\(\)\?\.close\(\)\s*\n\s*showMainWindow\(\)/)
  })

  it('gli eventi del renderer e il primo paint arrivano al cane da guardia', () => {
    expect(INDEX).toMatch(/watchdog\.onRendererReady\(\)/)
    expect(INDEX).toMatch(/watchdog\.onDidFinishLoad\(\)/)
    expect(INDEX).toMatch(/watchdog\.onDidFailLoad\(/)
    expect(INDEX).toMatch(/watchdog\.onRenderProcessGone\(\)/)
  })

  it('all\'uscita il cane da guardia si ferma (prima del will-quit)', () => {
    const at = INDEX.indexOf("app.on('before-quit'")
    const block = INDEX.slice(at, INDEX.indexOf("app.on('will-quit'", at))
    expect(block).toContain('watchdog.dispose()')
  })
})
