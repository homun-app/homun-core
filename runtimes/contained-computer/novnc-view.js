// Minimal, chrome-free noVNC embed used by the in-app "Computer" panel.
// Kept external because the packaged Electron CSP deliberately blocks inline scripts.
import RFB from './core/rfb.js';

const params = new URLSearchParams(location.search);
// view_only defaults ON; pass view_only=0 to allow input (future interactive mode).
const viewOnly = !['0', 'false'].includes((params.get('view_only') ?? '1').toLowerCase());
const status = document.getElementById('status');

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
// WS path relative to where THIS page is served: works both directly on the
// container (host:6080/lfpa-view.html → /websockify) and proxied behind the
// gateway (/api/computer/novnc/lfpa-view.html → /api/computer/novnc/websockify).
// The ticket (present only when proxied) is forwarded so the proxy authorizes us.
const dir = location.pathname.replace(/[^/]*$/, '');
const ticket = params.get('ticket');
const url = `${proto}://${location.host}${dir}websockify`
  + (ticket ? `?ticket=${encodeURIComponent(ticket)}` : '');

let rfb = null;
function connect() {
  status.hidden = false;
  status.textContent = 'Connessione al computer…';
  rfb = new RFB(document.getElementById('screen'), url, { shared: true });
  // Scale the remote framebuffer to fit the container, preserve aspect ratio,
  // never clip; do not ask the server to resize its display.
  rfb.viewOnly = viewOnly;
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.background = '#0b0d12';
  rfb.addEventListener('connect', () => { status.hidden = true; });
  rfb.addEventListener('disconnect', () => {
    status.hidden = false;
    status.textContent = 'Riconnessione…';
    // x11vnc runs with -forever -shared, so reconnecting is safe.
    setTimeout(connect, 1200);
  });
}
connect();
