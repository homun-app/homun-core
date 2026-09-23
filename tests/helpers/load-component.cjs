// Load a TSX orchestration component without mounting its child panels.
// Its real JSX props/callbacks are inspected; children are boundary stubs.
const ts = require("typescript");
const vm = require("node:vm");
const fs = require("node:fs");
function loadComponent(path, overrides = {}, source) {
  const components = new Map();
  const exports = {};
  const transpiled = ts.transpileModule(source ?? fs.readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: path,
  }).outputText;
  const requireBoundary = (id) => {
    if (id === "react/jsx-runtime") return require(id);
    return new Proxy(
      {},
      {
        get(_target, name) {
          if (name in overrides) return overrides[name];
          if (!components.has(name)) components.set(name, function Boundary() {});
          return components.get(name);
        },
      },
    );
  };
  vm.runInNewContext(transpiled, { exports, require: requireBoundary, Error }, { filename: path });
  return { exports, components };
}
module.exports = { loadComponent };
