// Fase rilascio (A5): le protezioni di Electron, nella parte PURA.
// - l'handler del protocollo homun:// risolve i percorsi DENTRO la cartella
//   del renderer: .., percorsi assoluti e byte nulli sono rifiutati;
// - un URL esterno si apre solo se http/https/mailto (mai file:, javascript:,
//   schemi dell'app);
// - lo schema dei permessi: tutto negato salvo la copia negli appunti.
import { describe, expect, it } from 'vitest'
import { resolveRendererPath, RENDERER_CSP, MIME_TYPES } from '../protocol'
import { canOpenExternally } from '../external-url'
import { permissionAllowed } from '../permissions'

const ROOT = '/out/renderer'

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
