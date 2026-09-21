# Technical consolidation implementation plan

**Goal:** Repair the reviewed conversation-to-result transitions without redesigning the product.

**Architecture:** Keep domain commands authoritative. Reuse intake policy, typed errors, material project resolution and one shared result-review surface. Encryption stays explicit and preserves existing plaintext workspaces until a safe migration is available.

**Tech stack:** React/TypeScript, Python, SQLite/SQLCipher, existing node:test and pytest suites.

## Work packages

- [x] Intake: reproduce a confirmed, idle preparation agreement followed by a work request; route it through classification and a new supervised proposal. Preserve chat questions and prohibit re-intake after execution. Tie confirmation idempotency to proposal identity.
- [x] Operational notices: restore typed connection/request errors and durable recovery notices in `ConversationWorkspace` through `ConversationEngineBanner`; render nothing in healthy idle state. Keep simulation explicitly labelled.
- [x] Materials: make initial listing read-only; ensure a project only on ingestion. Preserve file errors, reject stale loads and invalidate project material consumers after mutations.
- [x] Review: share approval and request-changes controls across CSV and material reads, expose individual chain outputs and preserve canonical artifact/version checks and a viable correction path.
- [x] Encryption: isolate Keychain tests, make the context-level test actually encrypted, inspect dependencies and all database connections/backup boundaries. Implement only a safe explicit operational mode; document remaining migration/distribution limits.
- [x] Integration: run targeted regressions then typecheck, frontend tests/build, engine tests and architecture checks. Exercise the relevant GUI against disposable local state where possible. Record evidence and remaining limitations in a research report.

## Verification discipline

Each behavioral fix starts with a failing regression against the existing boundary. Workers own disjoint files and do not commit or modify the user's runtime data. Review diffs before integrating. Existing baseline at c817734: 173 frontend tests, typecheck/build passed; 21 targeted engine tests passed. Current branch is already `fabio/production-foundations`; use this clean feature checkout so the reviewed app and the fixes stay in the user's workspace.
