# P0 Production Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere il P0 di [confronto-codex-produzione.md](../confronto-codex-produzione.md): single-instance lock, log persistenti con rotazione (shell + gateway), panic hook Rust, recovery SQLite corrotto, watchdog respawn del gateway, e "Segnala un problema" (archivio log locale, senza vendor).

**Architecture:** Lato Electron la logica nuova va in moduli testabili `electron/lib/*.cjs` (node:test, zero nuove dipendenze); `main.cjs` li cabla. Lato Rust due NUOVI moduli del crate gateway (`panic_log.rs`, `store_integrity.rs`) — mai aggiungere corpo a `main.rs` (metodologia §2: è oltre il limite hard), in main.rs vanno solo `mod` + le chiamate di wiring. Tutti i log convergono sotto `~/.homun/logs/` così il bundle feedback li raccoglie da una sola radice. Nessun dato utente (SQLite store) entra mai nel bundle (caposaldo #3).

**Tech Stack:** Electron 42 (main process CJS), node:test (built-in, Node ≥20), Rust 1.95 (`std::panic::PanicHookInfo`, `std::backtrace`), rusqlite 0.37 (già dep), serde_json (già dep), `tar` di sistema per l'archivio (bsdtar presente su macOS/Win10+/Linux).

**Vincoli di progetto (da METHODOLOGY.md e memoria):**
- Commit convenzionali con scope, stile del log esistente (`feat(desktop): …`). **NIENTE trailer Co-Authored-By.**
- Commenti nel codice in **inglese**, che spiegano il PERCHÉ.
- Ogni fix porta un test; gate: `cargo test -p local-first-desktop-gateway <mod>`, `npm run test:electron`, `npm run typecheck`, `npm run build`.
- IPC namespace esistente = `lfpa:*` (nome legacy intenzionale — NON rinominare).

---

## Fatti verificati (2026-07-02) su cui il piano si appoggia

- `apps/desktop/electron/main.cjs` (661 righe): `spawnGateway()` a r.245 usa `stdio: app.isPackaged ? "ignore" : "inherit"` (r.306); exit-handler r.318-323 logga solo su console; **nessun** `requestSingleInstanceLock`.
- `apps/desktop/electron/preload.cjs`: bridge `localFirstDesktop`, pattern `ipcRenderer.invoke("lfpa:…")`.
- Gateway `crates/desktop-gateway/src/main.rs`: `fn main` r.550; apre 7 store SQLite (r.577-612) dopo `migrate_legacy_data_dir()` (r.564); path helper `gateway_database_path()` ecc. a r.46020-46125, tutti derivati da `gateway_data_dir()`; `struct AppState` r.142; `HealthResponse` r.230-236; handler `health` r.1134-1141; moduli dichiarati a r.3-17 (`mod scaffold;` ecc.).
- Nessun `tracing`/`chrono` nel workspace; niente panic hook (`set_hook` assente ovunque).
- Test JS: solo `scripts/check-ui-contract.mjs`; nessuna dir `tests/` → si crea con `node --test`.
- SettingsView.tsx (6721 righe): card versione nella sezione `t("settings.aboutVersion")` (r.914-936, container `set-rows`/`set-trow`, bottoni `set-btn`, icone lucide già importate es. `RefreshCw`). Helper desktop in `src/lib/gatewayConfig.ts` (`getAppVersion` r.156, `IS_DESKTOP` r.61). i18n: `src/i18n/locales/{en,it}.json`, blocco `settings.*` (~r.956).
- Branch corrente `feat/piano-ui-completion` con modifiche non committate a `docs/STATO.md` + doc nuovi non tracciati.

---

### Task 0: Branch e commit dei doc di sessione

**Files:**
- Nessun file di codice; solo git.

- [ ] **Step 0.1: Crea il branch di lavoro dal HEAD corrente**

```bash
cd /Users/fabio/Projects/Homun/app
git checkout -b feat/p0-production-hygiene
```

- [ ] **Step 0.2: Committa i doc della sessione di analisi (già scritti)**

```bash
git add docs/confronto-codex-produzione.md docs/confronto-zcode-vs-homun.md docs/STATO.md docs/plans/2026-07-02-p0-production-hygiene.md
git commit -m "docs: Codex production benchmark + P0 hygiene plan"
```

Nota: `docs/decisions/0022-*.md` e `docs/piano-ui-fluidita-memoria.md` sono untracked di una linea di lavoro precedente — NON aggiungerli qui (non sono di questa sessione).

---

### Task 1: Modulo logging Electron (rotazione + writer + pipe child)

**Files:**
- Create: `apps/desktop/electron/lib/logging.cjs`
- Create: `apps/desktop/tests/logging.test.mjs`
- Modify: `apps/desktop/package.json` (script `test:electron`)

- [ ] **Step 1.1: Aggiungi lo script test**

In `apps/desktop/package.json`, dentro `scripts`, dopo la riga `"test:ui-contract": …`:

```json
    "test:electron": "node --test tests/",
```

- [ ] **Step 1.2: Scrivi i test (falliranno: modulo assente)**

Crea `apps/desktop/tests/logging.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rotateLogFile, createLogWriter } = require("../electron/lib/logging.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "homun-logtest-"));
}

test("rotateLogFile is a no-op when the file is under maxBytes", () => {
  const dir = tmpDir();
  const file = path.join(dir, "gateway.log");
  fs.writeFileSync(file, "small\n");
  const rotated = rotateLogFile(file, { maxBytes: 1024, keep: 3 });
  assert.equal(rotated, false);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.1`), false);
});

