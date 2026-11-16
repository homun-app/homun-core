// Fase chat-limiti (CL3): mostrare in chat le foto di una pagina. Lo strumento
// show_images accetta SOLO url di immagini visti in un web_fetch DELLO STESSO
// turno; il download ha le guardie di web_fetch (checkUrl, IP privati, redirect
// controllati, timeout, resolvedIpsAllowed) più content-type immagine, byte
// magici e tetto di 8 MB. In chat le immagini si servono da homun://, MAI
// dall'URL remoto. Nessuna rete reale: il loopback dei test passa SOLO dal
// flag SANDBOT_WEB_FETCH_ALLOW_LOOPBACK=1, come web_fetch.
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { TEST_TMP_BASE } from '../../../test-tmp'
import type { HttpTransport } from '../web-tools'
import {
  parseShowImagesInput, downloadShowImage, saveShowImage, imageUrlsInMarkdown, sniffImageMime
} from '../show-images'
import { homunMediaUrl, galleryCardRows } from '../../../shared/chat-images'
import { toolDefs } from '../tools'
import { toolsForTurnSource } from '../connectors-policy'
import { subagentToolDenyReason } from '../subagents'
import { assembleTurnTools } from '../turn-tools'
import { externalContentSection } from '../prompts'

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-show-images-test-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

/** PNG 1×1 valido, scritto a mano (nessun download). */
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
])

describe('CL3 (puro): gli url delle immagini nel testo di web_fetch', () => {
  it('imageUrlsInMarkdown estrare gli url assoluti delle immagini', () => {
    const text = [
      '## [Titolo](https://annunci.example.it/a.htm)',
      '![prima](https://annunci.example.it/foto/1.jpg)',
      'testo',
      '![seconda](https://annunci.example.it/foto/2.png)',
      '[N more images]'
    ].join('\n')
    expect(imageUrlsInMarkdown(text)).toEqual([
      'https://annunci.example.it/foto/1.jpg',
      'https://annunci.example.it/foto/2.png'
    ])
  })

  it('sniffImageMime riconosce png, jpeg, gif e webp dai BYTE (non dall\'header)', () => {
    expect(sniffImageMime(PNG_1X1)).toBe('image/png')
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.from('GIF89a resti del file'))).toBe('image/gif')
    expect(sniffImageMime(Buffer.from('RIFF0004WEBPVP8 resti'))).toBe('image/webp')
    expect(sniffImageMime(Buffer.from('<html><body>non un\'immagine</body></html>'))).toBeNull()
    expect(sniffImageMime(Buffer.from([0x00, 0x01, 0x02]))).toBeNull()
  })
})

describe('CL3 (puro): parseShowImagesInput — solo url visti nel turno', () => {
  const seen = new Map([
    ['https://annunci.example.it/foto/1.jpg', 'https://annunci.example.it/lista'],
    ['https://annunci.example.it/foto/2.png', 'https://annunci.example.it/lista']
  ])

  it('url visti nel turno → ok (con caption)', () => {
    const r = parseShowImagesInput(
      { urls: ['https://annunci.example.it/foto/1.jpg', 'https://annunci.example.it/foto/2.png'], caption: 'Le due V7' },
      seen
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.urls).toHaveLength(2)
      expect(r.caption).toBe('Le due V7')
    }
  })

  it('url NON visto (inventato o di un altro turno) → errore in PAROLE, niente rete', () => {
    const r = parseShowImagesInput({ urls: ['https://malevolo.example.it/foto.jpg'] }, seen)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('web_fetch')
      expect(r.error).toContain('malevolo.example.it')
    }
  })

  it('più di 6 url per chiamata → errore; urls non array o vuoto → errore', () => {
    const many = Array.from({ length: 7 }, (_, i) => `https://annunci.example.it/foto/${i}.jpg`)
    const seen7 = new Map(many.map((u) => [u, 'https://annunci.example.it/lista']))
    expect(parseShowImagesInput({ urls: many }, seen7).ok).toBe(false)
    expect(parseShowImagesInput({ urls: [] }, seen).ok).toBe(false)
    expect(parseShowImagesInput({}, seen).ok).toBe(false)
    expect(parseShowImagesInput({ urls: 'no' }, seen).ok).toBe(false)
  })
})

