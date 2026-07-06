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
// the feedback bundle archives this one directory and nothing else.
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
  const file = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    rotateLogFile(file, opts);
    const stream = fs.createWriteStream(file, { flags: "a" });
    // Swallow stream errors (disk full, permissions): logging must never be
    // the thing that crashes the shell.
    stream.on("error", () => {});
    const log = (line) => {
      stream.write(`[${new Date().toISOString()}] ${line}\n`);
    };
    return { file, stream, log };
  } catch {
    // Setup failed (read-only home, ~/.homun exists as a file, …). Degrade to
    // an inert writer with the same contract: logging must never be the thing
    // that crashes the shell.
    return { file, stream: { end: (cb) => { if (cb) cb(); }, on: () => {} }, log: () => {} };
  }
}

// Line-buffer a child stdio stream into the writer so every line gets a
// timestamp and interleaved stdout/stderr stay greppable.
function pipeChildStream(stream, writer, label) {
  if (!stream) return;
  const rl = readline.createInterface({ input: stream });
  // Child stdio pipes error on abnormal termination (ECONNRESET/EPIPE) —
  // readline re-emits those on the Interface; diagnostics must never crash the shell.
  rl.on("error", () => {});
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
