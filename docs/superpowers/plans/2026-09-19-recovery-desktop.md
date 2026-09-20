# Recovery and desktop implementation tranche

Approved by Fabio with “procedi”, following the five-item autonomous scope. Execute in the current preserved `fabio/production-foundations` checkout; no publishing or rewriting history. Use bounded subagent implementation and independent spec/quality review, test regressions before fixes. All user data remains untouched; tests use temporary directories.

## Design choices

1. Material ingestion is an application use case. Atomic, durable content-addressed blobs precede a transactional domain registration. The same command/content replays the same identity. A dedicated blob lock serializes publication and garbage collection; recovery removes only managed unreferenced content, preserving legacy originals. I/O leaves domain handlers.
2. Complete backup v2 initially runs **offline**, with an exclusive engine-directory lease also held by the serving process. This yields a consistent workspace/DBOS/blob/receipt inventory without pretending two online database snapshots are atomic. Existing v1 workspace-only backups remain readable. Verify paths, hashes and required references before publishing the backup/restore; credentials are excluded. Interrupted restore never publishes a partial installation.
3. Persist model follow-up input and actor context. Recover expired processing claims automatically with bounded retries and backoff, retain fencing and user-visible terminal failure. Never reexecute domain input messages. Background work must have a lifecycle, serialize per conversation where necessary and revalidate authority at commit. Legacy claims lacking full input cannot be automatically guessed.
4. Extract coherent UI responsibilities, beginning with simulation actions and navigation from ConversationWorkspace. Preserve simulation/engine boundary, no new god hook and no UI redesign. Lower architecture budgets when files shrink.
5. Electron bootstrap uses a narrow preload, sandbox/context isolation, owned Python process lifecycle, loopback session authentication and fixed renderer origin. Prove source-level smoke before packaging; build a local unsigned artifact where dependencies permit. Signed notarized release and real key recovery require explicit operator credentials/choices; synthetic crypto/Keychain feasibility only.

## Executable work and acceptance

- [x] Materials: new application ingestion + managed blob store, domain register command and client idempotency key. Regressions: duplicate key/content, different content conflict, permission check before replay, failed DB commit cleanup, crash orphan recovery, shared content retained, integrity mismatch. Existing HTTP ingest tests pass; remove material I/O architecture exceptions.
- [x] Engine lease + backup v2: offline CLI create/verify/restore, immutable staged inventory containing required originals and DBOS/receipts; retain v1 compatibility. Test running-engine refusal, tamper/traversal/symlink, atomic failure, material hash roundtrip and actual pending workflow recovery after restoring elsewhere.
- [x] Follow-up recovery: durable input and attempt metadata; background recovery + bounded attempts. Test restart without caller retry, duplicate workers, superseded attempt, failure exhaustion and explicit retry, no automatic domain reassignment.
- [x] UI modularity: coherent extraction, lower baseline budget, typecheck/frontend tests and real browser check for changed interaction.
- [ ] Desktop boundary: shell, owned engine session, auth on all engine routes (including reads), local dev compatibility explicit; prove unrelated request rejected, renderer lifecycle and graceful engine stop. Keep signing/secret migration out of unattended real-data actions.
- [x] Reviews and final checks: selected RED/GREEN evidence; full backend including clean lock env when deps change, npm check, architecture checker, live process checks. Update delivery report with exact results and unfinished items.

Commands: `cd engine && .venv/bin/pytest -q tests/test_material_recovery.py`; backup tests in `tests/test_installation_backup.py`; follow-up tests in `tests/test_followup_recovery.py`; `npm run check`; `npm run architecture:check`.

Public APIs are implemented in small modules, with existing ports reused. No claim of production readiness, automatic key recovery or signed distribution without evidence.

## Delivery notes

Desktop source boundary and owned-process tests are complete; native Electron smoke was not completed with the Mac locked. No standalone Python artifact or installer produced. Reviews found and fixed lease ordering, extractor identity, durability retries, conversation ownership and startup cleanup. Browser acceptance passed on a temporary local server; source selection synchronization was repaired. See `docs/research/2026-09-19-recovery-desktop-delivery.md` for exact evidence and remaining release gates.

SQLCipher feasibility probe completed in an isolated temporary environment; see `docs/research/2026-09-19-crypto-spike.md`. Runtime encryption not adopted. Final checks: 218 backend passed / 1 live skip; 121 frontend passed; 5 desktop boundary passed; architecture zero errors. Native GUI/Keychain and packaged release remain unchecked.
