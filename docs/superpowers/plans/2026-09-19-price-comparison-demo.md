# Price comparison demo implementation plan

**Goal:** execute an approved local CSV price comparison from Homun chat using synthetic fixtures, return a durable report, and demonstrate restart-safe execution.

**Architecture:** preserve the approved Pydantic AI/DBOS split. A deterministic CSV tool owns validation/calculation/reporting; application services own approval, current authority, immutable source hashes, operational limits and artifact publication; DBOS owns execution/recovery. UI owns file selection and explicit confirmation only. Existing managed material ingestion, CommandRecord persistence, Work/Plan/Artifact and transcript are reused. No shell tool, arbitrary path, external connector, new orchestrator, or currency conversion.

**Tech Stack:** existing Python engine, SQLite, DBOS, React/Electron; CSV fixtures and independent expected results.

User approved the preceding end-to-end proposal and explicitly requested generated demo materials. Existing autonomous authorization covers implementation and synthetic execution; no further approval gate for the implementation itself. The product still requires its own explicit action confirmation in the demo.

- [x] Pure tool and fixtures: UTF-8 CSV columns sku/name/price/currency; exact SKU matching; Decimal arithmetic; changed/new/removed/unchanged and invalid/duplicate/currency-mismatch cases. Fixture oracle independently specified, source data explicitly synthetic.
- [x] Backend: persisted proposal including source IDs/versions/hashes, work revision, tool version and max rows/attempts; approval digest and current permission checks; atomic per-work admission; DBOS workflow with stable identity; recheck before publication; one artifact/transcript report on replay. GET status remains authorized. Restart resumes approved work; unapproved proposals never execute.
- [x] Frontend: dedicated chat panel selects two local CSV files, ingests through existing material API, shows exact proposal and explicit approval; status/report survive refresh and restart. Typed errors and no demo fallback. Ordinary engine attachments must not silently disappear.
- [x] Verify focused failures then passing tests, full checks and architecture, exact fixture oracle, duplicate approval/source tamper/revocation/restart cases, actual native GUI with the generated fixtures. Rebuild desktop and record final artifact and practical limits.

The local comparison itself calls no model and makes no paid API request. Row/byte/attempt limits are operational budgets for this capability; this tranche must not claim a universal monetary budget ledger for all model work.
