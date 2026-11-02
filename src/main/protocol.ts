// Protocollo homun:// (fase rilascio, A5 — adattato da homun2
// src-protocol.cjs.txt): la pagina è servita da un protocollo DELL'APP, non
// da file://. Registrato `standard` e `secure`, serve SOLO i file della
// cartella del renderer, con percorso normalizzato e controllato (niente ..,
// niente symlink fuori: realpath dentro la radice). L'engine proxy di Homun 2
// non c'è: il renderer parla col daemon via ws://127.0.0.1, che la CSP
// permette solo lì.
import { realpath, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/** Tipi MIME dei file che il renderer può effettivamente caricare. */
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.wasm': 'application/wasm'
}

/**
 * CSP dell'origine homun://app: 'self' è l'app stessa; connect-src apre
 * SOLO il WebSocket del daemon su 127.0.0.1 (chat, schermo, terminale);
 * gli worker di vega/mermaid arrivano da blob:.
 */
export const RENDERER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'"

export interface ProtocolFs {
  realpath(p: string): Promise<string>
  readFile(p: string): Promise<Buffer>
  stat(p: string): Promise<{ isFile(): boolean }>
}

const realFs: ProtocolFs = {
  realpath: (p) => realpath(p),
  readFile: (p) => readFile(p),
  stat: (p) => stat(p)
}

/**
 * Puro: il percorso richiesto, risolto DENTRO la radice del renderer.
 * Null quando il percorso esce dalla radice (.., assoluto, traversal dopo
 * la decodifica) — la risposta dev'essere 403.
 */
export function resolveRendererPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null // URI malformato (es. /%): 403, nessuna eccezione
  }
  if (decoded.includes('\0')) return null
  const candidate = path.resolve(root, '.' + decoded)
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null
  return candidate
}

/** L'handler del protocollo homun:// (solo host "app", solo GET di file). */
export function createRendererHandler(webRoot: string, fs: ProtocolFs = realFs) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.protocol !== 'homun:' || url.host !== 'app') {
      return new Response('Forbidden', { status: 403 })
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 })
    }
    try {
      const root = await fs.realpath(webRoot)
      let candidate = resolveRendererPath(root, url.pathname)
      if (candidate === null) {
        return new Response('Forbidden', { status: 403 })
      }
      if (candidate === root || !(await fs.stat(candidate).catch(() => null))?.isFile()) {
        if (path.extname(candidate)) return new Response('Not found', { status: 404 })
        candidate = path.join(root, 'index.html')
      }
      candidate = await fs.realpath(candidate)
      if (!candidate.startsWith(root + path.sep)) {
        return new Response('Forbidden', { status: 403 })
      }
      return new Response(new Uint8Array(await fs.readFile(candidate)), {
        headers: {
          'Content-Type': MIME_TYPES[path.extname(candidate)] ?? 'application/octet-stream',
          'Content-Security-Policy': RENDERER_CSP,
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
}