test("rotateLogFile shifts file to .1 when over maxBytes", () => {
  const dir = tmpDir();
  const file = path.join(dir, "gateway.log");
  fs.writeFileSync(file, "x".repeat(64));
  const rotated = rotateLogFile(file, { maxBytes: 10, keep: 3 });
  assert.equal(rotated, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(64));
});

test("rotateLogFile keeps at most `keep` generations, dropping the oldest", () => {
  const dir = tmpDir();
  const file = path.join(dir, "gateway.log");
  fs.writeFileSync(`${file}.1`, "gen1");
  fs.writeFileSync(`${file}.2`, "gen2");
  fs.writeFileSync(`${file}.3`, "gen3"); // keep=3 → this one must fall off
  fs.writeFileSync(file, "y".repeat(64));
  rotateLogFile(file, { maxBytes: 10, keep: 3 });
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "y".repeat(64));
  assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "gen1");
  assert.equal(fs.readFileSync(`${file}.3`, "utf8"), "gen2");
  assert.equal(fs.existsSync(`${file}.4`), false);
});

test("createLogWriter appends ISO-timestamped lines", async () => {
  const dir = tmpDir();
  const writer = createLogWriter(dir, "desktop.log");
  writer.log("hello world");
  await new Promise((resolve) => writer.stream.end(resolve));
  const content = fs.readFileSync(path.join(dir, "desktop.log"), "utf8");
  assert.match(content, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] hello world\n$/);
});

test("createLogWriter creates the directory when missing", async () => {
  const dir = path.join(tmpDir(), "nested", "logs");
  const writer = createLogWriter(dir, "desktop.log");
  writer.log("x");
  await new Promise((resolve) => writer.stream.end(resolve));
  assert.equal(fs.existsSync(path.join(dir, "desktop.log")), true);
});
```

- [ ] **Step 1.3: Verifica che i test falliscano**

Run: `cd apps/desktop && npm run test:electron`
Expected: FAIL — `Cannot find module '../electron/lib/logging.cjs'`

- [ ] **Step 1.4: Implementa il modulo**

Crea `apps/desktop/electron/lib/logging.cjs`:

```js
"use strict";
// Persistent shell/gateway logging. P0 of docs/confronto-codex-produzione.md:
// without a file trail, every packaged-app bug is unreproducible by design
// (main.cjs used to discard the gateway's stdio entirely).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 5;

// Single root for all diagnostics (shell log, gateway log, Rust panic log):
// the feedback bundle (Task 6) archives this one directory and nothing else.
function resolveLogsDir() {
  return path.join(os.homedir(), ".homun", "logs");
}

// Shift-rotation (file → file.1 → … → file.N, oldest dropped). Runs once per
// writer creation — i.e. per app/gateway start — NOT on every write, so one
// session's log always stays in one file and post-mortems don't straddle files.
function rotateLogFile(file, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // no current file → nothing to rotate
  }
  if (size < maxBytes) return false;
  for (let i = keep - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // generation missing — fine
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    return false;
  }
  return true;
}

function createLogWriter(dir, name, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  rotateLogFile(file, opts);
  const stream = fs.createWriteStream(file, { flags: "a" });
  // Swallow stream errors (disk full, permissions): logging must never be
  // the thing that crashes the shell.
  stream.on("error", () => {});
  const log = (line) => {
    stream.write(`[${new Date().toISOString()}] ${line}\n`);
  };
  return { file, stream, log };
}

// Line-buffer a child stdio stream into the writer so every line gets a
// timestamp and interleaved stdout/stderr stay greppable.
function pipeChildStream(stream, writer, label) {
  if (!stream) return;
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => writer.log(label ? `[${label}] ${line}` : line));
}

module.exports = {
  resolveLogsDir,
  rotateLogFile,
  createLogWriter,
  pipeChildStream,
  DEFAULT_MAX_BYTES,
  DEFAULT_KEEP,
};
```

- [ ] **Step 1.5: Verifica che i test passino**

Run: `cd apps/desktop && npm run test:electron`
Expected: PASS (5 test)

- [ ] **Step 1.6: Commit**

```bash
git add apps/desktop/electron/lib/logging.cjs apps/desktop/tests/logging.test.mjs apps/desktop/package.json
git commit -m "feat(desktop): rotating file logger for shell + gateway diagnostics (P0)"
```

---

### Task 2: Cabla il logging in main.cjs (desktop.log + cattura stdio gateway)

**Files:**
- Modify: `apps/desktop/electron/main.cjs`

- [ ] **Step 2.1: Importa il modulo e crea il writer di shell**

In `main.cjs`, dopo la riga 8 (`const { pathToFileURL } = require("node:url");`):

```js
const { createLogWriter, resolveLogsDir, pipeChildStream } = require("./lib/logging.cjs");

