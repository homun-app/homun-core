# MCP descriptor contracts

Continue the approved owned-engine design toward H07/H36. A declared server is
not proof of its schema. Discovery happens outside database transactions, with
configuration revalidation before persisting the proposal. Pin the complete tool
descriptor in the approval digest; validate arguments locally with JSON Schema
without network reference resolution. Rediscover and compare within the execution
session before tools/call. Preflight rejection is not an uncertain external effect.

- [x] Tests: malformed arguments, missing/duplicate tool, contract drift,
  configuration race, replay without rediscovery, same-session preflight refusal.
- [x] Descriptor helper, proposal binding and SDK preflight; direct pinned deps.
- [x] Review, regressions and local protocol evidence; update documents and merge.

Remote server behavior is not cryptographically attested. No assumption of trust
from annotations and no new execution authority from discovery. Adaptive registry
binding and model-driven selection remain the next integration, not yet delivered.
