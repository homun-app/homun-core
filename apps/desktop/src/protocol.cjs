/** Fixed-origin static renderer and restricted streaming engine proxy. */
const { realpath, readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'";
function createProtocolHandler({ webRoot, engine }) {
  return async request => {
    const url = new URL(request.url);
    if (url.protocol !== 'homun:' || url.host !== 'app') return new Response('Forbidden', { status: 403 });
    if (url.pathname.startsWith('/engine/v1/')) {
      if (!['GET', 'POST', 'DELETE'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const headers = new Headers({ Authorization: `Bearer ${engine.token}` });
      for (const name of ['accept', 'content-type', 'x-homun-actor-id', 'x-homun-actor-name', 'x-homun-command-id']) {
        const value = request.headers.get(name); if (value) headers.set(name, value);
      }
      try {
        const upstream = await fetch(engine.baseUrl + url.pathname.slice('/engine'.length) + url.search, {
          method: request.method, headers, redirect: 'error', signal: request.signal,
          ...(request.method === 'GET' ? {} : { body: request.body, duplex: 'half' }),
        });
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.set('Cache-Control', 'no-store');
        return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
      } catch {
        return Response.json({ detail: { code: 'engine_unavailable', message: 'The desktop engine is unavailable' } }, { status: 503 });
      }
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    try {
      const root = await realpath(webRoot);
      let candidate = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (candidate !== root && !candidate.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      if (candidate === root || !(await stat(candidate).catch(() => null))?.isFile()) {
        if (path.extname(candidate)) return new Response('Not found', { status: 404 });
        candidate = path.join(root, 'index.html');
      }
      candidate = await realpath(candidate);
      if (!candidate.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      return new Response(await readFile(candidate), { headers: {
        'Content-Type': types[path.extname(candidate)] || 'application/octet-stream',
        'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response('Not found', { status: 404 }); }
  };
}
module.exports = { createProtocolHandler };