// Shell-side diagnostics (~/.homun/logs/desktop.log). Created eagerly so even
// a failure during startup leaves a trail.
const LOGS_DIR = resolveLogsDir();
const desktopLog = createLogWriter(LOGS_DIR, "desktop.log");
```

- [ ] **Step 2.2: Cattura lo stdio del gateway packaged su file**

In `spawnGateway()`, sostituisci il blocco (r.302-316 pre-modifica):

```js
  if (gatewayBin) {
    gatewayProcess = spawn(gatewayBin, [], {
      cwd: REPO_ROOT,
      env,
      stdio: app.isPackaged ? "ignore" : "inherit",
      windowsHide: true,
    });
  } else {
```

con:

```js
  if (gatewayBin) {
    // Packaged: capture the gateway's stdout/stderr into a rotating file —
    // "ignore" made every field bug unreproducible (no trail at all). Dev
    // keeps "inherit" so cargo/terminal output stays visible.
    const captureToFile = app.isPackaged || process.env.HOMUN_DESKTOP_RESOURCES_DIR;
    gatewayProcess = spawn(gatewayBin, [], {
      cwd: REPO_ROOT,
      env,
      stdio: captureToFile ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    if (captureToFile) {
      const gatewayLog = createLogWriter(LOGS_DIR, "gateway.log");
      pipeChildStream(gatewayProcess.stdout, gatewayLog);
      pipeChildStream(gatewayProcess.stderr, gatewayLog, "err");
      gatewayProcess.once("exit", () => gatewayLog.stream.end());
    }
  } else {
```

(La condizione `HOMUN_DESKTOP_RESOURCES_DIR` fa sì che anche `npm run package:smoke` eserciti il path di cattura — così è verificabile senza una build firmata.)

- [ ] **Step 2.3: Logga l'uscita inattesa anche su file**

Nell'exit-handler esistente, sostituisci:

```js
  gatewayProcess.on("exit", () => {
    gatewayProcess = null;
    if (!isQuitting) {
      console.error("Desktop gateway exited unexpectedly");
    }
  });
```

con:

```js
  gatewayProcess.on("exit", (code, signal) => {
    gatewayProcess = null;
    if (!isQuitting) {
      const line = `gateway exited unexpectedly (code=${code} signal=${signal})`;
      console.error(line);
      desktopLog.log(line);
    }
  });
```

(Il respawn arriva nel Task 4 — qui solo la traccia.)

- [ ] **Step 2.4: Verifica smoke**

Run:
```bash
cd apps/desktop && npm run typecheck && npm run test:ui-contract
rm -f ~/.homun/logs/gateway.log && npm run package:smoke
```
Expected: l'app si avvia; dopo la chiusura `~/.homun/logs/gateway.log` esiste e contiene la riga timestampata `local-first-desktop-gateway listening on http://…`. Verifica: `head -3 ~/.homun/logs/gateway.log`.

- [ ] **Step 2.5: Commit**

```bash
git add apps/desktop/electron/main.cjs
git commit -m "feat(desktop): persist gateway stdio + shell events to ~/.homun/logs (P0)"
```

---

### Task 3: Single-instance lock

**Files:**
- Modify: `apps/desktop/electron/main.cjs`

- [ ] **Step 3.1: Chiedi il lock prima di ogni init**

In `main.cjs`, subito dopo `app.setName("Homun");` (r.43 pre-modifica):

```js
// Two app instances would spawn two gateways racing on the same port and the
// same ~/.homun SQLite files — nondeterministic contention. First instance
// wins; a second launch just focuses the existing window.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0] ?? null;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
```

- [ ] **Step 3.2: Guarda il bootstrap dietro il lock**

Nel blocco `app.whenReady().then(async () => {` (r.631 pre-modifica), come PRIMA riga del callback:

```js
  if (!hasSingleInstanceLock) return; // quitting — don't spawn the gateway
```

- [ ] **Step 3.3: Verifica manuale**

Run (due terminali, o in sequenza):
```bash
cd apps/desktop && npm run package:smoke &
sleep 15 && HOMUN_DESKTOP_RESOURCES_DIR="$PWD/.package/resources" HOMUN_DESKTOP_GATEWAY_PORT=18766 HOMUN_DESKTOP_GATEWAY_URL=http://127.0.0.1:18766 npx electron electron/main.cjs
```
Expected: la seconda invocazione esce subito (nessuna seconda finestra); la prima finestra torna in primo piano. Chiudi la prima app al termine.

- [ ] **Step 3.4: Commit**

```bash
git add apps/desktop/electron/main.cjs
git commit -m "feat(desktop): single-instance lock — second launch focuses the window (P0)"
```

---

### Task 4: Watchdog respawn del gateway (policy pura + wiring)

**Files:**
- Create: `apps/desktop/electron/lib/watchdog.cjs`
- Create: `apps/desktop/tests/watchdog.test.mjs`
- Modify: `apps/desktop/electron/main.cjs`

> **Decisione aperta per Fabio (valori di policy):** i default proposti sono
> backoff `1s → 5s → 15s` e give-up dopo 3 respawn in 5 minuti. Sono il punto
> in cui si bilancia "l'app si ripara da sola" contro "un crash-loop che macina
> CPU in silenzio". Se preferisci soglie diverse, il posto è `DELAYS_MS` /
> `WINDOW_MS` in `watchdog.cjs` — il resto del design non cambia.

- [ ] **Step 4.1: Scrivi i test (falliranno)**

Crea `apps/desktop/tests/watchdog.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { nextRestartDelay, WINDOW_MS, DELAYS_MS } = require("../electron/lib/watchdog.cjs");

const NOW = 1_000_000_000;

test("first crash restarts quickly", () => {
  assert.equal(nextRestartDelay([], NOW), DELAYS_MS[0]);
});

test("delays escalate with each recent restart", () => {
  assert.equal(nextRestartDelay([NOW - 1000], NOW), DELAYS_MS[1]);
  assert.equal(nextRestartDelay([NOW - 2000, NOW - 1000], NOW), DELAYS_MS[2]);
});

test("gives up (null) after budget exhausted within the window", () => {
  const stamps = [NOW - 3000, NOW - 2000, NOW - 1000];
  assert.equal(nextRestartDelay(stamps, NOW), null);
});

test("old restarts outside the window don't count", () => {
  const stamps = [NOW - WINDOW_MS - 1, NOW - WINDOW_MS - 2, NOW - WINDOW_MS - 3];
  assert.equal(nextRestartDelay(stamps, NOW), DELAYS_MS[0]);
});
```

- [ ] **Step 4.2: Verifica che falliscano**

Run: `cd apps/desktop && npm run test:electron`
Expected: FAIL — `Cannot find module '../electron/lib/watchdog.cjs'`

- [ ] **Step 4.3: Implementa la policy**

Crea `apps/desktop/electron/lib/watchdog.cjs`:

```js
"use strict";
// Gateway restart policy. Pure on purpose: the caller passes the timestamps
// (ms) of previous respawns and "now"; we return how long to wait before the
// next respawn, or null when the crash-loop budget is exhausted and the shell
// must surface an error dialog instead of silently burning CPU.
const WINDOW_MS = 5 * 60 * 1000;
const DELAYS_MS = [1_000, 5_000, 15_000];

function nextRestartDelay(restartTimestamps, now) {
  const recent = restartTimestamps.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= DELAYS_MS.length) return null;
  return DELAYS_MS[recent.length];
}

module.exports = { nextRestartDelay, WINDOW_MS, DELAYS_MS };
```

- [ ] **Step 4.4: Verifica che passino**

Run: `cd apps/desktop && npm run test:electron`
Expected: PASS (9 test totali: 5 logging + 4 watchdog)

- [ ] **Step 4.5: Cabla il respawn in main.cjs**

Import (accanto a quello del logging, Step 2.1):

```js
const { nextRestartDelay } = require("./lib/watchdog.cjs");
```

Stato (accanto a `let gatewayProcess = null;`, r.20 pre-modifica):

```js
let gatewayRestarts = []; // timestamps of watchdog respawns (see lib/watchdog.cjs)
```

Sostituisci l'exit-handler del Task 2.3 con la versione completa:

```js
  gatewayProcess.on("exit", (code, signal) => {
    gatewayProcess = null;
    if (isQuitting) return;
    const line = `gateway exited unexpectedly (code=${code} signal=${signal})`;
    console.error(line);
    desktopLog.log(line);

    const delay = nextRestartDelay(gatewayRestarts, Date.now());
    if (delay === null) {
      desktopLog.log("gateway crash-loop: auto-restart budget exhausted, giving up");
      void dialog
        .showMessageBox({
          type: "error",
          title: "Homun",
          message: "Il motore di Homun continua ad arrestarsi.",
          detail: `I log diagnostici sono in ${LOGS_DIR}. Riavvia l'app; se il problema persiste, usa "Segnala un problema" nelle Impostazioni.`,
          buttons: ["Apri i log", "Chiudi"],
        })
        .then((r) => {
          if (r.response === 0) void shell.openPath(LOGS_DIR);
        });
      return;
    }
    gatewayRestarts.push(Date.now());
    desktopLog.log(`watchdog: respawning gateway in ${delay}ms`);
    setTimeout(() => {
      if (!isQuitting && !gatewayProcess) spawnGateway();
    }, delay);
  });
