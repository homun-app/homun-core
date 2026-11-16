// Fase rilascio (A5): le protezioni di Electron, nella parte PURA.
// - l'handler del protocollo homun:// risolve i percorsi DENTRO la cartella
//   del renderer: .., percorsi assoluti e byte nulli sono rifiutati;
// - un URL esterno si apre solo se http/https/mailto (mai file:, javascript:,
//   schemi dell'app);
// - lo schema dei permessi: tutto negato salvo la copia negli appunti.
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRendererPath, resolveMediaPath, createRendererHandler, realFs, RENDERER_CSP, MIME_TYPES } from '../protocol'
import { canOpenExternally } from '../external-url'
import { permissionAllowed } from '../permissions'
import { TEST_TMP_BASE } from '../../test-tmp'

const ROOT = '/out/renderer'

describe('fase chat-limiti (CL3): /media/ serve le immagini della chat, e SOLO quelle', () => {
  const MEDIA = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-media-test-'))
  afterAll(() => rmSync(MEDIA, { recursive: true, force: true }))

  it('resolveMediaPath: solo <sha256>.<png|jpe?g|gif|webp>; tutto il resto è rifiutato', () => {
    const hash = 'a'.repeat(64)
    expect(resolveMediaPath('/media/dir', `/media/${hash}.png`)).toBe(join('/media/dir', `${hash}.png`))
    expect(resolveMediaPath('/media/dir', `/media/${hash}.webp`)).toBe(join('/media/dir', `${hash}.webp`))
    expect(resolveMediaPath('/media/dir', `/media/${hash}.html`)).toBeNull()
    expect(resolveMediaPath('/media/dir', `/media/${'A'.repeat(64)}.png`)).toBeNull() // non esadecimale
    expect(resolveMediaPath('/media/dir', `/media/../../etc/passwd`)).toBeNull()
    expect(resolveMediaPath('/media/dir', `/media/${hash}.png/x`)).toBeNull()
    expect(resolveMediaPath('/media/dir', '/media/foto.png')).toBeNull()
    expect(resolveMediaPath('/media/dir', '/index.html')).toBeNull()
  })

  it('l\'handler serve il file con content-type immagine e la CSP; nomi fuori forma → 403', async () => {
    const hash = 'b'.repeat(64)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFileSync(join(MEDIA, `${hash}.png`), png)
    const handler = createRendererHandler('/out/renderer', realFs, { dir: MEDIA })
    const ok = await handler(new Request(`homun://app/media/${hash}.png`))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(ok.headers.get('content-security-policy')).toBe(RENDERER_CSP)
    expect(Buffer.from(await ok.arrayBuffer()).equals(png)).toBe(true)
    const bad = await handler(new Request(`homun://app/media/${'c'.repeat(64)}.html`))
    expect(bad.status).toBe(403)
    const missing = await handler(new Request(`homun://app/media/${'d'.repeat(64)}.png`))
    expect([403, 404]).toContain(missing.status)
  })
})

describe('fase rilascio (A5): percorsi del protocollo homun://', () => {
  it('i file del renderer si risolvono dentro la radice', () => {
    expect(resolveRendererPath(ROOT, '/')).toBe(ROOT)
    expect(resolveRendererPath(ROOT, '/index.html')).toBe(`${ROOT}/index.html`)
    expect(resolveRendererPath(ROOT, '/assets/app-B1n2.js')).toBe(`${ROOT}/assets/app-B1n2.js`)
    expect(resolveRendererPath(ROOT, '/%69ndex.html')).toBe(`${ROOT}/index.html`) // percent-encoded
  })

  it('.. e compagnia sono rifiutati (403)', () => {
    expect(resolveRendererPath(ROOT, '/../main/index.js')).toBeNull()
    expect(resolveRendererPath(ROOT, '/assets/../../secrets')).toBeNull()
    expect(resolveRendererPath(ROOT, '/..%2f..%2fx')).toBeNull() // traversal decodificato
    expect(resolveRendererPath(ROOT, '/%2e%2e/%2e%2e/x')).toBeNull()
  })

  it('input malformati non lanciano eccezioni', () => {
    expect(resolveRendererPath(ROOT, '/%E0%A4%A')).toBeNull() // URI rotto
    expect(resolveRendererPath(ROOT, '/a\0b')).toBeNull() // byte nullo
  })

  it('la CSP permette il ws SOLO su 127.0.0.1', () => {
    expect(RENDERER_CSP).toContain('ws://127.0.0.1:*')
    expect(RENDERER_CSP).not.toMatch(/connect-src[^;]*ws:(?!\/\/127\.0\.0\.1)/)
    expect(RENDERER_CSP).toContain("default-src 'self'")
    expect(RENDERER_CSP).toContain("frame-src 'none'")
    expect(RENDERER_CSP).toContain("object-src 'none'")
  })

  it('i tipi MIME coprono ciò che il renderer carica davvero', () => {
    expect(MIME_TYPES['.html']).toBe('text/html')
    expect(MIME_TYPES['.js']).toBe('text/javascript')
    expect(MIME_TYPES['.wasm']).toBe('application/wasm')
    expect(MIME_TYPES['.woff2']).toBe('font/woff2')
  })
})

describe('fase rilascio (A5): URL esterni apribili nel browser', () => {
  it('http, https e mailto si aprono', () => {
    expect(canOpenExternally('https://github.com/homun-app/homun-releases')).toBe(true)
    expect(canOpenExternally('http://example.com/x')).toBe(true)
    expect(canOpenExternally('mailto:fabio@example.com')).toBe(true)
  })

  it('file:, javascript:, schemi dell\'app e robe strane MAI', () => {
    expect(canOpenExternally('file:///etc/passwd')).toBe(false)
    expect(canOpenExternally('javascript:alert(1)')).toBe(false)
    expect(canOpenExternally('sandbot://agent/1')).toBe(false)
    expect(canOpenExternally('homun://app/')).toBe(false)
    expect(canOpenExternally('data:text/html,<script>1</script>')).toBe(false)
    expect(canOpenExternally('niente')).toBe(false)
  })
})

describe('fase rilascio (A5): schema dei permessi', () => {
  it('tutto negato salvo la scrittura degli appunti', () => {
    expect(permissionAllowed('clipboard-sanitized-write')).toBe(true)
    expect(permissionAllowed('clipboard-write')).toBe(true)
    expect(permissionAllowed('clipboard-read')).toBe(false)
    expect(permissionAllowed('media')).toBe(false) // microfono/camera: nessuna funzione li usa
    expect(permissionAllowed('notifications')).toBe(false)
    expect(permissionAllowed('geolocation')).toBe(false)
    expect(permissionAllowed('unknown')).toBe(false)
  })
})
