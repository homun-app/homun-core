#!/usr/bin/env python3
"""Rendered QA for Homun decks.

Runs Chromium headless against the rendered HTML and inspects real layout metrics
through the DevTools Protocol. This is intentionally dependency-free: the
contained computer already has Chromium and Python, and the gateway can run this
after `deck-render` without installing Playwright.
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request


def _read_http(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read().decode("utf-8")


def _ws_connect(ws_url):
    parsed = urllib.parse.urlparse(ws_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 80
    path = parsed.path
    if parsed.query:
        path += "?" + parsed.query
    sock = socket.create_connection((host, port), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(request.encode("ascii"))
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response += chunk
    if b" 101 " not in response.split(b"\r\n", 1)[0]:
        raise RuntimeError(f"websocket handshake failed: {response[:160]!r}")
    return sock


def _ws_send(sock, payload):
    data = payload.encode("utf-8")
    header = bytearray([0x81])
    length = len(data)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", length))
    mask = os.urandom(4)
    header.extend(mask)
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
    sock.sendall(header + masked)


def _recv_exact(sock, size):
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise RuntimeError("websocket closed")
        chunks.extend(chunk)
    return bytes(chunks)


def _ws_recv(sock):
    first, second = _recv_exact(sock, 2)
    opcode = first & 0x0F
    masked = second & 0x80
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(sock, 8))[0]
    mask = _recv_exact(sock, 4) if masked else b""
    payload = bytearray(_recv_exact(sock, length))
    if masked:
        payload = bytearray(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    if opcode == 8:
        raise RuntimeError("websocket closed by peer")
    if opcode not in (1, 2):
        return _ws_recv(sock)
    return payload.decode("utf-8")


def _cdp_call(sock, method, params=None, msg_id=1):
    _ws_send(sock, json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    deadline = time.time() + 10
    while time.time() < deadline:
        message = json.loads(_ws_recv(sock))
        if message.get("id") == msg_id:
            if "error" in message:
                raise RuntimeError(message["error"])
            return message.get("result", {})
    raise RuntimeError(f"timeout waiting for {method}")


QA_JS = r"""
(() => {
  const issues = [];
  // Deck slides are a fixed canvas (overflow = real defect); documents flow
  // vertically across printed A4 pages, so their container is `.doc .block`
  // and vertical overflow is normal pagination, not a bug.
  const containerSelector = MODE === 'document' ? '.doc .block' : '.slide';
  const unitLabel = MODE === 'document' ? 'block' : 'slide';
  const containers = Array.from(document.querySelectorAll(containerSelector));
  const px = n => Math.round(Number(n || 0));
  const parseRgb = (value) => {
    const match = String(value || '').match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(',').map(part => Number(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some(part => Number.isNaN(part))) return null;
    const alpha = parts.length >= 4 && !Number.isNaN(parts[3]) ? parts[3] : 1;
    return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
  };
  const luminance = (rgb) => {
    const channel = (value) => {
      const normalized = Math.max(0, Math.min(255, value)) / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  };
  const contrastRatio = (fg, bg) => {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const effectiveBackground = (node) => {
    let current = node;
    while (current && current !== document.documentElement) {
      const bg = parseRgb(getComputedStyle(current).backgroundColor);
      if (bg && bg.a > 0.05) return bg;
      current = current.parentElement;
    }
    return parseRgb(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  const label = (el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    const text = (el.innerText || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 72);
    return text ? `${tag} "${text}"` : tag;
  };
  // Document mode: only the whole-column horizontal overflow is a defect
  // (the .doc column has a fixed width; anything wider than it is clipped/
  // truncated in the printed PDF). Vertical growth just means more pages.
  if (MODE === 'document') {
    const doc = document.querySelector('.doc');
    if (doc && doc.scrollWidth > doc.clientWidth + 1) {
      issues.push({
        severity: 'error',
        code: 'doc_horizontal_overflow',
        message: `document overflows horizontally (${doc.scrollWidth} > ${doc.clientWidth})`
      });
    }
  }
  containers.forEach((container, index) => {
    const unitNo = index + 1;
    const cr = container.getBoundingClientRect();
    // Fixed-canvas checks (overflow / out-of-bounds) only make sense for decks;
    // a document block is free to grow vertically across page breaks.
    if (MODE === 'deck') {
      // scrollWidth/scrollHeight measure the UNCLIPPED content box, so they count
      // decorative accent layers that bleed past the slide on purpose — e.g.
      // `.hero-art { right:-4vw; width:44vw }` under `.slide{overflow:hidden}`,
      // which is clipped visually but still adds ~51px of phantom scrollWidth at a
      // 1280px canvas. That is a full-bleed design choice, not a defect, and would
      // false-flag every cover/section using hero_art. Neutralize decorative
      // layers (class `hero-art`, or any `pointer-events:none` overlay) before
      // measuring, then restore them, so only genuine content overflow trips the
      // check. `element_outside_slide` below already ignores these (it scans a
      // content selector list), so this keeps the two checks consistent.
      const decorative = Array.from(container.querySelectorAll('*')).filter((el) => {
        if (el.classList && el.classList.contains('hero-art')) return true;
        return getComputedStyle(el).pointerEvents === 'none';
      });
      const restore = decorative.map((el) => [el, el.style.display]);
      decorative.forEach((el) => { el.style.display = 'none'; });
      const scrollW = container.scrollWidth;   // reading forces a synchronous reflow
      const scrollH = container.scrollHeight;
      const clientW = container.clientWidth;
      const clientH = container.clientHeight;
      restore.forEach(([el, prev]) => { el.style.display = prev; });
      if (scrollW > clientW + 2 || scrollH > clientH + 2) {
        issues.push({
          severity: 'error',
          code: 'slide_overflow',
          message: `slide ${unitNo} overflows (${scrollW}x${scrollH} > ${clientW}x${clientH})`
        });
      }
    }
    const nodes = Array.from(container.querySelectorAll('h1,h2,h3,li,p,blockquote,.kpi,.sub,.col,img'));
    nodes.forEach((node) => {
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (MODE === 'deck') {
        const outside =
          r.left < cr.left - 2 ||
          r.top < cr.top - 2 ||
          r.right > cr.right + 2 ||
          r.bottom > cr.bottom + 2;
        if (outside) {
          issues.push({
            severity: 'error',
            code: 'element_outside_slide',
            message: `slide ${unitNo}: ${label(node)} outside slide bounds`
          });
        }
      }
      if (node.tagName && node.tagName.toLowerCase() === 'img') {
        if (!node.complete || node.naturalWidth === 0 || node.naturalHeight === 0) {
          issues.push({
            severity: 'error',
            code: 'image_not_loaded',
            message: `${unitLabel} ${unitNo}: image failed to load`
          });
        }
        return;
      }
      const text = (node.innerText || '').trim();
      if (text) {
        const style = getComputedStyle(node);
        const fontSize = Number.parseFloat(style.fontSize || '0');
        const fontWeight = Number.parseInt(style.fontWeight || '400', 10);
        if (fontSize > 0 && fontSize < 12) {
          issues.push({
            severity: 'error',
            code: 'text_too_small',
            message: `${unitLabel} ${unitNo}: ${label(node)} font-size ${fontSize.toFixed(1)}px is below 12px`
          });
        }
        const fg = parseRgb(style.color);
        const bg = effectiveBackground(node);
        if (fg && bg) {
          const ratio = contrastRatio(fg, bg);
          const minRatio = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700) ? 3.0 : 4.5;
          if (ratio < minRatio) {
            issues.push({
              severity: 'error',
              code: 'low_contrast',
              message: `${unitLabel} ${unitNo}: ${label(node)} contrast ratio ${ratio.toFixed(2)} is below ${minRatio.toFixed(1)}`
            });
          }
        }
      }
    });
  });
  return {
    ok: issues.filter(issue => issue.severity === 'error').length === 0,
    slide_count: containers.length,
    viewport: { width: px(window.innerWidth), height: px(window.innerHeight) },
    issues
  };
})()
"""


def build_qa_js(mode):
    """Inject MODE as a plain JS constant prepended to QA_JS.

    NOT a .format()/%-format over the whole script: QA_JS is full of JS object
    / template-literal braces that would need double-escaping and silently
    break (same anti-graffe lesson as design_tokens/doc_render CSS). A simple
    string-concat prefix sidesteps that entirely.
    """
    return "const MODE = %r;\n" % mode + QA_JS


def run_qa(path, chromium="chromium", mode="deck"):
    abs_path = os.path.abspath(path)
    if not os.path.isfile(abs_path):
        raise RuntimeError(f"HTML file not found: {path}")
    url = "file://" + urllib.parse.quote(abs_path)
    proc = subprocess.Popen(
        [
            chromium,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--remote-debugging-port=0",
            "--window-size=1280,720",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        browser_ws = None
        deadline = time.time() + 10
        while time.time() < deadline:
            line = proc.stderr.readline()
            if "DevTools listening on " in line:
                browser_ws = line.strip().split("DevTools listening on ", 1)[1]
                break
            if proc.poll() is not None:
                raise RuntimeError("chromium exited before DevTools became available")
        if not browser_ws:
            raise RuntimeError("chromium did not expose DevTools")
        parsed = urllib.parse.urlparse(browser_ws)
        base = f"http://{parsed.hostname}:{parsed.port}"
        page_ws = None
        for _ in range(40):
            pages = json.loads(_read_http(base + "/json/list"))
            for page in pages:
                if page.get("type") == "page":
                    page_ws = page.get("webSocketDebuggerUrl")
                    break
            if page_ws:
                break
            time.sleep(0.1)
        if not page_ws:
            raise RuntimeError("no Chromium page target found")
        sock = _ws_connect(page_ws)
        try:
            _cdp_call(sock, "Runtime.enable", msg_id=1)
            _cdp_call(sock, "Page.enable", msg_id=2)
            time.sleep(0.4)
            result = _cdp_call(
                sock,
                "Runtime.evaluate",
                {"expression": build_qa_js(mode), "returnByValue": True, "awaitPromise": True},
                msg_id=3,
            )
        finally:
            sock.close()
        value = result.get("result", {}).get("value")
        if not isinstance(value, dict):
            raise RuntimeError(f"unexpected QA result: {result}")
        return value
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
        # Close the stderr pipe explicitly: the CLI path exits and the OS reaps it,
        # but callers that invoke run_qa in-process (e.g. tests) would otherwise
        # leak the fd until GC and emit a ResourceWarning.
        if proc.stderr:
            proc.stderr.close()


def main():
    parser = argparse.ArgumentParser(description="Run rendered QA on a Homun deck or document HTML file.")
    parser.add_argument("html", nargs="?", help="deck.html / doc.html path")
    parser.add_argument("--json", action="store_true", help="print JSON result")
    parser.add_argument("--chromium", default=os.environ.get("CHROMIUM", "chromium"))
    parser.add_argument("--mode", choices=["deck", "document"], default="deck",
                         help="deck = .slide canvas checks; document = .doc .block, vertical overflow allowed")
    parser.add_argument("--self-test", action="store_true", help="verify built-in QA checks")
    args = parser.parse_args()

    if args.self_test:
        required_codes = [
            "slide_overflow", "element_outside_slide", "image_not_loaded",
            "low_contrast", "text_too_small", "doc_horizontal_overflow",
        ]
        missing = [code for code in required_codes if code not in QA_JS]
        # Mode-injection marker: build_qa_js must prepend a real JS constant
        # (not a template-formatted QA_JS) and QA_JS must actually branch on it —
        # otherwise --mode document would silently run deck-only checks.
        for probe_mode in ("deck", "document"):
            js = build_qa_js(probe_mode)
            if not js.startswith("const MODE = ") or repr(probe_mode) not in js.splitlines()[0]:
                missing.append(f"mode-injection marker missing for mode={probe_mode}")
        if "MODE ===" not in QA_JS:
            missing.append("QA_JS does not branch on MODE")
        if missing:
            print(json.dumps({"ok": False, "missing": missing}, ensure_ascii=False))
            return 2
        print(json.dumps({"ok": True, "codes": required_codes}, ensure_ascii=False))
        return 0

    if not args.html:
        parser.error("the following arguments are required: html")

    try:
        result = run_qa(args.html, args.chromium, args.mode)
    except Exception as exc:
        result = {"ok": False, "slide_count": 0, "issues": [{
            "severity": "error",
            "code": "qa_runtime_error",
            "message": str(exc),
        }]}
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        status = "PASS" if result.get("ok") else "FAIL"
        print(f"deck QA {status}: {result.get('slide_count', 0)} slides")
        for issue in result.get("issues", []):
            print(f"- {issue.get('severity', 'error')}: {issue.get('code')}: {issue.get('message')}")
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