```

Nota il PERCHÉ del design: il token e la porta non cambiano al respawn (sono
costanti del processo shell), quindi il renderer riprende a funzionare da solo
appena l'health torna ok — nessun coordinamento extra.

- [ ] **Step 4.6: Verifica manuale del respawn**

Run: `cd apps/desktop && npm run package:smoke`, poi in un altro terminale:
```bash
pkill -f local-first-desktop-gateway
sleep 3 && curl -s http://127.0.0.1:18766/api/health | head -c 120
```
Expected: dopo ~1-2s il gateway è di nuovo su (`{"ok":true,…}`); `~/.homun/logs/desktop.log` contiene `gateway exited unexpectedly` + `watchdog: respawning gateway in 1000ms`.

- [ ] **Step 4.7: Commit**

```bash
git add apps/desktop/electron/lib/watchdog.cjs apps/desktop/tests/watchdog.test.mjs apps/desktop/electron/main.cjs
git commit -m "feat(desktop): gateway watchdog — bounded respawn with backoff + give-up dialog (P0)"
```

---

### Task 5: Panic hook Rust (backtrace su file + crash marker)

**Files:**
- Create: `crates/desktop-gateway/src/panic_log.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (riga `mod`, helper path, chiamata in `main()`)

- [ ] **Step 5.1: Scrivi il modulo con i test**

Crea `crates/desktop-gateway/src/panic_log.rs`:

