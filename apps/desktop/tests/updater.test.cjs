const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup() {
  const updater = new EventEmitter();
  const dialogs = [],
    handlers = {},
    windows = [];
  let newer = true,
    failCheck = false,
    downloads = 0;
  updater.currentVersion = { version: "0.2.1001", compare: () => (newer ? -1 : 0) };
  updater.checkForUpdates = async () => {
    if (failCheck) throw new Error("offline");
    const updateInfo = { version: newer ? "0.2.1002" : "0.2.1001" };
    updater.emit(newer ? "update-available" : "update-not-available", updateInfo);
    return { updateInfo };
  };
  updater.downloadUpdate = async () => {
    downloads++;
  };
  const sandbox = {
    module: { exports: {} },
    process: { platform: "darwin", env: {} },
    console: { log() {}, error() {} },
    require: (id) => {
      if (id === "electron")
        return {
          app: { getVersion: () => "0.2.1001" },
          dialog: {
            showMessageBoxSync: (options) => {
              dialogs.push(options);
              return sandbox.choice;
            },
          },
          ipcMain: {
            handle: (key, fn) => {
              handlers[key] = fn;
            },
          },
          shell: { openExternal() {} },
        };
      if (id === "electron-updater") return { autoUpdater: updater };
      if (id === "./update-progress-window.cjs")
        return {
          createUpdateProgressWindow: () => {
            const window = {
              closed: false,
              close() {
                this.closed = true;
              },
              update() {},
            };
            windows.push(window);
            return window;
          },
        };
      throw new Error(`Unexpected import ${id}`);
    },
    choice: 2,
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, "../src/updater.cjs"), "utf8"), sandbox);
  sandbox.module.exports.registerUpdaterIpc();
  return {
    updater,
    dialogs,
    windows,
    handlers,
    sandbox,
    get downloads() {
      return downloads;
    },
    current: () => {
      newer = false;
    },
    offline: () => {
      failCheck = true;
    },
    init: () => sandbox.module.exports.initUpdater(),
  };
}

test("manual update check after automatic init offers exactly one dialog", async () => {
  const ctx = setup();
  ctx.init();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.dialogs.length, 1);
  ctx.dialogs.length = 0;
  const result = await ctx.handlers["homun:update-check"]();
  assert.equal(result.available, true);
  assert.equal(ctx.dialogs.length, 1);
});

test("manual check reports current version and offline error without offer", async () => {
  const ctx = setup();
  ctx.current();
  ctx.init();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await ctx.handlers["homun:update-check"]()).available, false);
  assert.equal(ctx.dialogs.length, 0);
  ctx.offline();
  assert.equal((await ctx.handlers["homun:update-check"]()).error, "offline");
  assert.equal(ctx.dialogs.length, 0);
});

test("manual check during download does not trigger a second download or duplicate status dialog", async () => {
  const ctx = setup();
  ctx.sandbox.choice = 0;
  ctx.init();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.downloads, 1);
  ctx.dialogs.length = 0;
  await ctx.handlers["homun:update-check"]();
  assert.equal(ctx.downloads, 1);
  assert.equal(ctx.dialogs.length, 1);
  assert.equal(ctx.dialogs[0].message, "Download già in corso");
});
