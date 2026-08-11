# Architecture — as-built (2026-07-31)

Mappe riscritte dal codice del workspace Cargo e di `apps/desktop`.
**Non** confondere con `docs/archive/2026-07-31-doc-reset/architecture/` (storia).

| Pagina | Contenuto |
| --- | --- |
| [`overview.md`](overview.md) | Crate, porte, flusso a bande |
| [`agent-loop.md`](agent-loop.md) | Turno chat → `engine::run_turn` |
| [`kernel-v2-contract.md`](kernel-v2-contract.md) | Contratto owner per turno, piano, browser, receipts e UI liveness |
| [`chat-lifecycle.md`](chat-lifecycle.md) | Contratti owner per turni, steering, visible content e layout chat |
| [`execution.md`](execution.md) | `ExecutionContract`, effect host, outbox, lease |
| [`memory.md`](memory.md) | `MemoryFacade`, SQLite, flag pool/service |
| [`desktop-ui.md`](desktop-ui.md) | Superfici Electron, chat, island |
| [`contained-computer.md`](contained-computer.md) | Docker computer + setup API |
| [`host-computer-control.md`](host-computer-control.md) | Helper macOS (separato dal Docker) |
| [`runtime-flags.md`](runtime-flags.md) | `HOMUN_*` con default verificati |

Prima di aggiungere una nuova pagina: `rg` sul simbolo, poi scrivi. Niente
“direzione futura” senza codice già presente.