```rust
//! Panic trail for the gateway process (P0, docs/confronto-codex-produzione.md).
//!
//! WHY: the gateway has no panic hook — a panic in a non-tokio thread (or an
//! abort-on-panic future) kills the process leaving zero trace once the shell
//! stops inheriting stdio. This hook appends the panic message + backtrace to
//! `~/.homun/logs/panic.log` and drops a `last-crash.json` marker the shell
//! (or a future startup notice) can read. It never panics itself and never
//! blocks: logging must not be the thing that takes the process down.

use std::backtrace::Backtrace;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Render one panic to a self-contained log entry. Kept pure for testability.
/// Timestamps are epoch seconds on purpose: no chrono dependency in the
/// workspace, and the shell-side logs already carry ISO timestamps.
fn render_panic_entry(info: &std::panic::PanicHookInfo<'_>, at_epoch_secs: u64) -> String {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_string());
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "<unknown location>".to_string());
    format!(
        "=== panic at epoch {at_epoch_secs} ===\nmessage: {message}\nlocation: {location}\nbacktrace:\n{}\n",
        Backtrace::force_capture()
    )
}

fn append_panic_log(logs_dir: &Path, entry: &str) {
    let _ = std::fs::create_dir_all(logs_dir);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("panic.log"))
    {
        let _ = file.write_all(entry.as_bytes());
    }
}

fn write_crash_marker(logs_dir: &Path, info: &std::panic::PanicHookInfo<'_>, at_epoch_secs: u64) {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_default();
    let marker = serde_json::json!({ "at": at_epoch_secs, "message": message });
    let _ = std::fs::write(
        logs_dir.join("last-crash.json"),
        serde_json::to_vec_pretty(&marker).unwrap_or_default(),
    );
}

/// Install the process-wide panic hook. Call once, first thing in `main()`.
pub fn install(logs_dir: PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let at = epoch_secs();
        let entry = render_panic_entry(info, at);
        // stderr first (visible in dev / captured by the shell's gateway.log),
        // file second (survives even if the pipe is gone).
        eprintln!("{entry}");
        append_panic_log(&logs_dir, &entry);
        write_crash_marker(&logs_dir, info, at);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "homun-panic-test-{tag}-{}-{}",
            std::process::id(),
            epoch_secs()
        ));
        std::fs::create_dir_all(&dir).expect("create tmp dir");
        dir
    }

    #[test]
    fn hook_writes_panic_log_and_marker() {
        let dir = unique_tmp_dir("hook");
        install(dir.clone());
        // Panic in a scoped thread: the hook runs, the test survives.
        let _ = std::thread::spawn(|| panic!("boom for panic_log test")).join();
        // Restore the default hook so other tests' intentional panics stay quiet.
        let _ = std::panic::take_hook();

        let log = std::fs::read_to_string(dir.join("panic.log")).expect("panic.log written");
        assert!(log.contains("boom for panic_log test"));
        assert!(log.contains("location:"));
        assert!(log.contains("backtrace:"));

        let marker = std::fs::read_to_string(dir.join("last-crash.json")).expect("marker written");
        assert!(marker.contains("boom for panic_log test"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 5.2: Registra il modulo e verifica che il test giri**

In `main.rs`, tra le righe `mod` esistenti (r.3-17), in ordine alfabetico:

```rust
mod panic_log;
```

Run: `cargo test -p local-first-desktop-gateway panic_log`
Expected: PASS (1 test). (Il test è auto-contenuto: installa il hook, panica in un thread, ripristina.)

- [ ] **Step 5.3: Helper per la dir dei log + chiamata in main()**

In `main.rs`, accanto agli altri path helper (dopo `gateway_capability_database_path`, ~r.46125):

```rust
/// Diagnostic logs directory (panic trail, crash marker). Lives beside the
/// SQLite stores so the desktop shell bundles diagnostics from one root.
fn gateway_logs_dir() -> Result<PathBuf, std::io::Error> {
    let base = gateway_data_dir()?.join("logs");
    fs::create_dir_all(&base)?;
    Ok(base)
}
```

In `fn main()` (r.550), come PRIMA istruzione del corpo (prima del blocco umask — il hook deve coprire anche i panics dell'init):

```rust
    // P0 observability: leave a trail for every panic, even when the shell
    // isn't capturing stdio. Fall back to the OS temp dir if HOME is unusable.
    panic_log::install(gateway_logs_dir().unwrap_or_else(|_| std::env::temp_dir()));
```

- [ ] **Step 5.4: Build + gate**

Run: `cargo build -p local-first-desktop-gateway && cargo test -p local-first-desktop-gateway panic_log`
Expected: build ok, test PASS.

- [ ] **Step 5.5: Commit**

```bash
git add crates/desktop-gateway/src/panic_log.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): panic hook — backtrace to ~/.homun/logs/panic.log + crash marker (P0)"
```

---

### Task 6: Integrità SQLite all'avvio (quick_check + quarantena) + health

**Files:**
- Create: `crates/desktop-gateway/src/store_integrity.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (riga `mod`, wiring in `main()`, campo `AppState` r.142, `HealthResponse` r.230, handler `health` r.1134)

- [ ] **Step 6.1: Scrivi il modulo con i test**

Crea `crates/desktop-gateway/src/store_integrity.rs`:

