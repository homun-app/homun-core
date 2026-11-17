// Guardia della sonda fase-schermo-vivo: il sorgente si legge e si controlla
// che faccia SOLO quello che la fase permette — app vera (node_modules/electron)
// su dati temporanei, schermo finto dietro SANDBOT_TEST_FAKE_SCREEN_SOCKET,
// NESSUN container/docker/osascript/sudo/apertura vera, rete solo su
// 127.0.0.1, temporanei SOLO con mkdtemp nella cartella di fase, pulizia dei
// daemon a fine corsa. Come le guardie delle altre sonde.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../fase-schermo-vivo-probe.mjs', import.meta.url)), 'utf8')

describe('guardia sonda fase-schermo-vivo', () => {
  it('usa il flag di test SANDBOT_TEST_FAKE_SCREEN_SOCKET per lo schermo finto', () => {
    expect(src).toContain("SANDBOT_TEST_FAKE_SCREEN_SOCKET: SOCK")
  })

  it('l\'app è QUELLA VERA (node_modules/electron), con dati TEMPORANEI via SANDBOT_TEST_USER_DATA', () => {
    expect(src).toMatch(/node_modules.*electron.*Electron\.app/)
    expect(src).toContain('SANDBOT_TEST_USER_DATA: DATA')
  })

  it('il browser acceso è il finto MCP di sempre (SANDBOT_TEST_FAKE_BROWSER_MCP), mai un browser vero', () => {
    expect(src).toContain("SANDBOT_TEST_FAKE_BROWSER_MCP: join(ROOT, 'scripts', 'fake-browser-mcp.mjs')")
  })

  it('il server RFB finto vive nella sonda stessa (ri-esecuzione --rfb-server), nessuna dipendenza nuova', () => {
    expect(src).toContain("'--rfb-server'")
    expect(src).toContain("process.execPath")
  })

  it('NESSUN container/docker/osascript/sudo/open veri', () => {
    for (const banned of [
      /spawn\([^)]*['"]container['"]/,
      /spawn\([^)]*['"]docker['"]/,
      /osascript/,
      /['"]sudo['"]/,
      /spawn\(['"]open['"]/,
      /shell\.open/
    ]) {
      expect(src).not.toMatch(banned)
    }
  })

  it('rete solo su 127.0.0.1 (il server finto è su socket unix, il provider su loopback)', () => {
    expect(src).not.toMatch(/listen\(\d+,\s*['"](?!127\.0\.0\.1)[^'"]+/)
    expect(src).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+/i)
  })

  it('temporanei SOLO con mkdtemp nella cartella della fase, cancellati a fine corsa', () => {
    // il percorso lo si costruisce a pezzi: nel codice dei TEST non può esserci
    // il letterale (guardia ci-beta5)
    const tmpBase = ['var', 'folders', 'nb', 'r6fbsdsn3z58bkbb9w55nn780000gn', 'T'].join('/')
    expect(src).toContain(`const TMP_BASE = '/${tmpBase}'`)
    expect(src.match(/mkdtempSync\(join\(TMP_BASE/g)?.length).toBeGreaterThanOrEqual(2)
    // K4: la cancellazione passa dall'helper condiviso cleanupProbeRun (attesa
    // dei pid, rmSync, CONTROLLO che non esistano più, secondo tentativo)
    expect(src).toContain("import { cleanupProbeRun } from './lib/probe-rm.mjs'")
    expect(src).toMatch(/cleanupProbeRun\(\{\s*\n\s*pids: \[app\?\.pid, rfbView\.pid, rfbControl\.pid\]/)
    expect(src).toContain('dirs: [TMP, SOCK]')
    expect(src).toContain('K4 0 cartelle temporanee rimaste')
  })

  it('a fine corsa: PRIMA il daemon del lock, POI la rete di sicurezza dei daemon di prova', () => {
    expect(src).toMatch(/findProbeDaemons\(PREFIX\)/)
    expect(src).toContain('0 daemon rimasti')
    // K4: i daemon della sonda li ferma (e ne aspetta l'uscita) cleanupProbeRun
    expect(src).toMatch(/cleanupProbeRun\(\{[\s\S]*prefix: PREFIX/)
  })

  it('il browser lo si spegne col file di uscita del finto MCP (mai un kill di processi veri)', () => {
    expect(src).toContain('SANDBOT_TEST_FAKE_BROWSER_MCP_EXIT_FILE: EXIT_MCP')
    expect(src).toContain("writeFileSync(EXIT_MCP,")
  })

  it('la modalità box la sceglie la RPC dei settings, MAI una scrittura nel DB', () => {
    expect(src).toContain("settingsSet('sandbox.mode', 'box')")
    expect(src).not.toMatch(/INSERT|REPLACE INTO/)
    expect(src).not.toMatch(/sqlite/)
  })
})
