# Flag runtime `HOMUN_*` (as-built)

Default verificati 2026-08-03. Lista **non** esaustiva di ogni stringa env nel
monolite — solo quelli con semantica booleana/path chiara. Per il resto: `rg HOMUN_`.

## Bind / dati

| Flag | Default |
| --- | --- |
| `HOMUN_DESKTOP_GATEWAY_HOST` | `127.0.0.1` |
| `HOMUN_DESKTOP_GATEWAY_PORT` / `PORT` | `18765` |
| `HOMUN_DATA_DIR` | `$HOME/.homun` |
| `HOMUN_MEMORY_DB` | `{data}/memory.sqlite` |
| `HOMUN_DESKTOP_GATEWAY_TOKEN` | da env o file persistito |

## Memoria / esecuzione

| Flag | Default |
| --- | --- |
| `HOMUN_MEMORY_SERVICE` | **ON** (`0`/`off`/`false` opt-out) |
| `HOMUN_MEMORY_POOL` | **ON** |
| `HOMUN_MEMORY_POOL_READERS` | `3` |
| `HOMUN_TASK_EXECUTOR_WORKER` | **ON** |
| `HOMUN_TASK_WORKER_COUNT` | `3` (clamp 1..=16) |
| `HOMUN_SANDBOX_MODE` | vince sull’env; parse fallback `WorkspaceWrite` (`ReadOnly` \| `WorkspaceWrite` \| `Danger`) |

`HOMUN_TOOL_SAFETY` **non esiste** più.

## Loop / piano

| Flag | Default |
| --- | --- |
| `HOMUN_TURN_TRACE` | **ON** (`0`/`off` spegne) |
| `HOMUN_VERIFY_STEPS` | **ON** |
| `HOMUN_PLAN_RECONCILE` | **ON** |
| `HOMUN_PLAN_AUTOADVANCE` | **ON** (stesso pattern opt-out) |
| `HOMUN_PLAN_STALL_ABORT` | **OFF** |
| `HOMUN_BRAIN_MATERIALIZE` | **ON** |
| `HOMUN_SEMANTIC_ROUTER` | **ON** |
| `HOMUN_STREAM_LEGACY_MARKER_DELTAS` | **OFF** |
| `HOMUN_DEBUG` | **OFF** (presenza = on) |

## Browser / computer

| Flag | Default |
| --- | --- |
| `HOMUN_BROWSER_HEADLESS` | `"1"` |
| `HOMUN_BROWSER_AUTOMATION_DIR` | `runtimes/browser-automation` |
| `HOMUN_CONTAINED_COMPUTER` | **OFF** (`1`/`true` → CDP `127.0.0.1:9222`) |
| `HOMUN_HOST_COMPUTER` | richiede `"1"` (macOS aarch64) |

`electron:dev` imposta `HOMUN_BROWSER_AUTOMATION_DIR` esplicitamente al runtime
del checkout corrente e prepara le dipendenze Node del sidecar se manca
`node_modules/tsx/dist/cli.mjs`.