```rust
//! Startup integrity sweep for the personal SQLite stores (P0,
//! docs/confronto-codex-produzione.md §2).
//!
//! WHY: a corrupt store (power loss, disk error) is fatal AND silent today —
//! the open fails, the gateway dies, the user sees a broken app with no story.
//! Same philosophy as the browser CDP-wedge self-heal: detect → quarantine →
//! start fresh → tell the user. We NEVER delete: the corrupt file is renamed
//! to `<name>.corrupt-<epoch>.bak` (with its WAL/SHM) so data rescue stays
//! possible.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};

/// One store to verify: a short stable name (surfaced in /api/health) + path.
pub struct StoreCheck {
    pub name: &'static str,
    pub path: PathBuf,
}

/// PRAGMA quick_check outcome. Missing file = healthy (fresh install).
fn is_healthy(path: &Path) -> bool {
    if !path.exists() {
        return true;
    }
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    conn.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))
        .map(|verdict| verdict == "ok")
        .unwrap_or(false)
}

fn quarantine(path: &Path) {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Move WAL/SHM alongside the main file: a fresh DB must not inherit them.
    for suffix in ["", "-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{suffix}", path.display()));
        if source.exists() {
            let target = PathBuf::from(format!("{}{suffix}.corrupt-{epoch}.bak", path.display()));
            let _ = std::fs::rename(&source, &target);
        }
    }
}

/// Verify every store; quarantine the corrupt ones. Returns the names of the
/// stores that were reset, for /api/health (the UI can tell the user which
/// data area restarted fresh and where the backup lives).
pub fn ensure_store_integrity(stores: &[StoreCheck]) -> Vec<String> {
    let mut recovered = Vec::new();
    for store in stores {
        if is_healthy(&store.path) {
            continue;
        }
        eprintln!(
            "[store-integrity] {} failed quick_check → quarantined to *.corrupt-*.bak (fresh store will be created): {}",
            store.name,
            store.path.display()
        );
        quarantine(&store.path);
        recovered.push(store.name.to_string());
    }
    recovered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "homun-integrity-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create tmp dir");
        dir
    }

    #[test]
    fn healthy_store_is_untouched() {
        let dir = unique_tmp_dir("healthy");
        let db = dir.join("ok.sqlite");
        let conn = Connection::open(&db).expect("create db");
        conn.execute("CREATE TABLE t (id INTEGER)", []).expect("ddl");
        drop(conn);

        let recovered = ensure_store_integrity(&[StoreCheck { name: "ok", path: db.clone() }]);
        assert!(recovered.is_empty());
        assert!(db.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_store_is_quarantined_and_reported() {
        let dir = unique_tmp_dir("corrupt");
        let db = dir.join("broken.sqlite");
        // Bigger than a valid empty DB and NOT starting with the SQLite magic.
        std::fs::write(&db, vec![0x42; 8192]).expect("write garbage");

        let recovered = ensure_store_integrity(&[StoreCheck { name: "broken", path: db.clone() }]);
        assert_eq!(recovered, vec!["broken".to_string()]);
        assert!(!db.exists(), "corrupt file must be moved away");
        let bak_exists = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(bak_exists, "quarantined backup must exist");
        // A fresh open on the original path now works.
        Connection::open(&db).expect("fresh store opens");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_store_is_healthy() {
        let dir = unique_tmp_dir("missing");
        let db = dir.join("never-created.sqlite");
        let recovered = ensure_store_integrity(&[StoreCheck { name: "missing", path: db }]);
        assert!(recovered.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 6.2: Registra il modulo e verifica i test**

In `main.rs`, righe `mod` (ordine alfabetico):

```rust
mod store_integrity;
```

Run: `cargo test -p local-first-desktop-gateway store_integrity`
Expected: PASS (3 test)

- [ ] **Step 6.3: Cabla lo sweep in main() prima dell'apertura degli store**

In `fn main()`, DOPO `migrate_legacy_data_dir();` (r.564) e PRIMA del blocco `let port = …`:

```rust
    // P0 resilience: verify every personal store BEFORE anything opens it; a
    // corrupt file is quarantined (never deleted) and the fresh open below
    // succeeds. Surfaced to the UI via /api/health `recovered_stores`.
    let recovered_stores: std::sync::Arc<Vec<String>> = std::sync::Arc::new(
        store_integrity::ensure_store_integrity(&[
            store_integrity::StoreCheck { name: "desktop-gateway", path: gateway_database_path()? },
            store_integrity::StoreCheck { name: "task-runtime", path: gateway_task_database_path()? },
            store_integrity::StoreCheck { name: "local-computer-session", path: gateway_local_computer_database_path()? },
            store_integrity::StoreCheck { name: "browser-url-policy", path: gateway_browser_policy_database_path()? },
            store_integrity::StoreCheck { name: "memory", path: gateway_memory_database_path()? },
            store_integrity::StoreCheck { name: "vault", path: gateway_vault_database_path()? },
            store_integrity::StoreCheck { name: "capability-registry", path: gateway_capability_database_path()? },
        ]),
    );
```

- [ ] **Step 6.4: Esponi l'esito in AppState + /api/health**

In `struct AppState` (r.142), aggiungi il campo (in coda alla struct):

```rust
    /// Stores quarantined by the startup integrity sweep (empty = all healthy).
    recovered_stores: std::sync::Arc<Vec<String>>,
```

Nel letterale `AppState { … }` in `main()` (r.577-612), aggiungi in coda:

```rust
        recovered_stores: recovered_stores.clone(),
```

In `HealthResponse` (r.230-236) aggiungi:

```rust
    /// Names of stores reset at startup after failing quick_check (backups kept
    /// as *.corrupt-<epoch>.bak beside the store). Empty on a healthy boot.
    recovered_stores: Vec<String>,
```

Nel handler `health` (r.1134-1141):

```rust
        recovered_stores: state.recovered_stores.as_ref().clone(),