describe('CL3: downloadShowImage — le guardie di web_fetch (nessuna rete reale)', () => {
  /** trasporto FINTO: la lookup VALIDANTE decide, poi si connette (come i test di web_fetch). */
  const fakeTransport = (respond: (url: URL) => { status: number; body?: Buffer; headers?: Record<string, string> }) => {
    const connections: string[] = []
    const transport: HttpTransport = async (url, opts) => {
      await new Promise<void>((resolve, reject) => {
        opts.lookup(url.hostname, { all: true }, (err) => { if (err) reject(err); else resolve() })
      })
      connections.push(url.hostname)
      const r = respond(url)
      return { status: r.status, headers: r.headers ?? {}, body: r.body ?? Buffer.from(''), truncated: false }
    }
    return { transport, connections }
  }

  it('IP privato o loopback SENZA flag → rifiutato PRIMA della rete (transport mai chiamato)', async () => {
    const saved = process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    try {
      const f = fakeTransport(() => ({ status: 200, body: PNG_1X1, headers: { 'content-type': 'image/png' } }))
      const r = await downloadShowImage('http://10.0.0.5/foto.jpg', {
        transport: f.transport,
        lookup: async () => ['10.0.0.5']
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('internal')
      expect(f.connections).toHaveLength(0) // NESSUNA richiesta di rete
    } finally {
      if (saved !== undefined) process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = saved
    }
  })

  it('content-type image/png ma byte HTML → SCARTATO (i byte magici contano, non l\'header)', async () => {
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = '1'
    try {
      const f = fakeTransport(() => ({
        status: 200,
        body: Buffer.from('<html><body>fake image</body></html>'),
        headers: { 'content-type': 'image/png' }
      }))
      const r = await downloadShowImage('http://127.0.0.1:9/foto.png', { transport: f.transport, lookup: async () => ['127.0.0.1'] })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('not an image')
    } finally {
      delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    }
  })

  it('un file oltre 8 MB → SCARTATO', async () => {
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = '1'
    try {
      const huge = Buffer.concat([PNG_1X1, Buffer.alloc(8 * 1024 * 1024 + 1)])
      const f = fakeTransport(() => ({ status: 200, body: huge, headers: { 'content-type': 'image/png' } }))
      const r = await downloadShowImage('http://127.0.0.1:9/grande.png', { transport: f.transport, lookup: async () => ['127.0.0.1'] })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('8 MB')
    } finally {
      delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    }
  })

  it('HTTP ≥ 400 → scartato; content-type non immagine → scartato', async () => {
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = '1'
    try {
      const f404 = fakeTransport(() => ({ status: 404, body: Buffer.from('nope'), headers: { 'content-type': 'text/html' } }))
      const r404 = await downloadShowImage('http://127.0.0.1:9/x.png', { transport: f404.transport, lookup: async () => ['127.0.0.1'] })
      expect(r404.ok).toBe(false)
      const fTxt = fakeTransport(() => ({ status: 200, body: Buffer.from('solo testo'), headers: { 'content-type': 'text/plain' } }))
      const rTxt = await downloadShowImage('http://127.0.0.1:9/x.png', { transport: fTxt.transport, lookup: async () => ['127.0.0.1'] })
      expect(rTxt.ok).toBe(false)
    } finally {
      delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    }
  })

  it('un REDIRECT verso un host privato è rifiutato (il redirect si ricontrolla da capo)', async () => {
    const saved = process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    try {
      // primo hop: nome che risolve a un IP PUBBLICO (transport finto, mai rete);
      // la risposta è un 302 verso un IP privato
      const f = fakeTransport(() => ({ status: 302, headers: { location: 'http://10.0.0.9/foto.png' } }))
      const r = await downloadShowImage('https://cdn.example.it/foto.png', {
        transport: f.transport,
        lookup: async () => ['93.184.216.34']
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('redirect not allowed')
      expect(f.connections).toEqual(['cdn.example.it']) // UN solo hop: il secondo non parte
    } finally {
      if (saved !== undefined) process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = saved
    }
  })
})

describe('CL3: il download dal server di prova su 127.0.0.1 (flag di test)', () => {
  let url = ''
  const server = createServer((req, res) => {
    if (req.url === '/foto/v7.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG_1X1.length) })
      res.end(PNG_1X1)
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://10.0.0.9/foto.png' })
      res.end()
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('nope')
    }
  })
  beforeAll(async () => {
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = '1'
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('url visto nel turno → scaricato, verificato e salvato col nome dall\'hash', async () => {
    const dl = await downloadShowImage(`${url}/foto/v7.png`, { lookup: async () => ['127.0.0.1'] })
    expect(dl.ok).toBe(true)
    if (dl.ok) {
      expect(dl.mime).toBe('image/png')
      expect(dl.file).toMatch(/^[a-f0-9]{64}\.png$/)
      const saved = await saveShowImage(TMP, dl)
      expect(existsSync(saved.path)).toBe(true)
      expect(readFileSync(saved.path).length).toBe(PNG_1X1.length)
      // lo SHA-256 del nome è il sha-256 del contenuto
      const { createHash } = await import('node:crypto')
      expect(dl.file).toBe(`${createHash('sha256').update(PNG_1X1).digest('hex')}.png`)
    }
  })
})

describe('CL3: la galleria in chat usa homun://, MAI un src http(s)', () => {
  const images = [
    { file: `${'a'.repeat(64)}.png`, domain: 'annunci.example.it', pageUrl: 'https://annunci.example.it/lista', mime: 'image/png' },
    { file: `${'b'.repeat(64)}.jpg`, domain: 'foto.example.org', pageUrl: 'https://foto.example.org/pagina', mime: 'image/jpeg' }
  ]

  it('homunMediaUrl: nome hash valido → homun://app/media/…; nome strano → null', () => {
    expect(homunMediaUrl(`${'a'.repeat(64)}.png`)).toBe(`homun://app/media/${'a'.repeat(64)}.png`)
    expect(homunMediaUrl('../main/index.js')).toBeNull()
    expect(homunMediaUrl('foto.jpg')).toBeNull()
    expect(homunMediaUrl(`${'a'.repeat(64)}.html`)).toBeNull()
    expect(homunMediaUrl(`${'A'.repeat(64)}.png`)).toBeNull() // non esadecimale
  })

  it('galleryCardRows: OGNI src è homun:// e NESSUN http(s) passa al DOM', () => {
    const rows = galleryCardRows(images)
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.src.startsWith('homun://app/media/')).toBe(true)
      expect(/^https?:/.test(r.src)).toBe(false)
      expect(r.domain).toBeTruthy()
      expect(r.pageUrl).toMatch(/^https?:\/\//)
    }
  })
})

describe('CL3: show_images sta nel turno del bot normale, non nel figlio né nei gruppi', () => {
  it('il turno normale offre show_images nel NUCLEO, dopo web_fetch', () => {
    const builtins = toolsForTurnSource(toolDefs, { source: 'user' })
    const r = assembleTurnTools({ builtins, browserAvailable: false, browserDefs: [], mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [] })
    const names = r.tools.map((t) => t.name)
    expect(names).toContain('show_images')
    expect(names.indexOf('show_images')).toBeGreaterThan(names.indexOf('web_fetch'))
  })

  it('il FIGLIO non lo ha (non parla con l\'utente) e il turno di GRUPPO non lo ha', () => {
    const child = toolDefs.filter((t) => subagentToolDenyReason(t.name) === null)
    expect(child.some((t) => t.name === 'show_images')).toBe(false)
    const group = toolsForTurnSource(toolDefs, { source: 'group', groupTurn: {} })
    expect(group.some((t) => t.name === 'show_images')).toBe(false)
  })
})

describe('CL3: il prompt dice di usare show_images per le foto', () => {
  it('la sezione dei contenuti esterni contiene la regola, parola per parola', () => {
    const section = externalContentSection()
    expect(section).toContain(
      'When the user asks to SEE photos or images and a web_fetch result of this turn contains image urls, show them with show_images: never say you cannot show them if the urls are there.'
    )
  })
})
