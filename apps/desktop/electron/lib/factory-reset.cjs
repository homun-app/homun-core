const fs = require("node:fs");
const path = require("node:path");

function assertHomunRoot(homunRoot) {
  const resolved = path.resolve(homunRoot);
  if (path.basename(resolved) !== ".homun" || resolved === path.parse(resolved).root) {
    throw new Error("factory reset root must resolve to an exact .homun directory");
  }
  return resolved;
}

function hostComputerStatePaths(homunRoot) {
  const root = assertHomunRoot(homunRoot);
  return [
    path.join(root, "host-computer"),
    path.join(root, "host-computer-grants.sqlite3"),
    path.join(root, "host-computer-grants.sqlite3-shm"),
    path.join(root, "host-computer-grants.sqlite3-wal"),
    path.join(root, "host-computer-journal.jsonl"),
    path.join(root, "host-computer-cache"),
    path.join(root, "runtime-settings.json"),
  ];
}

async function performFactoryReset({ homunRoot, stopManagedProcesses, clearStorage }) {
  const root = assertHomunRoot(homunRoot);
  await stopManagedProcesses();
  for (const ownedPath of hostComputerStatePaths(root)) {
    await fs.promises.rm(ownedPath, { recursive: true, force: true });
  }
  await fs.promises.rm(root, { recursive: true, force: true });
  await clearStorage();
}

module.exports = { assertHomunRoot, hostComputerStatePaths, performFactoryReset };