```

Nota: cerca eventuali ALTRI costruttori di `AppState` nei test del gateway
(`grep -n "AppState {" crates/desktop-gateway/src/main.rs | head -30`) e aggiungi
`recovered_stores: std::sync::Arc::new(Vec::new()),` a ciascuno, altrimenti il
crate non compila.

- [ ] **Step 6.5: Gate completo del crate**

Run: `cargo test -p local-first-desktop-gateway`
Expected: tutti verdi tranne l'eventuale fallimento ambientale noto (`import_pptx_template_pack…` richiede soffice — pre-esistente, non di questo task).

- [ ] **Step 6.6: Commit**

```bash
git add crates/desktop-gateway/src/store_integrity.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): SQLite integrity sweep at boot — quarantine corrupt stores, report in /api/health (P0)"
```

---

### Task 7: "Segnala un problema" — bundle log locale (main + preload + UI + i18n)

**Files:**
- Modify: `apps/desktop/electron/main.cjs` (nuovo handler IPC)
- Modify: `apps/desktop/electron/preload.cjs`
- Modify: `apps/desktop/src/lib/gatewayConfig.ts`
- Modify: `apps/desktop/src/components/SettingsView.tsx` (sezione `settings.aboutVersion`, r.914-936)
- Modify: `apps/desktop/src/i18n/locales/en.json`, `apps/desktop/src/i18n/locales/it.json` (blocco `settings.*`, ~r.956)

- [ ] **Step 7.1: Handler IPC in main.cjs**

Dopo il handler `lfpa:capture-page` (r.438-513 pre-modifica):

```js
// "Report a problem": builds a LOCAL archive of the diagnostics the user can
// attach to a bug report. Privacy by design (caposaldo #3): ONLY ~/.homun/logs
// + a small report.json (versions/specs) — NEVER the SQLite stores (memory,
// chats, vault). Works with the gateway down — that's exactly when it's needed.
ipcMain.handle("lfpa:feedback-bundle", async () => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "homun-feedback-"));
    const payload = path.join(staging, `homun-feedback-${stamp}`);
    fs.mkdirSync(payload, { recursive: true });
    if (fs.existsSync(LOGS_DIR)) {
      fs.cpSync(LOGS_DIR, path.join(payload, "logs"), { recursive: true });
    }
    const report = {
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      totalMemGb: Math.round(os.totalmem() / 1e9),
      cpuCount: os.cpus().length,
    };
    fs.writeFileSync(path.join(payload, "report.json"), JSON.stringify(report, null, 2));

    const outDir = path.join(os.homedir(), ".homun", "feedback");
    fs.mkdirSync(outDir, { recursive: true });
    const archive = path.join(outDir, `homun-feedback-${stamp}.tar.gz`);
    // System tar: bsdtar on macOS/Windows 10+, GNU tar on Linux — no new dep.
    const tar = spawnSync("tar", ["-czf", archive, "-C", staging, path.basename(payload)], {
      encoding: "utf8",
    });
    let result;
    if (tar.status === 0) {
      result = { ok: true, path: archive };
    } else {
      // No tar on PATH (rare): ship the uncompressed folder instead.
      const fallback = path.join(outDir, path.basename(payload));
      fs.cpSync(payload, fallback, { recursive: true });
      result = { ok: true, path: fallback, uncompressed: true };
    }
    fs.rmSync(staging, { recursive: true, force: true });
    desktopLog.log(`feedback bundle created at ${result.path}`);
    shell.showItemInFolder(result.path);
    return result;
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
});
```

- [ ] **Step 7.2: Esponi nel preload**

In `preload.cjs`, dopo `systemSpecs` (r.30):

```js
  // "Report a problem": builds a local tar.gz of ~/.homun/logs + a report.json
  // (versions/specs) and reveals it. Logs only — never memory/chat stores.
  createFeedbackBundle: () => ipcRenderer.invoke("lfpa:feedback-bundle"),
```

- [ ] **Step 7.3: Helper renderer**

In `src/lib/gatewayConfig.ts`, accanto a `getAppVersion` (r.156), rispecchiandone il pattern (stesso `desktopConfig` + try/catch → null). Aggiorna anche il type della finestra desktop se il file lo dichiara (grep `pickFolder` nel file per trovare la dichiarazione):

```ts
export async function createFeedbackBundle(): Promise<
  { ok: boolean; path?: string; uncompressed?: boolean; error?: string } | null
> {
  const bridge = desktopConfig as
    | { createFeedbackBundle?: () => Promise<{ ok: boolean; path?: string; uncompressed?: boolean; error?: string }> }
    | null;
  if (!bridge?.createFeedbackBundle) return null;
  try {
    return await bridge.createFeedbackBundle();
  } catch {
    return null;
  }
}
```

- [ ] **Step 7.4: Riga UI in Settings (sezione "Informazioni e versione")**

In `SettingsView.tsx`: importa `createFeedbackBundle` accanto agli altri import da `../lib/gatewayConfig`, importa `LifeBuoy` accanto alle altre icone lucide, e nel componente della version card aggiungi lo stato + handler:

```tsx
  const [bundling, setBundling] = useState(false);
  const [bundlePath, setBundlePath] = useState<string | null>(null);

  const makeBundle = async () => {
    setBundling(true);
    setBundlePath(null);
    try {
      const r = await createFeedbackBundle();
      if (r?.ok && r.path) setBundlePath(r.path);
    } finally {
      setBundling(false);
    }
  };
