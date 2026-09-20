# Project READ authorization delivery — 2026-09-19

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

Work list/detail, work current run, run detail and event reads now require an actor. Work and run reads reuse the current work policy, including every project attached through linked conversations. A revoked or expired grant takes effect on the next snapshot read. Denied detail reads return typed `permission_denied` HTTP 403; actorless development reads return typed `unauthorized` HTTP 401. Production session identity binding is handled separately by the session middleware.

`routes/reads.py` owns the extracted endpoints; `policy/read.py` owns visibility. The event filter checks the aggregate plus protected project/work/conversation/material/grant/run IDs recursively in payloads, including prefixed keys and ID arrays. Missing protected records and unknown aggregate kinds fail closed. Agent, team and workspace aggregates remain workspace shared when their payload has no denied reference. Historical events use current grants, not the authority at emission time.

Event `limit` bounds the scanned page, so a page may contain no visible items. Its cursor advances to the last scanned sequence. Consumers must continue while the cursor changes, even when items are empty. Numeric cursors expose sequence position but never denied event records. The existing snapshot storage still loads workspace state; this is response authorization, not a new storage query engine.

The web domain client now supplies the existing `defaultLocalActor()` for work reads, consistent with conversation reads and commands. Both read helpers accept an explicit actor override. No new identity or simulation fallback was introduced.

## Verification

- TDD: the initial nine backend cases failed against unrestricted endpoints; all passed after policy integration. A separate prefixed-reference case failed before the recursive key handling fix.
- `engine/.venv/bin/python -m pytest engine/tests/test_read_authorization.py engine/tests/test_storage_api_f2.py engine/tests/test_f41_durable_runtime.py engine/tests/test_access_grant_b2.py -q`: **23 passed**. Coverage includes 401/403, granted/denied/revoked/expired reads, all linked projects, run inheritance, historical event filtering, unknown references and cursor progress.
- Final tightened event revocation and bounded-page assertions: `test_read_authorization.py`: **11 passed**.
- `node --experimental-strip-types --test tests/engine-read-authorization.test.ts tests/engine-client.test.ts`: **10 passed**, including default and explicit actor headers.
- `npm run typecheck`: passed.
- Existing Starlette/AnyIO deprecation warning remains. No native UI, full build, deployment, commit or push was performed by this tranche.

## Files

- `engine/src/homun/policy/read.py`
- `engine/src/homun/routes/reads.py`
- `engine/src/homun/routes/domain.py` (router composition)
- `apps/web/src/lib/engine-domain-client.ts`
- `engine/tests/test_read_authorization.py`
- `engine/tests/test_storage_api_f2.py`, `engine/tests/test_f41_durable_runtime.py` (explicit actors on existing read callers)
- `tests/engine-read-authorization.test.ts`

## Grant metadata review follow-up

Grant visibility now uses one shared `policy/grants.py` helper in both `/grants` and event projection: subjects can read their own grants (including revoked grants), and current project admins can read project grants. Ordinary project readers cannot read another subject's grant aggregate or a payload containing its `grant_id`.

For `project.created` and `project.created_from_conversation` only, an inaccessible `admin_grant_id` is omitted from the returned payload so readable project history remains available. Stored events are never changed. Missing grant references still fail closed. Other grant references retain whole-event filtering. Own grant events may include their matching resource ID after revocation because that metadata is already visible in `/grants`; this does not restore project/work/material access.

A new test first reproduced the grant-event leak, then passed after sharing the policy and adding explicit projection. Follow-up verification: `test_read_authorization.py` + `test_access_grant_b2.py`: **20 passed**, including both creation event types, other-subject deny, own/admin visibility, post-revocation own audit, and stored history preservation.

## Canonical HTTP contract integration

Added `tools/export_openapi.py` with `--write` (default) and `--check`, and generated `contracts/openapi/v1-engine.json` from the current FastAPI factory. The JSON uses sorted keys and stable formatting; no new dependencies. Backend CI now checks drift after engine installation. `contracts/README.md` identifies this as the canonical current route snapshot, distinguishes the old partial F2 YAML, and documents bound-session/development actor semantics, middleware Bearer protection not inferred in OpenAPI, generic response-schema limits, and filtered event cursor pagination.

Verification: write/check succeeded; canonical schema has **42 paths**. Export/check also succeeded with context creation, context access and `sqlite3.connect` patched to fail, proving no user database was read in that run. A temporary intentionally stale snapshot returned exit status 1; the real snapshot then passed again. No application/policy/session/runtime source was changed for this integration.
