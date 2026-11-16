// SV8 (fase schermo-vivo) — show_images accetta anche i PATH dei file
// immagine nel COMPUTER DEL BOT (la sua home o /workspace): risolti con
// resolveBoxPath come gli altri strumenti dei file, letti con le funzioni di
// computer-files (in box DAL BOX, mai file del Mac), tipo controllato DAI
// BYTE, tetto per file come il download di CL3, al massimo 6 tra url e path,
// stessa galleria (saveShowImage). E browser_screenshot: il `ref` facoltativo
// arriva allo strumento di cattura e il result dice in coda come mostrare la
// foto all'utente.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// la sandbox è MOCKATA come nelle prove dei file: modalità host, boxRoot
// sulla temporanea del test (i path del MODELLO restano /box/home/... e
// /workspace/...: li risolve resolveBoxPath)
const h = vi.hoisted(() => ({ boxRoot: '' }))
vi.mock('../../sandbox', async (importOriginal) => {
  const orig = (await importOriginal<Record<string, unknown>>())
  return {
    ...orig,
    sandboxMode: () => 'host',
    boxRoot: () => h.boxRoot,
    boxOwnerOf: (id: string) => id,
    runDockerArgv: async () => ({ stdout: '', stderr: '', exitCode: 1, signal: null, trimmed: false })
  }
})

import { parseShowImagesInput, sniffImageMime } from '../show-images'
import { SHOW_IMAGE_MAX_BYTES } from '../../../shared/web-limits'
import { resolveBoxPath, readBoxBytesRel } from '../computer-files'
import { boxRoot as mockedBoxRoot, sandboxMode as mockedMode } from '../../sandbox'
import { TEST_TMP_BASE } from '../../../test-tmp'

// un PNG 1×1 VERO (stesso del test di show-images)
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
])

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-show-paths-'))

beforeAll(() => {
  h.boxRoot = join(TMP, 'box')
  mkdirSync(join(h.boxRoot, 'home', 'agent_p', '.browser', 'screens'), { recursive: true })
  mkdirSync(join(h.boxRoot, 'workspace'), { recursive: true })
  writeFileSync(join(h.boxRoot, 'home', 'agent_p', '.browser', 'screens', 'sc1.png'), PNG_1X1)
  writeFileSync(join(h.boxRoot, 'workspace', 'foto.png'), PNG_1X1)
  writeFileSync(join(h.boxRoot, 'home', 'agent_p', 'finto.png'), Buffer.from('<html>non è una png</html>'))
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('SV8: show_images — gli input con urls E paths', () => {
  it('urls E paths insieme vanno bene, e il TOTALE resta al massimo 6', () => {
    const seen = new Map([['https://sito.example/a.png', 'https://sito.example/a']])
    const ok = parseShowImagesInput({ urls: ['https://sito.example/a.png'], paths: ['/box/home/agent_p/foto.png'] }, seen)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.urls).toEqual(['https://sito.example/a.png'])
      expect(ok.paths).toEqual(['/box/home/agent_p/foto.png'])
    }
    const troppi = parseShowImagesInput({
      urls: ['https://sito.example/a.png'],
      paths: Array.from({ length: 6 }, (_v, i) => `/box/home/agent_p/p${i}.png`)
    }, seen)
    expect(troppi.ok).toBe(false)
    if (!troppi.ok) expect(troppi.error).toMatch(/at most 6/)
  })

  it('solo paths senza urls va bene; niente né urls né paths → rifiuto in parole', () => {
    const ok = parseShowImagesInput({ paths: ['/workspace/foto.png'] }, new Map())
    expect(ok.ok).toBe(true)
    const vuoto = parseShowImagesInput({}, new Map())
    expect(vuoto.ok).toBe(false)
  })
})

describe('SV8: resolveBoxPath — solo la home del bot o /workspace', () => {
  it('un path nella HOME del bot viene risolto (relativo alla radice dei file)', async () => {
    const r = await resolveBoxPath('agent_p', '/box/home/agent_p/.browser/screens/sc1.png')
    if (!r.ok) console.error('DBG resolve err:', r.error)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rel).toBe('home/agent_p/.browser/screens/sc1.png')
  })

  it('un path in /workspace viene risolto', async () => {
    const r = await resolveBoxPath('agent_p', '/workspace/foto.png')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rel).toBe('workspace/foto.png')
  })

  it('la home di UN ALTRO bot è FUORI', async () => {
    const r = await resolveBoxPath('agent_p', '/box/home/altro_bot/foto.png')
    expect(r.ok).toBe(false)
  })

  it('«../» che esce dalla radice è rifiutato', async () => {
    const r = await resolveBoxPath('agent_p', '/box/home/agent_p/../../etc/passwd.png')
    expect(r.ok).toBe(false)
  })

  it('un path ASSOLUTO del Mac è rifiutato in parole (mai file del Mac)', async () => {
    const r = await resolveBoxPath('agent_p', '/Users/fabio/Desktop/foto.png')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/bot's computer|Mac/i)
  })

  it('i path relativi non valgono (servono i path assoluti del computer del bot)', async () => {
    const r = await resolveBoxPath('agent_p', 'foto.png')
    expect(r.ok).toBe(false)
  })

  it('in HOST si legge DAL computer del bot (la radice box), non dal Mac', async () => {
    const r = await resolveBoxPath('agent_p', '/box/home/agent_p/.browser/screens/sc1.png')
    expect(r.ok).toBe(true)
    const bytes = await readBoxBytesRel('home/agent_p/.browser/screens/sc1.png')
    expect(bytes).not.toBeNull()
    expect(sniffImageMime(bytes!)).toBe('image/png')
    // un file del Mac NON passa da qui: la radice è la box del test
    const mac = await readBoxBytesRel('home/agent_p/inesistente.png')
    expect(mac).toBeNull()
  })
})

describe('SV8: il tipo vero si controlla DAI BYTE (e il tetto per file)', () => {
  it('un file .png che NON è una png viene rifiutato dai byte', async () => {
    const r = await resolveBoxPath('agent_p', '/box/home/agent_p/finto.png')
    expect(r.ok).toBe(true)
    const bytes = await readBoxBytesRel('home/agent_p/finto.png')
    expect(sniffImageMime(bytes!)).toBeNull()
  })

  it('il tetto per file è quello del download di CL3 (8 MB)', () => {
    expect(SHOW_IMAGE_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})