```

Poi, come ULTIMO figlio del container `set-rows` della sezione `t("settings.aboutVersion")` (il div che si apre a r.915), aggiungi la riga:

```tsx
        <div className="set-trow">
          <div>
            <div className="tt">{t("settings.feedbackTitle")}</div>
            <div className="td">
              {bundlePath
                ? t("settings.feedbackDone", { path: bundlePath })
                : t("settings.feedbackHint")}
            </div>
          </div>
          <button
            type="button"
            className="set-btn"
            onClick={() => void makeBundle()}
            disabled={bundling}
          >
            <LifeBuoy size={14} />
            <span style={{ marginLeft: 6 }}>
              {bundling ? t("settings.feedbackBuilding") : t("settings.feedbackButton")}
            </span>
          </button>
        </div>
```

- [ ] **Step 7.5: Chiavi i18n**

In `it.json`, nel blocco `settings` (accanto ad `aboutVersion`, r.956):

```json
    "feedbackTitle": "Segnala un problema",
    "feedbackHint": "Crea un archivio con i log tecnici (nessun dato di memoria o chat) da allegare alla segnalazione.",
    "feedbackButton": "Crea archivio log",
    "feedbackBuilding": "Creo l'archivio…",
    "feedbackDone": "Archivio creato: {{path}}",
```

In `en.json`, stessa posizione:

```json
    "feedbackTitle": "Report a problem",
    "feedbackHint": "Creates an archive with the technical logs (no memory or chat data) to attach to your report.",
    "feedbackButton": "Create log archive",
    "feedbackBuilding": "Building archive…",
    "feedbackDone": "Archive created: {{path}}",
```

- [ ] **Step 7.6: Gate + verifica visiva**

Run:
```bash
cd apps/desktop && npm run typecheck && npm run test:ui-contract && npm run test:electron
npm run package:smoke
```
Expected: typecheck/test verdi; nell'app Settings → "Informazioni e versione" mostra la riga "Segnala un problema"; il click crea `~/.homun/feedback/homun-feedback-*.tar.gz`, lo rivela nel Finder e la UI mostra il path. Verifica contenuto: `tar -tzf ~/.homun/feedback/homun-feedback-*.tar.gz` → SOLO `logs/…` e `report.json` (MAI file `.sqlite`).

- [ ] **Step 7.7: Commit**

```bash
git add apps/desktop/electron/main.cjs apps/desktop/electron/preload.cjs apps/desktop/src/lib/gatewayConfig.ts apps/desktop/src/components/SettingsView.tsx apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/it.json
git commit -m "feat(desktop): Report a problem — local log archive bundle, privacy-safe (P0)"
```

---

### Task 8: Documentazione + gate finale

**Files:**
- Create: `docs/architecture/desktop-shell.md`
- Modify: `docs/STATO.md` (voce di sessione)
- Modify: `docs/confronto-codex-produzione.md` (spunta P0)
- Modify: `.github/workflows/ci.yml` (aggiungi `npm run test:electron` accanto al typecheck esistente del job desktop)

- [ ] **Step 8.1: Pagina architecture del shell desktop**

Crea `docs/architecture/desktop-shell.md` con: responsabilità del main process (spawn gateway + PATH reconstruction, single-instance, watchdog con policy `lib/watchdog.cjs`, logging `lib/logging.cjs` → `~/.homun/logs/{desktop,gateway}.log` con rotazione 5×5MB, panic trail lato Rust `panic_log.rs` → `panic.log` + `last-crash.json`, integrity sweep `store_integrity.rs` → `recovered_stores` in `/api/health`, feedback bundle → `~/.homun/feedback/`), un diagramma Mermaid del ciclo spawn→exit→respawn→give-up, e il riferimento al caposaldo #3 (il bundle non contiene MAI store SQLite). Cita [confronto-codex-produzione.md](../confronto-codex-produzione.md) come origine.

- [ ] **Step 8.2: Spunta il P0 nel doc di confronto + voce STATO**

In `docs/confronto-codex-produzione.md`, sezione "Piano d'azione": marca 1-4 come fatti (`✅ fatto 2026-07-0X, vedi docs/architecture/desktop-shell.md`). In `docs/STATO.md`, aggiungi la voce di sessione (rolling) con i commit.

- [ ] **Step 8.3: CI**

In `.github/workflows/ci.yml`, nel job che esegue typecheck/build del desktop, aggiungi lo step `npm run test:electron` (stessa working-directory del typecheck). Verifica prima la struttura reale: `grep -n "typecheck\|working-directory" .github/workflows/ci.yml`.

- [ ] **Step 8.4: Gate finale completo**

```bash
cd apps/desktop && npm run typecheck && npm run build && npm run test:electron && npm run test:ui-contract
cd ../.. && cargo test -p local-first-desktop-gateway
```
Expected: tutto verde (salvo il fallimento ambientale soffice noto).

- [ ] **Step 8.5: Commit finale**

```bash
git add docs/architecture/desktop-shell.md docs/STATO.md docs/confronto-codex-produzione.md .github/workflows/ci.yml
git commit -m "docs(desktop): shell architecture page + P0 checked off; run electron tests in CI"
```

---

## Fuori scope (esplicito)

- Sandbox OS-level dell'esecuzione shell (P1.5) — si progetta con la separazione motore/gateway.
- Firma Windows/Linux (P1.6) — richiede certificati, non codice.
- Crash reporting verso vendor (Sentry) — decisione di prodotto opt-in, non in P0.
- Migrazione del gateway a `tracing` — ha senso solo col motore separato; oggi la cattura stdio è il punto di leva minimo.
