## Homun 2 engineering rules

- **No monoliths.** Prefer small modules with one job (domain, storage, API,
  UI shell, feature panels). Do not grow `ConversationWorkspace` or similar
  god-files; extract types, data, hooks, and panels instead. Soft ceiling:
  keep orchestration shells under ~1.5k lines; move pure helpers and panels out
  as soon as a section has a clear boundary.
- **Reuse first.** Prefer shared helpers, ports, and UI pieces over copy-paste
  or one-off lookups. When the same decision appears twice (e.g. “which agent
  chrome for this work?”), extract a named function or component and use it
  everywhere — including engine vs simulation paths. New code should extend
  existing modules before inventing a parallel path.
- **Errors are first-class.** Surface engine/domain failures with typed codes
  (`HomunClientError` / `HomunErrorNotice`); never hide them by falling back to
  simulation data.
- **Simulation vs engine stay explicit.** `Fonte: simulazione | motore` must
  never mix silently.
