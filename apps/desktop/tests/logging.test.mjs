import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rotateLogFile, createLogWriter, pipeChildStream } = require("../electron/lib/logging.cjs");

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

test("pipeChildStream splits lines and prefixes the label", async () => {
  const dir = tmpDir();
  const writer = createLogWriter(dir, "gateway.log");
  const child = new PassThrough();
  pipeChildStream(child, writer, "err");
  child.write("first line\nsecond line\n");
  child.end();
  // Readline flushes its last buffered line while handling the stream's "end"
  // (its listener is attached before ours), so both log writes precede this.
  await once(child, "end");
  await new Promise((resolve) => writer.stream.end(resolve));
  const lines = fs.readFileSync(path.join(dir, "gateway.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[err\] first line$/);
  assert.match(lines[1], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[err\] second line$/);
});

test("pipeChildStream is a no-op for a null stream", () => {
  const dir = tmpDir();
  const writer = createLogWriter(dir, "gateway.log");
  assert.doesNotThrow(() => pipeChildStream(null, writer, "err"));
});

test("pipeChildStream swallows stream errors instead of crashing", async () => {
  const dir = tmpDir();
  const writer = createLogWriter(dir, "gateway.log");
  const child = new PassThrough();
  pipeChildStream(child, writer, "err");
  child.write("before error\n");
  // Let readline consume the line before the pipe dies mid-session.
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("error", new Error("ECONNRESET"));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => writer.stream.end(resolve));
  // Surviving to this point without an uncaught exception is the real
  // assertion; the content check confirms pre-error lines were kept.
  const content = fs.readFileSync(path.join(dir, "gateway.log"), "utf8");
  assert.match(content, /\[err\] before error\n/);
});
